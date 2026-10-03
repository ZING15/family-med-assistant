#!/usr/bin/env bash
# 打包要上傳到 Azure App Service 的檔案：dist/deploy.zip
# 只包含程式、前端與唯讀的藥品參考表、健保給付藥品表；不包含 .env（金鑰改在 Azure 的「應用程式設定」填寫）、
# 本機的筆記與病歷（app.sqlite、uploads），雲端會從空白資料開始，並自動建立 3 筆示範病歷。
set -euo pipefail
cd "$(dirname "$0")/.."

DRUG_DB=data/drug_reference/drug_reference.sqlite
if [ ! -f "$DRUG_DB" ]; then
  echo "找不到 $DRUG_DB，請先執行 python3 scripts/build_drug_reference.py" >&2
  exit 1
fi

rm -rf dist
mkdir -p dist/package/backend dist/package/data/drug_reference
cp -R backend/app dist/package/backend/
cp -R frontend dist/package/
cp "$DRUG_DB" dist/package/data/drug_reference/
# 健保給付藥品表（選用；沒有時網站照常運作，只是不顯示健保資訊）
NHI_DB=data/drug_reference/nhi_drugs.sqlite
if [ -f "$NHI_DB" ]; then
  cp "$NHI_DB" dist/package/data/drug_reference/
else
  echo "提醒：找不到 $NHI_DB，部署版不會顯示健保給付資訊（執行 python3 scripts/build_nhi_drugs.py 產生）" >&2
fi
# Azure 會在根目錄找 requirements.txt 並自動安裝套件
cp backend/requirements.txt dist/package/requirements.txt
find dist/package -name "__pycache__" -type d -prune -exec rm -rf {} +
find dist/package -name ".DS_Store" -delete

(cd dist/package && zip -qr ../deploy.zip .)
echo "完成：dist/deploy.zip（$(du -h dist/deploy.zip | cut -f1)）"
