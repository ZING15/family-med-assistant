"""新手家醫看診助手後端入口。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .ai import ai
from .config import DRUG_DB, FRONTEND_DIR, UPLOAD_DIR
from .db import init_app_db
from .routers import library

app = FastAPI(title="新手家醫看診助手 API", version="0.2.0")


@app.on_event("startup")
def startup() -> None:
    init_app_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "ai": ai.status(),
        "drug_reference": DRUG_DB.is_file(),
        "notice": "練習資料，非臨床建議",
    }


app.include_router(library.router)

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
