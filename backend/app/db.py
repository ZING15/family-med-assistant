"""SQLite 連線與應用資料表結構。"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime

from .config import APP_DB, DRUG_DB

SCHEMA = """
CREATE TABLE IF NOT EXISTS library_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    kind            TEXT NOT NULL DEFAULT 'figure',   -- figure | drug | education | note
    title           TEXT NOT NULL,
    topic           TEXT NOT NULL DEFAULT '',
    tags            TEXT NOT NULL DEFAULT '[]',       -- JSON array
    note            TEXT NOT NULL DEFAULT '',
    source_title    TEXT NOT NULL DEFAULT '',
    source_url      TEXT NOT NULL DEFAULT '',
    source_year     TEXT NOT NULL DEFAULT '',
    image_path      TEXT NOT NULL DEFAULT '',
    extracted_text  TEXT NOT NULL DEFAULT '',
    ai_summary      TEXT NOT NULL DEFAULT '',
    ai_meta         TEXT NOT NULL DEFAULT '{}',       -- JSON: model, mode, generated_at
    ref_type        TEXT NOT NULL DEFAULT '',         -- 例如 atc、education
    ref_id          TEXT NOT NULL DEFAULT '',
    embedding       TEXT NOT NULL DEFAULT '',         -- JSON array，未設定 AI 時為空
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def init_app_db() -> None:
    APP_DB.parent.mkdir(parents=True, exist_ok=True)
    with app_db() as con:
        con.executescript(SCHEMA)


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
def drug_db():
    """藥品參考表為唯讀。"""
    con = sqlite3.connect(f"file:{DRUG_DB}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    try:
        yield con
    finally:
        con.close()
