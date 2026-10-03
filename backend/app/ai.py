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
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid
from datetime import datetime
from pathlib import Path

from openai import AzureOpenAI
from opencc import OpenCC

from .config import azure

# MAI-Transcribe 的中文輸出為簡體，轉成台灣正體與用語
_to_traditional = OpenCC("s2twp").convert
SPEECH_FORMATS = {".wav", ".mp3", ".flac"}


class TranscriptionError(RuntimeError):
    pass


def _meta(mode: str, model: str = "") -> dict:
    return {"mode": mode, "model": model, "generated_at": datetime.now().isoformat(timespec="seconds")}


# 學習庫三種輸入共用的輸出格式；source_* 只在內容中明確出現時才填
NOTE_FIELDS = (
    "\"title\": 繁體中文標題(20字內), \"topic\": 主題(見主題規則), "
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
TOPIC_RULE = (
    "主題規則：topic 是以臨床問題為中心的主題，用 4-12 字的繁體中文片語，"
    "例如「咳嗽的處置」「蟲咬的問題」「上消化道出血評估」「兒童發燒」；不要用科別（皮膚科、小兒科）或「醫學知識」這類籠統名稱。"
)


def topic_instruction(topics: list[str]) -> str:
    if not topics:
        return TOPIC_RULE
    listed = "、".join(f"「{t}」" for t in topics[:60])
    return (
        TOPIC_RULE + f"現有主題：{listed}。內容屬於其中某個主題時，topic 必須一字不差地沿用該主題；"
        "只有和所有現有主題都無關時才建立新主題。"
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
        return self._transcribe is not None or bool(
            azure.speech_model and azure.speech_endpoint and azure.speech_api_key
        )

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
    def analyze_figure(self, image_bytes: bytes, mime: str, topics: list[str] = ()) -> tuple[dict, dict]:
        system = (
            "你協助醫師把期刊圖表、評估量表或醫學 AI 查詢結果的截圖整理成學習筆記。"
            "只描述圖中呈現的內容，不做病人診斷或影像判讀。"
            f"回傳 JSON：{{{NOTE_FIELDS}, \"extracted_text\": 圖中可辨識的文字(保留原文與表格結構)}}。"
            + SOURCE_RULE + topic_instruction(list(topics))
        )
        data_url = f"data:{mime};base64,{base64.b64encode(image_bytes).decode()}"
        user = [
            {"type": "text", "text": "請整理這張圖。"},
            {"type": "image_url", "image_url": {"url": data_url, "detail": "high"}},
        ]
        result, meta = self.chat_json(system, user, max_tokens=4000, deployment=azure.vision_deployment)
        return _normalize(result), meta

    # ---- 學習庫：文字與語音逐字稿 ----
    def analyze_text(self, text: str, spoken: bool = False, topics: list[str] = ()) -> tuple[dict, dict]:
        kind = "醫師口述的語音逐字稿（可能有口語贅字或辨識錯字）" if spoken else "醫師寫的文字筆記"
        system = (
            f"你協助醫師整理學習筆記。以下是{kind}。不做病人診斷。"
            f"回傳 JSON：{{{NOTE_FIELDS}}}。" + SOURCE_RULE + topic_instruction(list(topics))
        )
        result, meta = self.chat_json(system, text[:12000])
        return _normalize(result), meta

    # ---- 學習庫：重新整理主題 ----
    def propose_topics(self, items: list[dict]) -> tuple[dict | None, dict]:
        """把所有筆記重新歸類成臨床問題導向的主題，相關筆記合併到同一主題。"""
        system = (
            "你協助醫師整理學習庫的主題分類。" + TOPIC_RULE
            + "請把相關的筆記歸到同一個主題（主題數量盡量精簡，但不要硬把無關的內容合併）。"
            "回傳 JSON：{\"assignments\": [{\"id\": 筆記 id, \"topic\": 主題}]}，每筆筆記都要出現一次。"
        )
        lines = "\n".join(
            f"id={i['id']}｜標題：{i['title']}｜原主題：{i['topic']}｜標籤：{'、'.join(i['tags'])}｜摘要：{i['summary'][:80]}"
            for i in items
        )
        return self.chat_json(system, lines, max_tokens=3000)

    # ---- 語音轉文字 ----
    def transcribe(self, audio_path: Path) -> tuple[str | None, dict]:
        if self._transcribe is not None:
            with open(audio_path, "rb") as f:
                response = self._transcribe.audio.transcriptions.create(
                    model=azure.transcribe_deployment,
                    file=(audio_path.name, f),
                    # 提示醫學情境，讓中英夾雜的專有名詞辨識更準
                    prompt="以下是醫師以繁體中文口述的醫學學習筆記，可能夾雜英文醫學名詞。",
                )
            return _to_traditional(response.text), _meta("azure", azure.transcribe_deployment)
        if azure.speech_model and azure.speech_endpoint and azure.speech_api_key:
            return _to_traditional(self._speech_transcribe(audio_path)), _meta("azure", azure.speech_model)
        return None, _meta("demo")

    def _speech_transcribe(self, audio_path: Path) -> str:
        """Azure Speech 快速轉錄 API（enhancedMode 指定 MAI-Transcribe 模型）。"""
        with tempfile.TemporaryDirectory() as tmp:
            path = audio_path if audio_path.suffix in SPEECH_FORMATS else _convert_to_wav(audio_path, Path(tmp))
            definition = {
                "enhancedMode": {
                    "enabled": True,
                    "model": azure.speech_model,
                    # clean：去除「嗯、呃」等贅字，適合整理成筆記
                    "modelOptions": {"transcribeStyle": "clean"},
                }
            }
            boundary = uuid.uuid4().hex
            body = (
                f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{path.name}"\r\n'
                f"Content-Type: application/octet-stream\r\n\r\n"
            ).encode() + path.read_bytes() + (
                f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="definition"\r\n\r\n'
                f"{json.dumps(definition)}\r\n--{boundary}--\r\n"
            ).encode()
        host = azure.speech_endpoint.rstrip("/")
        request = urllib.request.Request(
            f"{host}/speechtotext/transcriptions:transcribe?api-version={azure.speech_api_version}",
            data=body,
            headers={
                "Ocp-Apim-Subscription-Key": azure.speech_api_key,
                "Content-Type": f"multipart/form-data; boundary={boundary}",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                result = json.loads(response.read())
        except urllib.error.HTTPError as error:
            raise TranscriptionError(f"語音服務回應 {error.code}：{error.read().decode()[:200]}") from error
        except urllib.error.URLError as error:
            raise TranscriptionError(f"無法連線語音服務：{error.reason}") from error
        return " ".join(p["text"] for p in result.get("combinedPhrases", []))

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


def _convert_to_wav(source: Path, folder: Path) -> Path:
    """瀏覽器錄音多為 webm／m4a，MAI-Transcribe 只收 WAV／MP3／FLAC，以 ffmpeg 轉成 16kHz 單聲道 WAV。"""
    if not shutil.which("ffmpeg"):
        raise TranscriptionError("伺服器需要安裝 ffmpeg 才能轉換這個音檔格式（brew install ffmpeg）")
    target = folder / f"{source.stem}.wav"
    result = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-ac", "1", "-ar", "16000", str(target)],
        capture_output=True, text=True, timeout=120,
    )
    if result.returncode != 0:
        raise TranscriptionError(f"音檔轉換失敗：{result.stderr.strip()[:200]}")
    return target


def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


ai = AIService()
