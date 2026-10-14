"""
F-03～F-06 病灶偵測與用藥推薦。

推薦分數 = 類別優先（對照表中越前面越常用） + 常見首選成分加分 + 醫師回饋（曾在此病灶採用加分）
         + 市售品項數（TFDA 有效許可證數，代表可取得性）
病史風險（risk_flags.json）只在卡片加提醒，不影響排序、不排除。
排除：過敏原對應的 ATC 類別、醫師標記「此病灶不再推薦」、本次病歷「這次不用」。
"""

from __future__ import annotations

import json
import math
import re
from collections import Counter
from functools import lru_cache
from pathlib import Path

from . import nhi
from .db import app_db, drug_db

DATA_DIR = Path(__file__).parent / "data"
ROW_LIMIT = 12
SYMPTOM_LIMIT = 4   # 症狀列：每個症狀只取最常用的前幾名

# 推薦範圍：有效、製劑、需要醫師處方或指示的藥品
CATEGORIES = {
    "須由醫師處方使用": "rx", "限由醫師使用": "rx",
    "醫師藥師藥劑生指示藥品": "otc", "須經醫師指示使用": "otc", "成藥": "general", "乙類成藥": "general",
}
FORM_GROUPS = [
    ("injection", ("注射",)),
    ("inhaler", ("吸入", "噴霧", "噴液")),
    ("eye", ("點眼", "眼用", "眼藥")),
    ("topical", ("軟膏", "乳膏", "凝膠", "外用", "貼", "乳液", "洗劑", "膏")),
    ("liquid", ("液", "糖漿", "懸", "顆粒", "散", "粉", "乳劑")),
    ("oral", ("錠", "膠囊", "丸")),
]
FORM_LABEL = {"oral": "錠劑／膠囊", "liquid": "口服液／顆粒", "topical": "外用", "inhaler": "吸入／噴劑",
              "eye": "眼用", "injection": "注射", "other": "其他"}
NEGATION = re.compile(r"(無|沒有|否認|未有|不|denies|denied|no)\s*$", re.IGNORECASE)


@lru_cache
def conditions() -> list[dict]:
    return json.loads((DATA_DIR / "conditions.json").read_text(encoding="utf-8"))["conditions"]


@lru_cache
def allergens() -> list[dict]:
    return json.loads((DATA_DIR / "allergens.json").read_text(encoding="utf-8"))["allergens"]


@lru_cache
def risk_flags() -> list[dict]:
    return json.loads((DATA_DIR / "risk_flags.json").read_text(encoding="utf-8"))["flags"]


@lru_cache
def atc_labels() -> dict:
    return json.loads((DATA_DIR / "atc_classes.json").read_text(encoding="utf-8"))


def _longest_prefix(table: dict, atc: str) -> str:
    keys = [k for k in table if atc.startswith(k)]
    return table[max(keys, key=len)] if keys else ""


def class_zh(atc: str, fallback: str = "") -> str:
    """推薦卡的中文藥理類別：先查人工對照表，查不到才用 TFDA AHFS 推論的分類。"""
    return _longest_prefix(atc_labels()["classes"], atc) or fallback


def display_name(atc: str, name_en: str) -> str:
    """ATC 的「combinations」「OTHER …」這類名稱改成醫師看得懂的寫法；一般成分維持英文學名。"""
    if atc in atc_labels()["names"]:
        return atc_labels()["names"][atc]
    lowered = name_en.lower().strip()
    if lowered in ("combinations", "various combinations"):
        return f"{class_zh(atc) or '其他'}複方"
    if lowered == "various":
        return f"{class_zh(atc) or '其他藥品'}（多成分）"
    for suffix, label in ((", combinations with psycholeptics", " 複方（含鎮靜成分）"),
                          (", combinations excl. psycholeptics", " 複方"), (", combinations", " 複方")):
        if lowered.endswith(suffix):
            return name_en[: -len(suffix)] + label
    name = name_en.capitalize() if name_en.isupper() else name_en
    # 同一成分常有口服與外用等不同給藥途徑（例：diclofenac），把途徑寫進名稱
    route = next((label for prefix, label in ROUTES if atc.startswith(prefix)), "")
    return f"{name} {route}" if route else name


