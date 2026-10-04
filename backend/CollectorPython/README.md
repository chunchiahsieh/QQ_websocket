# Python 採集器：jason-mt 測試

`collector.py` 在本機以三個獨立工作程序採集 MT、DG、歐博，分別解碼成現有牌桌欄位並透過 HTTP 完整快照上傳 `jason-mt`。只作模擬桌況收集，不會下注。每個平台可單獨啟動、停止；官方連線失敗不會重新啟動另外兩個平台。測試程式只允許 `jason-mt` 單一目標，不接正式站。

在 PowerShell 執行 `& 'C:\Disk F\Aga\jshen-sync-worktree\backend\CollectorPython\start_jason_test.ps1'`。它在記憶體中讀取既有 C# 採集器的加密帳號與金鑰，不改寫設定。看到 `>` 提示後輸入 `start ALL` 一次啟動三平台，或輸入 `start MT`、`start DG`、`start AB` 分別啟動；用 `stop MT` 等指令個別停止，`status` 查狀態，`quit` 停止全部。啟動時預設三平台全停，必須手動選擇。不要同時讓 C# 採集器向同一測試站送同一平台，以免快照租約衝突。

Render 使用 `render-worker.yaml` 建立獨立背景工作服務，`Dockerfile` 啟動 `collector.py --start-all`，自動執行 MT／DG／歐博，且只上傳至 `https://jason-mt.onrender.com/`。官方帳密與上傳金鑰只能放在 Render 私密環境變數，不可提交至 Git。本機 `start_jason_test.ps1` 仍維持手動啟停。

完成的驗證：Python 單元測試涵蓋 MT／DG／歐博基本封包與欄位映射；2026-10-04 本機 MT 實連並上傳 14 桌快照至 `jason-mt`，Live 桌照片也已確認顯示。Render 來源 IP 的官方連線須在部署後另行驗證。官方登入若回 403，程式停止該平台，不會快速重試。

`collector.py` 目前不使用下述觀看人數生命週期原型；平台啟停由本機操作者控制。

另外保留的 `collector_probe.py` 是唯讀官方連線探針，與真正的採集器不同。
`collector_probe.py` **不會上傳桌況，也不是可取代 C# 的正式採集器**：
收到 WebSocket 封包仍須移植及驗證 C# 的 MT 標準化、DG／歐博解碼後，才能稱作採集成功。
不會投注，不會輸出帳密、授權網址或原始封包。

環境變數：`TZ_USERNAME`、`TZ_PASSWORD`、`TZ_OFFICIAL_URL`、
`TZ_DEVICE_ID`、`COLLECTOR_INGEST_KEY`、`COLLECTOR_DESTINATIONS`。
`COLLECTOR_DESTINATIONS` 是 0 到多個網址的 JSON 陣列；所有網址共用一把上傳金鑰。
0 個網址 (`[]`) 只測官方連線。區網 HTTP 僅允許私有 IP；正式站使用 HTTPS。
不要把密碼或金鑰寫入檔案、命令列、Git 或日誌。

本地測試：在此目錄執行 `python -m unittest discover -s tests`。
完整驗收順序：官方授權 → 官方 WebSocket → 收到封包 → 解出桌況 →
每個指定網址各自確認收到完整快照。MT 本機已完成；Render 端與 DG／歐博仍需逐一確認。
