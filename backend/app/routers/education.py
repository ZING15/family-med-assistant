"""
F-08／F-09 衛教單與 AI 衛教圖。

流程：從病歷（病灶＋本次處方）或主題產生 AI 草稿 → 醫師編輯 → 每個重點產生一張小插圖（存檔重複使用）
→ 醫師勾選確認後，前端才允許下載圖片或存到學習庫。
衛教單為圖卡式（content.version = 2）：在家照顧與回診警訊各是一張張「插圖＋5–10 字標語」的卡片。
舊版（version 1）的整張插圖與條列文字仍可開啟與編輯。
用藥的頻率與天數一律取自醫師的開藥區，AI 只寫白話用途與服用提醒。
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
import uuid
from urllib.parse import urlparse

from fastapi import APIRouter, HTTPException, Response
from openai import OpenAIError
from pydantic import BaseModel, Field

from ..ai import ImageGenerationError, ai
from ..config import UPLOAD_DIR, azure
from ..db import app_db, now

router = APIRouter(prefix="/api", tags=["education"])

IMAGE_DIR = UPLOAD_DIR / "education"
# 給長輩看的服用頻率寫法
FREQUENCY_TEXT = {
    "QD": "每天 1 次", "BID": "每天 2 次（早、晚）", "TID": "每天 3 次（三餐）",
    "QID": "每天 4 次", "HS": "睡前 1 次", "PRN": "不舒服時才吃",
    "QDAC": "每天 1 次，飯前吃", "BIDAC": "每天 2 次，早晚飯前吃", "TIDAC": "每天 3 次，三餐飯前吃",
    "QDPC": "每天 1 次，飯後吃", "BIDPC": "每天 2 次，早晚飯後吃", "TIDPC": "每天 3 次，三餐飯後吃",
    "TID+HS": "三餐飯後和睡前各 1 次", "Q4H": "每 4 小時 1 次", "Q6H": "每 6 小時 1 次", "Q8H": "每 8 小時 1 次",
    "Q12H": "每 12 小時 1 次", "Q6H PRN": "不舒服時才吃，間隔至少 6 小時", "Q4H PRN": "不舒服時才吃，間隔至少 4 小時",
    "QOD": "隔一天吃 1 次", "QW": "每週 1 次", "STAT": "現在先吃 1 次", "ASORDER": "依醫師指示服用",
}
# 藥品外觀圖只允許從 TFDA 轉傳（下載衛教單圖片時用），不存檔
PROXY_HOSTS = {"mcp.fda.gov.tw"}
PROXY_MAX_BYTES = 8 * 1024 * 1024


class SheetCreate(BaseModel):
    record_id: int | None = None
    topics: list[str] = []


CARD_SECTIONS = {"care": 4, "warnings": 6}


def _cards(items, limit: int) -> list[dict]:
    """AI 回傳的重點轉成卡片；舊格式（純文字）也接受。"""
    cards = []
    for item in items or []:
        if isinstance(item, str):
            item = {"text": item}
        if not isinstance(item, dict) or not str(item.get("text", "")).strip():
            continue
        cards.append({"text": str(item["text"]).strip(), "emoji": str(item.get("emoji", ""))[:4],
                      "scene": str(item.get("scene", "")), "image": ""})
    return cards[:limit]


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
    frequency = p.get("frequency", "")
    # 自訂頻率（例：TID×3天後改BID）對照不到白話說法時，保留醫師寫的原文
    parts = [f"每次 {p['dose']}" if p.get("dose") else "", FREQUENCY_TEXT.get(frequency.upper(), frequency)]
    if p.get("days"):
        parts.append(f"吃 {p['days']} 天")
    return "・".join(x for x in parts if x) or "依醫師指示服用"


def _short_product(name: str) -> str:
    """許可證品名去掉廠牌與含量，留下病人藥袋上看得到的名字（例："台裕"利敏亭膜衣錠5毫克 → 利敏亭膜衣錠）。"""
    name = re.sub(r'^\s*["“「][^"”」]*["”」]\s*', "", name or "")
    name = re.sub(r"\s*[\d０-９.．]+\s*(毫克|公絲|微克|毫升|公撮|mg|MG|mcg|%).*$", "", name).strip()
    return name if re.search(r"[\u4e00-\u9fff]", name) else ""  # 進口藥只有英文品名時，改用中文成分名


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


def _draft(topics: list[str], medicines: list[dict], audience: str, patient: dict | None = None) -> tuple[dict, dict]:
    """AI 草稿；未設定 AI 時給空白範本，醫師仍可手動完成。"""
    try:
        result, meta = ai.education_draft(topics, medicines, audience)
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    result = result or {}
    by_atc = {m.get("atc_code"): m for m in result.get("medicines", []) if isinstance(m, dict)}
    for med in medicines:
        ai_med = by_atc.get(med["atc_code"], {})
        # AI 翻的中文藥名不一定正確，有許可證品名時以品名為準
        med["name_zh"] = med["name_zh"] or _short_product(med.get("product_name", "")) or str(ai_med.get("name_zh", ""))
        med["purpose"] = str(ai_med.get("purpose", ""))
        med["tip"] = str(ai_med.get("tip", ""))
    content = {
        "version": 2,
        "main": str(result.get("main", "")) or topics[0],
        "patient": patient or {},  # 插圖人物依病人的年齡、性別畫
        "about": str(result.get("about", "")),
        "medicines": medicines,
        "care": _cards(result.get("care"), CARD_SECTIONS["care"]),
        "warnings": _cards(result.get("warnings"), CARD_SECTIONS["warnings"]),
    }
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
    patient: dict = {}
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
        patient = {"age": record["age"], "sex": record["sex"]}
        symptoms = [x["name"] for x in json.loads(record["symptoms"] or "[]") if isinstance(x, dict) and x.get("name")]
        if symptoms:
            audience = f"{audience}；本次症狀：{'、'.join(symptoms)}".lstrip("；")
    else:
        topics = [t.strip() for t in body.topics if t.strip()]
        if not topics:
            raise HTTPException(422, "請選擇衛教主題")

    draft, meta = _draft(topics, medicines, audience, patient)
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
        raise HTTPException(503 if error.status != 429 else 429, _image_error(error))
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


@router.post("/education/{sheet_id}/cards/{section}/{index}/image")
def create_card_image(sheet_id: int, section: str, index: int):
    """圖卡式衛教單：替單一重點產生插圖。前端一張一張呼叫，才能顯示進度、遇到每分鐘上限時等候重試。"""
    sheet = _get(sheet_id)
    content = sheet["content"]
    cards = content.get(section) if section in CARD_SECTIONS else None
    if not isinstance(cards, list) or not 0 <= index < len(cards) or not isinstance(cards[index], dict):
        raise HTTPException(404, "找不到這個重點")
    card = cards[index]
    scene = card.get("scene") or f"a person illustrating: {card.get('text', '')}"
    try:
        data, meta = ai.education_card_image(
            scene, topic=content.get("main") or sheet["topic"].split("、")[0],
            person=_person(content.get("patient") or {}), warning=section == "warnings",
        )
    except ImageGenerationError as error:
        raise HTTPException(429 if error.status == 429 else 503, _image_error(error))
    except OpenAIError as error:
        raise HTTPException(502, f"AI 生圖錯誤：{getattr(error, 'message', str(error))[:200]}")
    if data is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 生圖模型才能產生插圖")
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    name = f"education/{sheet_id}-{section}-{uuid.uuid4().hex[:10]}.png"
    (UPLOAD_DIR / name).write_bytes(data)
    if card.get("image") in _card_images(sheet):
        (UPLOAD_DIR / card["image"]).unlink(missing_ok=True)
    card["image"] = name
    card["scene"] = scene
    with app_db() as con:
        # 換了插圖，醫師需要重新確認
        con.execute(
            "UPDATE education_sheets SET content=?, confirmed=0, confirmed_at='', updated_at=? WHERE id=?",
            (json.dumps(content, ensure_ascii=False), now(), sheet_id),
        )
    return _get(sheet_id) | {"image_model": meta.get("model", "")}


def _person(patient: dict) -> str:
    """病人的年齡、性別轉成插圖人物描述：20 歲女性就畫年輕女性，不要畫成奶奶。"""
    try:
        age = int(re.sub(r"\D", "", str(patient.get("age", ""))) or -1)
    except ValueError:
        age = -1
    sex = str(patient.get("sex", ""))
    male, female = sex in ("男", "M", "male"), sex in ("女", "F", "female")
    if age < 0:
        who = "an adult man" if male else "an adult woman" if female else "an adult"
    elif age < 4:
        who = f"a {age}-year-old toddler{' boy' if male else ' girl' if female else ''} with a caring parent beside them"
    elif age < 13:
        who = f"a {age}-year-old {'boy' if male else 'girl' if female else 'child'}"
    elif age < 20:
        who = f"a teenage {'boy' if male else 'girl' if female else 'student'} about {age} years old"
    elif age < 40:
        who = f"a young {'man' if male else 'woman' if female else 'adult'} in their {age // 10 * 10}s"
    elif age < 65:
        who = f"a middle-aged {'man' if male else 'woman' if female else 'adult'} in their {age // 10 * 10}s"
    else:
        who = f"an elderly {'man' if male else 'woman' if female else 'person'} in their {min(age // 10 * 10, 90)}s with gray hair"
    return f"{who}, Taiwanese (East Asian)"


def _image_error(error: ImageGenerationError) -> str:
    messages = {
        404: f"Azure 上找不到生圖模型部署「{azure.image_deployment}」，請確認 Foundry 的部署名稱和 .env 的 AZURE_OPENAI_IMAGE_DEPLOYMENT 相同",
        429: "生圖太頻繁，已達每分鐘上限，請等一分鐘再試",
        400: "生圖要求被拒絕，可能是插圖描述觸發內容安全過濾，請修改後再試",
        401: "生圖模型的金鑰無效，請確認 .env 的金鑰設定",
    }
    return messages.get(error.status, f"AI 生圖錯誤（{error.status}）：{str(error)[:160]}")


def _card_images(sheet: dict) -> list[str]:
    """這份衛教單產生的插圖檔；內容由前端送回，只認本程式產生的檔名，避免刪到其他檔案。"""
    pattern = re.compile(rf"education/{sheet['id']}-(?:{'|'.join(CARD_SECTIONS)})-[0-9a-f]{{10}}\.png")
    return [c["image"] for key in CARD_SECTIONS for c in sheet["content"].get(key) or []
            if isinstance(c, dict) and isinstance(c.get("image"), str) and pattern.fullmatch(c["image"])]


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
    for path in _card_images(sheet):
        (UPLOAD_DIR / path).unlink(missing_ok=True)


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
