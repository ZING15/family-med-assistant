# 新手家醫看診助手（練習專案）

給新手家醫科醫師的看診輔助與學習工具。規格見 [產品規格_新手家醫看診助手.md](產品規格_新手家醫看診助手.md)（v0.2）。

> 練習資料，非臨床建議。病例為假資料；藥品資料來自 TFDA 開放資料。

## 功能進度

| 功能 | 狀態 |
|---|---|
| 圖像學習庫（上傳、來源必填、標籤、搜尋、檢視、編輯、刪除） | ✅ |
| 學習庫 AI 辨識與語意搜尋 | ✅ 已實作，待設定 Azure OpenAI 後測試 |
| 病歷、病灶偵測、用藥推薦、回饋、過敏排除、藥品卡 | 開發中 |
| 衛教單與 AI 衛教圖 | 開發中 |

## 啟動

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
python3 scripts/build_drug_reference.py      # 需先把 TFDA JSON 放在 data/raw/tfda/
backend/.venv/bin/uvicorn app.main:app --reload --app-dir backend
```

開啟 http://localhost:8000 。API 文件在 http://localhost:8000/docs 。

AI 功能需要把 `.env.example` 複製成 `.env` 並填入 Azure OpenAI 設定；沒有設定時以示範模式運作。

## 目錄

```
frontend/   原生 HTML／CSS／JS
backend/    FastAPI（app/main.py、routers/、ai.py）
scripts/    資料處理腳本（藥品參考表、Kaggle 練習資料）
data/       藥品參考表、上傳檔、app.sqlite（皆不進版控）
archive/    合成資料、規格 v0.1
```
# family-med-assistant
