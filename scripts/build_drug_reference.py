"""
彙整 TFDA 三份開放資料，產生藥品參考表。

輸入（data/raw/tfda/，由 data.gov.tw 下載的 JSON）：
  - license_36/36_5.json  全部藥品許可證資料集（dataset 9122）
  - ahfs_40/40_5.json     藥品藥理治療分類 AHFS/DI 碼（dataset 9118）
  - atc_41/41_5.json      藥品藥理治療分類 ATC 碼（dataset 9119）
  - appearance_42/42_5.json 藥品外觀（dataset 9120）；圖片不下載，只保留 TFDA 圖檔連結

合併規則：
  1. 以「許可證字號」為主鍵；同一許可證因多個製造廠而重複的列，合併為一筆，製造廠存成清單。
  2. ATC、AHFS、外觀依許可證字號直接對應；ATC、AHFS 分主項／次項。
  3. AHFS 資料集多為已註銷藥證，因此若某許可證沒有 AHFS，但它的主 ATC 碼與其他有 AHFS 的
     許可證相同（視為同一藥品成分），就沿用該 AHFS 分類，並標記 ahfs_source = "inferred_via_atc"。
     同一 ATC 對到多個 AHFS 時取最多數者，並記錄信心比例。

輸出（data/drug_reference/）：
  - drug_reference.sqlite  products（每張許可證一列）、concepts（每個 ATC 成分一列）
  - drug_products.csv      products 表，UTF-8 BOM，可直接用 Excel 開啟
  - drug_concepts.csv      concepts 表
  - build_report.json      筆數與覆蓋率統計
"""

from __future__ import annotations

import csv
import json
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "tfda"
OUT = ROOT / "data" / "drug_reference"

SOURCES = {
    "license": {"file": RAW / "license_36" / "36_5.json", "dataset": "https://data.gov.tw/dataset/9122"},
    "ahfs": {"file": RAW / "ahfs_40" / "40_5.json", "dataset": "https://data.gov.tw/dataset/9118"},
    "atc": {"file": RAW / "atc_41" / "41_5.json", "dataset": "https://data.gov.tw/dataset/9119"},
    "appearance": {"file": RAW / "appearance_42" / "42_5.json", "dataset": "https://data.gov.tw/dataset/9120"},
}

PRODUCT_COLUMNS = [
    "license_no", "status", "is_active", "license_type", "drug_category", "controlled_level",
    "name_zh", "name_en", "ingredients", "indication", "dosage_form", "package", "usage",
    "issue_date", "expiry_date", "cancel_date", "cancel_reason",
    "applicant", "manufacturers", "manufacturer_countries",
    "atc_main", "atc_main_name_en", "atc_main_name_zh", "atc_l1", "atc_l2", "atc_l3", "atc_l4",
    "atc_secondary",
    "ahfs_main", "ahfs_main_name_en", "ahfs_main_name_zh", "ahfs_secondary",
    "ahfs_source", "ahfs_confidence",
    "shape", "color", "special_form", "odor", "score_line", "size_mm", "marking", "image_url",
    "updated_at",
]


def load(name: str) -> list[dict]:
    with open(SOURCES[name]["file"], encoding="utf-8-sig") as f:
        return json.load(f)


# 原始資料中無法編碼而變成「?」的字（主要是「酶」）
TEXT_FIXES = {
    "轉化?": "轉化酶",
    "氧化?": "氧化酶",
    "抗青黴素?": "抗青黴素酶",
    "類?治類利尿劑": "類 Thiazide 利尿劑",
}


def clean(value) -> str:
    if value is None:
        return ""
    text = str(value).replace("　", "").strip()
    for broken, fixed in TEXT_FIXES.items():
        text = text.replace(broken, fixed)
    return text


def atc_levels(code: str) -> dict:
    """ATC 階層：L1=1碼、L2=3碼、L3=4碼、L4=5碼、L5=7碼。"""
    return {
        "atc_l1": code[:1] if len(code) >= 1 else "",
        "atc_l2": code[:3] if len(code) >= 3 else "",
        "atc_l3": code[:4] if len(code) >= 4 else "",
        "atc_l4": code[:5] if len(code) >= 5 else "",
    }


def group_codes(rows: list[dict]) -> dict[str, dict]:
    """把分類資料依許可證字號分成主項（取第一筆）與次項清單。"""
    grouped: dict[str, dict] = defaultdict(lambda: {"main": None, "secondary": []})
    for row in rows:
        entry = {
            "code": clean(row["代碼"]),
            "name_en": clean(row["英文分類名稱"]),
            "name_zh": clean(row["中文分類名稱"]),
        }
        slot = grouped[row["許可證字號"]]
        if row["主或次項"] == "主" and slot["main"] is None:
            slot["main"] = entry
        else:
            slot["secondary"].append(entry)
    return grouped


