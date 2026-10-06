"""F-03～F-07 病歷（SOAP／POMR）、病灶偵測、用藥推薦、回饋、過敏與藥品資訊 API。"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, HTTPException, UploadFile
from openai import OpenAIError
from pydantic import BaseModel, Field

from .. import recommend as rec
from ..ai import TranscriptionError, ai
from ..db import app_db, now
from .library import AUDIO_EXTENSIONS, AUDIO_MIME_EXT, MAX_AUDIO_BYTES

router = APIRouter(prefix="/api", tags=["records"])

JSON_FIELDS = ("allergies", "conditions", "removed_conditions", "dismissed", "prescriptions", "vitals", "ai_plan")
OBJECT_FIELDS = {"vitals", "ai_plan"}
VITAL_KEYS = ("bp", "hr", "bt", "rr", "spo2")

# 練習病歷（Modified POMR）：S 主訴＋現病史、O 生命徵象＋身體檢查、每個問題各自的 A／P
SEED_RECORDS = [
    {
        "patient_code": "練習-001", "age": "35", "sex": "女", "allergies": [],
        "chief_complaint": "咳嗽兩週，有痰，晚上咳得比較厲害",
        "history": "兩週前感冒後持續咳嗽，痰白色，「晚上躺下就一直咳」。無發燒、無喘。早上常打噴嚏、流鼻水，春天容易鼻子過敏。不抽菸。",
        "vitals": {"bp": "118/76", "hr": "82", "bt": "36.8", "rr": "16", "spo2": "98"},
        "exam": "咽部輕度紅，無扁桃腺腫大；鼻黏膜蒼白水腫；雙側肺音清，無喘鳴。",
        "problems": {
            "咳嗽": ("感冒後咳嗽，無發燒、痰白、肺音清，傾向病毒感染後咳嗽，不像細菌性肺炎", "症狀治療止咳化痰；兩週後未改善或出現發燒、喘再回診"),
            "過敏性鼻炎": ("季節性症狀，鼻黏膜蒼白水腫，可能加重夜間咳嗽", "口服抗組織胺；衛教避開過敏原"),
        },
    },
    {
        "patient_code": "練習-002", "age": "68", "sex": "男", "allergies": ["penicillin"],
        "chief_complaint": "喉嚨痛三天，吞東西會痛",
        "history": "三天前開始喉嚨痛，昨天開始發燒，「吞口水都會痛」，無咳嗽。高血壓十年，規則服藥。曾對 penicillin 起疹子；三年前吃止痛藥後胃出血住院。",
        "vitals": {"bp": "146/88", "hr": "96", "bt": "38.5", "rr": "18", "spo2": "97"},
        "exam": "扁桃腺腫大有白色滲出物，前頸淋巴結腫大壓痛；無咳嗽。",
        "problems": {
            "扁桃腺炎／咽喉炎": ("發燒、扁桃腺滲出、頸部淋巴結腫大、無咳嗽，Centor 分數高，疑似細菌性", "Penicillin 過敏，需選替代抗生素；避免 NSAID（胃出血史）"),
            "高血壓": ("目前 146/88，發燒疼痛時偏高，平時控制可", "續原降壓藥；感染好轉後再量血壓"),
        },
    },
    {
        "patient_code": "練習-003", "age": "29", "sex": "女", "allergies": ["sulfonamide"],
        "chief_complaint": "小便會痛、頻尿兩天",
        "history": "兩天前開始解尿灼熱、頻尿、下腹悶痛，無發燒、無腰痛。目前懷孕 16 週。對磺胺類藥物過敏。",
        "vitals": {"bp": "112/70", "hr": "88", "bt": "37.0", "rr": "16", "spo2": "99"},
        "exam": "恥骨上輕壓痛，無肋脊角叩痛。尿液試紙：白血球酯酶陽性、亞硝酸鹽陽性。",
        "problems": {
            "尿路感染": ("懷孕中的急性膀胱炎，無發燒、無腰痛，暫無腎盂腎炎徵象", "懷孕安全的抗生素（避開磺胺類）；送尿液培養"),
        },
    },
    {
        "patient_code": "練習-004", "age": "55", "sex": "男", "allergies": [],
        "chief_complaint": "右腳大拇趾紅腫熱痛，一天",
        "history": "昨晚喝酒、吃火鍋後，半夜右腳大拇趾突然劇痛、紅腫，「被子碰到都痛」，無外傷。第二型糖尿病五年，慢性腎病第三期，過去有痛風發作兩次。",
        "vitals": {"bp": "138/86", "hr": "84", "bt": "37.2", "rr": "16", "spo2": "98"},
        "exam": "右第一蹠趾關節紅腫熱，壓痛明顯，活動受限；皮膚無傷口。",
        "problems": {
            "痛風": ("典型急性痛風發作（第三次），慢性腎病限制 NSAID 使用", "急性期止痛消炎，避開 NSAID；抽血尿酸、腎功能"),
            "第二型糖尿病": ("五年病史，本次未測血糖", "續原降血糖藥，依腎功能調整；安排 HbA1c"),
        },
    },
    {
        "patient_code": "練習-005", "age": "74", "sex": "女", "allergies": ["benzodiazepine"],
        "chief_complaint": "睡不好一個月，早上起床會頭暈",
        "history": "近一個月入睡困難、半夜容易醒，白天沒精神。早上起床時「天旋地轉」約一分鐘。高血脂服藥中。曾吃安眠藥後跌倒。",
        "vitals": {"bp": "128/78", "hr": "72", "bt": "36.5", "rr": "14", "spo2": "97"},
        "exam": "神經學檢查無局部缺損；Dix-Hallpike 右側陽性。",
        "problems": {
            "失眠": ("入睡困難與易醒一個月，年長、曾服安眠藥跌倒", "睡眠衛生衛教優先；避免 benzodiazepine"),
            "眩暈": ("姿勢改變誘發、持續短、Dix-Hallpike 陽性，疑良性陣發性姿勢性眩暈", "耳石復位術；防跌衛教"),
            "高血脂": ("服藥中，控制情形待抽血確認", "續原藥，安排血脂追蹤"),
        },
    },
]


class RecordIn(BaseModel):
    patient_code: str = Field("", max_length=30)
    age: str = Field("", max_length=10)
    sex: str = Field("", max_length=4)
    visit_date: str = Field("", max_length=10)
    allergies: list[str] = []
    chief_complaint: str = ""
    history: str = ""
    vitals: dict = {}
    exam: str = ""
    assessment: str = ""
    conditions: list[dict] = []
    removed_conditions: list[str] = []
    dismissed: list[dict] = []
    prescriptions: list[dict] = []


class TextIn(BaseModel):
    text: str


class SemanticIn(BaseModel):
    text: str
    skip: list[str] = []


class RecommendIn(BaseModel):
    conditions: list[str]
    allergies: list[str] = []
    dismissed: list[dict] = []
    text: str = ""   # S＋O＋各問題的 A，用來找病史風險（胃出血、腎功能…）
    age: str = ""


class FeedbackIn(BaseModel):
    condition: str
    atc_code: str
    action: Literal["adopt", "never"]


def _row(row) -> dict:
    data = dict(row)
    for key in JSON_FIELDS:
        data[key] = json.loads(data[key] or ("{}" if key in OBJECT_FIELDS else "[]"))
    return data


def _vitals(raw: dict) -> dict:
    return {k: str(raw.get(k, "")).strip()[:12] for k in VITAL_KEYS}


def _insert(con, data: dict) -> int:
    ts = now()
    cur = con.execute(
        """INSERT INTO records (patient_code, age, sex, visit_date, allergies, chief_complaint, history, vitals, exam,
           assessment, conditions, removed_conditions, dismissed, prescriptions, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (data.get("patient_code", ""), data.get("age", ""), data.get("sex", ""), data.get("visit_date", ts[:10]),
         json.dumps(data.get("allergies", []), ensure_ascii=False),
         data.get("chief_complaint", ""), data.get("history", ""),
         json.dumps(_vitals(data.get("vitals", {})), ensure_ascii=False), data.get("exam", ""),
         data.get("assessment", ""),
         json.dumps(data.get("conditions", []), ensure_ascii=False),
         json.dumps(data.get("removed_conditions", []), ensure_ascii=False),
         json.dumps(data.get("dismissed", []), ensure_ascii=False),
         json.dumps(data.get("prescriptions", []), ensure_ascii=False), ts, ts),
    )
    return cur.lastrowid


