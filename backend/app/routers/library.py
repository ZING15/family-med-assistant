"""
F-01／F-02 學習庫 API。

三種輸入方式：
  - 圖片（kind=figure）：上傳圖片 → AI 辨識文字、建議欄位與來源 → 醫師確認後儲存
  - 文字（kind=note）：醫師撰寫內容 → AI 建議標題、標籤、摘要與來源 → 醫師確認後儲存
  - 語音（kind=voice）：錄音或上傳音檔 → AI 轉逐字稿並建議欄位 → 醫師確認後儲存
來源為選填；AI 只在內容中明確出現期刊資訊時自動帶入。
"""

from __future__ import annotations

import json
import uuid

from typing import Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from openai import OpenAIError
from pydantic import BaseModel, Field

from ..ai import TranscriptionError, ai, cosine
from ..config import UPLOAD_DIR
from ..db import app_db, now

router = APIRouter(prefix="/api/library", tags=["library"])

LIBRARY_UPLOADS = UPLOAD_DIR / "library"
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_BYTES = 10 * 1024 * 1024
# Azure 語音轉文字支援的格式；瀏覽器錄音在 Chrome 為 webm、Safari 為 mp4
AUDIO_EXTENSIONS = {".webm", ".mp3", ".mp4", ".m4a", ".wav", ".mpeg", ".mpga"}
AUDIO_MIME_EXT = {
    "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/wave": ".wav", "video/webm": ".webm", "video/mp4": ".mp4",
}
MAX_AUDIO_BYTES = 25 * 1024 * 1024
SEMANTIC_MIN_SCORE = 0.4


class LibraryItemIn(BaseModel):
    kind: str = Field("figure", pattern="^(figure|note|voice|drug|education)$")
    title: str = Field(..., min_length=1, max_length=120)
    topic: str = ""
    tags: list[str] = []
    note: str = ""
    source_title: str = ""
    source_url: str = ""
    source_year: str = ""
    image_path: str = ""
    audio_path: str = ""
    extracted_text: str = ""
    ai_summary: str = ""
    ai_meta: dict = {}
    ref_type: str = ""
    ref_id: str = ""


class TopicRename(BaseModel):
    old: str = Field(..., min_length=1)
    new: str = Field(..., min_length=1, max_length=40)


class TopicAssignment(BaseModel):
    id: int
    topic: str = Field(..., min_length=1, max_length=40)


class TopicApply(BaseModel):
    assignments: list[TopicAssignment]


class AnalyzeIn(BaseModel):
    mode: Literal["image", "text", "voice"]
    image_path: str = ""
    audio_path: str = ""
    text: str = ""


def _row_to_item(row) -> dict:
    item = dict(row)
    item["tags"] = json.loads(item["tags"] or "[]")
    item["ai_meta"] = json.loads(item["ai_meta"] or "{}")
    item["has_embedding"] = bool(item.pop("embedding"))
    # 藥品卡可直接引用 TFDA 外觀圖網址（不下載）
    path = item["image_path"]
    item["image_url"] = path if path.startswith("https://") else (f"/uploads/{path}" if path else "")
    item["audio_url"] = f"/uploads/{item['audio_path']}" if item["audio_path"] else ""
    return item


def _embedding_text(data: LibraryItemIn) -> str:
    return "\n".join(
        [data.title, data.topic, " ".join(data.tags), data.note, data.ai_summary,
         data.extracted_text, data.source_title]
    )


def _resolve_upload(image_path: str):
    path = (UPLOAD_DIR / image_path).resolve()
    if not str(path).startswith(str(UPLOAD_DIR.resolve())) or not path.is_file():
        raise HTTPException(404, "找不到上傳的圖片")
    return path


_topic_vectors: dict[str, list[float]] = {}


def _existing_topics() -> list[str]:
    """現有主題，依筆記數量排序。"""
    with app_db() as con:
        rows = con.execute(
            "SELECT topic, COUNT(*) AS n FROM library_items WHERE topic != '' GROUP BY topic ORDER BY n DESC, MAX(updated_at) DESC"
        ).fetchall()
    return [r["topic"] for r in rows]


def _topic_vector(topic: str) -> list[float] | None:
    if topic not in _topic_vectors:
        vector = ai.embed(topic)
        if vector is None:
            return None
        _topic_vectors[topic] = vector
    return _topic_vectors[topic]


