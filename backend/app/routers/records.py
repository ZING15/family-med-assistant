"""F-03～F-07 病歷、病灶偵測、用藥推薦、回饋、過敏與藥品資訊 API。"""

from __future__ import annotations

import json
from typing import Literal

from fastapi import APIRouter, HTTPException
from openai import OpenAIError
from pydantic import BaseModel, Field

from .. import recommend as rec
from ..ai import ai
from ..db import app_db, now

router = APIRouter(prefix="/api", tags=["records"])

JSON_FIELDS = ("allergies", "conditions", "removed_conditions", "dismissed", "prescriptions")
SEED_RECORDS = [
    {
        "patient_code": "練習-001", "age": "35", "sex": "女", "allergies": [],
        "chief_complaint": "咳嗽兩週，有痰，夜間較嚴重",
        "history": "兩週前感冒後持續咳嗽，痰白色，無發燒、無喘。偶爾打噴嚏、流鼻水，春天容易鼻子過敏。不抽菸。",
        "assessment": "感冒後咳嗽，合併過敏性鼻炎",
    },
    {
        "patient_code": "練習-002", "age": "62", "sex": "男", "allergies": ["penicillin", "nsaid"],
        "chief_complaint": "喉嚨痛三天，吞嚥疼痛",
        "history": "三天前開始喉嚨痛，昨天開始發燒 38.5 度，無咳嗽。高血壓病史十年，規則服藥。曾對 penicillin 起疹子，吃止痛藥曾胃出血。",
        "assessment": "急性咽喉炎；高血壓控制中",
    },
    {
        "patient_code": "練習-003", "age": "8", "sex": "男", "allergies": [],
        "chief_complaint": "全身起紅疹、很癢，一天",
        "history": "昨晚吃海鮮後全身出現風疹塊，抓了會更多，無喘、無嘴唇腫。過去有異位性皮膚炎。",
        "assessment": "急性蕁麻疹",
    },
]


class RecordIn(BaseModel):
    patient_code: str = Field("", max_length=30)
    age: str = Field("", max_length=10)
    sex: str = Field("", max_length=4)
    allergies: list[str] = []
    chief_complaint: str = ""
    history: str = ""
    assessment: str = ""
    conditions: list[dict] = []
    removed_conditions: list[str] = []
    dismissed: list[dict] = []
    prescriptions: list[dict] = []


class TextIn(BaseModel):
    text: str


class RecommendIn(BaseModel):
    conditions: list[str]
    allergies: list[str] = []
    dismissed: list[dict] = []
    text: str = ""   # 主訴＋病史＋評估，用來找病史風險（胃出血、腎功能…）
    age: str = ""


class FeedbackIn(BaseModel):
    condition: str
    atc_code: str
    action: Literal["adopt", "never"]


def _row(row) -> dict:
    data = dict(row)
    for key in JSON_FIELDS:
        data[key] = json.loads(data[key] or "[]")
    return data


