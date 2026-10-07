"""
下載教育部《臺灣台語常用詞辭典》三個分類（身體構造、傷疾病痛、醫療保健）的詞條，
存成 backend/app/data/taiwanese_terms.json，讓 AI 寫衛教單時加入病人熟悉的台語說法（例：皮蛇＝帶狀皰疹）。

授權：辭典文字以「創用CC 姓名標示－禁止改作 3.0 臺灣」釋出，因此詞目、音讀、釋義一律保留原文、不改寫，
並在檔案與畫面註明出處。

用法：python3 scripts/build_taiwanese_terms.py
"""

from __future__ import annotations

import html
import json
import re
import time
import subprocess
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "backend" / "app" / "data" / "taiwanese_terms.json"
CATEGORIES = {20: "身體構造", 43: "傷疾病痛", 44: "醫療保健"}
URL = "https://sutian.moe.edu.tw/zh-hant/hunlui/{cat}/?iahbe={page}&pitsoo=100"


def page_text(url: str) -> str:
    # 用 curl 下載：此網站憑證缺少 Subject Key Identifier，Python 3.13 的嚴格檢查會拒絕（curl 仍正常驗證憑證）
    raw = subprocess.run(["curl", "-sf", "--max-time", "60", "-A", "family-med-assistant/0.2 (education project)", url],
                         capture_output=True, check=True).stdout.decode("utf-8")
    raw = re.sub(r"<script.*?</script>|<style.*?</style>", "", raw, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", raw))
    lines = [l.strip() for l in text.split("\n") if l.strip()]
    start = lines.index("主內容區塊") if "主內容區塊" in lines else 0
    end = lines.index("頁腳區塊") if "頁腳區塊" in lines else len(lines)
    return "\n".join(lines[start:end])


def parse(text: str) -> list[dict]:
    # 每個詞條的結構：序號N 詞目 X 音讀 … 播放音讀… 釋義 …（可能多個義項）；把「序號N詞目」區塊切開逐一解析
    text = re.split(r"\n(?:分頁|重新選分類)\n", text)[0]
    blocks = re.split(r"\n序號\d+\S*\n(?=序號\n)", text)
    entries = []
    for block in blocks:
        m = re.search(r"詞目\n(?P<word>.+?)\n音讀\n(?P<roman>(?:[文白俗替]\n)?.+?)\n播放音讀.*?\n釋義\n(?P<meaning>.+?)(?:\n分頁|\n有\d+筆|$)", block, re.S)
        if not m:
            continue
        roman = m["roman"].split("\n")[-1]
        meaning = [l for l in m["meaning"].split("\n") if not re.fullmatch(r"\d+|第\d+頁|…|上一頁|下一頁|每頁\d+筆", l)]
        entries.append({"word": m["word"].split("\n")[0], "roman": roman, "meaning": "\n".join(meaning).strip()})
    return entries


def main() -> None:
    result = []
    for cat, name in CATEGORIES.items():
        first = page_text(URL.format(cat=cat, page=1))
        total = int(re.search(r"有(\d+)筆", first)[1])
        texts = [first]
        for page in range(2, (total + 99) // 100 + 1):
            time.sleep(1)
            texts.append(page_text(URL.format(cat=cat, page=page)))
        entries = [e | {"category": name} for t in texts for e in parse(t)]
        print(f"{name}：網站 {total} 筆，解析 {len(entries)} 筆")
        result += entries
    OUT.write_text(json.dumps({
        "_source": "教育部《臺灣台語常用詞辭典》分類索引：身體構造、傷疾病痛、醫療保健（https://sutian.moe.edu.tw/zh-hant/hunlui/20/、/43/、/44/）",
        "_license": "創用CC 姓名標示－禁止改作 3.0 臺灣（CC BY-ND 3.0 TW）。詞目、音讀、釋義為原文，未經改寫。",
        "_retrieved": date.today().isoformat(),
        "terms": result,
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"完成：{OUT.relative_to(ROOT)}（{len(result)} 筆）")


if __name__ == "__main__":
    main()
