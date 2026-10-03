"""
驗證 build_nhi_drugs.py 的輸出。不需要藥學知識：失敗就代表解析或對應有問題。

兩類檢查：
  A. 官方對照：下列藥品於 2026-10-03 在健保署「健保用藥品項網路查詢服務」
     （https://info.nhi.gov.tw/INAE3000/INAE3000S01）逐筆查詢，期望值即官網顯示值。
     每類情況各挑一筆：一般學名藥、研發廠、BA/BE 學名藥、生物相似性藥品、BE 對照品、
     已公告將停止給付、專案進口（無 TFDA 許可證）、目前不給付。
  B. 一致性：從原始檔與價格歷史重新推算，確認輸出沒有漏列、錯列。

用法：python3 scripts/verify_nhi_drugs.py   （全部通過時結束碼為 0）
"""

from __future__ import annotations

import csv
import random
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_nhi_drugs as nhi  # noqa: E402

DB = nhi.OUT / "nhi_drugs.sqlite"
CSV = nhi.OUT / "nhi_covered_drugs.csv"

# A. 官方對照（官網日期為民國，這裡換算成西元）
OFFICIAL_CASES = [
    # 藥品代碼, 期望欄位, 情況說明
    ("A022664100", {"is_covered": 1, "price": 1.23, "price_start": "2022-01-01", "atc_code": "J01CA04",
                    "class_label": "一般學名藥", "license_no": "衛署藥製字第022664號"},
     "一般學名藥：太田阿莫克西林膠囊 500mg（抗生素）"),
    ("A008907100", {"is_covered": 1, "price": 0.77, "price_start": "2022-01-01", "atc_code": "R05DB24",
                    "class_label": "研發廠"},
     "研發廠：安嗽寧錠 20mg（止咳藥）"),
    ("A001646100", {"is_covered": 1, "price": 0.80, "price_start": "2014-07-01", "atc_code": "N05BA01",
                    "class_label": "BA/BE學名藥"},
     "BA/BE 學名藥：健喬丹祈屏錠 2mg（diazepam，鎮靜劑）"),
    ("JC00154261", {"is_covered": 1, "price": 11323.00, "price_start": "2023-10-01", "atc_code": "L01FD01",
                    "class_label": "生物相似性藥品"},
     "生物相似性藥品：益康平凍晶注射劑 150mg（trastuzumab，乳癌標靶藥）"),
    ("A024398100", {"is_covered": 1, "price": 1.08, "price_start": "2016-04-01", "atc_code": "M01AE02",
                    "class_label": "BE對照品"},
     "BE 對照品：安鈉百鎮錠（naproxen，止痛消炎藥）"),
    ("BA25337100", {"is_covered": 1, "price": 11.80, "price_start": "2026-08-01", "price_end": "2027-11-30",
                    "next_price": 0.0, "next_price_start": "2027-12-01", "atc_code": "C10AA05"},
     "已公告將停止給付：妥寧膜衣錠 20mg（atorvastatin，降血脂），官網迄日 116.11.30"),
    ("X000014238", {"is_covered": 1, "price": 5000.00, "price_start": "2022-12-01", "atc_code": "M03CA01",
                    "license_no": ""},
     "專案進口：DANTROLENE 20MG IV，健保有給付但沒有 TFDA 許可證"),
    ("A000420100", {"is_covered": 0},
     "目前不給付：福元納舒糖衣錠 100mg，官網勾「只顯示給付中資料」查無資料"),
]

# 資料本身的特殊情況（期望值由原始檔確認）
DATA_CASES = [
    ("BC21128229", {"name_zh": "哌明克注射劑"}, "原檔把「哌」存成「?」，應以 TFDA 名稱補回"),
    ("AC303961G0", {"vendor": "台灣塩野義製藥股份有"}, "原檔把「塩」存成「?」，應以 TFDA 名稱補回"),
    ("BC209712CX", {"is_combination": "Y", "atc_code": "J01CR05"}, "複方：達梭黴素（piperacillin + tazobactam）"),
    ("K000285214", {"group_name": "CYTOMEGALOVIRUS IMMUNOGLOBULIN , 注射劑 , 50.00 ML"},
     "原檔成分欄登錄有誤（寫成 LIOTHYRONINE），分類分組名稱才是正確的藥品概念"),
    ("AC39392221", {"group_name": "VITAMIN A 3300IU + VITAMIN B1 3.0-4.0MG + VITAMIN B2 3.0-5.0MG + VITAMIN B6 "
                    "4.0-5.0MG + VITAMIN B12 0.005MG + VITAMIN C 100MG + VITAMIN D 200IU + VITAMIN E 10MG + "
                    "NICOTINAMIDE 40MG + FOLIC ACID 0.4MG + PANTHENOL 14-15MG + BIOTIN 0.06MG + VITAMIN K "
                    "0-2.0MG, 注射劑"},
     "分類分組名稱長 300 byte（依官方格式說明），長複方名稱不可截斷"),
]


class Checker:
    def __init__(self) -> None:
        self.failures = 0

    def check(self, ok: bool, label: str, detail: str = "") -> None:
        print(f"  {'✓' if ok else '✗'} {label}" + (f" — {detail}" if detail and not ok else ""))
        self.failures += not ok


