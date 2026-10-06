# 部署指南：把網站放到 Azure 給醫師試用

受測醫師用瀏覽器打開網址、輸入共用密碼就能使用，不需要安裝任何東西。

## 目前的部署（2026-10-06）

| 項目 | 值 |
|---|---|
| 網址 | https://tsuchedaily.azurewebsites.net |
| 自訂網域 | `tsuchedaily.com`（GoDaddy）：目前以 GoDaddy「轉址」導到上面的網址，網址列最後顯示 azurewebsites.net；`https://tsuchedaily.com` 要等 GoDaddy 憑證生效 |
| 訂閱 | Azure subscription 1 (Metaage)：**緯育的課程訂閱**（CSP，經銷商邁達特代管），費用由緯育支付，結訓後可能收回 |
| 租用戶 ID | `2e44da17-d0e9-42f9-98f6-4221f20368c3`（帳號 `26509@tibame.com`） |
| 資源群組 | `GAE26509RG`（學員只能用這個群組，不能自建；Foundry 資源也都在這裡） |
| App Service 方案 | `tsuchedaily-plan`，**F1 免費**，Linux，東亞（香港） |
| Web App | `tsuchedaily`，Python 3.13，只允許 HTTPS |
| 資料位置 | `/home/data/app.sqlite`、`/home/data/uploads/`（與本機的資料是分開的兩份） |

## 0. 先懂這幾個名詞

| 名詞 | 白話說明 | 在本專案的角色 |
|---|---|---|
| **Azure App Service** | 微軟代管的網站主機。你上傳程式，它負責開機、HTTPS、重開。不是虛擬機，不用自己管作業系統 | 跑 FastAPI 後端，同時提供前端網頁 |
| **資源群組（Resource Group）** | 一個資料夾，把同一個專案的雲端資源放在一起 | 本專案用課程提供的 `GAE26509RG` |
| **App Service 方案（Plan）** | 主機的規格與價格 | 目前用 **F1 免費**；要綁自訂網域、不休眠需升級 B1（約 US$13／月） |
| **應用程式設定（App settings）** | 雲端版的 `.env`，以環境變數提供給程式 | 放 Azure AI 金鑰、資料路徑、共用密碼 |
| **/home** | App Service 裡重開機也不會消失的磁碟 | 放筆記、病歷、上傳的圖片與錄音（`/home/data`） |
| **Azure CLI（`az`）** | 在終端機操作 Azure 的指令工具 | 本指南所有步驟都用它，每一步也都能在 Azure 入口網站用點選完成 |

### 部署後的架構