# ATC 前綴 → 給藥途徑
ROUTES = [("M02", "外用"), ("D", "外用"), ("S01", "眼用"), ("S02", "耳用"), ("R01A", "鼻用"),
          ("R03A", "吸入"), ("R03B", "吸入"), ("A01", "口內用"), ("G01", "陰道用"), ("R02", "含片")]
SALTS = {"HCL", "HYDROCHLORIDE", "MALEATE", "HYDROBROMIDE", "HBR", "ANHYDROUS", "DEHYDRATE", "DIHYDRATE",
         "MONOHYDRATE", "TRIHYDRATE", "MONONITRATE", "NITRATE", "CITRATE", "SULFATE", "SULPHATE", "PHOSPHATE",
         "TARTRATE", "BITARTRATE", "BESYLATE", "MESYLATE", "FUMARATE", "SUCCINATE", "ACETATE", "SODIUM",
         "POTASSIUM", "BROMIDE", "CHLORIDE", "MICRONIZED", "USP", "BP"}


def ingredient_name(raw: str) -> str:
    """TFDA 成分欄位轉成簡短學名：去掉括號註記與鹽類（ACETAMINOPHEN (EQ TO PARACETAMOL) → paracetamol）。"""
    text = raw.strip()
    eq = re.search(r"\(EQ\.? TO ([^)]+)\)", text, re.IGNORECASE)
    if eq:
        text = eq.group(1)
    text = re.sub(r"\(.*?\)", "", text).strip()
    words = text.split()
    while len(words) > 1 and words[-1].upper().strip(".,") in SALTS:
        words.pop()
    return " ".join(words).lower()


@lru_cache
def symptoms() -> list[dict]:
    return json.loads((DATA_DIR / "symptoms.json").read_text(encoding="utf-8"))["symptoms"]


def condition_by_name(name: str) -> dict | None:
    return next((c for c in conditions() if c["name"] == name), None)


def symptom_by_name(name: str) -> dict | None:
    return next((s for s in symptoms() if s["name"] == name), None)


def form_group(form: str) -> str:
    return next((group for group, words in FORM_GROUPS if any(w in form for w in words)), "other")


# ---------- 病灶偵測 ----------

def _normalize(text: str) -> str:
    """「痠」「酸」混用很常見（肌肉痠痛／酸痛），比對前統一成「酸」。"""
    return text.lower().replace("痠", "酸")


def _excluded(text: str, index: int, length: int, phrases: list[str]) -> bool:
    """命中的位置若落在較長的排除詞裡（例：「骨頭痛」中的「頭痛」），就不算。"""
    for phrase in phrases:
        phrase = _normalize(phrase)
        start = 0
        while (pos := text.find(phrase, start)) != -1:
            if pos <= index and index + length <= pos + len(phrase):
                return True
            start = pos + 1
    return False


def _word_ok(text: str, index: int, needle: str) -> bool:
    """英文關鍵字要對在字首（URI 不可對到 dysuria、pruritus）；4 個字母以內的短縮寫也要對在字尾。中文不受影響。"""
    if needle[:1].isascii() and needle[:1].isalpha() and index > 0 and text[index - 1].isascii() and text[index - 1].isalnum():
        return False
    end = index + len(needle)
    if len(needle) <= 4 and needle[-1:].isascii() and needle[-1:].isalpha() and end < len(text) \
            and text[end].isascii() and text[end].isalpha():
        return False
    return True


def detect_keywords(text: str) -> list[dict]:
    """以關鍵字比對病灶；關鍵字前方 4 字內有否定詞（無、否認…）時不算。"""
    found = []
    lowered = _normalize(text)
    for cond in conditions():
        for alias in cond["aliases"]:
            needle = _normalize(alias)
            start = 0
            hit = None
            while (index := lowered.find(needle, start)) != -1:
                before = lowered[max(0, index - 4):index]
                if _word_ok(lowered, index, needle) and not NEGATION.search(before) \
                        and not _excluded(lowered, index, len(needle), cond.get("exclude", [])):
                    hit = alias
                    break
                start = index + len(needle)
            if hit:
                found.append({"name": cond["name"], "source": "keyword", "matched": hit, "icd10": cond["icd10"]})
                break
    return found


