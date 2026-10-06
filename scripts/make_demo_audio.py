"""
用 Azure 語音合成（Text-to-Speech）把 demo 看診劇本轉成兩人對話的 mp3，給「語音看診」示範用。

用法：python3 scripts/make_demo_audio.py [劇本.txt]
預設劇本：測試資料/demo_看診對話_咳嗽發燒.txt；輸出同名 .mp3。
劇本格式：每行「醫師：…」或「病人：…」，# 開頭為註解。沿用 .env 的 Foundry 端點與金鑰。
"""

from __future__ import annotations

import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path
from urllib.parse import urlparse
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))
from app.config import azure  # noqa: E402

VOICES = {"醫師": "zh-TW-YunJheNeural", "病人": "zh-TW-HsiaoChenNeural"}
TURNS_PER_REQUEST = 8  # 分批合成，避免單次請求太長


def synthesize(turns: list[tuple[str, str]], out: Path) -> None:
    body = "".join(
        f'<voice name="{VOICES[who]}"><prosody rate="-5%">{escape(text)}</prosody><break time="700ms"/></voice>'
        for who, text in turns
    )
    ssml = f'<speak version="1.0" xml:lang="zh-TW" xmlns="http://www.w3.org/2001/10/synthesis">{body}</speak>'
    host = urlparse(azure.speech_endpoint).netloc
    request = urllib.request.Request(
        f"https://{host}/tts/cognitiveservices/v1", data=ssml.encode(),
        headers={"Ocp-Apim-Subscription-Key": azure.speech_api_key, "Content-Type": "application/ssml+xml",
                 "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3", "User-Agent": "family-med-assistant"},
    )
    with urllib.request.urlopen(request, timeout=180) as response:
        out.write_bytes(response.read())


def main() -> None:
    script = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "測試資料" / "demo_看診對話_咳嗽發燒.txt"
    turns = []
    for line in script.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        who, _, text = line.partition("：")
        if who in VOICES and text:
            turns.append((who, text))
    try:
        import imageio_ffmpeg
        ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        ffmpeg = "ffmpeg"
    with tempfile.TemporaryDirectory() as tmp:
        parts = []
        for i in range(0, len(turns), TURNS_PER_REQUEST):
            part = Path(tmp) / f"part{i:03d}.mp3"
            synthesize(turns[i:i + TURNS_PER_REQUEST], part)
            parts.append(part)
            print(f"已合成 {min(i + TURNS_PER_REQUEST, len(turns))}/{len(turns)} 句")
        listing = Path(tmp) / "list.txt"
        listing.write_text("".join(f"file '{p}'\n" for p in parts))
        out = script.with_suffix(".mp3")
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(listing),
                        "-c", "copy", str(out)], check=True)
    print(f"完成：{out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
