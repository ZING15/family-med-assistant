"""
Azure OpenAI 封裝。

每個能力（對話、視覺、embedding、語音轉文字、生圖）各自判斷是否已設定；未設定時回傳示範結果，
並在回應中標示 mode = "demo"，讓前端顯示「示範模式」。
"""

from __future__ import annotations

import base64
import json
import math
import re
from datetime import datetime
from pathlib import Path

from openai import AzureOpenAI

from .config import azure


def _meta(mode: str, model: str = "") -> dict:
    return {"mode": mode, "model": model, "generated_at": datetime.now().isoformat(timespec="seconds")}


# 學習庫三種輸入共用的輸出格式；source_* 只在內容中明確出現時才填
NOTE_FIELDS = (
    "\"title\": 繁體中文標題(20字內), \"topic\": 主題分類(例：皮膚科／蟲咬), "
    "\"tags\": 3-6個繁中或英文醫學標籤, \"summary\": 1-2句繁體中文重點, "
    "\"source_title\": 引用的期刊、指南或文章名稱(多個以；分隔), "
    "\"source_year\": 出版年份(4位數), "
    "\"source_url\": 內容中出現的網址或 DOI(DOI 請轉成 https://doi.org/ 開頭)"
)
SOURCE_RULE = (
    "來源欄位：把內容中出現的參考資料都列進 source_title，包含表格的「參考文獻」欄、引用標籤"
    "（例如 OpenEvidence 的「AFP + 1」「Medical Entomo…」這類縮寫或被截斷的名稱，照原樣列出並去重）、"
    "圖說、頁尾、作者年份（例如 Stanley 2017）。年份與 DOI 也只在內容中出現時才填。"
    "完全看不到任何參考資料才留空字串，不可自行杜撰期刊名稱。"
)
EMPTY_NOTE = {
    "title": "", "topic": "", "tags": [], "summary": "",
    "source_title": "", "source_year": "", "source_url": "", "extracted_text": "",
}


def _normalize(result: dict | None) -> dict:
    data = {**EMPTY_NOTE, **(result or {})}
    if isinstance(data["tags"], str):
        data["tags"] = [t.strip() for t in data["tags"].replace("，", ",").split(",") if t.strip()]
    for key in ("title", "topic", "summary", "source_title", "source_year", "source_url", "extracted_text"):
        data[key] = str(data[key] or "").strip()
    # 引用標籤常帶「+ 1」之類的計數（例：AFP + 2），去掉計數後去重
    sources = [re.sub(r"\s*\+\s*\d+$", "", part).strip() for part in re.split(r"[;；]", data["source_title"])]
    data["source_title"] = "；".join(dict.fromkeys(part for part in sources if part))
    return data


class AIService:
    def __init__(self) -> None:
        self._chat = None
        self._image = None
        if azure.endpoint and azure.api_key:
            self._chat = AzureOpenAI(
                api_key=azure.api_key, azure_endpoint=azure.endpoint, api_version=azure.api_version
            )
        self._transcribe = None
        if azure.endpoint and azure.api_key and azure.transcribe_deployment:
            # 語音轉文字模型需要較新的 API 版本
            self._transcribe = AzureOpenAI(
                api_key=azure.api_key,
                azure_endpoint=azure.endpoint,
                api_version=azure.transcribe_api_version,
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
    def transcribe_ready(self) -> bool:
        return self._transcribe is not None

    @property
    def image_ready(self) -> bool:
        return self._image is not None

    def status(self) -> dict:
        return {
            "chat": self.chat_ready,
            "vision": self.chat_ready,
            "embedding": self.embedding_ready,
            "transcribe": self.transcribe_ready,
            "image": self.image_ready,
        }

    # ---- 對話（JSON 結構化輸出） ----
    def chat_json(
        self, system: str, user: str | list, max_tokens: int = 2000, deployment: str = ""
    ) -> tuple[dict | None, dict]:
        if not self.chat_ready:
            return None, _meta("demo")
        deployment = deployment or azure.chat_deployment
        response = self._chat.chat.completions.create(
            model=deployment,
            messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
            response_format={"type": "json_object"},
            # 新一代與推理模型只接受 max_completion_tokens（含推理 token，因此上限放寬），且不支援自訂 temperature
            max_completion_tokens=max_tokens,
        )
        content = response.choices[0].message.content or "{}"
        return json.loads(content), _meta("azure", deployment)

    # ---- 學習庫：圖片 ----
    def analyze_figure(self, image_bytes: bytes, mime: str) -> tuple[dict, dict]:
        system = (
            "你協助醫師把期刊圖表、評估量表或醫學 AI 查詢結果的截圖整理成學習筆記。"
            "只描述圖中呈現的內容，不做病人診斷或影像判讀。"
            f"回傳 JSON：{{{NOTE_FIELDS}, \"extracted_text\": 圖中可辨識的文字(保留原文與表格結構)}}。"
            + SOURCE_RULE
        )
        data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"
        user = [
            {"type": "text", "text": "請整理這張圖。"},
            {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
        ]
        result, meta = self.chat_json(system, user, max_tokens=4000, deployment=azure.vision_deployment)
        return _normalize(result), meta

    # ---- 學習庫：文字與語音逐字稿 ----
    def analyze_text(self, text: str, spoken: bool = False) -> tuple[dict, dict]:
        kind = "醫師口述的語音逐字稿（可能有口語贅字或辨識錯字）" if spoken else "醫師寫的文字筆記"
        system = (
            f"你協助醫師整理學習筆記。以下是{kind}。不做病人診斷。"
            f"回傳 JSON：{{{NOTE_FIELDS}}}。" + SOURCE_RULE
        )
        result, meta = self.chat_json(system, text[:12000])
        return _normalize(result), meta

    # ---- 語音轉文字 ----
    def transcribe(self, audio_path: Path) -> tuple[str | None, dict]:
        if not self.transcribe_ready:
            return None, _meta("demo")
        with open(audio_path, "rb") as f:
            response = self._transcribe.audio.transcriptions.create(
                model=azure.transcribe_deployment,
                file=(audio_path.name, f),
                # 提示醫學情境，讓中英夾雜的專有名詞辨識更準
                prompt="以下是醫師以繁體中文口述的醫學學習筆記，可能夾雜英文醫學名詞。",
            )
        return response.text, _meta("azure", azure.transcribe_deployment)

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
