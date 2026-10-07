"""
F-08／F-09 衛教單與 AI 衛教圖。

流程：從病歷（病灶＋本次處方）或主題產生 AI 草稿 → 醫師編輯 → 產生一張衛教插圖（存檔重複使用）
→ 醫師勾選確認後，前端才允許下載圖片或存到學習庫。
用藥的頻率與天數一律取自醫師的開藥區，AI 只寫白話用途與服用提醒。
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Response
from openai import OpenAIError
from pydantic import BaseModel, Field

from .. import terms
from ..ai import ImageGenerationError, ai
from ..config import UPLOAD_DIR, azure
from ..db import app_db, now

router = APIRouter(prefix="/api", tags=["education"])

IMAGE_DIR = UPLOAD_DIR / "education"
# 給長輩看的服用頻率寫法
FREQUENCY_TEXT = {
    "QD": "每天 1 次", "BID": "每天 2 次（早、晚）", "TID": "每天 3 次（三餐）",
    "QID": "每天 4 次", "HS": "睡前 1 次", "PRN": "不舒服時才吃",
}
# 藥品外觀圖只允許從 TFDA 轉傳（下載衛教單圖片時用），不存檔
PROXY_HOSTS = {"mcp.fda.gov.tw"}
PROXY_MAX_BYTES = 8 * 1024 * 1024


class SheetCreate(BaseModel):
    record_id: int | None = None
    topics: list[str] = []


class SheetUpdate(BaseModel):
    title: str = Field("", max_length=60)
    content: dict
    confirmed: bool = False


def _row(row) -> dict:
    data = dict(row)
    for key in ("content", "image_meta", "ai_meta"):
        data[key] = json.loads(data[key] or "{}")
    data["confirmed"] = bool(data["confirmed"])
    data["image_url"] = f"/uploads/{data['image_path']}" if data["image_path"] else ""
    return data


def _get(sheet_id: int) -> dict:
    with app_db() as con:
        row = con.execute("SELECT * FROM education_sheets WHERE id = ?", (sheet_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到這份衛教單")
    return _row(row)


def _schedule(p: dict) -> str:
    parts = [FREQUENCY_TEXT.get(p.get("frequency", ""), "")]
    if p.get("days"):
        parts.append(f"吃 {p['days']} 天")
    return "・".join(x for x in parts if x) or "依醫師指示服用"


def _medicines_from_record(record: dict) -> list[dict]:
    meds = []
    for p in json.loads(record["prescriptions"] or "[]"):
        meds.append({
            "atc_code": p.get("atc_code", ""),
            "name": p.get("display_name") or p.get("name_en", ""),
            "name_zh": p.get("name_zh", ""),
            "class_zh": p.get("class_zh", ""),
            "schedule": _schedule(p),
            "image_url": p.get("image_url", ""),
            "product_name": p.get("product_name", ""),
            "purpose": "",
            "tip": "",
        })
    return meds


def _draft(topics: list[str], medicines: list[dict], audience: str) -> tuple[dict, dict]:
    """AI 草稿；未設定 AI 時給空白範本，醫師仍可手動完成。病名搭配台灣常見說法（俗稱、台語），只從對照資料中挑選。"""
    candidates = terms.for_topics(topics)
    try:
        result, meta = ai.education_draft(topics, medicines, audience, candidates)
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    result = result or {}
    by_atc = {m.get("atc_code"): m for m in result.get("medicines", []) if isinstance(m, dict)}
    for med in medicines:
        ai_med = by_atc.get(med["atc_code"], {})
        med["name_zh"] = med["name_zh"] or str(ai_med.get("name_zh", ""))
        med["purpose"] = str(ai_med.get("purpose", ""))
        med["tip"] = str(ai_med.get("tip", ""))
    content = {
        "about": str(result.get("about", "")),
        "medicines": medicines,
        "care": [str(x) for x in result.get("care", [])][:6],
        "warnings": [str(x) for x in result.get("warnings", [])][:5],
        "image_scene": str(result.get("image_scene", "")) or "an elderly person resting at home with a cup of warm water",
    }
    # 「大家常說」以內文真的用到的說法為準（AI 有時沒回傳 aka），再補 AI 回傳的；只保留對照資料裡有的、非單字、非容易混淆的說法。
    # 用到台語辭典的詞時，衛教單需註明出處（CC BY-ND 3.0 TW）
    allowed = {c["term"]: "華語" for c in candidates["colloquial"] if not c.get("confusable")}
    allowed |= {t["word"]: "台語" for t in candidates["taiwanese"] if len(t["word"]) >= 2}
    # 容易混淆的說法（例：雞眼與病毒疣）AI 常漏寫，由程式補上對照表裡的提醒
    for c in candidates["colloquial"]:
        if c.get("confusable") and c["term"] not in content["about"]:
            content["about"] = f"{content['about'].rstrip()}提醒：{c['note']}，請讓醫師看過再處理。"
    text = f"{result.get('title', '')}{content['about']}"
    returned = [str(a.get("term", "")) for a in result.get("aka", []) if isinstance(a, dict)]
    picked = [w for w in allowed if w in text] + [w for w in returned if w in allowed]
    aka = list(dict.fromkeys(picked))[:3] or list(allowed)[:2]  # 都沒用到時，取對照資料中最相關的說法，醫師可再修改
    content["aka"] = "、".join(f"{w}（台語）" if allowed[w] == "台語" else w for w in aka)
    content["term_source"] = terms.MOE_SOURCE if any(allowed[w] == "台語" for w in aka) else ""
    title = str(result.get("title", "")) or f"{'、'.join(topics)}的衛教"
    return {"title": title[:60], "content": content}, meta


@router.get("/education")
def list_sheets():
    with app_db() as con:
        rows = con.execute(
            "SELECT id, record_id, topic, title, image_path, confirmed, updated_at FROM education_sheets ORDER BY updated_at DESC"
        ).fetchall()
    return {"sheets": [dict(r) | {"confirmed": bool(r["confirmed"]),
                                  "image_url": f"/uploads/{r['image_path']}" if r["image_path"] else ""} for r in rows]}


@router.get("/education/{sheet_id}")
def get_sheet(sheet_id: int):
    return _get(sheet_id)


@router.post("/education", status_code=201)
def create_sheet(body: SheetCreate):
    medicines: list[dict] = []
    audience = ""
    if body.record_id is not None:
        with app_db() as con:
            record = con.execute("SELECT * FROM records WHERE id = ?", (body.record_id,)).fetchone()
        if not record:
            raise HTTPException(404, "找不到這份病歷")
        topics = [c["name"] for c in json.loads(record["conditions"] or "[]")]
        if not topics:
            raise HTTPException(422, "這份病歷還沒有病灶，請先寫主訴或手動新增病灶")
        medicines = _medicines_from_record(record)
        audience = " ".join(x for x in (record["age"] and f"{record['age']} 歲", record["sex"]) if x)
    else:
        topics = [t.strip() for t in body.topics if t.strip()]
        if not topics:
            raise HTTPException(422, "請選擇衛教主題")

    draft, meta = _draft(topics, medicines, audience)
    stamp = now()
    with app_db() as con:
        cur = con.execute(
            """INSERT INTO education_sheets (record_id, topic, title, content, ai_meta, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?)""",
            (body.record_id, "、".join(topics), draft["title"], json.dumps(draft["content"], ensure_ascii=False),
             json.dumps(meta, ensure_ascii=False), stamp, stamp),
        )
    return _get(cur.lastrowid)


@router.put("/education/{sheet_id}")
def update_sheet(sheet_id: int, body: SheetUpdate):
    current = _get(sheet_id)
    confirmed_at = (current["confirmed_at"] or now()) if body.confirmed else ""
    with app_db() as con:
        con.execute(
            "UPDATE education_sheets SET title=?, content=?, confirmed=?, confirmed_at=?, updated_at=? WHERE id=?",
            (body.title or current["title"], json.dumps(body.content, ensure_ascii=False), int(body.confirmed),
             confirmed_at, now(), sheet_id),
        )
    return _get(sheet_id)


@router.post("/education/{sheet_id}/image")
def create_image(sheet_id: int, regenerate: bool = False):
    """產生衛教插圖；已有圖片且未要求重新產生時直接回傳，避免重複付費。"""
    sheet = _get(sheet_id)
    if sheet["image_path"] and not regenerate:
        return sheet
    scene = sheet["content"].get("image_scene") or "an elderly person resting at home with a cup of warm water"
    try:
        data, meta = ai.education_image(scene)
    except ImageGenerationError as error:
        messages = {
            404: f"Azure 上找不到生圖模型部署「{azure.image_deployment}」，請確認 Foundry 的部署名稱和 .env 的 AZURE_OPENAI_IMAGE_DEPLOYMENT 相同",
            429: "生圖太頻繁，已達每分鐘上限，請等一分鐘再試",
            400: "生圖要求被拒絕，可能是插圖描述觸發內容安全過濾，請修改後再試",
            401: "生圖模型的金鑰無效，請確認 .env 的金鑰設定",
        }
        raise HTTPException(503 if error.status != 429 else 429,
                            messages.get(error.status, f"AI 生圖錯誤（{error.status}）：{str(error)[:160]}"))
    except OpenAIError as error:
        raise HTTPException(502, f"AI 生圖錯誤：{getattr(error, 'message', str(error))[:200]}")
    if data is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 生圖模型才能產生衛教圖")
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"education/{sheet_id}-{uuid.uuid4().hex[:10]}.png"
    (UPLOAD_DIR / name).write_bytes(data)
    if sheet["image_path"]:
        (UPLOAD_DIR / sheet["image_path"]).unlink(missing_ok=True)
    with app_db() as con:
        # 換了插圖，醫師需要重新確認
        con.execute(
            "UPDATE education_sheets SET image_path=?, image_meta=?, confirmed=0, confirmed_at='', updated_at=? WHERE id=?",
            (name, json.dumps(meta | {"scene": scene}, ensure_ascii=False), now(), sheet_id),
        )
    return _get(sheet_id)


@router.delete("/education/{sheet_id}", status_code=204)
def delete_sheet(sheet_id: int):
    sheet = _get(sheet_id)
    with app_db() as con:
        con.execute("DELETE FROM education_sheets WHERE id = ?", (sheet_id,))
        # 已存到學習庫的筆記還在用這張圖時保留檔案
        in_library = con.execute(
            "SELECT 1 FROM library_items WHERE image_path = ? LIMIT 1", (sheet["image_path"],)
        ).fetchone() if sheet["image_path"] else None
    if sheet["image_path"] and not in_library:
        (UPLOAD_DIR / sheet["image_path"]).unlink(missing_ok=True)


@router.get("/image-proxy")
def image_proxy(url: str):
    """下載衛教單圖片時，瀏覽器不允許把外部網站的圖畫進同一張圖；由後端即時轉傳 TFDA 外觀圖，不存檔。"""
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in PROXY_HOSTS:
        raise HTTPException(400, "只允許轉傳 TFDA 藥品外觀圖")
    request = urllib.request.Request(url, headers={"User-Agent": "family-med-assistant/0.2"})
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            data = response.read(PROXY_MAX_BYTES + 1)
            media_type = response.headers.get_content_type()
    except (urllib.error.URLError, TimeoutError) as error:
        raise HTTPException(502, f"TFDA 圖片暫時無法取得：{error}")
    if len(data) > PROXY_MAX_BYTES or not media_type.startswith("image/"):
        raise HTTPException(502, "TFDA 回傳的不是圖片")
    return Response(data, media_type=media_type, headers={"Cache-Control": "no-store"})
