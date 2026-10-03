"""新手家醫看診助手後端入口。"""

from __future__ import annotations

import time

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .ai import ai
from .config import DRUG_DB, FRONTEND_DIR, UPLOAD_DIR
from .db import app_db, init_app_db
from .routers import library

app = FastAPI(title="新手家醫看診助手 API", version="0.2.0")


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """前端檔案每次都向伺服器確認是否有新版（開發期間修改後重新整理即可看到）。"""
    response = await call_next(request)
    if not request.url.path.startswith(("/api", "/uploads")):
        response.headers["Cache-Control"] = "no-cache"
    return response


def cleanup_orphan_uploads(max_age_hours: int = 6) -> int:
    """刪除上傳後沒有存成筆記（例如按了取消）且超過時限的檔案。"""
    folder = UPLOAD_DIR / "library"
    if not folder.is_dir():
        return 0
    with app_db() as con:
        used = {
            path
            for row in con.execute("SELECT image_path, audio_path FROM library_items")
            for path in row
            if path
        }
    cutoff = time.time() - max_age_hours * 3600
    removed = 0
    for file in folder.iterdir():
        if f"library/{file.name}" not in used and file.stat().st_mtime < cutoff:
            file.unlink()
            removed += 1
    return removed


@app.on_event("startup")
def startup() -> None:
    init_app_db()
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    cleanup_orphan_uploads()


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
