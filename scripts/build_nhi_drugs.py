"""
解析健保署「健保用藥品項查詢檔」，萃取目前有健保給付的藥品，並對回 TFDA 許可證。

輸入（data/raw/nhi/，由健保署網站下載的 all1_YYYMM_*.TXT）：
  - Big5（含 HKSCS 字）編碼、每列固定 1,859 byte 的文字檔，沒有分隔符號，欄位依 byte 位置切。
  - 同一藥品代碼每次調價就多一列（有效起日～有效迄日），所以檔案同時是價格歷史。
  - 多個檔案只是同一份清單切段，合併即為完整資料。

給付判定：
  以檔名的年月（如 11510 → 民國 115/10/01）為基準日，取有效期間涵蓋基準日的那一列；
  該列支付價 > 0 即視為「健保有給付」。支付價 0 表示已不給付（例如停產、取消給付）。

對回 TFDA 許可證（data/drug_reference/drug_reference.sqlite，先執行 build_drug_reference.py）：
  健保代碼第 1 碼是許可證類別（A 藥製、B 藥輸、N 內衛藥製、K 菌疫輸…），
  第 2～7 碼是許可證號（第 2 碼若為英文字母，代表號碼首位 0）。
  1. 先依「類別＋號碼」找候選許可證，再用中文品名、藥商挑最符合的一張。
  2. 代碼對不到時（如 X 開頭的專案進口），改用「中文品名＋藥商」比對。
  match_method 記錄依據：code+name、code+applicant、code_only、name、空白（未對到）。

輸出（data/drug_reference/）：
  - nhi_drugs.sqlite         nhi_items（每個健保代碼一列）、nhi_price_history（所有價格期間）、meta
  - nhi_covered_drugs.csv    目前有健保給付的藥品，UTF-8 BOM，可直接用 Excel 開啟
  - nhi_build_report.json    筆數與對應率統計

欄位說明未公開的代碼欄（類別碼 1/2/3/4/5/9、a1～a5、末欄 Y/N）保留原值，不自行命名其意義。
"""

from __future__ import annotations

import csv
import json
import re
import sqlite3
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw" / "nhi"
OUT = ROOT / "data" / "drug_reference"
TFDA_DB = OUT / "drug_reference.sqlite"
SOURCE_URL = "https://data.gov.tw/dataset/23715"

ENCODING = "big5hkscs"  # cp950 有約 600 列解不開（如「塩野義」的「塩」）
RECORD_BYTES = 1859

# (欄位, 起, 迄) — byte 位置，由資料本身逐欄驗證
FIELDS = [
    ("change_mark", 0, 3),          # '*'：本期新增／異動
    ("a_flag", 3, 14),              # a1～a5，意義未確認
    ("is_combination", 14, 17),     # Y 複方／N 單方
    ("nhi_code", 17, 28),
    ("price", 28, 38),
    ("start_date", 38, 46),
    ("end_date", 46, 54),
    ("name_en", 54, 174),
    ("spec_qty", 174, 182),
    ("spec_unit", 182, 236),
    ("ingredient", 236, 294),
    ("ingredient_qty", 294, 306),
    ("ingredient_unit", 306, 358),
    ("dosage_form", 358, 604),
    ("vendor", 604, 767),           # 藥商，原檔截為 10 個中文字
    ("class_code", 767, 771),       # 1/2/3/4/5/9，意義未確認
    ("name_zh", 771, 900),
    ("group_name", 900, 1135),      # 分類分組名稱：同成分、同劑型、同含量為一組
    ("manufacturer", 1806, 1849),
    ("atc_code", 1849, 1858),
    ("tail_flag", 1858, 1859),      # Y/N，意義未確認
]
# 複方第 2～6 成分：自 1200 起每組 121 byte（名稱 58、含量 12、單位 51）
EXTRA_INGREDIENT_START, EXTRA_INGREDIENT_SIZE, EXTRA_INGREDIENT_COUNT = 1200, 121, 5

