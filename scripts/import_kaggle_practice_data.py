"""Create a local-only, de-identified practice-data bundle for the prototype.

This importer intentionally excludes names, dates of birth, and medicine fields.
It does not validate medical accuracy and must not be used to drive diagnosis or treatment.
"""

from __future__ import annotations

import csv
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "data" / "raw" / "medical data.csv"
OUTPUT = ROOT / "data" / "medical-practice-cases.js"


def clean(value: str | None) -> str:
    return " ".join((value or "").replace("\x00", "").split())


def main() -> None:
    if not INPUT.exists():
        raise SystemExit(f"Missing input file: {INPUT}")

    with INPUT.open(encoding="utf-8-sig", newline="") as source:
        rows = list(csv.DictReader(source))

    cases = []
    for number, row in enumerate(rows, start=1):
        symptoms = clean(row.get("Symptoms"))
        if not symptoms:
            continue
        cases.append(
            {
                "id": f"practice-{number:03d}",
                "gender": clean(row.get("Gender")),
                "symptoms": symptoms,
                "documentedCause": clean(row.get("Causes")),
                "datasetLabel": clean(row.get("Disease")),
            }
        )

    bundle = {
        "notice": "Local practice data only. Dataset labels are not diagnoses and must not guide treatment.",
        "source": "Kaggle: joymarhew/medical-reccomadation-dataset (license shown as Unknown)",
        "caseCount": len(cases),
        "cases": cases,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(
        "/* Generated locally. Do not publish until source licensing is verified. */\n"
        f"window.practiceCases = {json.dumps(bundle, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"Created {OUTPUT} with {len(cases)} de-identified practice cases.")


if __name__ == "__main__":
    main()
