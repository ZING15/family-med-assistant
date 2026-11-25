"""集中管理路徑與環境變數設定。"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")



def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


FRONTEND_DIR = ROOT / "frontend"
# 本機模式的資料（沒有設定 Supabase 時的筆記、病歷、上傳檔）
DATA_DIR = Path(env("APP_DATA_DIR") or ROOT / "data")
UPLOAD_DIR = DATA_DIR / "uploads"
APP_DB = DATA_DIR / "app.sqlite"
# 藥品參考表為唯讀，隨程式一起部署
DRUG_DB = ROOT / "data" / "drug_reference" / "drug_reference.sqlite"
# 健保給付藥品（scripts/build_nhi_drugs.py 產生；沒有這個檔時不顯示健保資訊）
NHI_DB = ROOT / "data" / "drug_reference" / "nhi_drugs.sqlite"
# 設定後整個網站需要密碼才能使用（給受測醫師的共用密碼）；本機開發留空
APP_PASSWORD = env("APP_PASSWORD")


# ---- 2026-11 起的雲端：Supabase（Postgres＋Storage）與 Gemini ----
# 有填 DATABASE_URL 就改用 Postgres；沒填時沿用本機 SQLite（開發用）
DATABASE_URL = env("DATABASE_URL")


class SupabaseSettings:
    url = env("SUPABASE_URL").rstrip("/")
    secret_key = env("SUPABASE_SECRET_KEY")
    bucket = env("SUPABASE_BUCKET", "uploads")   # 私人 bucket：圖片以有時效的簽名網址顯示

    @property
    def ready(self) -> bool:
        return bool(self.url and self.secret_key)


supabase = SupabaseSettings()


class GeminiSettings:
    api_key = env("GEMINI_API_KEY")
    chat_model = env("GEMINI_CHAT_MODEL", "gemini-3.6-flash")
    vision_model = env("GEMINI_VISION_MODEL") or chat_model
    transcribe_model = env("GEMINI_TRANSCRIBE_MODEL") or chat_model
    embedding_model = env("GEMINI_EMBEDDING_MODEL", "gemini-embedding-001")
    embedding_dim = int(env("GEMINI_EMBEDDING_DIM", "768"))
    image_model = env("GEMINI_IMAGE_MODEL", "gemini-3.1-flash-image")   # Nano Banana 2
    # 衛教插圖：AI Studio 免費層沒有生圖額度，改用 GCP Agent Platform（原 Vertex AI）的 express mode 金鑰
    # （@gmail.com 帳號免費 90 天、不需綁卡）。有填 VERTEX_API_KEY 就自動開啟插圖。
    vertex_api_key = env("VERTEX_API_KEY")
    # 沒有 GCP 金鑰、但 AI Studio 專案已付費時，可設 GEMINI_IMAGE_ENABLED=true 改用 AI Studio 畫圖
    image_enabled = bool(vertex_api_key) or env("GEMINI_IMAGE_ENABLED", "false").lower() in ("1", "true", "yes")


gemini = GeminiSettings()