# 健保代碼首碼 → TFDA 許可證字號中的類別（不含 衛署／衛部 字首，兩者號碼共用同一碼）
CODE_KIND = {
    "A": ("衛署藥製字", "衛部藥製字"),
    "B": ("衛署藥輸字", "衛部藥輸字", "衛署藥陸輸字", "衛部藥陸輸字"),
    "N": ("內衛藥製字",),
    "J": ("衛署菌疫製字", "衛部菌疫製字", "內衛菌疫製字"),
    "K": ("衛署菌疫輸字", "衛部菌疫輸字", "內衛菌疫輸字"),
    "V": ("衛署罕藥輸字", "衛部罕藥輸字"),
    "W": ("衛署罕藥製字", "衛部罕藥製字"),
    "Y": ("衛署罕菌疫輸字", "衛部罕菌疫輸字"),
    "Z": ("衛署罕菌疫製字", "衛部罕菌疫製字"),
}

ITEM_COLUMNS = [
    "nhi_code", "is_covered", "price", "price_start", "price_end", "next_price", "next_price_start",
    "first_listed", "name_zh", "name_en", "spec_qty", "spec_unit", "is_combination", "ingredients",
    "dosage_form", "group_name", "atc_code", "vendor", "manufacturer",
    "class_code", "a_flag", "tail_flag", "change_mark",
    "license_no", "license_status", "match_method",
]


def roc_to_iso(value: str) -> str:
    """民國 YYYMMDD → 西元 YYYY-MM-DD；9991231 表示無迄日，回傳空字串。"""
    if not value or value == "9991231":
        return ""
    return f"{int(value[:-4]) + 1911:04d}-{value[-4:-2]}-{value[-2:]}"


def parse_price(value: str) -> float | None:
    try:
        return float(value)
    except ValueError:
        return None  # 早年部分品項價格欄為「-」


def decode(chunk: bytes) -> str:
    """固定寬度欄位可能剛好切在中文字中間，此時去掉殘留的半個字。"""
    try:
        return chunk.decode(ENCODING).strip()
    except UnicodeDecodeError:
        return chunk[:-1].decode(ENCODING).strip()


def parse_line(raw: bytes) -> dict:
    row = {name: decode(raw[a:b]) for name, a, b in FIELDS}
    ingredients = [_format_ingredient(row["ingredient"], row["ingredient_qty"], row["ingredient_unit"])]
    for i in range(EXTRA_INGREDIENT_COUNT):
        a = EXTRA_INGREDIENT_START + i * EXTRA_INGREDIENT_SIZE
        name = decode(raw[a:a + 58])
        if name:
            qty = decode(raw[a + 58:a + 70])
            unit = decode(raw[a + 70:a + EXTRA_INGREDIENT_SIZE])
            ingredients.append(_format_ingredient(name, qty, unit))
    row["ingredients"] = " + ".join(x for x in ingredients if x)
    row["price"] = parse_price(row["price"])
    return row


def _format_ingredient(name: str, qty: str, unit: str) -> str:
    if not name:
        return ""
    try:
        qty = f"{float(qty):g}"
    except ValueError:
        pass
    return " ".join(x for x in (name, qty, unit) if x)


def read_records() -> tuple[list[dict], list[str]]:
    files = sorted(RAW.glob("all1_*.TXT"))
    if not files:
        raise SystemExit(f"找不到原始檔：{RAW}/all1_*.TXT")
    rows = []
    for path in files:
        for raw in path.read_bytes().split(b"\r\n"):
            if not raw.strip():
                continue
            if len(raw) != RECORD_BYTES:
                raise ValueError(f"{path.name}：列長 {len(raw)} byte，預期 {RECORD_BYTES}")
            rows.append(parse_line(raw))
    # 去除完全重複的價格期間（以防切檔時同一列出現在兩個檔）
    unique = {(r["nhi_code"], r["start_date"], r["end_date"]): r for r in rows}
    return list(unique.values()), [p.name for p in files]


def snapshot_date(file_names: list[str]) -> str:
    """all1_11510_1.TXT → 1151001（民國）。"""
    m = re.search(r"all1_(\d{3})(\d{2})_", file_names[0])
    if not m:
        raise SystemExit(f"無法由檔名判斷資料月份：{file_names[0]}")
    return f"{m.group(1)}{m.group(2)}01"


