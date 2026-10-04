# 新手家醫看診助手（練習專案）

給新手家醫科醫師的看診輔助與學習工具。

> 練習資料，非臨床建議。病例為假資料；藥品資料來自 TFDA 與健保署開放資料。

## 文件

| 文件 | 內容 |
|---|---|
| [產品規格_新手家醫看診助手.md](產品規格_新手家醫看診助手.md) | 需求的唯一依據：Persona、功能 F-01～F-10 與驗收條件、流程、技術與 AI 規劃、時程（v0.2） |
| [PRODUCT.md](PRODUCT.md) | 給設計工具 impeccable 讀的產品脈絡：使用者、使用情境、定位、產品原則 |
| [DESIGN.md](DESIGN.md) | 視覺設計系統「臨床手札」：色彩、字體、元件與規則 |
| [部署指南_Azure.md](部署指南_Azure.md) | 部署到 Azure App Service 給醫師試用的步驟 |
| [驗證清單_健保藥品.md](驗證清單_健保藥品.md) | 健保給付藥品清單的人工核對步驟（對照健保署官網） |

## 功能進度

| 功能 | 狀態 |
|---|---|
| 學習庫：圖片／文字／語音三種新增方式、標籤、搜尋、檢視、編輯、刪除 | ✅ |
| 學習庫 AI：圖片辨識、語音轉逐字稿、自動帶入來源、語意搜尋 | ✅ |
| 病歷、病灶偵測、用藥推薦、回饋、過敏排除、藥品卡 | ✅ |
| 衛教單：從病歷或主題產生 AI 草稿、直接編輯、醫師確認、下載圖片、存到學習庫 | ✅ |
| AI 衛教圖（gpt-image-1-mini） | ✅ 程式完成，待 Azure 部署生圖模型 |

## 啟動

需要 Python 3.13 與 ffmpeg（語音筆記轉檔用：`brew install ffmpeg`）。

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
python3 scripts/build_drug_reference.py      # 需先把 TFDA JSON 放在 data/raw/tfda/
python3 scripts/build_nhi_drugs.py           # 需先把健保 all1_*.TXT 放在 data/raw/nhi/
python3 scripts/verify_nhi_drugs.py          # 驗證健保藥品輸出
backend/.venv/bin/uvicorn app.main:app --reload --app-dir backend
```

開啟 http://localhost:8000 。API 文件在 http://localhost:8000/docs 。

AI 功能需要把 `.env.example` 複製成 `.env` 並填入 Azure OpenAI 設定；沒有設定時以示範模式運作。

## 目錄

```
frontend/   原生 HTML／CSS／JS
backend/    FastAPI（app/main.py、routers/、ai.py；app/data/ 為病灶、過敏、藥理類別對照表）
scripts/    藥品參考表建置、部署打包與設定腳本
data/       TFDA／健保署原始資料、藥品參考表、上傳檔、app.sqlite（皆不進版控）
```

## 資料

本專案只使用政府資料開放平台上的 TFDA 與健保署開放資料（政府資料開放授權條款－第1版）。

### 原始資料（`data/raw/tfda/`）

| 資料夾 | 資料集 | 來源 |
|---|---|---|
| `license_36/` | 全部藥品許可證資料集 | https://data.gov.tw/dataset/9122 |
| `ahfs_40/` | 藥品藥理治療分類 AHFS/DI 碼 | https://data.gov.tw/dataset/9118 |
| `atc_41/` | 藥品藥理治療分類 ATC 碼 | https://data.gov.tw/dataset/9119 |
| `appearance_42/` | 藥品外觀（圖片不下載，只保留 TFDA 圖檔連結） | https://data.gov.tw/dataset/9120 |

### 原始資料（`data/raw/nhi/`）

| 檔案 | 資料集 | 來源 |
|---|---|---|
| `all1_YYYMM_*.TXT` | 健保用藥品項查詢檔（Big5、固定寬度、含歷年價格；多檔為同一清單切段） | https://data.gov.tw/dataset/23715 |
| `健保用藥品項查詢檔欄位格式說明(109.01.09更新，更正末欄名稱).pdf` | 上述檔案的官方欄位位置說明，解析腳本依此切欄 | 健保署，與資料檔一同下載 |

### 產生的資料

| 檔案 | 說明 |
|---|---|
| `data/drug_reference/drug_reference.sqlite` | 執行 `scripts/build_drug_reference.py` 產生的藥品參考表，程式唯讀使用 |
| `data/drug_reference/nhi_drugs.sqlite` | 執行 `scripts/build_nhi_drugs.py` 產生：每個健保代碼一列（`is_covered` = 資料月份當日支付價 > 0）、價格歷史，並以健保代碼對回 TFDA 許可證字號 |
| `data/drug_reference/nhi_covered_drugs.csv` | 目前有健保給付的藥品清單（UTF-8 BOM，可用 Excel 開啟） |
| `data/app.sqlite` | 學習庫、病歷、推薦回饋（程式執行時自動建立，並建立 3 筆示範病歷） |
| `data/uploads/` | 學習庫上傳的圖片與錄音 |

### 不採用的資料

- Kaggle「Medical Reccomandation dataSet」：授權標示為 Unknown，且重複、缺漏多，藥物欄多為「Rest」「Antibiotics」等籠統描述，2026-10-03 評估後移除。
- v0.1 的 Faker 合成病人資料與胸部 X 光樣本：產品不做影像判讀，2026-10-03 移除。