def _related_topics(suggestion: dict, topics: list[str], limit: int = 3) -> list[dict]:
    """用 embedding 找出與 AI 建議內容最接近的現有主題，讓醫師一鍵改用。"""
    if not topics or not ai.embedding_ready:
        return []
    query = ai.embed(f"{suggestion.get('topic', '')}｜{suggestion.get('title', '')}｜{' '.join(suggestion.get('tags', []))}")
    if not query:
        return []
    scored = []
    for topic in topics:
        vector = _topic_vector(topic)
        if vector:
            scored.append({"topic": topic, "score": round(cosine(query, vector), 3)})
    scored.sort(key=lambda t: t["score"], reverse=True)
    return [t for t in scored[:limit] if t["score"] >= 0.35]


@router.post("/uploads")
async def upload_image(file: UploadFile = File(...)):
    if file.content_type not in ALLOWED_TYPES:
        raise HTTPException(415, "只接受 JPG、PNG、WebP 或 GIF 圖片")
    content = await file.read()
    if len(content) > MAX_BYTES:
        raise HTTPException(413, "圖片不可超過 10MB")
    LIBRARY_UPLOADS.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ALLOWED_TYPES[file.content_type]}"
    (LIBRARY_UPLOADS / name).write_bytes(content)
    image_path = f"library/{name}"
    return {"image_path": image_path, "image_url": f"/uploads/{image_path}"}


@router.post("/audio")
async def upload_audio(file: UploadFile = File(...)):
    mime = (file.content_type or "").split(";")[0].strip()
    ext = AUDIO_MIME_EXT.get(mime) or next(
        (e for e in AUDIO_EXTENSIONS if (file.filename or "").lower().endswith(e)), None
    )
    if not ext:
        raise HTTPException(415, "只接受 mp3、m4a、wav、webm 或 mp4 音檔")
    content = await file.read()
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "音檔不可超過 25MB（約 20 分鐘以內的錄音）")
    if not content:
        raise HTTPException(422, "音檔是空的，請重新錄音")
    LIBRARY_UPLOADS.mkdir(parents=True, exist_ok=True)
    name = f"{uuid.uuid4().hex}{ext}"
    (LIBRARY_UPLOADS / name).write_bytes(content)
    audio_path = f"library/{name}"
    return {"audio_path": audio_path, "audio_url": f"/uploads/{audio_path}"}


@router.post("/analyze")
def analyze(body: AnalyzeIn):
    """AI 整理內容，只回傳建議，不自動儲存。"""
    transcript = ""
    topics = _existing_topics()
    try:
        if body.mode == "image":
            path = _resolve_upload(body.image_path)
            mime = next((m for m, ext in ALLOWED_TYPES.items() if path.suffix == ext), "image/png")
            suggestion, meta = ai.analyze_figure(path.read_bytes(), mime, topics)
        elif body.mode == "text":
            if not body.text.strip():
                raise HTTPException(422, "請先輸入筆記內容")
            suggestion, meta = ai.analyze_text(body.text, topics=topics)
        else:
            path = _resolve_upload(body.audio_path)
            text, meta = ai.transcribe(path)
            if text is None:
                return {
                    "suggestion": {}, "transcript": "", "ai_meta": meta,
                    "message": "語音辨識尚未設定（需要 AZURE_SPEECH_MODEL 或 AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT），請手動輸入內容。",
                }
            transcript = text.strip()
            if not transcript:
                raise HTTPException(422, "沒有辨識到語音內容，請確認麥克風或音檔")
            transcribe_model = meta["model"]
            suggestion, meta = ai.analyze_text(transcript, spoken=True, topics=topics)
            meta = {**meta, "model": f"{transcribe_model} + {meta['model']}" if meta["model"] else transcribe_model}
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    except TranscriptionError as error:
        raise HTTPException(502, str(error))

    message = "" if meta["mode"] == "azure" else "示範模式：尚未設定 Azure OpenAI，請手動輸入內容。"
    try:
        related = _related_topics(suggestion, topics) if meta["mode"] == "azure" else []
    except OpenAIError:
        related = []
    return {
        "suggestion": suggestion,
        "transcript": transcript,
        "ai_meta": meta,
        "message": message,
        "topic_exists": suggestion.get("topic", "") in topics,
        "related_topics": [t for t in related if t["topic"] != suggestion.get("topic")],
    }


