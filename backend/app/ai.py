"""
Azure OpenAI 封裝。

每個能力（對話、視覺、embedding、生圖）各自判斷是否已設定；未設定時回傳示範結果，
並在回應中標示 mode = "demo"，讓前端顯示「示範模式」。
"""

from __future__ import annotations

import base64
import json
import math
from datetime import datetime

from openai import AzureOpenAI

from .config import azure


def _meta(mode: str, model: str = "") -> dict:
    return {"mode": mode, "model": model, "generated_at": datetime.now().isoformat(timespec="seconds")}


class AIService:
    def __init__(self) -> None:
        self._chat = None
        self._image = None
        if azure.endpoint and azure.api_key:
            self._chat = AzureOpenAI(
                api_key=azure.api_key, azure_endpoint=azure.endpoint, api_version=azure.api_version
            )
        if azure.image_endpoint and azure.image_api_key and azure.image_deployment:
            self._image = AzureOpenAI(
                api_key=azure.image_api_key,
                azure_endpoint=azure.image_endpoint,
                api_version=azure.image_api_version,
            )

    # ---- 狀態 ----
    @property
    def chat_ready(self) -> bool:
        return bool(self._chat and azure.chat_deployment)

    @property
    def embedding_ready(self) -> bool:
        return bool(self._chat and azure.embedding_deployment)

    @property
    def image_ready(self) -> bool:
        return self._image is not None

    def status(self) -> dict:
        return {
            "chat": self.chat_ready,
            "vision": self.chat_ready,
            "embedding": self.embedding_ready,
            "image": self.image_ready,
        }

    # ---- 對話（JSON 結構化輸出） ----
    def chat_json(self, system: str, user: str | list, max_tokens: int = 2000) -> tuple[dict | None, dict]:
        if not self.chat_ready:
            return None, _meta("demo")
        response = self._chat.chat.completions.create(
            model=azure.chat_deployment,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            # 新一代與推理模型只接受 max_completion_tokens（含推理 token，因此上限放寬），且不支援自訂 temperature
            max_completion_tokens=max_tokens,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content), _meta("azure", azure.chat_deployment)

    # ---- 視覺：學習庫圖片整理 ----
    def analyze_figure(self, image_bytes: bytes, mime: str, hint: str = "") -> tuple[dict, dict]:
        system = (
            "你協助醫師整理期刊圖表的學習筆記。只描述圖中呈現的內容，不做病人診斷或影像判讀。"
            "回傳 JSON：{\"title\": 繁體中文標題(20字內), \"topic\": 主題分類, "
            "\"tags\": 3-6個繁中或英文醫學標籤, \"summary\": 一句繁體中文重點, "
            "\"extracted_text\": 圖中可辨識的文字(保留原文), "
            "\"source_guess\": 圖中可見的期刊、作者或年份(看不到則空字串)}"
        )
        data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"
        user = [
            {"type": "text", "text": f"醫師補充：{hint}" if hint else "請整理這張圖表。"},
            {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
        ]
        result, meta = self.chat_json(system, user, max_tokens=3000)
        if result is None:
            result = {
                "title": "", "topic": "", "tags": [], "summary": "",
                "extracted_text": "", "source_guess": "",
            }
        return result, meta

    # ---- Embedding ----
    def embed(self, text: str) -> list[float] | None:
        if not self.embedding_ready or not text.strip():
            return None
        response = self._chat.embeddings.create(model=azure.embedding_deployment, input=text[:8000])
        return response.data[0].embedding

    # ---- 圖片生成 ----
    def generate_image(self, prompt: str, size: str = "1024x1024") -> tuple[bytes | None, dict]:
        if not self.image_ready:
            return None, _meta("demo")
        response = self._image.images.generate(
            model=azure.image_deployment, prompt=prompt, size=size, quality=azure.image_quality, n=1
        )
        item = response.data[0]
        if getattr(item, "b64_json", None):
            return base64.b64decode(item.b64_json), _meta("azure", azure.image_deployment)
        return None, _meta("azure", azure.image_deployment)


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


ai = AIService()
