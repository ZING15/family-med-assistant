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
    conditions      TEXT NOT NULL DEFAULT '[]',        -- JSON：問題清單（POMR）[{name, source: keyword|semantic|ai|manual|voice, icd10, assessment, plan, custom}]
    removed_conditions TEXT NOT NULL DEFAULT '[]',     -- JSON：醫師手動移除、不再自動偵測的病灶
    dismissed       TEXT NOT NULL DEFAULT '[]',        -- JSON：這次不用 [{condition, atc}]
    prescriptions   TEXT NOT NULL DEFAULT '[]',        -- JSON：開藥區（每項的 condition 對應問題清單）
    visit_date      TEXT NOT NULL DEFAULT '',          -- 就診日期（醫師法第 12 條必載）
    vitals          TEXT NOT NULL DEFAULT '{}',        -- JSON：O 的生命徵象 bp、hr、bt、rr、spo2
    exam            TEXT NOT NULL DEFAULT '',          -- O：身體檢查與檢驗結果
    ai_plan         TEXT NOT NULL DEFAULT '{}',        -- JSON：AI 參考計畫（醫師寫完可對照，預設遮蔽）
    english_note    TEXT NOT NULL DEFAULT '',          -- 完成病歷時產生的英文 SOAP
    completed_at    TEXT NOT NULL DEFAULT '',
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

-- 衛教單（F-08／F-09）：AI 草稿經醫師編輯、確認後才能下載或存到學習庫
CREATE TABLE IF NOT EXISTS education_sheets (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    record_id    INTEGER,                              -- 從病歷產生時對應的練習病歷；主題衛教為空
    topic        TEXT NOT NULL DEFAULT '',             -- 病灶名稱（多個以、分隔）
    title        TEXT NOT NULL DEFAULT '',
    content      TEXT NOT NULL DEFAULT '{}',           -- JSON：about、medicines、care、warnings、image_scene
    image_path   TEXT NOT NULL DEFAULT '',             -- AI 衛教圖（uploads/education/），產生一次後重複使用
    image_meta   TEXT NOT NULL DEFAULT '{}',
    ai_meta      TEXT NOT NULL DEFAULT '{}',
    confirmed    INTEGER NOT NULL DEFAULT 0,           -- 醫師已確認
    confirmed_at TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL,
    updated_at   TEXT NOT NULL
);

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
    ("records", "visit_date", "TEXT NOT NULL DEFAULT ''"),
    ("records", "vitals", "TEXT NOT NULL DEFAULT '{}'"),
    ("records", "exam", "TEXT NOT NULL DEFAULT ''"),
    ("records", "ai_plan", "TEXT NOT NULL DEFAULT '{}'"),
    ("records", "english_note", "TEXT NOT NULL DEFAULT ''"),
    ("records", "completed_at", "TEXT NOT NULL DEFAULT ''"),
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