@router.get("")
def list_items(q: str = "", tag: str = "", kind: str = "", topic: str = "", mode: str = "auto"):
    """
    mode: keyword | semantic | auto
    auto 會在 embedding 可用時合併語意與關鍵字分數，否則只用關鍵字。
    """
    with app_db() as con:
        rows = con.execute("SELECT * FROM library_items ORDER BY created_at DESC").fetchall()

    items = []
    for row in rows:
        if kind and row["kind"] != kind:
            continue
        if topic and row["topic"] != topic:
            continue
        tags = json.loads(row["tags"] or "[]")
        if tag and tag not in tags:
            continue
        items.append(row)

    if not q.strip():
        return {"items": [_row_to_item(r) for r in items], "search_mode": "none"}

    terms = [t.lower() for t in q.split() if t]
    use_semantic = mode in ("auto", "semantic") and ai.embedding_ready
    query_vec = ai.embed(q) if use_semantic else None

    scored = []
    for row in items:
        haystack = " ".join(
            str(row[k]) for k in ("title", "topic", "tags", "note", "ai_summary", "extracted_text", "source_title")
        ).lower()
        keyword = sum(1 for t in terms if t in haystack) / len(terms)
        semantic = cosine(query_vec, json.loads(row["embedding"])) if query_vec and row["embedding"] else 0.0
        if mode == "keyword" or not query_vec:
            score, matched = keyword, keyword > 0
        else:
            score = semantic + 0.3 * keyword
            matched = semantic >= SEMANTIC_MIN_SCORE or keyword > 0
        if matched:
            item = _row_to_item(row)
            item["score"] = round(score, 3)
            item["match"] = {"keyword": round(keyword, 2), "semantic": round(semantic, 3)}
            scored.append(item)

    scored.sort(key=lambda i: i["score"], reverse=True)
    return {"items": scored, "search_mode": "hybrid" if query_vec else "keyword"}


@router.get("/tags")
def list_tags():
    with app_db() as con:
        rows = con.execute("SELECT tags FROM library_items").fetchall()
    counts: dict[str, int] = {}
    for row in rows:
        for t in json.loads(row["tags"] or "[]"):
            counts[t] = counts.get(t, 0) + 1
    return {"tags": sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))}


@router.get("/topics")
def list_topics():
    """主題清單：筆記數、最後更新時間與一張封面圖。"""
    with app_db() as con:
        rows = con.execute(
            "SELECT topic, kind, image_path, updated_at FROM library_items ORDER BY updated_at DESC"
        ).fetchall()
    topics: dict[str, dict] = {}
    for row in rows:
        name = row["topic"] or "未分類"
        entry = topics.setdefault(name, {"topic": name, "count": 0, "updated_at": row["updated_at"], "cover_url": "", "kinds": {}})
        entry["count"] += 1
        entry["kinds"][row["kind"]] = entry["kinds"].get(row["kind"], 0) + 1
        if not entry["cover_url"] and row["image_path"]:
            entry["cover_url"] = f"/uploads/{row['image_path']}"
    return {"topics": sorted(topics.values(), key=lambda t: (-t["count"], t["topic"]))}


@router.put("/topics")
def rename_topic(body: TopicRename):
    """主題改名；改成已存在的名稱即為合併。"""
    with app_db() as con:
        old = "" if body.old == "未分類" else body.old
        cur = con.execute(
            "UPDATE library_items SET topic = ?, updated_at = ? WHERE topic = ?", (body.new.strip(), now(), old)
        )
    return {"updated": cur.rowcount}