# 英文句點也斷句（避開 38.5 這類小數）；別人的症狀或接觸史（同學發燒、sick contact）不算病人本人的症狀
SENTENCE_DOT = re.compile(r"(?<!\d)\.(?!\d)")
OTHER_PERSON = re.compile(r"(家人|家裡|同學|同事|室友|小孩|孩子|兒子|女兒|太太|先生|老公|老婆|爸爸|媽媽|父親|母親|有人|"
                          r"哥哥|姐姐|姊姊|弟弟|妹妹|兄弟|姊妹|姐妹|阿公|阿嬤|爺爺|奶奶|外公|外婆|"
                          r"\b(?:contact|exposure|family|classmates?|colleagues?|roommates?|sons?|daughters?|wife|husband|brothers?|sisters?|siblings?)\b)", re.IGNORECASE)


def detect_symptoms(text: str) -> list[dict]:
    """從 S（主訴＋現病史）找症狀，給推薦藥品補上對症用藥；不加入問題清單。
    逐句比對：整句是否定（no rhinorrhea、無發燒、denies fever）不算，關鍵字前方 4 字內有否定詞也不算。"""
    found = []
    pieces = [c for part in CLAUSE_SPLIT.split(_normalize(text)) for c in SENTENCE_DOT.split(part)]
    clauses = [c for c in pieces if c.strip() and not NEGATED_CLAUSE.search(c)]
    for symptom in symptoms():
        hit = None
        for alias in symptom["aliases"]:
            needle = _normalize(alias)
            for clause in clauses:
                start = 0
                while (index := clause.find(needle, start)) != -1:
                    if _word_ok(clause, index, needle) and not NEGATION.search(clause[max(0, index - 4):index]) \
                            and not OTHER_PERSON.search(clause[:index]) \
                            and not _excluded(clause, index, len(needle), symptom.get("exclude", [])):
                        hit = alias
                        break
                    start = index + len(needle)
                if hit:
                    break
            if hit:
                break
        if hit:
            found.append({"name": symptom["name"], "source": "keyword", "matched": hit})
    return found


# 語意偵測：關鍵字沒對到、但意思相近的句子（例：「小便灼熱、跑廁所很多次」→ 尿路感染）。
# 病歷逐句轉成向量，與每個病灶（名稱＋關鍵字）比較；否定句不算。結果只當「可能」，由醫師決定是否加入。
CLAUSE_SPLIT = re.compile(r"[。，,；;、\n！？!?]+")
NEGATED_CLAUSE = re.compile(r"^\s*(無|沒有|沒|否認|未|不|denies|denied|deny|without|negative for|no\b)", re.IGNORECASE)
SEMANTIC_THRESHOLD = 0.7   # 實測：相符的描述多在 0.7 以上，無關句子約 0.6 以下
_condition_vectors: list[tuple[dict, list[float]]] = []   # 每個病灶有多句描述，一句一個向量
_clause_vectors: dict[str, list[float]] = {}


@lru_cache
def condition_descriptions() -> dict[str, list[str]]:
    return json.loads((DATA_DIR / "condition_semantics.json").read_text(encoding="utf-8"))["descriptions"]


