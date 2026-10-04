"""新手家醫看診助手後端入口。"""

from __future__ import annotations

import base64
import secrets
import time

from fastapi import FastAPI
from fastapi.responses import PlainTextResponse
from fastapi.staticfiles import StaticFiles

from .ai import ai
from .config import APP_PASSWORD, DRUG_DB, FRONTEND_DIR, UPLOAD_DIR
from .db import app_db, init_app_db
from .routers import education, library, records

app = FastAPI(title="新手家醫看診助手 API", version="0.2.0")


@app.middleware("http")
async def no_cache_frontend(request, call_next):
    """前端檔案每次都向伺服器確認是否有新版（開發期間修改後重新整理即可看到）。"""
    response = await call_next(request)
    if not request.url.path.startswith(("/api", "/uploads")):
        response.headers["Cache-Control"] = "no-cache"
    return response


def _password_ok(header: str) -> bool:
    """HTTP Basic 驗證：帳號不限，只比對密碼。"""
    if not header.startswith("Basic "):
        return False
    try:
        _, _, password = base64.b64decode(header[6:]).decode("utf-8").partition(":")
    except ValueError:
        return False
    return secrets.compare_digest(password.encode(), APP_PASSWORD.encode())


@app.middleware("http")
async def require_password(request, call_next):
    """有設定 APP_PASSWORD 時，瀏覽器會跳出登入視窗；避免網址外流後被任意使用 AI 額度。"""
    if APP_PASSWORD and not _password_ok(request.headers.get("authorization", "")):
        return PlainTextResponse(
            "需要密碼才能使用新手家醫看診助手", status_code=401,
            headers={"WWW-Authenticate": 'Basic realm="family-med-assistant", charset="UTF-8"'},
        )
    return await call_next(request)


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
    records.seed_records()


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "ai": ai.status(),
        "drug_reference": DRUG_DB.is_file(),
        "notice": "練習資料，非臨床建議",
    }


app.include_router(library.router)
app.include_router(records.router)
app.include_router(education.router)

UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
