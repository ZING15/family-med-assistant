"""SQLite 連線與應用資料表結構。"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime

from .config import APP_DB, DRUG_DB, NHI_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS library_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL DEFAULT 'figure',   -- figure（圖片）| note（文字）| voice（語音）| drug | education
    title           TEXT NOT NULL,
    topic           TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',       -- JSON array
    note            TEXT NOT NULL DEFAULT '',
    source_title    TEXT NOT NULL DEFAULT '',
    source_url      TEXT NOT NULL DEFAULT '',
    source_year     TEXT NOT NULL DEFAULT '',
    image_path      TEXT NOT NULL DEFAULT '',
    audio_path      TEXT NOT NULL DEFAULT '',
    extracted_text  TEXT NOT NULL DEFAULT '',
    ai_summary      TEXT NOT NULL DEFAULT '',
    ai_meta         TEXT NOT NULL DEFAULT '{}',       -- JSON: model, mode, generated_at
    ref_type        TEXT NOT NULL DEFAULT '',         -- 例如 atc、education
    ref_id          TEXT NOT NULL DEFAULT '',
    embedding       TEXT NOT NULL DEFAULT '',         -- JSON array，未設定 AI 時為空
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    patient_code    TEXT NOT NULL DEFAULT '',          -- 練習用代號，不可填真實身分
    age             TEXT NOT NULL DEFAULT '',
    sex             TEXT NOT NULL DEFAULT '',
    allergies       TEXT NOT NULL DEFAULT '[]',        -- JSON：過敏原 id 或 "atc:<code>"（個別藥品）
    chief_complaint TEXT NOT NULL DEFAULT '',
    history         TEXT NOT NULL DEFAULT '',
    assessment      TEXT NOT NULL DEFAULT '',
    conditions      TEXT NOT NULL DEFAULT '[]',        -- JSON：[{name, source: keyword|ai|manual}]
    removed_conditions TEXT NOT NULL DEFAULT '[]',     -- JSON：醫師手動移除、不再自動偵測的病灶
    dismissed       TEXT NOT NULL DEFAULT '[]',        -- JSON：這次不用 [{condition, atc}]
    prescriptions   TEXT NOT NULL DEFAULT '[]',        -- JSON：開藥區
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);

-- 醫師回饋：adopt（採用，排序加分）或 never（此病灶不再推薦）
CREATE TABLE IF NOT EXISTS drug_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    condition   TEXT NOT NULL,
    atc_code    TEXT NOT NULL,
    action      TEXT NOT NULL,
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback ON drug_feedback(condition, atc_code, action);

-- AI 產生的藥品白話簡介，每個成分只產生一次
CREATE TABLE IF NOT EXISTS drug_summaries (
    atc_code     TEXT PRIMARY KEY,
    summary      TEXT NOT NULL,
    model        TEXT NOT NULL,
    generated_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


# 既有資料庫補欄位：(資料表, 欄位, 定義)
MIGRATIONS = [
    ("library_items", "audio_path", "TEXT NOT NULL DEFAULT ''"),
]


def init_app_db() -> None:
    APP_DB.parent.mkdir(parents=True, exist_ok=True)
    with app_db() as con:
        con.executescript(SCHEMA)
        for table, column, definition in MIGRATIONS:
            columns = {row["name"] for row in con.execute(f"PRAGMA table_info({table})")}
            if column not in columns:
                con.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


@contextmanager
def app_db():
    con = sqlite3.connect(APP_DB)
    con.row_factory = sqlite3.Row
    try:
        yield con
        con.commit()
    finally:
        con.close()


@contextmanager
def nhi_db():
    """健保給付藥品表為唯讀；檔案不存在時回傳 None。"""
    if not NHI_DB.is_file():
        yield None
        return
    con = sqlite3.connect(f"file:{NHI_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()


@contextmanager
def drug_db():
    """藥品參考表為唯讀。"""
    con = sqlite3.connect(f"file:{DRUG_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()