def semantic_candidates(text: str, skip: set[str]) -> list[dict]:
    """回傳語意相近、尚未在問題清單裡的病灶，依相似度排序；未設定 Embedding 時回傳空清單。"""
    from .ai import ai, cosine  # 避免循環匯入

    if not ai.embedding_ready:
        return []
    global _condition_vectors
    if not _condition_vectors:
        pairs = [(c, d) for c in conditions() for d in condition_descriptions().get(c["name"], [c["name"]])]
        vectors = ai.embed_many([d for _, d in pairs]) or []
        _condition_vectors = [(c, v) for (c, _), v in zip(pairs, vectors)]
    clauses = []
    for clause in CLAUSE_SPLIT.split(text):
        clause = clause.strip()
        if len(clause) >= 2 and not NEGATED_CLAUSE.search(clause) and clause not in clauses:
            clauses.append(clause)
    clauses = clauses[:40]
    missing = [c for c in clauses if c not in _clause_vectors]
    if missing:
        if len(_clause_vectors) > 2000:
            _clause_vectors.clear()
        for clause, vector in zip(missing, ai.embed_many(missing) or []):
            _clause_vectors[clause] = vector
    best: dict[str, dict] = {}
    for clause in clauses:
        vector = _clause_vectors.get(clause)
        if not vector:
            continue
        for cond, cond_vector in _condition_vectors:
            if cond["name"] in skip:
                continue
            score = cosine(vector, cond_vector)
            if score >= SEMANTIC_THRESHOLD and score > best.get(cond["name"], {}).get("score", 0):
                best[cond["name"]] = {"name": cond["name"], "source": "semantic", "matched": clause,
                                      "icd10": cond["icd10"], "score": round(score, 3)}
    return sorted(best.values(), key=lambda c: -c["score"])[:3]


# ---------- 過敏 ----------

def allergy_rules(allergy_ids: list[str]) -> list[dict]:
    """把病人的過敏紀錄轉成排除規則：過敏原 → ATC 前綴；個別藥品（atc:CODE）→ 該成分。"""
    rules = []
    lookup = {a["id"]: a for a in allergens()}
    for entry in allergy_ids:
        if entry.startswith("atc:"):
            code = entry[4:]
            rules.append({"label": f"{drug_name(code)}（個別藥品）", "prefixes": [code], "class_prefix": code[:5]})
        elif entry in lookup:
            rules.append({"label": lookup[entry]["name"], "prefixes": lookup[entry]["atc"], "class_prefix": ""})
    return rules


def allergy_hit(atc: str, rules: list[dict]) -> tuple[str, str]:
    """回傳 (排除原因, 同類警示)。"""
    for rule in rules:
        if any(atc.startswith(p) for p in rule["prefixes"]):
            return rule["label"], ""
    for rule in rules:
        if rule["class_prefix"] and atc.startswith(rule["class_prefix"]):
            return "", f"與過敏藥品 {rule['label'].split('（')[0]} 同類，請留意"
    return "", ""


# ---------- 藥品資料 ----------

def _category_sql() -> str:
    return ",".join(f"'{c}'" for c in CATEGORIES)


