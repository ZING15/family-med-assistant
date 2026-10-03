"""集中管理路徑與環境變數設定。"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")

FRONTEND_DIR = ROOT / "frontend"
DATA_DIR = ROOT / "data"
UPLOAD_DIR = DATA_DIR / "uploads"
APP_DB = DATA_DIR / "app.sqlite"
DRUG_DB = DATA_DIR / "drug_reference" / "drug_reference.sqlite"


def env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


class AzureSettings:
    endpoint = env("AZURE_OPENAI_ENDPOINT")
    api_key = env("AZURE_OPENAI_API_KEY")
    api_version = env("AZURE_OPENAI_API_VERSION", "2024-10-21")
    chat_deployment = env("AZURE_OPENAI_CHAT_DEPLOYMENT")
    embedding_deployment = env("AZURE_OPENAI_EMBEDDING_DEPLOYMENT")
    # 圖片辨識可另用較強的模型（中文表格 OCR 品質差異大）；未設定時沿用對話模型
    vision_deployment = env("AZURE_OPENAI_VISION_DEPLOYMENT") or chat_deployment
    # 語音轉文字（gpt-4o-mini-transcribe 等）需要 2025-03-01-preview 以上的 API 版本
    transcribe_deployment = env("AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT")
    transcribe_api_version = env("AZURE_OPENAI_TRANSCRIBE_API_VERSION", "2025-03-01-preview")
    # 圖片生成模型常部署在不同區域的資源，因此允許另設端點與金鑰
    image_endpoint = env("AZURE_OPENAI_IMAGE_ENDPOINT") or endpoint
    image_api_key = env("AZURE_OPENAI_IMAGE_API_KEY") or api_key
    image_api_version = env("AZURE_OPENAI_IMAGE_API_VERSION", "2025-04-01-preview")
    image_deployment = env("AZURE_OPENAI_IMAGE_DEPLOYMENT")
    # gpt-image 系列：low / medium / high；開發用 low，簡報時可改 medium
    image_quality = env("AZURE_OPENAI_IMAGE_QUALITY", "low")


azure = AzureSettings()
