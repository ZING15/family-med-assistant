"""F-01／F-02 圖像學習庫 API。"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel, Field

from ..ai import ai, cosine
from ..config import UPLOAD_DIR
from ..db import app_db, now

router = APIRouter(prefix="/api/library", tags=["library"])

LIBRARY_UPLOADS = UPLOAD_DIR / "library"
ALLOWED_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_BYTES = 10 * 1024 * 1024
SEMANTIC_MIN_SCORE = 0.25


class LibraryItemIn(BaseModel):
    kind: str = Field("figure", pattern="^(figure|drug|education|note)$")
    title: str = Field(..., min_length=1, max_length=120)
    topic: str = ""
    tags: list[str] = []
    note: str = ""
    source_title: str = ""
    source_url: str = ""
    source_year: str = ""
    image_path: str = ""
    extracted_text: str = ""
    ai_summary: str = ""
    ai_meta: dict = {}
    ref_type: str = ""
    ref_id: str = ""


class AnalyzeIn(BaseModel):
    image_path: str
    hint: str = ""


def _row_to_item(row) -> dict:
    item = dict(row)
    item["tags"] = json.loads(item["tags"] or "[]")
    item["ai_meta"] = json.loads(item["ai_meta"] or "{}")
    item["has_embedding"] = bool(item.pop("embedding"))
    item["image_url"] = f"/uploads/{item['image_path']}" if item["image_path"] else ""
    return item


def _embedding_text(data: LibraryItemIn) -> str:
    return "\n".join(
        [data.title, data.topic, " ".join(data.tags), data.note, data.ai_summary, data.extracted_text]
    )


def _resolve_upload(image_path: str):
    path = (UPLOAD_DIR / image_path).resolve()
    if not str(path).startswith(str(UPLOAD_DIR.resolve())) or not path.is_file():
        raise HTTPException(404, "找不到上傳的圖片")
    return path


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


@router.post("/analyze")
def analyze_image(body: AnalyzeIn):
    """AI 整理圖片，只回傳建議，不自動儲存。"""
    path = _resolve_upload(body.image_path)
    mime = next((m for m, ext in ALLOWED_TYPES.items() if path.suffix == ext), "image/png")
    suggestion, meta = ai.analyze_figure(path.read_bytes(), mime, body.hint)
    return {"suggestion": suggestion, "ai_meta": meta}


@router.get("")
def list_items(q: str = "", tag: str = "", kind: str = "", mode: str = "auto"):
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


@router.get("/{item_id}")
def get_item(item_id: int):
    with app_db() as con:
        row = con.execute("SELECT * FROM library_items WHERE id = ?", (item_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到這筆學習筆記")
    return _row_to_item(row)


def _validate(data: LibraryItemIn) -> None:
    if data.kind == "figure":
        if not data.image_path:
            raise HTTPException(422, "圖表筆記需要上傳圖片")
        if not (data.source_title.strip() or data.source_url.strip()):
            raise HTTPException(422, "請填寫來源（標題或連結至少一項）")
        _resolve_upload(data.image_path)


@router.post("", status_code=201)
def create_item(data: LibraryItemIn):
    _validate(data)
    vector = ai.embed(_embedding_text(data))
    ts = now()
    with app_db() as con:
        cur = con.execute(
            """INSERT INTO library_items
               (kind, title, topic, tags, note, source_title, source_url, source_year, image_path,
                extracted_text, ai_summary, ai_meta, ref_type, ref_id, embedding, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                data.kind, data.title.strip(), data.topic.strip(),
                json.dumps([t.strip() for t in data.tags if t.strip()], ensure_ascii=False),
                data.note, data.source_title.strip(), data.source_url.strip(), data.source_year.strip(),
                data.image_path, data.extracted_text, data.ai_summary,
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
               source_url=?, source_year=?, image_path=?, extracted_text=?, ai_summary=?, ai_meta=?,
               ref_type=?, ref_id=?, embedding=?, updated_at=? WHERE id=?""",
            (
                data.kind, data.title.strip(), data.topic.strip(),
                json.dumps([t.strip() for t in data.tags if t.strip()], ensure_ascii=False),
                data.note, data.source_title.strip(), data.source_url.strip(), data.source_year.strip(),
                data.image_path, data.extracted_text, data.ai_summary,
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
    if item["image_path"]:
        path = UPLOAD_DIR / item["image_path"]
        path.unlink(missing_ok=True)