def check_cases(c: Checker, con: sqlite3.Connection, title: str, cases: list) -> None:
    print(title)
    con.row_factory = sqlite3.Row
    for code, expected, note in cases:
        row = con.execute("SELECT * FROM nhi_items WHERE nhi_code = ?", (code,)).fetchone()
        if row is None:
            c.check(False, f"{code} {note}", "輸出中找不到這個代碼")
            continue
        wrong = [f"{k} 期望 {v!r}，實際 {row[k]!r}" for k, v in expected.items()
                 if (round(row[k], 2) if isinstance(v, float) and row[k] is not None else row[k]) != v]
        c.check(not wrong, f"{code} {note}", "；".join(wrong))
    con.row_factory = None


def check_consistency(c: Checker, con: sqlite3.Connection) -> None:
    print("B. 一致性檢查")
    raw_lines = [line for path in sorted(nhi.RAW.glob("all1_*.TXT"))
                 for line in path.read_bytes().split(b"\r\n") if line.strip()]
    history_rows = con.execute("SELECT COUNT(*) FROM nhi_price_history").fetchone()[0]
    c.check(len(raw_lines) == history_rows, f"原始檔 {len(raw_lines):,} 列全部進入價格歷史",
            f"價格歷史只有 {history_rows:,} 列")

    codes_raw = {line[17:28].decode().strip() for line in raw_lines}
    codes_db = {r[0] for r in con.execute("SELECT nhi_code FROM nhi_items")}
    c.check(codes_raw == codes_db, f"每個健保代碼各一列（{len(codes_db):,} 個）",
            f"差異 {len(codes_raw ^ codes_db)} 個")

    # 抽 300 列原始資料，用「以空白切開前 54 byte」的另一種方法讀代碼、價格、日期，確認都在價格歷史裡
    rng = random.Random(20261003)
    history = {(code, price, start) for code, price, start in
               con.execute("SELECT nhi_code, price, start_date FROM nhi_price_history")}
    misses = []
    for line in rng.sample(raw_lines, 300):
        parts = line[:54].decode().split()
        code, price, start = parts[-4], parts[-3], parts[-2]
        key = (code, None if price == "-" else float(price), nhi.roc_to_iso(start))
        if key not in history:
            misses.append(code)
    c.check(not misses, "抽樣 300 列原始資料：代碼、價格、起日與輸出一致", f"不一致：{misses[:5]}")

    # 由價格歷史獨立重算「目前給付」，與 is_covered 比對
    as_of = con.execute("SELECT value FROM meta WHERE key = 'as_of'").fetchone()[0].strip('"')
    recomputed = {code for (code,) in con.execute(
        """SELECT DISTINCT nhi_code FROM nhi_price_history
           WHERE start_date <= ? AND (end_date = '' OR end_date >= ?) AND price > 0""", (as_of, as_of))}
    covered = {code for (code,) in con.execute("SELECT nhi_code FROM nhi_items WHERE is_covered = 1")}
    c.check(recomputed == covered, f"由價格歷史重算給付品項，結果相同（{len(covered):,} 個）",
            f"差異 {len(recomputed ^ covered)} 個")

    with open(CSV, encoding="utf-8-sig", newline="") as f:
        csv_codes = {row["nhi_code"] for row in csv.DictReader(f)}
    c.check(csv_codes == covered, f"CSV 清單與資料庫的給付品項一致（{len(csv_codes):,} 列）")

    bad = con.execute("""SELECT COUNT(*) FROM nhi_items WHERE is_covered = 1
                         AND (price IS NULL OR price <= 0 OR atc_code = '')""").fetchone()[0]
    c.check(bad == 0, "給付品項都有正的健保價與 ATC 碼", f"{bad} 筆缺漏")

    bad = con.execute("""SELECT COUNT(*) FROM nhi_items WHERE is_covered = 1
                         AND (name_zh LIKE '%?%' OR vendor LIKE '%?%')""").fetchone()[0]
    c.check(bad == 0, "給付品項的中文名稱與藥商沒有殘留「?」", f"{bad} 筆")

    mismatched = []
    for code, lic in con.execute("""SELECT nhi_code, license_no FROM nhi_items
                                    WHERE match_method LIKE 'code%'"""):
        m = re.search(r"第(\d+)號", lic)
        if not m or m.group(1).zfill(6) != nhi.license_number(code):
            mismatched.append((code, lic))
    c.check(not mismatched, "以代碼對應的許可證，號碼與健保代碼編碼規則相符", f"{mismatched[:3]}")

    if nhi.TFDA_DB.exists():
        con.execute(f"ATTACH DATABASE '{nhi.TFDA_DB}' AS tfda")
        orphans = con.execute("""SELECT COUNT(*) FROM nhi_items n
                                 WHERE n.license_no != ''
                                 AND n.license_no NOT IN (SELECT license_no FROM tfda.products)""").fetchone()[0]
        c.check(orphans == 0, "對到的許可證字號都存在於 TFDA 資料", f"{orphans} 筆不存在")

    rate = con.execute("""SELECT AVG(license_no != '') FROM nhi_items WHERE is_covered = 1""").fetchone()[0]
    c.check(rate >= 0.99, f"給付品項對到 TFDA 許可證的比例 {rate:.1%}（門檻 99%）")


def main() -> int:
    if not DB.exists():
        print(f"找不到 {DB}，請先執行 python3 scripts/build_nhi_drugs.py")
        return 1
    con = sqlite3.connect(DB)
    c = Checker()
    check_cases(c, con, "A. 官方對照（健保署查詢網站，2026-10-03）", OFFICIAL_CASES)
    check_cases(c, con, "A2. 資料特殊情況", DATA_CASES)
    check_consistency(c, con)
    con.close()
    print(f"\n{'全部通過' if not c.failures else f'{c.failures} 項失敗'}")
    return 1 if c.failures else 0


if __name__ == "__main__":
    sys.exit(main())
