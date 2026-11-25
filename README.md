# 新手家醫看診助手

給剛上門診的家醫科醫師的看診輔助與學習工具：**學習庫、病歷與開藥、衛教單**。

- 線上版：https://family-med-assistant.vercel.app （不需登入）
- 作品簡報：[PPT/deck-final/新手家醫看診助手_作品集.pdf](PPT/deck-final/新手家醫看診助手_作品集.pdf)

> 練習資料，非臨床建議。病例為虛構的練習資料；藥品資料來自 TFDA 與健保署開放資料。系統只提出候選與草稿，寫入病歷或交給病人的內容都由醫師確認。

## 功能

| 功能 | 內容 |
|---|---|
| 學習庫 | 用圖片、文字或語音新增筆記；AI 辨識圖表、轉逐字稿、整理標題、主題與來源；以語意搜尋找回筆記 |
| 病歷與開藥 | SOAP 病歷（問題清單＋統整評估與計畫）；以關鍵字、語意與 AI 偵測問題與症狀；依病灶與症狀推薦藥品並排除過敏；頻率、天數、劑量可自訂；回診病人自動帶入年齡、過敏與過去就診；語音看診分段到 SOAP；AI 參考計畫；英文版病歷 |
| 衛教單 | 從病歷或主題產生圖卡式衛教單：每個重點一張插圖＋5–10 字標語，插圖人物依病人年齡與性別繪製；醫師確認後下載圖片 |

## 架構

| 部分 | 使用的服務 |
|---|---|
| 網站（FastAPI 後端＋原生 HTML／CSS／JS 前端） | Vercel（首爾 `icn1`），GitHub `main` 分支推送後自動部署 |
| 資料庫 | Supabase Postgres（首爾），經 Transaction pooler 連線 |
| 圖片與錄音 | Supabase Storage 私人 bucket；瀏覽器直接上傳，網站以一小時有效的簽名網址顯示 |
| AI | Google Gemini API：`gemini-3.6-flash`（文字整理、看圖、語音轉錄），過載時改用 `gemini-3.5-flash-lite`、`gemini-3.8-flash`；`gemini-embedding-001`（語意搜尋） |
| 衛教插圖 | `gemini-3.1-flash-image`（Nano Banana 2），經 GCP Agent Platform；設定 `VERTEX_API_KEY` 後開啟 |
| 藥品參考表 | TFDA、健保署開放資料整理成唯讀 SQLite，隨程式部署 |

部署與金鑰設定見 [部署指南.md](部署指南.md)。

## 本機開發

需要 Python 3.13。

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp .env.example .env      # 填入 Supabase 與 Gemini 金鑰；不填則使用本機 SQLite、AI 為示範模式
backend/.venv/bin/uvicorn app.main:app --reload --app-dir backend
```

開啟 http://localhost:8000 。API 文件在 http://localhost:8000/docs 。

- `.env` 有填 `DATABASE_URL`、`SUPABASE_*` 時，本機會直接讀寫雲端的資料庫與檔案。
- 沒有填時改用本機 `data/app.sqlite` 與 `data/uploads/`，第一次啟動會建立 5 筆練習病歷。

## 目錄

```
index.py            Vercel 入口（載入 backend/app/main.py 的 FastAPI app）
vercel.json         Vercel 設定（首爾區、函式最長 300 秒）
frontend/           原生 HTML／CSS／JS
backend/app/        FastAPI：main.py、routers/、ai.py（Gemini）、db.py（Postgres／SQLite）、storage.py（Supabase Storage／本機）
backend/app/data/   病灶、症狀、過敏、藥理類別、病史風險等對照表（待醫師確認）
data/drug_reference/ 藥品參考表與健保藥品表（唯讀 SQLite）
scripts/            藥品參考表建置、健保資料驗證、審閱表產生、資料轉移
demo素材/           示範用的語音、病例文字與說明
PPT/deck-final/     作品簡報（HTML 與 PDF）
```

## 資料

本專案只使用政府資料開放平台上的 TFDA 與健保署開放資料（政府資料開放授權條款－第1版）。

### 藥品參考表的來源

重建時把原始檔下載到 `data/raw/`，再執行 `scripts/build_drug_reference.py`、`scripts/build_nhi_drugs.py`（原始檔不進版控）。

| 資料集 | 來源 |
|---|---|
| 全部藥品許可證資料集 | https://data.gov.tw/dataset/9122 |
| 藥品藥理治療分類 AHFS/DI 碼 | https://data.gov.tw/dataset/9118 |
| 藥品藥理治療分類 ATC 碼 | https://data.gov.tw/dataset/9119 |
| 藥品外觀（只保留 TFDA 圖檔連結） | https://data.gov.tw/dataset/9120 |
| 健保用藥品項查詢檔 | https://data.gov.tw/dataset/23715 |
| 中文版 ICD-10-CM（核對病灶代碼） | https://data.gov.tw/dataset/177507 |

| 產生的檔案 | 說明 |
|---|---|
| `data/drug_reference/drug_reference.sqlite` | 藥品參考表：許可證、成分、ATC／AHFS 分類、外觀圖連結 |
| `data/drug_reference/nhi_drugs.sqlite` | 健保給付藥品：每個健保代碼一列、價格歷史，並以許可證字號對回 TFDA |
| `data/review/病灶用藥對照_審閱表.xlsx` | 給醫師審閱的病灶、ATC 類別、ICD-10-CM 核對與風險提醒（`scripts/build_review_sheet.py`） |

### 用語對照（`backend/app/data/`）

| 檔案 | 內容 | 來源與授權 |
|---|---|---|
| `taiwanese_terms.json` | 台語詞條 1219 筆（身體構造、傷疾病痛、醫療保健） | 教育部《臺灣台語常用詞辭典》https://sutian.moe.edu.tw ，CC BY-ND 3.0 TW |
| `colloquial_terms.json` | 台灣常見病名俗稱對照（例：皮蛇＝帶狀皰疹） | 本專案整理，待醫師確認 |

## 文件

| 文件 | 內容 |
|---|---|
| [產品規格_新手家醫看診助手.md](產品規格_新手家醫看診助手.md) | Persona、功能 F-01～F-10 與驗收條件、流程、技術與 AI 規劃 |
| [PRODUCT.md](PRODUCT.md) | 產品脈絡：使用者、使用情境、定位、產品原則 |
| [DESIGN.md](DESIGN.md) | 視覺設計系統「臨床手札」：色彩、字體、元件與規則 |
| [部署指南.md](部署指南.md) | Vercel、Supabase、Gemini 的設定與免費方案限制 |
| [驗證清單_健保藥品.md](驗證清單_健保藥品.md) | 健保給付藥品清單的人工核對步驟 |
| [demo素材/Demo素材.md](demo素材/Demo素材.md) | 示範用的筆記、語音與病例文字 |