def build_items(rows: list[dict], as_of: str) -> list[dict]:
    by_code = defaultdict(list)
    for r in rows:
        by_code[r["nhi_code"]].append(r)
    items = []
    for code, history in by_code.items():
        history.sort(key=lambda r: r["start_date"])
        current = next((r for r in history if r["start_date"] <= as_of <= r["end_date"]), None)
        upcoming = next((r for r in history if r["start_date"] > as_of), None)
        base = current or upcoming or history[-1]  # 尚未生效的新品項，以即將生效那列為準
        is_covered = bool(current and current["price"])
        items.append({
            **{k: base[k] for k in (
                "nhi_code", "name_zh", "name_en", "spec_qty", "spec_unit", "is_combination", "ingredients",
                "dosage_form", "group_name", "atc_code", "vendor", "manufacturer",
                "class_code", "a_flag", "tail_flag", "change_mark")},
            "is_covered": int(is_covered),
            "price": current["price"] if current else None,
            "price_start": roc_to_iso(current["start_date"]) if current else "",
            "price_end": roc_to_iso(current["end_date"]) if current else "",
            "next_price": upcoming["price"] if upcoming else None,
            "next_price_start": roc_to_iso(upcoming["start_date"]) if upcoming else "",
            "first_listed": roc_to_iso(history[0]["start_date"]),
        })
    return sorted(items, key=lambda r: r["nhi_code"])


def normalize_name(text: str) -> str:
    """忽略空白、全形半形與引號樣式的差異。"""
    text = unicodedata.normalize("NFKC", text or "").translate(str.maketrans("“”「」", '""""'))
    return re.sub(r"\s", "", text)


def same_name(nhi_name: str, tfda_name: str | None) -> bool:
    """健保原檔把 Big5 沒有的字存成「?」（如「塩」），比對時視為任一字。"""
    a, b = normalize_name(nhi_name), normalize_name(tfda_name)
    if not a:
        return False
    if "?" not in a:
        return a == b
    return re.fullmatch(re.escape(a).replace(r"\?", "."), b) is not None


def repair_unknown_chars(nhi_text: str, tfda_text: str | None) -> str:
    """用 TFDA 的正確文字補回健保原檔的「?」；兩邊無法逐字對應時保留原值。"""
    if "?" not in nhi_text or not tfda_text:
        return nhi_text
    # 先逐字對原文；對不上（如全形「％」對半形「%」）再以正規化後的文字對
    for source, target in ((nhi_text, tfda_text), (normalize_name(nhi_text), normalize_name(tfda_text))):
        pattern = "".join("(.)" if ch == "?" else re.escape(ch) for ch in source)
        m = re.match(pattern, target)
        if m and "?" not in m.groups():
            fills = iter(m.groups())
            return "".join(next(fills) if ch == "?" else ch for ch in source)
    return nhi_text


def load_licenses() -> list[tuple]:
    if not TFDA_DB.exists():
        print(f"略過 TFDA 對應：找不到 {TFDA_DB}（請先執行 build_drug_reference.py）")
        return []
    con = sqlite3.connect(TFDA_DB)
    try:
        return con.execute("SELECT license_no, status, name_zh, applicant FROM products").fetchall()
    finally:
        con.close()


def license_number(code: str) -> str:
    """健保代碼第 2～7 碼 → 6 位許可證號；第 2 碼為字母時代表首位 0。"""
    return code[1:7] if code[1].isdigit() else "0" + code[2:7]


