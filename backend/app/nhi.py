"""
健保給付資訊：以 TFDA 許可證字號對到健保用藥品項（data/drug_reference/nhi_drugs.sqlite，
由 scripts/build_nhi_drugs.py 產生）。資料檔不存在時所有函式回傳空值，其他功能照常運作。

支付價為健保署公告的每個計價單位價格（錠、粒，或液劑的整瓶容量），不是病人自付額。
"""

from __future__ import annotations

import json
from functools import lru_cache

from .db import nhi_db


def _unit(qty: str, unit: str, form: str) -> str:
    """支付價的計價單位：有標示規格量（例如液劑 60 ML）就用規格量，否則依劑型推定。"""
    try:
        amount = float(qty or 0)
    except ValueError:
        amount = 0
    if amount > 0 and unit:
        return f"{amount:g} {unit}"
    if "膠囊" in form:
        return "粒"
    if "錠" in form:
        return "錠"
    return "單位"


@lru_cache(maxsize=1)
def covered_by_license() -> dict[str, list[dict]]:
    """許可證字號 → 目前有給付的健保代碼（依支付價由低到高）。"""
    result: dict[str, list[dict]] = {}
    with nhi_db() as con:
        if con is None:
            return result
        rows = con.execute(
            """SELECT nhi_code, license_no, price, price_start, next_price, next_price_start,
                      spec_qty, spec_unit, dosage_form, class_label
               FROM nhi_items WHERE is_covered = 1 AND license_no != '' ORDER BY price"""
        ).fetchall()
    for r in rows:
        result.setdefault(r["license_no"], []).append({
            "code": r["nhi_code"],
            "price": r["price"],
            "price_start": r["price_start"],
            "next_price": r["next_price"] if r["next_price"] not in (None, "") else None,
            "next_price_start": r["next_price_start"] or "",
            "unit": _unit(r["spec_qty"], r["spec_unit"], r["dosage_form"] or ""),
            "class_label": r["class_label"] or "",
        })
    return result


@lru_cache(maxsize=1)
def as_of() -> str:
    """健保資料的基準日（例如 2026-10-01）。"""
    with nhi_db() as con:
        if con is None:
            return ""
        row = con.execute("SELECT value FROM meta WHERE key = 'as_of'").fetchone()
    return json.loads(row["value"]) if row else ""


def for_license(license_no: str) -> list[dict]:
    return covered_by_license().get(license_no, [])


def summarize(license_nos: list[str]) -> dict:
    """一個成分底下的市售品項，有幾個健保給付、支付價範圍。"""
    covered = [codes for no in license_nos if (codes := for_license(no))]
    prices = [c["price"] for codes in covered for c in codes]
    units = {c["unit"] for codes in covered for c in codes}
    return {
        "covered_products": len(covered),
        "price_min": min(prices) if prices else None,
        "price_max": max(prices) if prices else None,
        # 計價單位一致（例如都是「錠」）時才顯示單位，混合劑型時只顯示價格範圍
        "unit": units.pop() if len(units) == 1 else "",
    }
