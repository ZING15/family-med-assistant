# 練習資料

`medical-practice-cases.js` 由使用者指定的 Kaggle 資料集在本機轉換產生：

- 資料集：Medical Reccomandation dataSet
- 來源：https://www.kaggle.com/datasets/joymarhew/medical-reccomadation-dataset/data
- 擁有者：Joy Mathew
- 版本：1（2023-09-04）
- Kaggle 顯示授權：Unknown（於 2026-09-23 查閱）

## 使用限制

- 僅供本專案的本機練習與介面展示。
- 不可將原始資料或衍生資料公開發布、商業使用或重新散布，直到取得明確授權。
- 匯入時會移除 `Name` 和 `DateOfBirth` 欄位。
- `Disease` 僅改名為 `datasetLabel`，表示資料集的原始標記，**不是診斷**。
- `Medicine` 不會匯入前端資料，避免形成處方或用藥建議功能。

## 重新產生

將下載的 CSV 放入 `data/raw/medical data.csv` 後執行：

```bash
python3 scripts/import_kaggle_practice_data.py
```

輸出為 `data/medical-practice-cases.js`，可由原型直接載入。