def merge_licenses(rows: list[dict]) -> dict[str, dict]:
    merged: dict[str, dict] = {}
    for row in rows:
        key = row["許可證字號"]
        maker = clean(row["製造商名稱"])
        country = clean(row["製造廠國別"])
        if key not in merged:
            merged[key] = {"row": row, "makers": [], "countries": []}
        item = merged[key]
        if maker and maker not in item["makers"]:
            item["makers"].append(maker)
        if country and country not in item["countries"]:
            item["countries"].append(country)
    return merged


def build_ahfs_bridge(atc: dict, ahfs: dict) -> dict[str, tuple[dict, float]]:
    """主 ATC 碼 → 最常見的主 AHFS 分類與其比例。"""
    votes: dict[str, Counter] = defaultdict(Counter)
    lookup: dict[str, dict] = {}
    for license_no, a in ahfs.items():
        t = atc.get(license_no)
        if not (a["main"] and t and t["main"]):
            continue
        code = a["main"]["code"]
        votes[t["main"]["code"]][code] += 1
        lookup[code] = a["main"]
    bridge = {}
    for atc_code, counter in votes.items():
        code, n = counter.most_common(1)[0]
        bridge[atc_code] = (lookup[code], round(n / sum(counter.values()), 2))
    return bridge


def index_appearance(rows: list[dict]) -> dict[str, dict]:
    appearance = {}
    for r in rows:
        marking = " / ".join(m for m in (clean(r["標註一"]), clean(r["標註二"])) if m)
        url = clean(r["外觀圖檔連結"])
        appearance[r["許可證字號"]] = {
            "shape": clean(r["形狀"]),
            # 膠囊等多色藥品以 ; 分隔各部位顏色，去除空值與重複
            "color": "、".join(dict.fromkeys(c.strip() for c in clean(r["顏色"]).split(";") if c.strip())),
            "special_form": clean(r["特殊劑型"]),
            "odor": clean(r["特殊氣味"]),
            "score_line": clean(r["刻痕"]),
            "size_mm": clean(r["外觀尺寸"]),
            "marking": marking,
            "image_url": url if url.startswith("https://") else "",
        }
    return appearance


EMPTY_APPEARANCE = dict.fromkeys(
    ["shape", "color", "special_form", "odor", "score_line", "size_mm", "marking", "image_url"], ""
)


def build_products(licenses, atc, ahfs, bridge, appearance) -> list[dict]:
    products = []
    for license_no, item in licenses.items():
        r = item["row"]
        t = atc.get(license_no, {"main": None, "secondary": []})
        a = ahfs.get(license_no, {"main": None, "secondary": []})
        status = clean(r["註銷狀態"]) or "有效"

        ahfs_main, ahfs_source, ahfs_conf = a["main"], "", ""
        if ahfs_main:
            ahfs_source, ahfs_conf = "direct", 1.0
        elif t["main"] and t["main"]["code"] in bridge:
            ahfs_main, ahfs_conf = bridge[t["main"]["code"]]
            ahfs_source = "inferred_via_atc"

        atc_code = t["main"]["code"] if t["main"] else ""
        products.append({
            "license_no": license_no,
            "status": status,
            "is_active": int(status == "有效"),
            "license_type": clean(r["許可證種類"]),
            "drug_category": clean(r["藥品類別"]),
            "controlled_level": clean(r["管制藥品分類級別"]),
            "name_zh": clean(r["中文品名"]),
            "name_en": clean(r["英文品名"]),
            "ingredients": clean(r["主成分略述"]),
            "indication": clean(r["適應症"]),
            "dosage_form": clean(r["劑型"]),
            "package": clean(r["包裝"]),
            "usage": clean(r["用法用量"]),
            "issue_date": clean(r["發證日期"]),
            "expiry_date": clean(r["有效日期"]),
            "cancel_date": clean(r["註銷日期"]),
            "cancel_reason": clean(r["註銷理由"]),
            "applicant": clean(r["申請商名稱"]),
            "manufacturers": " | ".join(item["makers"]),
            "manufacturer_countries": " | ".join(item["countries"]),
            "atc_main": atc_code,
            "atc_main_name_en": t["main"]["name_en"] if t["main"] else "",
            "atc_main_name_zh": t["main"]["name_zh"] if t["main"] else "",
            **atc_levels(atc_code),
            "atc_secondary": " | ".join(e["code"] for e in t["secondary"]),
            "ahfs_main": ahfs_main["code"] if ahfs_main else "",
            "ahfs_main_name_en": ahfs_main["name_en"] if ahfs_main else "",
            "ahfs_main_name_zh": ahfs_main["name_zh"] if ahfs_main else "",
            "ahfs_secondary": " | ".join(e["code"] for e in a["secondary"]),
            "ahfs_source": ahfs_source,
            "ahfs_confidence": ahfs_conf,
            **appearance.get(license_no, EMPTY_APPEARANCE),
            "updated_at": clean(r["異動日期"]),
        })
    return products


