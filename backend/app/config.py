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
# 會變動的資料（筆記、病歷、上傳檔）。部署到雲端時指向持久磁碟，例如 Azure App Service 的 /home/data
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
    # 免費方案沒有生圖額度：預設關閉，衛教單卡片改顯示圖示；啟用付費後設 GEMINI_IMAGE_ENABLED=true
    image_enabled = env("GEMINI_IMAGE_ENABLED", "false").lower() in ("1", "true", "yes")


gemini = GeminiSettings()


class AzureSettings:
    endpoint = env("AZURE_OPENAI_ENDPOINT")
    api_key = env("AZURE_OPENAI_API_KEY")
    api_version = env("AZURE_OPENAI_API_VERSION", "2024-10-21")
    chat_deployment = env("AZURE_OPENAI_CHAT_DEPLOYMENT")
    embedding_deployment = env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
    # 圖片辨識可另用較強的模型（中文表格 OCR 品質差異大）；未設定時沿用對話模型
    vision_deployment = env("AZURE_OPENAI_VISION_DEPLOYMENT") or chat_deployment
    # 語音轉文字，二擇一：
    # 1. Azure Speech 快速轉錄（不需部署，用同一個 Foundry 資源的金鑰）
    #    azure-speech：預設模型，直接接受瀏覽器錄音的 webm／m4a；MAI-Transcribe-2：需 ffmpeg 轉 WAV
    speech_model = env("AZURE_SPEECH_MODEL")
    speech_locale = env("AZURE_SPEECH_LOCALE", "zh-TW")
    speech_endpoint = env("AZURE_SPEECH_ENDPOINT") or endpoint
    speech_api_key = env("AZURE_SPEECH_API_KEY") or api_key
    speech_api_version = env("AZURE_SPEECH_API_VERSION", "2025-10-15")
    # 2. Azure OpenAI 部署（gpt-4o-mini-transcribe 等，需要 2025-03-01-preview 以上的 API 版本）
    transcribe_deployment = env("AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT")
    transcribe_api_version = env("AZURE_OPENAI_TRANSCRIBE_API_VERSION", "2025-03-01-preview")
    # 圖片生成模型常部署在不同區域的資源，因此允許另設端點與金鑰
    image_endpoint = env("AZURE_OPENAI_IMAGE_ENDPOINT") or endpoint
    image_api_key = env("AZURE_OPENAI_IMAGE_API_KEY") or api_key
    image_api_version = env("AZURE_OPENAI_IMAGE_API_VERSION", "2025-04-01-preview")
    image_deployment = env("AZURE_OPENAI_IMAGE_DEPLOYMENT")
    # 只對 gpt-image 系列有效：low / medium / high；MAI-Image 不使用
    image_quality = env("AZURE_OPENAI_IMAGE_QUALITY", "low")


azure = AzureSettings()