@lru_cache(maxsize=512)
def concepts_for_prefix(prefix: str) -> tuple[dict, ...]:
    """某 ATC 前綴底下的成分，彙整有效製劑的品項數、劑型與外觀圖。"""
    with drug_db() as con:
        rows = con.execute(
            f"""SELECT atc_main, atc_main_name_en, ahfs_main_name_zh, ahfs_confidence, drug_category, dosage_form,
                       image_url, name_zh, indication, license_no, ingredients
                FROM products
                WHERE is_active = 1 AND license_type LIKE '製%' AND atc_main LIKE ?
                  AND drug_category IN ({_category_sql()})""",
            (prefix + "%",),
        ).fetchall()
    grouped: dict[str, dict] = {}
    for r in rows:
        c = grouped.setdefault(r["atc_main"], {
            "atc_code": r["atc_main"], "name_en": r["atc_main_name_en"], "class_zh": "",
            "product_count": 0, "categories": set(), "forms": {}, "image_url": "", "sample_name": "",
            "indication": "", "licenses": [], "_ingredients": Counter(),
        })
        parts = [p for p in (r["ingredients"] or "").split(";;") if p.strip()]
        if len(parts) > 1:
            c["_ingredients"].update({ingredient_name(p) for p in parts})
        c["product_count"] += 1
        c["licenses"].append(r["license_no"])
        c["categories"].add(CATEGORIES[r["drug_category"]])
        group = form_group(r["dosage_form"] or "")
        c["forms"][group] = c["forms"].get(group, 0) + 1
        # 由 ATC 推論的 AHFS 分類，只採用信心 ≥ 0.8 的，避免顯示錯誤分類
        if r["ahfs_main_name_zh"] and float(r["ahfs_confidence"] or 0) >= 0.8:
            c["class_zh"] = c["class_zh"] or r["ahfs_main_name_zh"]
        if not c["image_url"] and r["image_url"]:
            c["image_url"] = r["image_url"]
            c["sample_name"] = r["name_zh"]
        c["sample_name"] = c["sample_name"] or r["name_zh"]
        c["indication"] = c["indication"] or (r["indication"] or "")
    # 缺中文分類的成分，沿用同一 ATC 第四層（化學分類）其他成分的分類名稱
    class_by_l4 = {}
    for c in grouped.values():
        if c["class_zh"]:
            class_by_l4.setdefault(c["atc_code"][:5], c["class_zh"])
    result = []
    for c in grouped.values():
        c["class_zh"] = c["class_zh"] or class_by_l4.get(c["atc_code"][:5], "")
        c["categories"] = sorted(c["categories"])
        c["nhi"] = nhi.summarize(c.pop("licenses"))
        # 複方：列出最常出現的成分（各市售品項配方不同，取前 4 個）
        c["components"] = [name for name, _ in c.pop("_ingredients").most_common(4)]
        c["forms"] = [{"group": g, "label": FORM_LABEL[g], "count": n}
                      for g, n in sorted(c["forms"].items(), key=lambda kv: -kv[1])]
        result.append(c)
    return tuple(result)


@lru_cache(maxsize=2048)
def drug_name(atc: str) -> str:
    with drug_db() as con:
        row = con.execute("SELECT name_en FROM concepts WHERE atc_code = ?", (atc,)).fetchone()
    return row["name_en"] if row else atc


def concept_detail(atc: str) -> dict | None:
    with drug_db() as con:
        concept = con.execute("SELECT * FROM concepts WHERE atc_code = ?", (atc,)).fetchone()
        if not concept:
            return None
        products = con.execute(
            f"""SELECT license_no, name_zh, name_en, dosage_form, drug_category, ingredients, indication,
                       applicant, manufacturers, image_url, shape, color, marking
                FROM products
                WHERE is_active = 1 AND license_type LIKE '製%' AND atc_main = ?
                  AND drug_category IN ({_category_sql()})
                ORDER BY image_url = '', name_zh""",
            (atc,),
        ).fetchall()
    data = dict(concept)
    data["display_name"] = display_name(atc, data["name_en"])
    if any(w in data["name_en"].lower() for w in ("combination", "various", "cold preparations")):
        counts = Counter(name for p in products for name in
                         {ingredient_name(x) for x in (p["ingredients"] or "").split(";;") if x.strip()})
        data["components"] = [name for name, _ in counts.most_common(6)]
    else:
        data["components"] = []
    data["class_zh"] = class_zh(atc, data["ahfs_main_name_zh"] or "")
    data["products"] = [dict(p) | {"category": CATEGORIES[p["drug_category"]], "form_group": form_group(p["dosage_form"] or ""),
                                   "nhi": nhi.for_license(p["license_no"])}
                        for p in products]
    # 健保給付的品項排前面（同樣有給付時，維持有外觀圖的優先）
    data["products"].sort(key=lambda p: not p["nhi"])
    data["nhi"] = nhi.summarize([p["license_no"] for p in data["products"]])
    data["nhi_as_of"] = nhi.as_of()
    data["class_path"] = [data["atc_l1"], data["atc_l2"], data["atc_l3"], data["atc_l4"], atc]
    return data


