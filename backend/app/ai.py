"""
AI 服務封裝：Google Gemini（Google AI Studio 金鑰）。

每個能力（對話、視覺、embedding、語音轉文字、生圖）都用同一把 GEMINI_API_KEY；未設定時回傳示範結果，
並在回應中標示 mode = "demo"，讓前端顯示「示範模式」。
模型暫時過載（503）時自動重試，再改用備用模型；額度用完（429）直接告知使用者。
"""

from __future__ import annotations

import io
import json
import math
import re
import time
from datetime import datetime

from opencc import OpenCC

from .config import gemini

# 逐字稿偶爾混入簡體字，轉成台灣正體與用語
_to_traditional = OpenCC("s2twp").convert
# 模型過載時依序改用的備用模型（第一個是設定的主要模型）
# 只用 Gemini API 免費層列出的模型；3.8 Flash 尖峰時常過載，排在最後
FALLBACK_CHAT_MODELS = ("gemini-3.5-flash-lite", "gemini-3.8-flash")
INLINE_AUDIO_LIMIT = 18 * 1024 * 1024   # 超過時改用 Files API 上傳


class AIServiceError(RuntimeError):
    """AI 服務錯誤；status 為 HTTP 狀態碼，message 為給使用者看的說明。"""

    def __init__(self, message: str, status: int = 502):
        super().__init__(message)
        self.message = message
        self.status = status


class TranscriptionError(RuntimeError):
    pass


class ImageGenerationError(RuntimeError):
    """生圖失敗；status 為 HTTP 狀態碼（404 找不到部署、429 太頻繁…），供 API 轉成白話訊息。"""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


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


def _friendly(error) -> AIServiceError:
    code = getattr(error, "code", 502) or 502
    message = str(getattr(error, "message", "") or error)[:200]
    if code == 429:
        return AIServiceError("AI 額度已用完或太頻繁，請稍後再試（免費額度不足時需在 Google AI Studio 啟用付費）", 429)
    if code in (503, 504):
        return AIServiceError("AI 模型目前使用人數過多，請稍後再試", 503)
    if code in (401, 403):
        return AIServiceError("Gemini 金鑰無效或沒有權限，請確認 GEMINI_API_KEY", code)
    return AIServiceError(f"AI 服務錯誤（{code}）：{message}", code)


def _parse_json(text: str) -> dict:
    text = (text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.S)
        if match:
            return json.loads(match.group(0))
        raise