def seed_records() -> None:
    """第一次啟動時建立 5 筆練習病歷；舊版只有一段「評估」的病歷，把評估移到第一個問題的 A。"""
    with app_db() as con:
        if not con.execute("SELECT COUNT(*) FROM records").fetchone()[0]:
            for record in SEED_RECORDS:
                problems = record["problems"]
                text = " ".join([record["chief_complaint"], record["history"], record["exam"], *(a for a, _ in problems.values())])
                found = rec.detect_keywords(text)
                conditions = [c | {"assessment": problems[c["name"]][0], "plan": problems[c["name"]][1]}
                              for c in found if c["name"] in problems]
                fields = {k: v for k, v in record.items() if k != "problems"}
                _insert(con, fields | {"conditions": conditions,
                                       "removed_conditions": [c["name"] for c in found if c["name"] not in problems]})
        for row in con.execute("SELECT id, assessment, conditions FROM records WHERE assessment != ''").fetchall():
            conditions = json.loads(row["conditions"] or "[]")
            if conditions and not any(c.get("assessment") for c in conditions):
                conditions[0]["assessment"] = row["assessment"]
                con.execute("UPDATE records SET conditions = ?, assessment = '' WHERE id = ?",
                            (json.dumps(conditions, ensure_ascii=False), row["id"]))


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
            """UPDATE records SET patient_code=?, age=?, sex=?, visit_date=?, allergies=?, chief_complaint=?, history=?,
               vitals=?, exam=?, assessment=?, conditions=?, removed_conditions=?, dismissed=?, prescriptions=?, updated_at=?
               WHERE id=?""",
            (data.patient_code, data.age, data.sex, data.visit_date, json.dumps(data.allergies, ensure_ascii=False),
             data.chief_complaint, data.history, json.dumps(_vitals(data.vitals), ensure_ascii=False), data.exam,
             data.assessment,
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
        # 衛教單保留，只是不再連到已刪除的病歷
        con.execute("UPDATE education_sheets SET record_id = NULL WHERE record_id = ?", (record_id,))


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


@router.post("/detect/semantic")
def detect_semantic(body: SemanticIn):
    """語意相近的「可能病灶」：關鍵字沒對到時的補充建議，不自動加入。"""
    try:
        return {"conditions": rec.semantic_candidates(body.text, set(body.skip))}
    except OpenAIError:
        return {"conditions": []}


# ---------- SOAP：語音、AI 參考計畫、完成與英文版 ----------

def _chart(record: dict) -> dict:
    """整理給 AI 的病歷內容（Modified POMR），處方依問題歸類。"""
    allergy_names = {a["id"]: a["name"] for a in rec.allergens()}
    rx_by_problem: dict[str, list[str]] = {}
    for p in record["prescriptions"]:
        line = " ".join(x for x in (p.get("display_name") or p.get("name_en", ""), p.get("frequency", ""),
                                    f"{p['days']} days" if p.get("days") else "") if x)
        rx_by_problem.setdefault(p.get("condition") or "", []).append(line)
    return {
        "visit_date": record["visit_date"], "patient_code": record["patient_code"],
        "age": record["age"], "sex": record["sex"],
        "allergies": [allergy_names.get(a, a.removeprefix("atc:")) for a in record["allergies"]],
        "S": {"chief_complaint": record["chief_complaint"], "history": record["history"]},
        "O": {"vitals": record["vitals"], "exam": record["exam"]},
        "problems": [{"no": i, "name": c["name"], "icd10_cm": c.get("icd10", ""), "A": c.get("assessment", ""),
                      "P": c.get("plan", ""), "prescriptions": rx_by_problem.get(c["name"], [])}
                     for i, c in enumerate(record["conditions"], 1)],
        "other_prescriptions": rx_by_problem.get("", []),
    }


def _ai_error(error: OpenAIError) -> HTTPException:
    return HTTPException(502, f"AI 服務錯誤：{getattr(error, 'message', str(error))[:200]}")


@router.post("/records/voice")
async def voice_to_soap(file: UploadFile = File(...)):
    """看診錄音 → 逐字稿 → AI 依 SOAP 分段。錄音只用來轉文字，處理完立即刪除，不保存。"""
    mime = (file.content_type or "").split(";")[0].strip()
    ext = AUDIO_MIME_EXT.get(mime) or next((e for e in AUDIO_EXTENSIONS if (file.filename or "").lower().endswith(e)), None)
    if not ext:
        raise HTTPException(415, "只接受 mp3、m4a、wav、webm 或 mp4 音檔")
    content = await file.read()
    if not content:
        raise HTTPException(422, "音檔是空的，請重新錄音")
    if len(content) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "音檔不可超過 25MB（約 20 分鐘以內的錄音）")
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / f"visit{ext}"
        path.write_bytes(content)
        try:
            transcript, _ = ai.transcribe(path)
        except TranscriptionError as error:
            raise HTTPException(502, str(error))
        except OpenAIError as error:
            raise _ai_error(error)
    if transcript is None:
        raise HTTPException(503, "語音辨識尚未設定（需要 AZURE_SPEECH_MODEL），請改用手動輸入")
    if not transcript.strip():
        raise HTTPException(422, "沒有辨識到語音內容，請確認麥克風或音檔")
    try:
        soap, meta = ai.soap_from_transcript(transcript, [c["name"] for c in rec.conditions()])
    except OpenAIError as error:
        raise _ai_error(error)
    if soap is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能把逐字稿整理成 SOAP")
    problems = []
    for item in soap.get("problems", []):
        name = str(item.get("name", "")).strip()[:40]
        if not name:
            continue
        cond = rec.condition_by_name(name)
        if not cond:  # AI 沒用清單名稱時，再用關鍵字對一次（例：急性扁桃腺炎 → 扁桃腺炎／咽喉炎）
            hits = rec.detect_keywords(name)
            cond = rec.condition_by_name(hits[0]["name"]) if len(hits) == 1 else None
        if cond and any(p["name"] == cond["name"] for p in problems):
            continue
        problems.append({"name": cond["name"] if cond else name, "icd10": cond["icd10"] if cond else "",
                         "custom": cond is None, "assessment": str(item.get("assessment", "")),
                         "plan": str(item.get("plan", ""))})
    return {
        "transcript": transcript,
        "soap": {
            "chief_complaint": str(soap.get("chief_complaint", "")), "history": str(soap.get("history", "")),
            "vitals": _vitals(soap.get("vitals") or {}), "exam": str(soap.get("exam", "")), "problems": problems,
        },
        "ai_meta": meta,
    }