def search_drugs(query: str, limit: int = 15) -> list[dict]:
    q = f"%{query.strip()}%"
    with drug_db() as con:
        rows = con.execute(
            f"""SELECT atc_main AS atc_code, MAX(atc_main_name_en) AS name_en, MAX(ahfs_main_name_zh) AS class_zh,
                       COUNT(*) AS product_count, MAX(name_zh) AS sample_name, GROUP_CONCAT(license_no) AS licenses
                FROM products
                WHERE is_active = 1 AND license_type LIKE '製%' AND atc_main != ''
                  AND drug_category IN ({_category_sql()})
                  AND (atc_main_name_en LIKE ? OR name_zh LIKE ? OR name_en LIKE ? OR ingredients LIKE ?)
                GROUP BY atc_main ORDER BY product_count DESC LIMIT ?""",
            (q, q, q, q, limit),
        ).fetchall()
    results = []
    for r in rows:
        item = dict(r)
        licenses = (item.pop("licenses") or "").split(",")
        results.append(item | {"display_name": display_name(r["atc_code"], r["name_en"]),
                               "class_zh": class_zh(r["atc_code"], r["class_zh"] or ""),
                               "nhi": nhi.summarize(licenses)})
    return results


# ---------- 推薦 ----------

def _feedback() -> tuple[dict, dict, set]:
    """回傳 (此病灶採用次數, 跨病灶採用次數, 不再推薦集合)。"""
    adopt: dict[tuple[str, str], int] = {}
    adopt_any: dict[str, int] = {}
    never: set[tuple[str, str]] = set()
    with app_db() as con:
        for r in con.execute("SELECT condition, atc_code, action, COUNT(*) AS n FROM drug_feedback GROUP BY 1, 2, 3"):
            key = (r["condition"], r["atc_code"])
            if r["action"] == "adopt":
                adopt[key] = r["n"]
                adopt_any[r["atc_code"]] = adopt_any.get(r["atc_code"], 0) + r["n"]
            elif r["action"] == "never":
                never.add(key)
    return adopt, adopt_any, never


def diversify(items: list[dict], penalty: float = 0.9) -> list[dict]:
    """貪婪重排：同一藥理類別每多選一個就扣分，讓一排推薦涵蓋不同類別（醫師採用過的不扣分）。"""
    remaining = sorted(items, key=lambda i: i["score"], reverse=True)
    picked: list[dict] = []
    seen: dict[str, int] = {}
    while remaining:
        best = max(
            remaining,
            key=lambda i: i["score"] - (0 if i["adopted_here"] else penalty * seen.get(i["_prefix"], 0)),
        )
        remaining.remove(best)
        picked.append(best)
        seen[best["_prefix"]] = seen.get(best["_prefix"], 0) + 1
    return picked


def detect_risks(text: str, age: str = "") -> list[dict]:
    """從病史與年齡找出需要提醒的風險（否定句「無胃出血」不算）。"""
    lowered = _normalize(text)
    found = []
    for flag in risk_flags():
        if "min_age" in flag:
            years = int(age) if str(age).strip().isdigit() else 0
            if years >= flag["min_age"]:
                found.append({"id": flag["id"], "label": flag["label"], "matched": f"{years} 歲",
                              "message": flag["message"].format(age=years), "atc": flag["atc"]})
            continue
        for keyword in flag["keywords"]:
            needle = _normalize(keyword)
            index = lowered.find(needle)
            while index != -1 and NEGATION.search(lowered[max(0, index - 4):index]):
                index = lowered.find(needle, index + len(needle))
            if index != -1:
                found.append({"id": flag["id"], "label": flag["label"], "matched": keyword,
                              "message": flag["message"].format(matched=keyword), "atc": flag["atc"]})
                break
    return found