@router.post("/topics/reorganize")
def propose_topics():
    """AI 建議新的主題分類，只回傳建議，醫師確認後再套用。"""
    with app_db() as con:
        rows = con.execute("SELECT id, title, topic, tags, ai_summary, note FROM library_items").fetchall()
    if not rows:
        return {"assignments": []}
    items = [
        {"id": r["id"], "title": r["title"], "topic": r["topic"], "tags": json.loads(r["tags"] or "[]"),
         "summary": r["ai_summary"] or r["note"]}
        for r in rows
    ]
    try:
        result, meta = ai.propose_topics(items)
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    if result is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能使用 AI 整理主題")
    current = {i["id"]: i for i in items}
    assignments = [
        {"id": a["id"], "title": current[a["id"]]["title"], "old": current[a["id"]]["topic"], "topic": str(a["topic"]).strip()}
        for a in result.get("assignments", [])
        if isinstance(a, dict) and a.get("id") in current and str(a.get("topic", "")).strip()
    ]
    return {"assignments": assignments, "ai_meta": meta}


@router.post("/topics/apply")
def apply_topics(body: TopicApply):
    with app_db() as con:
        for a in body.assignments:
            con.execute("UPDATE library_items SET topic = ?, updated_at = ? WHERE id = ?", (a.topic.strip(), now(), a.id))
    return {"updated": len(body.assignments)}


@router.get("/{item_id}")
def get_item(item_id: int):
    with app_db() as con:
        row = con.execute("SELECT * FROM library_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到這筆學習筆記")
    return _row_to_item(row)


def _validate(data: LibraryItemIn) -> None:
    """來源為選填；各類型只檢查必要的內容是否存在。"""
    if data.kind == "figure":
        if not data.image_path:
            raise HTTPException(422, "圖片筆記需要上傳圖片")
        _resolve_upload(data.image_path)
    elif data.kind == "voice":
        if not data.audio_path:
            raise HTTPException(422, "語音筆記需要錄音或上傳音檔")
        _resolve_upload(data.audio_path)
    elif data.kind == "note" and not (data.note.strip() or data.extracted_text.strip()):
        raise HTTPException(422, "請輸入筆記內容")


@router.post("", status_code=201)
def create_item(data: LibraryItemIn):
    _validate(data)
    vector = ai.embed(_embedding_text(data))
    ts = now()
    with app_db() as con:
        cur = con.execute(
            """INSERT INTO library_items
               (kind, title, topic, tags, note, source_title, source_url, source_year, image_path,
                audio_path, extracted_text, ai_summary, ai_meta, ref_type, ref_id, embedding,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                data.kind, data.title.strip(), data.topic.strip(),
                json.dumps([t.strip() for t in data.tags if t.strip()], ensure_ascii=False),
                data.note, data.source_title.strip(), data.source_url.strip(), data.source_year.strip(),
                data.image_path, data.audio_path, data.extracted_text, data.ai_summary,
                json.dumps(data.ai_meta, ensure_ascii=False), data.ref_type, data.ref_id,
                json.dumps(vector) if vector else "", ts, ts,
            ),
        )
        item_id = cur.lastrowid
    return get_item(item_id)


@router.put("/{item_id}")
def update_item(item_id: int, data: LibraryItemIn):
    get_item(item_id)
    _validate(data)
    vector = ai.embed(_embedding_text(data))
    with app_db() as con:
        con.execute(
            """UPDATE library_items SET kind=?, title=?, topic=?, tags=?, note=?, source_title=?,
               source_url=?, source_year=?, image_path=?, audio_path=?, extracted_text=?, ai_summary=?, ai_meta=?,
               ref_type=?, ref_id=?, embedding=?, updated_at=? WHERE id=?""",
            (
                data.kind, data.title.strip(), data.topic.strip(),
                json.dumps([t.strip() for t in data.tags if t.strip()], ensure_ascii=False),
                data.note, data.source_title.strip(), data.source_url.strip(), data.source_year.strip(),
                data.image_path, data.audio_path, data.extracted_text, data.ai_summary,
                json.dumps(data.ai_meta, ensure_ascii=False), data.ref_type, data.ref_id,
                json.dumps(vector) if vector else "", now(), item_id,
            ),
        )
    return get_item(item_id)


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int):
    item = get_item(item_id)
    with app_db() as con:
        con.execute("DELETE FROM library_items WHERE id = ?", (item_id,))
    # 只刪學習庫自己上傳的檔案；藥品卡的 TFDA 連結、衛教單的插圖由各自功能管理
    for key in ("image_path", "audio_path"):
        if item[key] and item[key].startswith("library/"):
            (UPLOAD_DIR / item[key]).unlink(missing_ok=True)