@router.post("/records/{record_id}/ai-plan")
def ai_plan(record_id: int):
    """AI 參考計畫：依目前的 S、O、各問題的 A 產生，存起來供醫師對照（前端預設遮蔽）。"""
    record = get_record(record_id)
    if not record["conditions"]:
        raise HTTPException(422, "請先建立至少一個問題，AI 才能依問題寫計畫")
    try:
        result, meta = ai.plan_suggestions(_chart(record))
    except OpenAIError as error:
        raise _ai_error(error)
    if result is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能產生 AI 計畫")
    keys = ("diagnostic", "therapeutic", "educational", "follow_up", "consult")
    plan = {
        "problems": [{"name": str(p.get("name", ""))} | {k: str(p.get(k, "")) for k in keys}
                     for p in result.get("problems", []) if isinstance(p, dict)],
        "basis": [c["name"] for c in record["conditions"]],
        "model": meta["model"], "generated_at": meta["generated_at"],
    }
    with app_db() as con:
        con.execute("UPDATE records SET ai_plan = ? WHERE id = ?", (json.dumps(plan, ensure_ascii=False), record_id))
    return plan


@router.post("/records/{record_id}/complete")
def complete_record(record_id: int):
    """完成病歷：同時產生英文 SOAP。完成後再修改，前端會提示英文版需要更新。"""
    record = get_record(record_id)
    if not (record["chief_complaint"].strip() or record["conditions"]):
        raise HTTPException(422, "病歷還是空的，請先寫主訴或問題")
    try:
        result, _ = ai.english_note(_chart(record))
    except OpenAIError as error:
        raise _ai_error(error)
    if result is None:
        raise HTTPException(503, "需要設定 Azure OpenAI 才能產生英文版")
    stamp = now()
    with app_db() as con:
        con.execute("UPDATE records SET english_note = ?, completed_at = ?, updated_at = ? WHERE id = ?",
                    (str(result.get("note", "")).strip(), stamp, stamp, record_id))
    return get_record(record_id)


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