def build_concepts(products: list[dict]) -> list[dict]:
    """以主 ATC 碼（成分層級）彙整同一藥品的所有許可證。"""
    groups: dict[str, list[dict]] = defaultdict(list)
    for p in products:
        if p["atc_main"]:
            groups[p["atc_main"]].append(p)
    concepts = []
    for code, items in sorted(groups.items()):
        active = [p for p in items if p["is_active"]]
        ref = (active or items)[0]
        # 成分層級的 AHFS 取任一張有分類的許可證，優先直接對應者
        ahfs_ref = next((p for p in items if p["ahfs_source"] == "direct"), None) or next(
            (p for p in items if p["ahfs_main"]), ref
        )
        pictured = [p for p in active if p["image_url"]]
        forms = Counter(p["dosage_form"] for p in active if p["dosage_form"])
        categories = Counter(p["drug_category"] for p in active if p["drug_category"])
        concepts.append({
            "atc_code": code,
            "name_en": ref["atc_main_name_en"],
            "name_zh": ref["atc_main_name_zh"],
            **atc_levels(code),
            "ahfs_main": ahfs_ref["ahfs_main"],
            "ahfs_main_name_zh": ahfs_ref["ahfs_main_name_zh"],
            "ahfs_source": ahfs_ref["ahfs_source"],
            "license_count": len(items),
            "active_license_count": len(active),
            "common_dosage_forms": " | ".join(f for f, _ in forms.most_common(5)),
            "drug_categories": " | ".join(c for c, _ in categories.most_common()),
            "sample_indication": next((p["indication"] for p in active if p["indication"]), ""),
            "pictured_license_count": len(pictured),
            "sample_image_url": pictured[0]["image_url"] if pictured else "",
        })
    return concepts


def write_csv(path: Path, rows: list[dict]) -> None:
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)


def write_sqlite(path: Path, products: list[dict], concepts: list[dict], report: dict) -> None:
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    for table, rows, pk in [("products", products, "license_no"), ("concepts", concepts, "atc_code")]:
        cols = list(rows[0].keys())
        defs = ", ".join(f'"{c}" TEXT' + (" PRIMARY KEY" if c == pk else "") for c in cols)
        con.execute(f"CREATE TABLE {table} ({defs})")
        con.executemany(
            f"INSERT INTO {table} VALUES ({', '.join('?' for _ in cols)})",
            [tuple(r[c] for c in cols) for r in rows],
        )
    con.execute("CREATE INDEX idx_products_atc ON products(atc_main)")
    con.execute("CREATE INDEX idx_products_active ON products(is_active)")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    con.executemany("INSERT INTO meta VALUES (?, ?)", [(k, json.dumps(v, ensure_ascii=False)) for k, v in report.items()])
    con.commit()
    con.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    raw_licenses, raw_ahfs, raw_atc = load("license"), load("ahfs"), load("atc")
    raw_appearance = load("appearance")

    licenses = merge_licenses(raw_licenses)
    atc, ahfs = group_codes(raw_atc), group_codes(raw_ahfs)
    bridge = build_ahfs_bridge(atc, ahfs)
    products = build_products(licenses, atc, ahfs, bridge, index_appearance(raw_appearance))
    concepts = build_concepts(products)

    active = [p for p in products if p["is_active"]]
    report = {
        "built_at": datetime.now().isoformat(timespec="seconds"),
        "sources": {k: v["dataset"] for k, v in SOURCES.items()},
        "license": "政府資料開放授權條款－第1版",
        "raw_rows": {
        "license": len(raw_licenses), "ahfs": len(raw_ahfs), "atc": len(raw_atc), "appearance": len(raw_appearance),
    },
        "products": len(products),
        "active_products": len(active),
        "concepts": len(concepts),
        "active_with_atc": sum(1 for p in active if p["atc_main"]),
        "active_with_ahfs_direct": sum(1 for p in active if p["ahfs_source"] == "direct"),
        "active_with_ahfs_inferred": sum(1 for p in active if p["ahfs_source"] == "inferred_via_atc"),
        "atc_to_ahfs_bridge_size": len(bridge),
        "active_with_image": sum(1 for p in active if p["image_url"]),
        "concepts_with_ahfs": sum(1 for c in concepts if c["ahfs_main"]),
        "concepts_with_image": sum(1 for c in concepts if c["sample_image_url"]),
    }

    write_csv(OUT / "drug_products.csv", products)
    write_csv(OUT / "drug_concepts.csv", concepts)
    write_sqlite(OUT / "drug_reference.sqlite", products, concepts, report)
    (OUT / "build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
