"""Vercel 的入口：Vercel 會找專案根目錄的 index.py 裡名為 app 的 ASGI 程式。

實際程式在 backend/app（本機開發仍用 uvicorn app.main:app --app-dir backend）。
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "backend"))

from app.main import app  # noqa: E402,F401
