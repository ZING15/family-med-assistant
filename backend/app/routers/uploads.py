"""上傳與讀取檔案。

瀏覽器上傳分兩步：先 POST /api/uploads/sign 取得「上傳網址」與檔案鍵，再把檔案直接 PUT 到上傳網址。
雲端（Supabase）時上傳網址指向 Supabase，檔案不經過網站主機（Vercel 單次請求有 4.5MB 上限）；
本機開發時指向 /api/uploads/local/<鍵>。之後各功能只傳檔案鍵（例：library/abc.png）。
"""

from __future__ import annotations

import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, RedirectResponse
from pydantic import BaseModel

from .. import storage

router = APIRouter(tags=["uploads"])

IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif"}
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# 瀏覽器錄音在 Chrome 為 webm、Safari 為 mp4
AUDIO_EXTENSIONS = {".webm", ".mp3", ".mp4", ".m4a", ".wav", ".mpeg", ".mpga", ".aac", ".ogg"}
AUDIO_MIME_EXT = {
    "audio/webm": ".webm", "audio/mp4": ".m4a", "audio/x-m4a": ".m4a", "audio/m4a": ".m4a", "audio/aac": ".aac",
    "audio/mpeg": ".mp3", "audio/mp3": ".mp3", "audio/wav": ".wav", "audio/x-wav": ".wav",
    "audio/wave": ".wav", "audio/ogg": ".ogg", "video/webm": ".webm", "video/mp4": ".mp4",
}
AUDIO_MIME = {".webm": "audio/webm", ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".mp3": "audio/mpeg", ".mpeg": "audio/mpeg",
              ".mpga": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".ogg": "audio/ogg"}
MAX_AUDIO_BYTES = 25 * 1024 * 1024
# 看診錄音只用來轉文字，放在 tmp/，處理完立即刪除
FOLDERS = {"library-image": "library", "library-audio": "library", "voice": "tmp/voice"}


class SignIn(BaseModel):
    purpose: Literal["library-image", "library-audio", "voice"]
    filename: str = ""
    content_type: str = ""
    size: int = 0


def audio_ext(content_type: str, filename: str) -> str | None:
    mime = (content_type or "").split(";")[0].strip()
    return AUDIO_MIME_EXT.get(mime) or next((e for e in AUDIO_EXTENSIONS if (filename or "").lower().endswith(e)), None)


def audio_mime(key: str) -> str:
    return AUDIO_MIME.get("." + key.rsplit(".", 1)[-1].lower(), "audio/webm")


def load_upload(key: str, folder: str, kind: str) -> bytes:
    """讀取瀏覽器上傳的檔案；只接受指定資料夾內的鍵。"""
    if not key or not key.startswith(f"{folder}/"):
        raise HTTPException(404, f"找不到上傳的{kind}")
    try:
        data = storage.load(key)
    except storage.StorageError as error:
        raise HTTPException(502, str(error))
    if data is None:
        raise HTTPException(404, f"找不到上傳的{kind}，請重新上傳")
    return data


@router.post("/api/uploads/sign")
def sign_upload(body: SignIn):
    if body.purpose == "library-image":
        ext = IMAGE_TYPES.get(body.content_type)
        if not ext:
            raise HTTPException(415, "只接受 JPG、PNG、WebP 或 GIF 圖片")
        if body.size > MAX_IMAGE_BYTES:
            raise HTTPException(413, "圖片不可超過 10MB")
    else:
        ext = audio_ext(body.content_type, body.filename)
        if not ext:
            raise HTTPException(415, "只接受 mp3、m4a、wav、webm 或 mp4 音檔")
        if body.size > MAX_AUDIO_BYTES:
            raise HTTPException(413, "音檔不可超過 25MB（約 20 分鐘以內的錄音）")
        if body.size == 0:
            raise HTTPException(422, "音檔是空的，請重新錄音")
    key = f"{FOLDERS[body.purpose]}/{uuid.uuid4().hex}{ext}"
    try:
        target = storage.upload_target(key)
    except storage.StorageError as error:
        raise HTTPException(502, str(error))
    return {"key": key, "upload_url": target, "url": f"/uploads/{key}"}


@router.put("/api/uploads/local/{key:path}", status_code=204)
async def local_upload(key: str, request: Request):
    """本機開發用：取代 Supabase 的上傳網址。雲端模式不開放。"""
    if storage.USE_SUPABASE:
        raise HTTPException(404)
    data = await request.body()
    if len(data) > MAX_AUDIO_BYTES:
        raise HTTPException(413, "檔案太大")
    try:
        storage.save(key, data, request.headers.get("content-type", ""))
    except storage.StorageError as error:
        raise HTTPException(400, str(error))


@router.get("/uploads/{key:path}")
def read_upload(key: str):
    """學習庫圖片、衛教插圖等。雲端轉到有時效的簽名網址；本機直接回傳檔案。"""
    try:
        path = storage.local_path(key)
        if path:
            return FileResponse(path, headers={"Cache-Control": "private, max-age=86400"})
        url = storage.signed_url(key) if storage.USE_SUPABASE else None
    except storage.StorageError:
        raise HTTPException(404, "找不到檔案")
    if not url:
        raise HTTPException(404, "找不到檔案")
    # 簽名網址一小時內有效，瀏覽器快取 50 分鐘內的轉址
    return RedirectResponse(url, status_code=307, headers={"Cache-Control": "private, max-age=3000"})