```
醫師的瀏覽器 ──HTTPS + 共用密碼──▶ Azure App Service（F1，Linux，Python 3.13）
                                   ├─ FastAPI：API 與前端網頁
                                   ├─ 藥品參考表、健保藥品表（唯讀，隨程式上傳）
                                   ├─ /home/data：筆記、病歷、衛教單、上傳檔（持久保存）
                                   └─ 呼叫 Foundry 的 Azure OpenAI／Azure Speech／MAI-Image（沿用同一組金鑰）
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

課程帳號是用 tibame.com 信箱註冊的 Microsoft 帳號，直接 `az login` 會找不到訂閱，要指定租用戶並用代碼登入：

```bash
az login --tenant 2e44da17-d0e9-42f9-98f6-4221f20368c3 --use-device-code
```

終端機會顯示網址與代碼：用瀏覽器打開網址、輸入代碼、選 `26509@tibame.com` 登入。完成後確認：

```bash
az account show --query "{訂閱: name, 帳號: user.name}" --output table
```

> 租用戶 ID 的找法：Azure 入口網站右上角頭像 →「切換目錄」→ 目錄識別碼。

## 2. 設定變數

後面的指令都會用到：

```bash
RG=GAE26509RG
APP=tsuchedaily
```

## 3. 建立方案與 Web App（第一次才需要，已完成）

```bash
az appservice plan create --name tsuchedaily-plan --resource-group $RG --location eastasia --sku F1 --is-linux
```

```bash
az webapp create --name $APP --resource-group $RG --plan tsuchedaily-plan --runtime "PYTHON:3.13" --https-only true
```

## 4. 設定啟動指令（第一次才需要，已完成）

```bash
az webapp config set --name $APP --resource-group $RG --startup-file "python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --app-dir backend"
```

> F1 不支援 Always On，閒置約 20 分鐘會休眠，下次打開要等 20–40 秒。升級 B1 後可加上 `--always-on true`。

## 5. 寫入應用程式設定（金鑰與共用密碼）

這個腳本會讀取你的 `.env`，把 Azure AI 設定連同雲端需要的設定一起寫入，並請你設定給醫師的共用密碼（至少 8 個字元，輸入時畫面不顯示）。金鑰不會顯示在畫面上。

```bash
python3 scripts/push_settings_to_azure.py $RG $APP
```

只改單一設定（不是金鑰的值）時：

```bash
az webapp config appsettings set --name $APP --resource-group $RG --settings AZURE_SPEECH_MODEL=azure-speech --output none
```

> 想自己看設定是否寫入：Azure 入口網站 → `tsuchedaily` → 設定 → 環境變數。
>
> **改設定會讓網站重新啟動。** 請等網站重啟完（約 1 分鐘）再做第 6 步，否則重啟可能撞上正在安裝的程式，出現 `No module named uvicorn` 而啟動失敗。

## 6. 打包並上傳

```bash
scripts/build_deploy_zip.sh
```

```bash
az webapp deploy --name $APP --resource-group $RG --src-path dist/deploy.zip --type zip
```

約需 1–3 分鐘（Azure 會安裝 Python 套件）。

> 指令偶爾回報 `HTTP_502` 或卡在 `Parsing the build logs`，但程式其實已經放上去了（`/home/site/wwwroot/output.tar.zst` 的時間是新的）。這時執行 `az webapp restart --name $APP --resource-group $RG` 讓網站載入新版即可。

## 7. 打開網站測試

```bash
open https://$APP.azurewebsites.net
```

瀏覽器跳出登入框時，帳號隨意填（例如 doctor），密碼填第 5 步設定的共用密碼。

建議檢查：

1. 左下角顯示「AI 已連線」。
2. 學習庫：分別用圖片、文字、語音各新增一則筆記。
3. 病歷與開藥：打開示範病歷，確認推薦、採用、藥品卡、健保標示都正常。
4. 衛教單：產生一份並產生衛教圖。

出問題時看即時記錄：

```bash
az webapp log tail --name $APP --resource-group $RG
```

或下載完整記錄：

```bash
az webapp log download --name $APP --resource-group $RG --log-file logs.zip
```

## 8. 自訂網域 tsuchedaily.com

**目前做法（F1）：GoDaddy 轉址。** F1 不能把自訂網域綁在 App Service 上，所以由 GoDaddy 把網域導過來：

1. GoDaddy →「我的產品」→ tsuchedaily.com 的「DNS」→「轉址」分頁 →「新增轉址」。
2. 轉到：`https://` + `tsuchedaily.azurewebsites.net`；類型：永久（301）；設定：**只轉址**（不要選遮罩，遮罩會用框架包住網站，登入框與錄音可能失效）。

`http://tsuchedaily.com` 設定後幾分鐘就能用；`https://tsuchedaily.com` 要等 GoDaddy 產生憑證（幾小時到一兩天）。

**正式做法（需升級 B1，要先取得講師同意）：**

```bash
az appservice plan update --name tsuchedaily-plan --resource-group $RG --sku B1
```

```bash
az webapp config hostname get-external-ip --webapp-name $APP --resource-group $RG
```

```bash
az webapp show --name $APP --resource-group $RG --query customDomainVerificationId --output tsv
```

