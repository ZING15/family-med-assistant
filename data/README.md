# 資料

本專案只使用政府資料開放平台上的 TFDA 開放資料（政府資料開放授權條款－第1版）。

## 原始資料（`raw/tfda/`）

| 資料夾 | 資料集 | 來源 |
|---|---|---|
| `license_36/` | 全部藥品許可證資料集 | https://data.gov.tw/dataset/9122 |
| `ahfs_40/` | 藥品藥理治療分類 AHFS/DI 碼 | https://data.gov.tw/dataset/9118 |
| `atc_41/` | 藥品藥理治療分類 ATC 碼 | https://data.gov.tw/dataset/9119 |
| `appearance_42/` | 藥品外觀（圖片不下載，只保留 TFDA 圖檔連結） | https://data.gov.tw/dataset/9120 |

## 產生的資料

| 檔案 | 說明 |
|---|---|
| `drug_reference/drug_reference.sqlite` | 執行 `python3 scripts/build_drug_reference.py` 產生的藥品參考表，程式唯讀使用 |
| `app.sqlite` | 學習庫、病歷、推薦回饋（程式執行時自動建立） |
| `uploads/` | 學習庫上傳的圖片與錄音 |

## 不採用的資料

- Kaggle「Medical Reccomandation dataSet」：授權標示為 Unknown，且重複、缺漏多，藥物欄多為「Rest」「Antibiotics」等籠統描述，2026-10-03 評估後移除。
- v0.1 的 Faker 合成病人資料與胸部 X 光樣本：產品不做影像判讀，2026-10-03 移除。
