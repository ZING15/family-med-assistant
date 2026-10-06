# 部署指南：把學習庫與病歷開藥放到 Azure 給醫師試用

目標：產生一個網址（例如 `https://family-med-xxxx.azurewebsites.net`），受測醫師用瀏覽器打開、輸入共用密碼就能使用，不需要安裝任何東西。

## 0. 先懂這幾個名詞

| 名詞 | 白話說明 | 在本專案的角色 |
|---|---|---|
| **Azure App Service** | 微軟代管的網站主機。你上傳程式，它負責開機、HTTPS、重開。 | 跑 FastAPI 後端，同時提供前端網頁 |
| **資源群組（Resource Group）** | 一個資料夾，把同一個專案的雲端資源放在一起。 | 測試結束時刪掉整個群組，就不會再計費 |
| **App Service 方案（Plan）** | 主機的規格與價格。 | 用 **B1**（1 核、1.75 GB），約 US$13–18／月，按小時計費 |
| **應用程式設定（App settings）** | 雲端版的 `.env`，以環境變數提供給程式。 | 放 Azure OpenAI 金鑰、資料路徑、共用密碼 |
| **/home** | App Service 裡重開機也不會消失的磁碟。 | 放筆記、病歷、上傳的圖片與錄音（`/home/data`） |
| **Azure CLI（`az`）** | 在終端機操作 Azure 的指令工具。 | 本指南所有步驟都用它，每一步也都能在 Azure 入口網站用點選完成 |

### 部署後的架構

```
醫師的瀏覽器 ──HTTPS + 共用密碼──▶ Azure App Service（B1，Linux，Python 3.13）
                                   ├─ FastAPI：API 與前端網頁
                                   ├─ 藥品參考表（唯讀，隨程式上傳）
                                   ├─ /home/data：筆記、病歷、上傳檔（持久保存）
                                   └─ 呼叫 Azure OpenAI／Azure Speech（沿用你現在的金鑰）
```

### 使用到的技術

| 部分 | 技術 |
|---|---|
| 主機 | Azure App Service（Linux）＋ Oryx 自動建置（依 `requirements.txt` 安裝套件） |
| 後端執行 | Uvicorn 執行 FastAPI，單一程序（SQLite 不適合多程序同時寫入） |
| 資料 | SQLite，放在 App Service 的持久磁碟 `/home/data` |
| 語音轉文字 | Azure Speech 快速轉錄（預設模型），直接接受瀏覽器錄音，不需要 ffmpeg |
| 存取控制 | HTTP Basic 驗證（`APP_PASSWORD`），瀏覽器會跳出登入框 |
| 金鑰管理 | App Service 應用程式設定；`.env` 不會被上傳 |

---

## 1. 安裝 Azure CLI 並登入

```bash
brew install azure-cli
```

```bash
az login
```

瀏覽器會開啟登入頁，用你建立 Azure OpenAI 的那個帳號登入。完成後確認目前的訂閱：

```bash
az account show --query "{訂閱: name, 帳號: user.name}" --output table
```

> 有多個訂閱時，用 `az account list --output table` 查看，再用 `az account set --subscription "<名稱或 ID>"` 切換。

## 2. 決定名稱與區域

在終端機設定三個變數，後面的指令會用到。App 名稱會成為網址的一部分，**必須全球唯一**，只能用英文小寫、數字與連字號。

```bash
RG=family-med-rg
APP=family-med-<你的代號>
LOCATION=eastasia
```

`eastasia` 是香港機房，離台灣近、速度快。

## 3. 建立資源群組、方案與 Web App

```bash
az group create --name $RG --location $LOCATION
```

```bash
az appservice plan create --name family-med-plan --resource-group $RG --sku B1 --is-linux
```

先確認 Azure 支援的 Python 版本（看到 `PYTHON:3.13` 就用它，沒有就改用清單中最新的 3.x）：

```bash
az webapp list-runtimes --os linux --output tsv | grep PYTHON
```

```bash
az webapp create --name $APP --resource-group $RG --plan family-med-plan --runtime "PYTHON:3.13"
```

## 4. 設定啟動指令

告訴 Azure 怎麼啟動程式，並開啟 Always On（避免閒置後第一次打開要等很久）：

```bash
az webapp config set --name $APP --resource-group $RG --always-on true --startup-file "python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir backend"
```

## 5. 寫入應用程式設定（金鑰與共用密碼）

這個腳本會讀取你的 `.env`，把 Azure AI 設定連同雲端需要的設定一起寫入，並請你設定給醫師的共用密碼。金鑰不會顯示在畫面上。

```bash
python3 scripts/push_settings_to_azure.py $RG $APP
```

> 想自己看設定是否寫入：Azure 入口網站 → 你的 App → 設定 → 環境變數。

## 6. 打包並上傳

```bash
scripts/build_deploy_zip.sh
```

```bash
az webapp deploy --name $APP --resource-group $RG --src-path dist/deploy.zip --type zip
```

第一次上傳約需 3–6 分鐘（Azure 會安裝 Python 套件）。

## 7. 打開網站測試

```bash
open https://$APP.azurewebsites.net
```

瀏覽器跳出登入框時，帳號隨意填（例如 doctor），密碼填第 5 步設定的共用密碼。

建議檢查：

1. 左下角顯示「AI 已連線」。
2. 學習庫：分別用圖片、文字、語音各新增一則筆記。
3. 病歷與開藥：打開示範病歷，確認推薦、採用、藥品卡都正常。

出問題時看即時記錄：

```bash
az webapp log tail --name $APP --resource-group $RG
```

## 8. 交給受測醫師

傳給醫師的內容只需要：

- 網址：`https://<你的 App 名稱>.azurewebsites.net`
- 共用密碼
- 提醒：
  - 這是練習工具，不是臨床建議。
  - 請勿輸入可識別病人的資料。
  - 所有受測醫師共用同一份學習庫與病歷，彼此看得到。

## 9. 之後更新版本

改完程式後，只要重做第 6 步（打包＋上傳）。資料在 `/home/data`，不會因為更新而消失。

## 10. 費用與關閉

| 動作 | 指令 | 說明 |
|---|---|---|
| 暫停 | `az webapp stop --name $APP --resource-group $RG` | 網站停止，但 B1 方案仍會計費 |
| 降到免費方案 | `az appservice plan update --name family-med-plan --resource-group $RG --sku F1` | 不計主機費用，但每天 CPU 只有 60 分鐘、閒置會休眠 |
| 全部刪除 | `az group delete --name $RG` | 測試結束後執行，主機與資料一起刪除，之後不再計費 |

AI 用量（Azure OpenAI、Speech）另外按使用量計費，與主機費用無關。

## 已知限制

- **多人共用同一份資料**：所有受測醫師看到同一個學習庫、同一批病歷，「不再推薦」等回饋也會互相影響。要分開需要加入個人帳號功能。
- **SQLite 放在網路磁碟**：同時大量寫入時可能變慢；幾位醫師試用沒有問題。
- **共用密碼**：適合小規模試用；正式上線應改用個人帳號登入（例如 Microsoft Entra ID）。