到 GoDaddy 刪除轉址，新增兩筆 DNS 紀錄：A 紀錄 `@` → 上面查到的 IP；TXT 紀錄 `asuid` → 上面查到的驗證碼。生效後：

```bash
az webapp config hostname add --webapp-name $APP --resource-group $RG --hostname tsuchedaily.com
```

```bash
az webapp config ssl create --name $APP --resource-group $RG --hostname tsuchedaily.com
```

最後一行會申請 Azure 免費的 HTTPS 憑證，完成後網址列會一直顯示 `https://tsuchedaily.com`。

## 9. 交給受測醫師

傳給醫師的內容只需要：

- 網址：`https://tsuchedaily.azurewebsites.net`
- 共用密碼
- 提醒：
  - 這是練習工具，不是臨床建議。
  - 請勿輸入可識別病人的資料。
  - 所有受測醫師共用同一份學習庫與病歷，彼此看得到。
  - 第一次打開若很慢，是網站從休眠中醒來，等 20–40 秒即可。

## 10. 之後更新版本

改完程式後，重做第 6 步（打包＋上傳）。資料在 `/home/data`，不會因為更新而消失。`.env` 有新增或修改設定時，先做第 5 步、等網站重啟完，再做第 6 步。

## 11. F1 免費方案的限制

| 項目 | 限制 | 對本專案的影響 |
|---|---|---|
| 儲存空間 | 1 GB | 程式與藥品資料約 100 MB；筆記圖片每張約 1 MB、衛教圖每張約 2 MB，試用期夠用 |
| 記憶體 | 1 GB | 夠用，AI 都在 Foundry 執行 |
| 運算時間 | 官方標示每天 60 分鐘 CPU | 只算 CPU 真正在運算的時間，等 AI 回覆不太算；超過時網站停到隔天（台灣時間早上 8 點重置） |
| 流出流量 | 官方標示每天 165 MB | 最可能先碰到；主要來自圖片。超過時網站停到隔天 |
| 休眠 | 閒置約 20 分鐘 | 第一位打開的人要等 20–40 秒 |
| 自訂網域、Always On、自動備份 | 不支援 | 需升級 B1 |

AI 用量（Azure OpenAI、Speech、MAI-Image）另外按使用量計費，記在同一個緯育訂閱，與主機方案無關。只有用到 AI 功能時才會計費，衛教圖最貴（按張計費，產生後會存檔重複使用）。

## 12. 暫停與刪除

| 動作 | 指令 | 說明 |
|---|---|---|
| 暫停 | `az webapp stop --name $APP --resource-group $RG` | 網站停止，醫師打不開 |
| 恢復 | `az webapp start --name $APP --resource-group $RG` | |
| 備份資料 | Azure 入口網站 → `tsuchedaily` → 進階工具（Kudu）→ 檔案總管，下載 `/home/data/app.sqlite` 與 `uploads` | 結訓前建議先備份 |
| 刪除網站 | `az webapp delete --name $APP --resource-group $RG` | 網站與雲端資料一起刪除 |
| 刪除方案 | `az appservice plan delete --name tsuchedaily-plan --resource-group $RG` | 先刪網站才能刪方案 |

> ⚠️ **不要刪除整個資源群組**（`az group delete`）。`GAE26509RG` 裡還有你所有的 Foundry、Azure OpenAI 與其他課程資源，刪了會全部消失。

## 已知限制

- **多人共用同一份資料**：所有受測醫師看到同一個學習庫、同一批病歷，「不再推薦」等回饋也會互相影響；資料不會記錄是誰建立的。兩人同時修改同一筆資料時，後儲存的會蓋掉先儲存的。要分開需要加入個人帳號功能。
- **SQLite 放在網路磁碟**：同時大量寫入時可能變慢；幾位醫師試用沒有問題。
- **共用密碼**：適合小規模試用；正式上線應改用個人帳號登入（例如 Microsoft Entra ID）。
- **課程訂閱**：網站與資料放在緯育的訂閱，結訓後可能被收回。
