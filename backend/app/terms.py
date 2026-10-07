"""
衛教單用的台灣常見說法：依病灶找出病人熟悉的俗稱（本專案整理）與台語說法（教育部《臺灣台語常用詞辭典》）。

台語詞條只比對釋義開頭的病名（例：「痚呴：氣喘病、哮喘病。」），不比對整段釋義，
避免「雞仔目」（夜盲症）這類只在說明中提到雞眼的詞被誤配。
"""

from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path

from . import recommend as rec

DATA_DIR = Path(__file__).parent / "data"
MOE_SOURCE = "教育部《臺灣台語常用詞辭典》（CC BY-ND 3.0 TW）"
HEAD_SPLIT = re.compile(r"[，。、；（）()\s]+")
MAX_TAIWANESE = 6


@lru_cache
def colloquial() -> list[dict]:
    return json.loads((DATA_DIR / "colloquial_terms.json").read_text(encoding="utf-8"))["terms"]


@lru_cache
def taiwanese() -> list[dict]:
    path = DATA_DIR / "taiwanese_terms.json"
    if not path.is_file():
        return []
    terms = json.loads(path.read_text(encoding="utf-8"))["terms"]
    for t in terms:  # 釋義第一句（第一個義項）切成病名清單，例：「拉肚子、腹瀉。」→ {拉肚子, 腹瀉}
        first = t["meaning"].split("\n")[0].split("。")[0]
        t["_heads"] = {h for h in HEAD_SPLIT.split(first) if len(h) >= 2 and h != "病名"}
    return terms


def _keywords(topic: str) -> set[str]:
    words = {topic, *topic.split("／")}
    cond = rec.condition_by_name(topic)
    if cond:
        words |= {a for a in cond["aliases"] if re.search(r"[一-鿿]", a)}
    return {w for w in words if len(w) >= 2}


def for_topics(topics: list[str]) -> dict:
    """回傳 {"colloquial": [...], "taiwanese": [...]}，給 AI 挑選；兩者都只能從這裡選，不可自行編造。"""
    keys = set().union(*(_keywords(t) for t in topics)) if topics else set()
    found_colloquial = [c for c in colloquial() if keys & set(c["medical"]) or any(k in m or m in k for k in keys for m in c["medical"] if len(m) >= 2)]
    medical_names = keys | {m for c in found_colloquial for m in c["medical"]}
    exact, partial = [], []
    for t in taiwanese():
        if t["word"] in medical_names or any(t["word"] == x["word"] for x in exact + partial):
            continue  # 和華語同字（例：高血壓）的不必另外列
        entry = {"word": t["word"], "meaning": t["meaning"].split("\n")[0], "category": t["category"]}
        if t["_heads"] & medical_names:
            exact.append(entry)
        elif any(m in h for m in medical_names for h in t["_heads"]):  # 例：「氣喘」在「氣喘病」裡
            partial.append(entry)
    return {"colloquial": found_colloquial, "taiwanese": (exact + partial)[:MAX_TAIWANESE]}