def match_licenses(items: list[dict], licenses: list[tuple]) -> None:
    by_number = defaultdict(list)
    by_name = defaultdict(list)
    for lic in licenses:
        m = re.match(r"(.+?字)第(\d+)號$", lic[0])
        if m:
            by_number[(m.group(1), m.group(2).zfill(6))].append(lic)
        by_name[normalize_name(lic[2])].append(lic)

    for item in items:
        code, name, vendor = item["nhi_code"], item["name_zh"], item["vendor"][:6]

        def score(lic) -> tuple:
            return (same_name(name, lic[2]),
                    bool(vendor) and same_name(vendor, (lic[3] or "")[:len(vendor)]),
                    lic[1] == "有效")

        chosen, method = None, ""
        kinds = CODE_KIND.get(code[0], ())
        candidates = [lic for kind in kinds for lic in by_number.get((kind, license_number(code)), [])]
        if candidates:
            chosen = max(candidates, key=score)
            name_ok, vendor_ok, _ = score(chosen)
            method = "code+name" if name_ok else "code+applicant" if vendor_ok else "code_only"
        if method in ("", "code_only"):
            by_text = [lic for lic in by_name.get(normalize_name(name), []) if (lic[3] or "").startswith(vendor)]
            if by_text:
                chosen, method = max(by_text, key=score), "name"
        item["license_no"] = chosen[0] if chosen else ""
        item["license_status"] = chosen[1] if chosen else ""
        item["match_method"] = method
        if chosen and method != "code_only":
            item["name_zh"] = repair_unknown_chars(item["name_zh"], chosen[2])
            item["vendor"] = repair_unknown_chars(item["vendor"], chosen[3])


def write_csv(path: Path, rows: list[dict], columns: list[str]) -> None:
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def write_sqlite(path: Path, items: list[dict], history: list[dict], report: dict) -> None:
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    numeric = {"is_covered": "INTEGER", "price": "REAL", "next_price": "REAL"}
    defs = ", ".join(f"{c} {numeric.get(c, 'TEXT')}" + (" PRIMARY KEY" if c == "nhi_code" else "")
                     for c in ITEM_COLUMNS)
    con.execute(f"CREATE TABLE nhi_items ({defs})")
    con.executemany(f"INSERT INTO nhi_items VALUES ({','.join('?' * len(ITEM_COLUMNS))})",
                    [[r[c] for c in ITEM_COLUMNS] for r in items])
    con.execute("CREATE TABLE nhi_price_history (nhi_code TEXT, price REAL, start_date TEXT, end_date TEXT)")
    con.executemany("INSERT INTO nhi_price_history VALUES (?,?,?,?)",
                    [(r["nhi_code"], r["price"], roc_to_iso(r["start_date"]), roc_to_iso(r["end_date"]))
                     for r in history])
    con.execute("CREATE INDEX idx_nhi_covered ON nhi_items(is_covered)")
    con.execute("CREATE INDEX idx_nhi_license ON nhi_items(license_no)")
    con.execute("CREATE INDEX idx_nhi_atc ON nhi_items(atc_code)")
    con.execute("CREATE INDEX idx_nhi_history_code ON nhi_price_history(nhi_code)")
    con.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
    con.executemany("INSERT INTO meta VALUES (?, ?)",
                    [(k, json.dumps(v, ensure_ascii=False)) for k, v in report.items()])
    con.commit()
    con.close()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    rows, files = read_records()
    as_of = snapshot_date(files)
    items = build_items(rows, as_of)
    match_licenses(items, load_licenses())

    covered = [r for r in items if r["is_covered"]]
    report = {
        "source": SOURCE_URL,
        "files": files,
        "as_of": roc_to_iso(as_of),
        "price_rows": len(rows),
        "nhi_codes": len(items),
        "covered_codes": len(covered),
        "covered_licenses": len({r["license_no"] for r in covered if r["license_no"]}),
        "covered_atc_codes": len({r["atc_code"] for r in covered if r["atc_code"]}),
        "covered_groups": len({r["group_name"] for r in covered if r["group_name"]}),
        "covered_by_code_prefix": dict(Counter(r["nhi_code"][0] for r in covered).most_common()),
        "covered_match_method": dict(Counter(r["match_method"] or "unmatched" for r in covered).most_common()),
        "upcoming_price_changes": sum(1 for r in items if r["next_price_start"]),
        "built_at": datetime.now().isoformat(timespec="seconds"),
    }
    write_csv(OUT / "nhi_covered_drugs.csv", covered, ITEM_COLUMNS)
    write_sqlite(OUT / "nhi_drugs.sqlite", items, rows, report)
    (OUT / "nhi_build_report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
