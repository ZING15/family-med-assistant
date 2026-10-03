"""
把本機 .env 的 Azure AI 設定，加上雲端執行需要的設定，寫入 Azure App Service 的「應用程式設定」。

用法：python3 scripts/push_settings_to_azure.py <資源群組> <App 名稱>

- 金鑰只會傳給 Azure，不會印在畫面上（az 指令使用 --output none）。
- 會詢問受測醫師要用的共用密碼（APP_PASSWORD），輸入時不顯示。
"""

from __future__ import annotations

import getpass
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# 雲端專用設定
CLOUD_SETTINGS = {
    "APP_DATA_DIR": "/home/data",                  # 筆記、病歷、上傳檔放在 App Service 的持久磁碟
    "SCM_DO_BUILD_DURING_DEPLOYMENT": "true",      # 上傳 zip 後由 Azure 自動安裝 requirements.txt
    "WEBSITES_ENABLE_APP_SERVICE_STORAGE": "true", # 確保 /home 為持久儲存
}


def read_env(path: Path) -> dict[str, str]:
    """讀取 .env：忽略註解與空值，並去掉行尾的「# 說明」。"""
    values = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #")[0].strip().strip('"').strip("'")
        if key.strip().startswith("AZURE_") and value:
            values[key.strip()] = value
    return values


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit("用法：python3 scripts/push_settings_to_azure.py <資源群組> <App 名稱>")
    group, app = sys.argv[1], sys.argv[2]

    env_file = ROOT / ".env"
    if not env_file.is_file():
        sys.exit("找不到 .env")
    settings = read_env(env_file)
    print("將寫入以下設定（只列名稱，不顯示內容）：")
    for key in sorted(settings):
        print(f"  {key}")

    password = getpass.getpass("請設定給受測醫師的共用密碼（輸入時不會顯示）：").strip()
    if len(password) < 8:
        sys.exit("密碼至少 8 個字元，請重新執行")
    settings |= CLOUD_SETTINGS | {"APP_PASSWORD": password}

    subprocess.run(
        ["az", "webapp", "config", "appsettings", "set", "--resource-group", group, "--name", app,
         "--settings", *[f"{k}={v}" for k, v in settings.items()], "--output", "none"],
        check=True,
    )
    print(f"完成：已寫入 {len(settings)} 項設定到 {app}")


if __name__ == "__main__":
    main()
