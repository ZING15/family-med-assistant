"""把 Azure 雲端備份與本機資料轉移到 Supabase（Postgres＋Storage），2026-11 搬家用。

合併規則（2026-11-24 與專案擁有者確認）：
- 病歷、衛教單、推薦回饋：只用 Azure 雲端備份（醫師實際使用的資料），保留原本的 id
- 學習庫：雲端＋本機都帶；同一個檔案（內容雜湊相同）或同一個藥品成分只留一筆，以雲端為準
- 藥品白話簡介（快取）：兩邊合併
- 學習庫的語意向量全部用 Gemini 重新計算（舊的是 OpenAI 向量，維度不同不能沿用）

用法（在專案根目錄，.env 需有 DATABASE_URL、SUPABASE_URL、SUPABASE_SECRET_KEY、GEMINI_API_KEY）：
  backend/.venv/bin/python scripts/migrate_to_supabase.py            # 只預覽，不寫入
  backend/.venv/bin/python scripts/migrate_to_supabase.py --apply    # 實際寫入（目標資料表必須是空的）
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app import storage  # noqa: E402
from app.ai import ai  # noqa: E402
from app.db import USE_POSTGRES, app_db, init_app_db  # noqa: E402

CLOUD_DB = ROOT / "data/backup/azure-final-20261124/app.sqlite"
CLOUD_UPLOADS = ROOT / "data/backup/azure-final-20261124/data-folder/uploads"
LOCAL_DB = ROOT / "data/app.sqlite"
LOCAL_UPLOADS = ROOT / "data/uploads"
TABLES = ["records", "education_sheets", "drug_feedback", "library_items", "drug_summaries"]
CARD_SECTIONS = ("care", "warnings")


def rows(db: Path, table: str) -> list[dict]:
    con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        return [dict(r) for r in con.execute(f"SELECT * FROM {table} ORDER BY 1")]
    finally:
        con.close()


def file_hash(folder: Path, key: str) -> str | None:
    path = folder / key
    return hashlib.sha256(path.read_bytes()).hexdigest() if key and path.is_file() else None


def sheet_files(sheet: dict) -> list[str]:
    content = json.loads(sheet["content"] or "{}")
    keys = [sheet["image_path"]] if sheet["image_path"] else []
    for section in CARD_SECTIONS:
        keys += [c["image"] for c in content.get(section) or [] if isinstance(c, dict) and c.get("image")]
    return keys


def embedding_text(item: dict) -> str:
    tags = " ".join(json.loads(item["tags"] or "[]"))
    return "\n".join([item["title"], item["topic"], tags, item["note"], item["ai_summary"],
                      item["extracted_text"], item["source_title"]])


def plan() -> dict:
    records = rows(CLOUD_DB, "records")
    sheets = rows(CLOUD_DB, "education_sheets")
    feedback = rows(CLOUD_DB, "drug_feedback")
    summaries = {r["atc_code"]: r for r in rows(LOCAL_DB, "drug_summaries")}
    summaries |= {r["atc_code"]: r for r in rows(CLOUD_DB, "drug_summaries")}

    library, skipped, seen_files, seen_drugs = [], [], {}, {}
    for source, db, folder in (("雲端", CLOUD_DB, CLOUD_UPLOADS), ("本機", LOCAL_DB, LOCAL_UPLOADS)):
        for item in rows(db, "library_items"):
            label = f"{source}#{item['id']} {item['title']}"
            digest = None
            for key in (item["image_path"], item["audio_path"]):
                if key and not key.startswith("http"):
                    digest = file_hash(folder, key)
                    if digest is None:
                        print(f"  提醒：{label} 的檔案 {key} 不存在，只轉移文字內容")
            if digest and digest in seen_files:
                skipped.append(f"{label}（和 {seen_files[digest]} 是同一個檔案）")
                continue
            if item["kind"] == "drug" and item["ref_id"]:
                if item["ref_id"] in seen_drugs:
                    skipped.append(f"{label}（和 {seen_drugs[item['ref_id']]} 是同一個藥品成分）")
                    continue
                seen_drugs[item["ref_id"]] = label
            if digest:
                seen_files[digest] = label
            entry = dict(item)
            entry["_source"], entry["_folder"], entry["_label"] = source, folder, label
            if source == "本機" and item["ref_type"] == "education":
                # 本機的衛教單不轉移，連結會指到別的衛教單，因此清掉
                entry["ref_type"], entry["ref_id"] = "", ""
            library.append(entry)

    files = [(CLOUD_UPLOADS, k) for s in sheets for k in sheet_files(s)]
    files += [(e["_folder"], k) for e in library for k in (e["image_path"], e["audio_path"])
              if k and not k.startswith("http")]
    return {"records": records, "sheets": sheets, "feedback": feedback, "summaries": list(summaries.values()),
            "library": library, "skipped": skipped, "files": files}


def insert(con, table: str, row: dict, keep_id: bool) -> None:
    data = {k: v for k, v in row.items() if not k.startswith("_") and (keep_id or k != "id")}
    cols = ", ".join(data)
    marks = ", ".join("?" for _ in data)
    con.execute(f"INSERT INTO {table} ({cols}) VALUES ({marks})", list(data.values()))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="實際寫入 Supabase")
    args = parser.parse_args()
    if not (USE_POSTGRES and storage.USE_SUPABASE and ai.embedding_ready):
        sys.exit("需要在 .env 設定 DATABASE_URL、SUPABASE_URL、SUPABASE_SECRET_KEY、GEMINI_API_KEY")

    p = plan()
    print(f"病歷 {len(p['records'])} 份、衛教單 {len(p['sheets'])} 份、推薦回饋 {len(p['feedback'])} 筆、"
          f"藥品簡介 {len(p['summaries'])} 筆（以上來自雲端）")
    print(f"學習庫 {len(p['library'])} 則：" + "、".join(e["_label"] for e in p["library"]))
    for s in p["skipped"]:
        print(f"  略過重複：{s}")
    missing = [f"{folder.name}/{k}" for folder, k in p["files"] if not (folder / k).is_file()]
    print(f"檔案 {len(p['files'])} 個" + (f"，其中 {len(missing)} 個找不到：{missing}" if missing else ""))
    if not args.apply:
        print("\n（預覽模式，沒有寫入任何資料。確認無誤後加上 --apply）")
        return

    init_app_db()
    storage.ensure_bucket()
    with app_db() as con:
        existing = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
    if any(existing.values()):
        sys.exit(f"目標資料庫已經有資料，為避免覆蓋，停止轉移：{existing}")

    print("\n上傳檔案…")
    for folder, key in p["files"]:
        if (folder / key).is_file():
            storage.save(key, (folder / key).read_bytes())
    print("重新計算學習庫向量（Gemini）…")
    vectors = ai.embed_many([embedding_text(e) for e in p["library"]]) or []
    for entry, vector in zip(p["library"], vectors):
        entry["embedding"] = json.dumps(vector)

    print("寫入資料庫…")
    with app_db() as con:
        for r in p["records"]:
            insert(con, "records", r, keep_id=True)
        for s in p["sheets"]:
            insert(con, "education_sheets", s, keep_id=True)
        for f in p["feedback"]:
            insert(con, "drug_feedback", f, keep_id=False)
        for s in p["summaries"]:
            insert(con, "drug_summaries", s, keep_id=True)
        for e in p["library"]:
            insert(con, "library_items", e, keep_id=False)
        # 保留原 id 的資料表：自動編號從目前最大值往後接
        for table in ("records", "education_sheets"):
            con.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), "
                        f"COALESCE((SELECT MAX(id) FROM {table}), 1))")
        counts = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in TABLES}
    print(f"完成：{counts}")


if __name__ == "__main__":
    main()