def _insert(con, data: dict) -> int:
    ts = now()
    cur = con.execute(
        """INSERT INTO records (patient_code, age, sex, allergies, chief_complaint, history, assessment,
           conditions, removed_conditions, dismissed, prescriptions, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.get("patient_code", ""), data.get("age", ""), data.get("sex", ""),
         json.dumps(data.get("allergies", []), ensure_ascii=False),
         data.get("chief_complaint", ""), data.get("history", ""), data.get("assessment", ""),
         json.dumps(data.get("conditions", []), ensure_ascii=False),
         json.dumps(data.get("removed_conditions", []), ensure_ascii=False),
         json.dumps(data.get("dismissed", []), ensure_ascii=False),
         json.dumps(data.get("prescriptions", []), ensure_ascii=False), ts, ts),
    )
    return cur.lastrowid


def seed_records() -> None:
    """第一次啟動時建立 3 筆練習病歷。"""
    with app_db() as con:
        if con.execute("SELECT COUNT(*) FROM records").fetchone()[0]:
            return
        for record in SEED_RECORDS:
            text = " ".join([record["chief_complaint"], record["history"], record["assessment"]])
            _insert(con, {**record, "conditions": rec.detect_keywords(text)})


# ---------- 對照資料 ----------

@router.get("/catalog")
def catalog():
    return {
        "conditions": [{"name": c["name"], "icd10": c["icd10"], "chronic": c.get("chronic", False)} for c in rec.conditions()],
        "allergens": [{"id": a["id"], "name": a["name"]} for a in rec.allergens()],
    }


# ---------- 病歷 ----------

@router.get("/records")
def list_records():
    with app_db() as con:
        rows = con.execute("SELECT * FROM records ORDER BY updated_at DESC").fetchall()
    return {"records": [_row(r) for r in rows]}


@router.post("/records", status_code=201)
def create_record():
    with app_db() as con:
        n = con.execute("SELECT COUNT(*) FROM records").fetchone()[0]
        record_id = _insert(con, {"patient_code": f"練習-{n + 1:03d}"})
    return get_record(record_id)


@router.get("/records/{record_id}")
def get_record(record_id: int):
    with app_db() as con:
        row = con.execute("SELECT * FROM records WHERE id = ?", (record_id,)).fetchone()
    if not row:
        raise HTTPException(404, "找不到這份病歷")
    return _row(row)


@router.put("/records/{record_id}")
def update_record(record_id: int, data: RecordIn):
    get_record(record_id)
    with app_db() as con:
        con.execute(
            """UPDATE records SET patient_code=?, age=?, sex=?, allergies=?, chief_complaint=?, history=?,
               assessment=?, conditions=?, removed_conditions=?, dismissed=?, prescriptions=?, updated_at=?
               WHERE id=?""",
            (data.patient_code, data.age, data.sex, json.dumps(data.allergies, ensure_ascii=False),
             data.chief_complaint, data.history, data.assessment,
             json.dumps(data.conditions, ensure_ascii=False),
             json.dumps(data.removed_conditions, ensure_ascii=False),
             json.dumps(data.dismissed, ensure_ascii=False),
             json.dumps(data.prescriptions, ensure_ascii=False), now(), record_id),
        )
    return get_record(record_id)


@router.delete("/records/{record_id}", status_code=204)
def delete_record(record_id: int):
    get_record(record_id)
    with app_db() as con:
        con.execute("DELETE FROM records WHERE id = ?", (record_id,))


# ---------- 病灶偵測 ----------

@router.post("/detect")
def detect(body: TextIn):
    return {"conditions": rec.detect_keywords(body.text),
            "risks": [r["id"] for r in rec.detect_risks(body.text)]}


@router.post("/detect/ai")
def detect_ai(body: TextIn):
    if not body.text.strip():
        return {"conditions": [], "other": []}
    names = [c["name"] for c in rec.conditions()]
    try:
        result, meta = ai.extract_conditions(body.text, names)
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    if result is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能使用 AI 偵測")
    found = []
    for item in result.get("conditions", []):
        cond = rec.condition_by_name(str(item.get("name", "")))
        if cond and cond["name"] not in {f["name"] for f in found}:
            found.append({"name": cond["name"], "source": "ai", "matched": str(item.get("evidence", ""))[:60], "icd10": cond["icd10"]})
    return {"conditions": found, "other": [str(o) for o in result.get("other", [])][:5], "ai_meta": meta}


# ---------- 推薦與回饋 ----------

@router.post("/recommendations")
def recommendations(body: RecommendIn):
    return rec.recommend(body.conditions, body.allergies, body.dismissed, body.text, body.age)


@router.post("/feedback", status_code=201)
def add_feedback(body: FeedbackIn):
    with app_db() as con:
        if body.action == "never":
            con.execute("DELETE FROM drug_feedback WHERE condition=? AND atc_code=? AND action='never'", (body.condition, body.atc_code))
        con.execute(
            "INSERT INTO drug_feedback (condition, atc_code, action, created_at) VALUES (?,?,?,?)",
            (body.condition, body.atc_code, body.action, now()),
        )
    return {"ok": True}


@router.delete("/feedback")
def remove_feedback(condition: str, atc_code: str, action: str = "never"):
    """復原「此病灶不再推薦」；action=adopt 時只撤回最近一次採用（採用後按「復原」）。"""
    with app_db() as con:
        if action == "adopt":
            cur = con.execute(
                """DELETE FROM drug_feedback WHERE rowid = (SELECT rowid FROM drug_feedback
                   WHERE condition=? AND atc_code=? AND action='adopt' ORDER BY created_at DESC LIMIT 1)""",
                (condition, atc_code),
            )
        else:
            cur = con.execute(
                "DELETE FROM drug_feedback WHERE condition=? AND atc_code=? AND action=?", (condition, atc_code, action)
            )
    return {"removed": cur.rowcount}


@router.get("/feedback")
def list_feedback():
    with app_db() as con:
        rows = con.execute("SELECT * FROM drug_feedback WHERE action='never' ORDER BY created_at DESC").fetchall()
    return {"never": [dict(r) | {"name_en": rec.drug_name(r["atc_code"])} for r in rows]}


# ---------- 藥品 ----------

@router.get("/drugs/search")
def drug_search(q: str):
    if len(q.strip()) < 2:
        return {"results": []}
    return {"results": rec.search_drugs(q)}


@router.get("/drugs/{atc_code}")
def drug_detail(atc_code: str):
    detail = rec.concept_detail(atc_code)
    if not detail:
        raise HTTPException(404, "找不到這個藥品成分")
    with app_db() as con:
        cached = con.execute("SELECT * FROM drug_summaries WHERE atc_code = ?", (atc_code,)).fetchone()
    detail["summary"] = json.loads(cached["summary"]) if cached else None
    detail["summary_meta"] = {"model": cached["model"], "generated_at": cached["generated_at"]} if cached else None
    return detail


@router.post("/drugs/{atc_code}/summary")
def drug_summary(atc_code: str):
    """AI 白話簡介；已產生過就直接回傳快取，不重複呼叫。"""
    with app_db() as con:
        cached = con.execute("SELECT * FROM drug_summaries WHERE atc_code = ?", (atc_code,)).fetchone()
    if cached:
        return {"summary": json.loads(cached["summary"]), "summary_meta": {"model": cached["model"], "generated_at": cached["generated_at"]}, "cached": True}
    detail = rec.concept_detail(atc_code)
    if not detail:
        raise HTTPException(404, "找不到這個藥品成分")
    try:
        summary, meta = ai.drug_summary(detail)
    except OpenAIError as error:
        raise HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")
    if summary is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能產生藥品簡介")
    with app_db() as con:
        con.execute(
            "INSERT OR REPLACE INTO drug_summaries (atc_code, summary, model, generated_at) VALUES (?,?,?,?)",
            (atc_code, json.dumps(summary, ensure_ascii=False), meta["model"], meta["generated_at"]),
        )
    return {"summary": summary, "summary_meta": {"model": meta["model"], "generated_at": meta["generated_at"]}, "cached": False}