def recommend(condition_names: list[str], allergy_ids: list[str], dismissed: list[dict],
              text: str = "", age: str = "", symptom_list: list[dict] | None = None) -> dict:
    """先依問題清單（診斷）逐列推薦，再依現病史症狀補上對症用藥；症狀列只放診斷列沒出現過的藥。"""
    adopt, adopt_any, never = _feedback()
    risks = detect_risks(text, age)
    rules = allergy_rules(allergy_ids)
    dismissed_keys = {(d.get("condition"), d.get("atc")) for d in dismissed}
    rows, excluded = [], []

    targets = [(name, condition_by_name(name), None) for name in condition_names]
    targets += [(s["name"], symptom_by_name(s["name"]), s) for s in (symptom_list or [])
                if s.get("name") not in condition_names]
    shown: set[str] = set()
    for name, cond, symptom in targets:
        if not cond:
            continue
        prefixes = cond["atc"]
        first_line = cond.get("first_line", [])
        avoid = cond.get("avoid", [])
        candidates: dict[str, dict] = {}
        for rank, prefix in enumerate(prefixes):
            priority = 1 - rank / len(prefixes)
            for concept in concepts_for_prefix(prefix):
                code = concept["atc_code"]
                if code in candidates or any(code.startswith(a) for a in avoid):
                    continue
                candidates[code] = {**concept, "_priority": priority, "_prefix": prefix}

        items = []
        for code, c in candidates.items():
            key = (name, code)
            allergy_reason, class_warning = allergy_hit(code, rules)
            if allergy_reason:
                excluded.append({"condition": name, "atc_code": code, "name_en": display_name(code, c["name_en"]), "class_zh": class_zh(code, c["class_zh"]), "reason": "allergy", "label": f"過敏：{allergy_reason}"})
                continue
            if key in never:
                excluded.append({"condition": name, "atc_code": code, "name_en": display_name(code, c["name_en"]), "class_zh": class_zh(code, c["class_zh"]), "reason": "never", "label": "你標記此病灶不再推薦"})
                continue
            if key in dismissed_keys:
                excluded.append({"condition": name, "atc_code": code, "name_en": display_name(code, c["name_en"]), "class_zh": class_zh(code, c["class_zh"]), "reason": "dismissed", "label": "本次病歷：這次不用"})
                continue
            here, anywhere = adopt.get(key, 0), adopt_any.get(code, 0)
            # 複方：ATC 名稱為 combinations／various，或「其他感冒製劑」這類多成分類別
            combination = any(w in c["name_en"].lower() for w in ("combination", "various", "cold preparations"))
            preferred = any(code.startswith(f) for f in first_line)
            score = (3 * c["_priority"] + (1.5 if preferred else 0) + 2 * here + 0.5 * (anywhere - here)
                     + math.log10(c["product_count"] + 1)
                     - (0.6 if combination else 0))  # 單方優先於複方
            reasons = []
            if here:
                reasons.append(f"你在此病灶採用過 {here} 次")
            elif anywhere:
                reasons.append(f"你在其他病灶採用過 {anywhere} 次")

            items.append({
                "atc_code": code, "name_en": c["name_en"], "display_name": display_name(code, c["name_en"]),
                "class_zh": class_zh(code, c["class_zh"]), "preferred": preferred,
                "product_count": c["product_count"], "categories": c["categories"], "forms": c["forms"],
                "image_url": c["image_url"], "sample_name": c["sample_name"], "score": round(score, 3), "nhi": c["nhi"],
                "components": c["components"] if combination else [], "is_combination": combination,
                "risks": [r["message"] for r in risks if any(code.startswith(p) for p in r["atc"])],
                "reasons": reasons, "warning": class_warning, "adopted_here": here, "_prefix": c["_prefix"],
            })
        ranked = diversify(items)
        for item in ranked:
            item.pop("_prefix", None)
        if symptom:
            # 症狀列只看最常用的前幾名；已在上方病灶列出現的標成「已涵蓋」，避免只剩冷門藥
            top = ranked[:SYMPTOM_LIMIT]
            fresh = [i for i in top if i["atc_code"] not in shown]
            shown.update(i["atc_code"] for i in fresh)
            rows.append({"condition": name, "icd10": "", "items": fresh, "total": len(fresh), "kind": "symptom",
                         "matched": symptom.get("matched", ""),
                         "covered": [i["display_name"] for i in top if i not in fresh]})
            continue
        shown.update(i["atc_code"] for i in ranked[:ROW_LIMIT])
        rows.append({"condition": name, "icd10": cond["icd10"], "items": ranked[:ROW_LIMIT], "total": len(items)})

    return {"rows": rows, "excluded": excluded,
            "risks": [{"id": r["id"], "label": r["label"], "matched": r["matched"]} for r in risks]}
