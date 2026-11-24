"""上傳檔案的存放（學習庫圖片與錄音、衛教插圖）。

有設定 Supabase 時存到私人 bucket，否則存到本機 data/uploads（開發用）。
檔案一律以「鍵」（例：library/abc.png、education/12-care-xxx.png）表示，資料庫只存鍵。
網頁一律用 /uploads/<鍵> 讀取：本機直接回傳檔案；Supabase 則轉到有時效的簽名網址，
大檔不經過網站主機（Vercel 單次回應有 4.5MB 上限），網址外流也會過期。
瀏覽器上傳也不經過網站主機：先向後端要一個「上傳網址」，再直接把檔案送過去。
"""

from __future__ import annotations

import mimetypes
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .config import UPLOAD_DIR, supabase

USE_SUPABASE = supabase.ready
SIGNED_URL_SECONDS = 3600
KEY_PATTERN = re.compile(r"^[a-z]+(/[A-Za-z0-9_-]+)*/[A-Za-z0-9_.-]+$")


class StorageError(RuntimeError):
    pass


def _check(key: str) -> str:
    if not KEY_PATTERN.fullmatch(key or "") or ".." in key:
        raise StorageError("檔案路徑不正確")
    return key


def content_type(key: str) -> str:
    return mimetypes.guess_type(key)[0] or "application/octet-stream"


# ---------- Supabase Storage（REST API） ----------

def _auth_headers() -> dict:
    # 新版金鑰（sb_secret_ 開頭）只放 apikey 標頭，不是 JWT，不能放在 Authorization；舊版 service_role JWT 兩個都放
    if supabase.secret_key.startswith("sb_"):
        return {"apikey": supabase.secret_key}
    return {"apikey": supabase.secret_key, "Authorization": f"Bearer {supabase.secret_key}"}


def _request(method: str, path: str, data: bytes | None = None, headers: dict | None = None, timeout: int = 60):
    request = urllib.request.Request(
        f"{supabase.url}/storage/v1/{path}", data=data, method=method,
        headers={**_auth_headers(), **(headers or {})},
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()
    except urllib.error.URLError as error:
        raise StorageError(f"無法連線檔案儲存：{error.reason}") from error


def _object(key: str) -> str:
    return f"object/{supabase.bucket}/{urllib.parse.quote(key)}"


def ensure_bucket() -> None:
    """第一次啟動時建立私人 bucket（已存在就略過）。"""
    if not USE_SUPABASE:
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        return
    status, _ = _request("GET", f"bucket/{supabase.bucket}")
    if status == 200:
        return
    body = f'{{"id":"{supabase.bucket}","name":"{supabase.bucket}","public":false,"file_size_limit":26214400}}'.encode()
    status, payload = _request("POST", "bucket", body, {"Content-Type": "application/json"})
    if status not in (200, 201) and b"already exists" not in payload:
        raise StorageError(f"建立檔案儲存空間失敗（{status}）：{payload[:200]!r}")


# ---------- 共用操作 ----------

def save(key: str, data: bytes, mime: str = "") -> None:
    key = _check(key)
    if not USE_SUPABASE:
        path = UPLOAD_DIR / key
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return
    status, payload = _request("POST", _object(key), data,
                               {"Content-Type": mime or content_type(key), "x-upsert": "true"}, timeout=120)
    if status not in (200, 201):
        raise StorageError(f"檔案儲存失敗（{status}）：{payload[:200]!r}")


def load(key: str) -> bytes | None:
    key = _check(key)
    if not USE_SUPABASE:
        path = UPLOAD_DIR / key
        return path.read_bytes() if path.is_file() else None
    status, payload = _request("GET", f"object/authenticated/{supabase.bucket}/{urllib.parse.quote(key)}", timeout=120)
    if status == 200:
        return payload
    if status in (400, 404):
        return None
    raise StorageError(f"讀取檔案失敗（{status}）")


def delete(*keys: str) -> None:
    keys = [_check(k) for k in keys if k]
    if not keys:
        return
    if not USE_SUPABASE:
        for key in keys:
            (UPLOAD_DIR / key).unlink(missing_ok=True)
        return
    import json

    _request("DELETE", f"object/{supabase.bucket}", json.dumps({"prefixes": keys}).encode(),
             {"Content-Type": "application/json"})


def signed_url(key: str) -> str | None:
    """Supabase：回傳有時效的下載網址；本機回傳 None（由網站直接送出檔案）。"""
    if not USE_SUPABASE:
        return None
    key = _check(key)
    import json

    status, payload = _request("POST", f"object/sign/{supabase.bucket}/{urllib.parse.quote(key)}",
                               json.dumps({"expiresIn": SIGNED_URL_SECONDS}).encode(), {"Content-Type": "application/json"})
    if status != 200:
        return None
    return f"{supabase.url}/storage/v1{json.loads(payload)['signedURL']}"


def upload_target(key: str) -> str:
    """給瀏覽器直接上傳用的網址（PUT 原始檔案內容）。"""
    key = _check(key)
    if not USE_SUPABASE:
        return f"/api/uploads/local/{key}"
    import json

    status, payload = _request("POST", f"object/upload/sign/{supabase.bucket}/{urllib.parse.quote(key)}",
                               b"{}", {"Content-Type": "application/json"})
    if status != 200:
        raise StorageError(f"無法建立上傳網址（{status}）")
    return f"{supabase.url}/storage/v1{json.loads(payload)['url']}"


def list_keys(prefix: str) -> list[tuple[str, float]]:
    """列出資料夾內的檔案與最後修改時間（秒），清除沒用到的上傳檔用。"""
    if not USE_SUPABASE:
        folder = UPLOAD_DIR / prefix
        return [(f"{prefix}/{f.name}", f.stat().st_mtime) for f in folder.iterdir() if f.is_file()] if folder.is_dir() else []
    import json
    from datetime import datetime

    status, payload = _request("POST", f"object/list/{supabase.bucket}",
                               json.dumps({"prefix": prefix, "limit": 1000}).encode(), {"Content-Type": "application/json"})
    if status != 200:
        return []
    keys = []
    for item in json.loads(payload):
        if item.get("id") is None:  # 子資料夾
            continue
        stamp = item.get("updated_at") or item.get("created_at") or ""
        try:
            mtime = datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()
        except ValueError:
            mtime = time.time()
        keys.append((f"{prefix}/{item['name']}", mtime))
    return keys


def local_path(key: str) -> Path | None:
    """本機模式的實際檔案路徑（Supabase 模式為 None）。"""
    if USE_SUPABASE:
        return None
    path = (UPLOAD_DIR / _check(key)).resolve()
    return path if str(path).startswith(str(UPLOAD_DIR.resolve())) and path.is_file() else None