class AIService:
    def __init__(self) -> None:
        self._client = None
        if gemini.api_key:
            from google import genai
            from google.genai import types

            self._client = genai.Client(api_key=gemini.api_key, http_options=types.HttpOptions(timeout=170_000))
        self._image_client = None
        if gemini.vertex_api_key:
            from google import genai
            from google.genai import types

            # GCP Agent Platform（express mode）：不需專案 ID，使用 global 端點
            self._image_client = genai.Client(vertexai=True, api_key=gemini.vertex_api_key,
                                              http_options=types.HttpOptions(timeout=170_000))
        elif self._client is not None and gemini.image_enabled:
            self._image_client = self._client

    # ---- 狀態 ----
    @property
    def chat_ready(self) -> bool:
        return self._client is not None

    @property
    def embedding_ready(self) -> bool:
        return self._client is not None

    @property
    def transcribe_ready(self) -> bool:
        return self._client is not None

    @property
    def image_ready(self) -> bool:
        return self._image_client is not None

    def status(self) -> dict:
        return {
            "chat": self.chat_ready,
            "vision": self.chat_ready,
            "embedding": self.embedding_ready,
            "transcribe": self.transcribe_ready,
            "image": self.image_ready,
        }

    # ---- 共用：呼叫模型（過載時重試並改用備用模型） ----
    def _generate(self, model: str, contents, config, timeout: int = 60) -> tuple[object, str]:
        """依序嘗試主要模型與備用模型。過載（500／503）先等 2 秒重試一次；逾時（504 或連線逾時）直接換下一個模型。
        每次呼叫最多等 timeout 秒，避免整個請求超過 Vercel 的 300 秒上限。"""
        from google.genai import errors, types

        config.http_options = types.HttpOptions(timeout=timeout * 1000)
        models = [model] + [m for m in FALLBACK_CHAT_MODELS if m != model]
        last = None
        for name in models:
            for attempt in range(2):
                try:
                    return self._client.models.generate_content(model=name, contents=contents, config=config), name
                except errors.APIError as error:
                    last = error
                    if error.code in (500, 503) and attempt == 0:
                        time.sleep(2)
                        continue
                    if error.code in (404, 500, 503, 504):
                        break  # 換下一個模型
                    raise _friendly(error) from error
                except Exception as error:  # 連線逾時等網路錯誤
                    if "timeout" not in type(error).__name__.lower() and "timed out" not in str(error).lower():
                        raise
                    last = AIServiceError("AI 模型回應逾時，請稍後再試", 503)
                    break
        if isinstance(last, AIServiceError):
            raise last
        raise _friendly(last)

    # ---- 對話（JSON 結構化輸出） ----
    def chat_json(
        self, system: str, user: str | list, max_tokens: int = 2000, deployment: str = ""
    ) -> tuple[dict | None, dict]:
        if not self.chat_ready:
            return None, _meta("demo")
        from google.genai import types

        config = types.GenerateContentConfig(
            system_instruction=system,
            response_mime_type="application/json",
            # 新一代模型的思考也算在輸出額度內，上限放寬避免 JSON 被截斷
            max_output_tokens=min(max(max_tokens * 4, 4096), 32768),
        )
        response, model = self._generate(deployment or gemini.chat_model, user, config)
        try:
            return _parse_json(response.text), _meta("gemini", model)
        except (json.JSONDecodeError, TypeError) as error:
            raise AIServiceError("AI 回傳的格式不完整，請再試一次") from error

    # ---- 學習庫：圖片 ----
    def analyze_figure(self, image_bytes: bytes, mime: str, topics: list[str] = ()) -> tuple[dict, dict]:
        from google.genai import types

        system = (
            "你協助醫師把期刊圖表、評估量表或醫學 AI 查詢結果的截圖整理成學習筆記。"
            "只描述圖中呈現的內容，不做病人診斷或影像判讀。"
            f"回傳 JSON：{{{NOTE_FIELDS}, \"extracted_text\": 圖中可辨識的文字(保留原文與表格結構)}}。"
            + SOURCE_RULE + topic_instruction(list(topics))
        )
        user = [types.Part.from_bytes(data=image_bytes, mime_type=mime), "請整理這張圖。"]
        result, meta = self.chat_json(system, user, max_tokens=4000, deployment=gemini.vision_model)
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

    # ---- 病歷：病灶擷取 ----
    def extract_conditions(self, text: str, names: list[str]) -> tuple[dict | None, dict]:
        system = (
            "你協助醫師從練習病歷中找出『病灶／問題』，只做擷取，不下診斷結論。"
            f"可用的病灶名稱：{'、'.join(names)}。"
            "只回傳病歷中明確提到或醫師評估中列出的問題，忽略被否認的症狀（例如「無發燒」）。"
            "回傳 JSON：{\"conditions\": [{\"name\": 必須是可用名稱之一, \"evidence\": 病歷中的原文片段}], "
            "\"other\": [病歷中有但不在可用名稱裡的問題，繁體中文]}"
        )
        return self.chat_json(system, text[:6000], max_tokens=1200)

    # ---- 病歷：現病史症狀（補對症用藥） ----
    def extract_symptoms(self, text: str, names: list[str]) -> tuple[dict | None, dict]:
        system = (
            "你協助醫師從病歷的主訴與現病史（S）找出病人目前有的症狀，用來提示對症用藥，只做擷取，不下診斷。"
            f"可用的症狀名稱：{'、'.join(names)}。病歷可能中英文混寫（例：rhinorrhea＝流鼻水、myalgia＝肌肉酸痛、odynophagia＝喉嚨痛）。"
            "只回傳病人本人目前明確有的症狀；被否認的不算（例：no cough、無發燒、denies fever），"
            "別人的症狀或接觸史也不算（例：「同學發燒」）。"
            "evidence 必須逐字複製病歷中的原文片段（不可改寫、翻譯或補字）。"
            "回傳 JSON：{\"symptoms\": [{\"name\": 必須是可用名稱之一, \"evidence\": 病歷原文片段}]}"
        )
        return self.chat_json(system, text[:6000], max_tokens=800)

    # ---- 病歷：看診錄音 → SOAP ----
    def soap_from_transcript(self, transcript: str, names: list[str]) -> tuple[dict | None, dict]:
        system = (
            "你協助家醫科門診醫師，把看診錄音的逐字稿整理成 SOAP 病歷。格式：S 主訴與現病史；O 身體檢查與檢驗；"
            "A 先列出問題清單，再寫一段統整評估；P 寫一段統整治療計畫（不必每個問題各寫一次）。"
            "逐字稿包含醫師與病人的對話，可能有口語贅字與語音辨識的同音錯字：請依醫學語境修正明顯錯字"
            "（例：變桃腺→扁桃腺、肺陰→肺音、消傳→哮喘、涼血壓→量血壓、38度板→38度半），但不可改變原意。"
            "只整理逐字稿中明確出現的內容，不可推測或補上沒說到的症狀、檢查數值、診斷或藥物；沒提到的欄位留空字串。"
            "chief_complaint：一句話主訴，含持續時間。"
            "history：現病史（時間經過、伴隨症狀、有意義的陰性症狀如「無咳嗽」、病人自述的發燒度數）、過去病史、目前用藥、過敏、生活史，可引用病人原話。"
            "exam：醫師說出的量測值（如 BT 37.8°C、BP 146/90 mmHg、HR 88/min）與身體檢查、檢驗結果，陽性與有意義的陰性發現都要寫。"
            "problems：本次處理的所有問題名稱，依嚴重度排序，包含醫師有交代處置的慢性病（例如「高血壓的藥繼續吃」→ 高血壓）。"
            f"可用病灶名稱：{'、'.join(names)}。同一種病請用可用名稱（例：急性扁桃腺炎、咽喉炎 → 扁桃腺炎／咽喉炎；感冒 → 急性上呼吸道感染）；"
            "真的不在清單的才寫簡短的繁中病名。"
            "assessment：醫師的判斷與依據，可用 #1、#2 對應問題清單，每個問題一行（例：#1 急性上呼吸道感染：發燒、無肺炎跡象，疑病毒感染）。"
            "plan：醫師口述的整體計畫（檢查、用藥與注意事項、衛教、回診與警訊），條列成數行，不重複寫問題名稱也可以。"
            "使用繁體中文（台灣用語），醫學名詞與藥名可保留英文。"
            '回傳 JSON：{"chief_complaint": "", "history": "", "exam": "", "problems": [""], "assessment": "", "plan": ""}'
        )
        return self.chat_json(system, transcript[:12000], max_tokens=3000)

    # ---- 病歷：AI 參考計畫（醫師自己寫完再對照） ----
    def plan_suggestions(self, record: dict) -> tuple[dict | None, dict]:
        system = (
            "你是家醫科主治醫師，替新手醫師的門診病歷寫一份參考用的醫療計畫（P），供他寫完後對照學習，不是最終醫囑。"
            "依病歷中的 S、O、問題清單與 A，寫一份統整的計畫：diagnostic（還需要的檢查或鑑別診斷）、"
            "therapeutic（治療：藥理類別或常用成分、非藥物治療；不寫具體劑量，避開病人的過敏與病史風險）、"
            "educational（衛教與告知重點）、follow_up（回診時機與需要立即回診的警訊）、consult（需要轉介或會診時才寫，否則留空）。"
            "每項 1-4 點，以「；」分隔，必要時用 #1、#2 標出對應的問題；簡潔、符合台灣門診常規。"
            "藥名一律寫英文學名（例：dextromethorphan、cetirizine），不要音譯成中文。資訊不足以判斷時，寫出需要先確認的事。"
            '回傳 JSON：{"diagnostic": "", "therapeutic": "", "educational": "", "follow_up": "", "consult": ""}'
        )
        return self.chat_json(system, json.dumps(record, ensure_ascii=False)[:12000], max_tokens=2000)

    # ---- 病歷：英文版 ----
    def english_note(self, record: dict) -> tuple[dict | None, dict]:
        system = (
            "Translate this Taiwanese family-medicine outpatient chart into a concise English SOAP note. "
            "Translate faithfully: do not add findings, diagnoses, doses or advice that are not in the input. "
            "Use standard clinical English and abbreviations (e.g. y/o, F/M, c/o, HPI, PE, BP, QD, BID, TID, PRN). "
            "Start directly with 'S:' (the date/patient line is added by the program). "
            "Use this structure; the example only shows the format, never copy its findings, drugs or numbers:\n"
            "S: <chief complaint>\n   HPI: <history, pertinent negatives, PMH, current meds, allergy history>\n"
            "O: <vital signs and physical exam / labs>\n"
            "A: #1 <problem> (<ICD-10-CM>)\n   #2 <problem> (<ICD-10-CM>)\n   <assessment, keep the #1/#2 references>\n"
            "P: <plan>\n   Rx: <drug frequency x days; ...>\n"
            "Translate every Chinese word into English (including allergy names, e.g. Penicillin類 → penicillins), "
            "Omit any line or section that has no content in the input (e.g. no 'Rx:' line without prescriptions, no 'O:' without findings). "
            'Return JSON: {"note": "<the English note>"}'
        )
        return self.chat_json(system, json.dumps(record, ensure_ascii=False)[:12000], max_tokens=3000)

    # ---- 藥品白話簡介 ----
    def drug_summary(self, concept: dict) -> tuple[dict | None, dict]:
        system = (
            "你協助新手家醫科醫師快速認識藥品成分，並準備給病人的白話說明。依一般藥品知識整理，不是仿單。"
            "不要給個別病人的劑量建議。回傳 JSON：{"
            "\"name_zh\": 成分的台灣常用中文名, "
            "\"purpose\": 一句白話說明這個藥用來做什麼(30字內), "
            "\"mechanism\": 作用機轉一句(40字內), "
            "\"common_usage\": 一般常見的用法頻率描述(例：每日一次、需要時使用；不寫劑量數字), "
            "\"frequency\": 從 QD、BID、TID、QID、HS、PRN 中選一個最常見的, "
            "\"cautions\": 2-4 項醫師開立前要留意的事(禁忌、交互作用、特殊族群)；交互作用要點名藥物類別與後果，例如「併用 MAOI 或 SSRI 可能引發血清素症候群」，不要寫「某些藥物」這類含糊說法, "
            "\"patient_tips\": 2-3 項給病人的白話提醒}"
        )
        user = (
            f"成分：{concept['name_en']}（ATC {concept['atc_code']}）\n"
            f"藥理分類：{concept.get('class_zh') or concept.get('ahfs_main_name_zh') or ''}\n"
            f"TFDA 許可證適應症範例：{concept.get('sample_indication') or ''}"
        )
        return self.chat_json(system, user, max_tokens=1200)

    # ---- 衛教單 ----
    def education_draft(self, topics: list[str], medicines: list[dict], audience: str = "") -> tuple[dict | None, dict]:
        """產生圖卡式衛教單草稿：每個重點 5–10 字，配一張插圖。用藥的頻率與天數由醫師決定，AI 不得更改或補充劑量。"""
        system = (
            "你協助台灣的家醫科醫師，把衛教做成「一眼看懂的圖卡式衛教單」，病人多為長輩，醫師會再修改確認。"
            "原則：只放最重要、和這個病最相關的重點；每個重點 5–10 個字，像海報標語，不寫完整句子、不解釋原因、不重複。"
            "有多個病灶時，以最需要注意的診斷為中心（例：流感比感冒、咳嗽重要），標題、照顧重點與警訊都要針對它與病人本次的症狀；"
            "會傳染的病要包含避免傳染家人的做法（例：戴口罩）。警訊挑這個病真正危險的情況，越具體越好（例：嘴唇發紫、叫不太醒）。"
            "用白話繁體中文，不用醫學術語。不寫任何劑量數字（毫克、顆數）、不改變醫師開立的頻率與天數、不做診斷或保證療效。"
            "回傳 JSON：{"
            "\"main\": 先從病灶中選出最需要注意的一個診斷（原樣照抄病灶名稱）, "
            "\"title\": 衛教單標題(12字內，以 main 為主並帶到最主要的症狀，例：流感發燒怎麼照顧), "
            "\"about\": 一句話(25字內)說明這是什麼、通常多久會好, "
            "\"medicines\": [對每個輸入藥品回傳 {\"atc_code\": 原樣帶回, \"name_zh\": 成分的台灣常用中文名(例：右美沙芬；不要寫劑型或「止咳藥」這類統稱), "
            "\"purpose\": 用途(8字內，例：退燒止痛), \"tip\": 具體的注意事項(10字內，例：會想睡、別開車；不可寫吃藥的時間或次數，那由醫師決定；沒有就空字串，不要寫「依醫囑」)}], "
            "\"care\": 3–4 個在家要做的重點（會傳染的病一定要有一張避免傳染家人，例：戴口罩勤洗手） [{\"text\": 5–10字(例：多喝溫開水), \"emoji\": 一個代表這件事的 emoji, "
            "\"scene\": 一句英文，只描述動作（例：drinking a cup of warm water），人物的年齡性別由程式決定，不要寫}], "
            "\"warnings\": 4–6 個要馬上就醫的警訊 [{\"text\": 5–10字(例：呼吸很喘), \"emoji\": 一個 emoji, "
            "\"scene\": 一句英文，只描述症狀的樣子（例：struggling to breathe, hand on chest），不要寫人物的年齡性別}]}"
        )
        lines = [f"病灶／主題：{'、'.join(topics)}"]
        if audience:
            lines.append(f"病人：{audience}")
        if medicines:
            lines.append("醫師開立的藥品（頻率與天數由醫師決定，只需寫用途與提醒）：")
            lines += [f"- atc_code={m['atc_code']}；{m.get('name', '')}；類別：{m.get('class_zh', '')}" for m in medicines]
        else:
            lines.append("這份是一般衛教，沒有開立藥品，medicines 回傳空陣列。")
        return self.chat_json(system, "\n".join(lines), max_tokens=2500)

    def education_card_image(self, scene: str, topic: str = "", person: str = "an adult", warning: bool = False) -> tuple[bytes | None, dict]:
        """圖卡插圖：一個重點一張，同一套畫風。
        依「主題＋對象＋這張卡的重點＋風格」組成提示：人物照病人的年齡性別畫，
        滿版、大而清楚的單一主體、高對比、色盲友善；紅色只留給回診警訊。不含文字與藥品，標語由網頁疊加。"""
        palette = (
            "a soft coral-red background to signal a warning sign, otherwise calm colors on the character"
            if warning else
            "a soft sage-green or sky-blue background, no red"
        )
        prompt = (
            "One card of a patient education infographic"
            f"{f' about {topic}' if topic else ''}. "
            f"Audience and main character: {person}. Draw the character to match this age and gender exactly. "
            f"This card shows: {scene}. "
            "Composition: a full-bleed square illustration that fills the entire canvas edge to edge with {palette}; "
            "no circle, no frame, no border, no white margins, no vignette. "
            "A single large, clear subject, upper body, the action or symptom instantly recognizable at a glance like a big icon. "
            "Style: warm and reassuring clean flat vector illustration, rounded shapes, bold clean outlines, high contrast, "
            "colorblind-friendly colors, consistent with a matching icon set. "
            "Strictly no text, no letters, no numbers, no speech bubbles, no logos, no pills, tablets, capsules or medicine packaging, no syringes."
        ).replace("{palette}", palette)
        return self.generate_image(prompt, size="1024x1024")

    def education_image(self, scene: str) -> tuple[bytes | None, dict]:
        """舊版衛教單的整張插圖：不含文字與藥品，中文說明由網頁疊加。"""
        prompt = (
            "A warm, gentle flat illustration for a patient health-education leaflet for elderly people in Taiwan. "
            f"Scene: {scene}. "
            "Style: soft hand-drawn flat shapes, calm muted palette of cream paper, sage green, soft blue and warm peach, "
            "rounded friendly forms, a balanced composition with the subject filling the center of the frame, simple uncluttered background. "
            "Strictly no text, no letters, no numbers, no logos, no pills, tablets, capsules or medicine packaging, "
            "no syringes or medical devices, no realistic or detailed faces."
        )
        return self.generate_image(prompt, size="1536x1024")

    # ---- 語音轉文字 ----
    def transcribe(self, data: bytes, mime: str) -> tuple[str | None, dict]:
        """錄音 → 繁體中文逐字稿（學習筆記口述或看診對話皆可）。"""
        if not self.transcribe_ready:
            return None, _meta("demo")
        from google.genai import types

        prompt = (
            "這是台灣醫師的錄音（可能是口述的學習筆記，或醫師與病人的看診對話）。"
            "請逐字轉錄成繁體中文（台灣用語），英文醫學名詞與藥名保留英文；"
            "不要摘要、不要加標題或說明，只輸出逐字稿。聽不清楚的地方略過，不要自行補寫。"
        )
        mime = mime.split(";")[0] or "audio/webm"
        if len(data) > INLINE_AUDIO_LIMIT:
            part = self._client.files.upload(file=io.BytesIO(data), config={"mime_type": mime})
        else:
            part = types.Part.from_bytes(data=data, mime_type=mime)
        config = types.GenerateContentConfig(max_output_tokens=32768)
        try:
            response, model = self._generate(gemini.transcribe_model, [part, prompt], config, timeout=150)
        except AIServiceError as error:
            raise TranscriptionError(error.message) from error
        text = _to_traditional((response.text or "").strip())
        # 模型有時在中文字之間加空格，去掉（英文詞之間的空格保留）
        text = re.sub(r"(?<=[\u3000-\u9fff\uff00-\uffef])[ \t]+(?=[\u3000-\u9fff\uff00-\uffef])", "", text)
        return text, _meta("gemini", model)

    # ---- Embedding ----
    def embed(self, text: str) -> list[float] | None:
        if not self.embedding_ready or not text.strip():
            return None
        vectors = self.embed_many([text[:8000]])
        return vectors[0] if vectors else None

    def embed_many(self, texts: list[str]) -> list[list[float]] | None:
        """一次取得多段文字的向量（每批最多 100 段）。"""
        if not self.embedding_ready or not texts:
            return None
        from google.genai import errors, types

        config = types.EmbedContentConfig(output_dimensionality=gemini.embedding_dim)
        vectors: list[list[float]] = []
        for start in range(0, len(texts), 100):
            batch = [t[:2000] or " " for t in texts[start:start + 100]]
            try:
                result = self._client.models.embed_content(model=gemini.embedding_model, contents=batch, config=config)
            except errors.APIError as error:
                raise _friendly(error) from error
            vectors += [list(e.values) for e in result.embeddings]
        return vectors

    # ---- 圖片生成 ----
    def generate_image(self, prompt: str, size: str = "1024x1024") -> tuple[bytes | None, dict]:
        if not self.image_ready:
            return None, _meta("demo")
        from google.genai import errors, types

        width, height = (int(x) for x in size.split("x"))
        ratio = "1:1" if width == height else ("3:2" if width > height else "2:3")
        # Agent Platform 規定這類模型的回應要同時包含文字與圖片
        config = types.GenerateContentConfig(response_modalities=["TEXT", "IMAGE"], image_config=types.ImageConfig(aspect_ratio=ratio))
        try:
            response = self._image_client.models.generate_content(model=gemini.image_model, contents=prompt, config=config)
        except errors.APIError as error:
            raise ImageGenerationError(error.code or 502, str(error.message or error)[:300]) from error
        parts = [p for c in (response.candidates or []) for p in (c.content.parts if c.content else []) if p.inline_data]
        provider = "GCP Agent Platform" if gemini.vertex_api_key else "Gemini API"
        meta = _meta("gemini", f"{gemini.image_model}（{provider}）") | {"size": ratio}
        if not parts:
            raise ImageGenerationError(400, "生圖要求被拒絕，可能觸發內容安全過濾")
        return parts[0].inline_data.data, meta


def cosine(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):  # 不同模型的向量（例：舊的 OpenAI 向量）不能比較
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


ai = AIService()
