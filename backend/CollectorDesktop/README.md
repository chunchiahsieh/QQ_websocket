# Windows 採集端 A

這個專案只在備用 PC 執行，**不會部署到 Render**。它的責任是：

1. 每 10 秒向 Render 查詢是否有觀看端需求。
2. 有需求時，以此電腦本機保存的官方採集帳號登入官方平台，取得 MTLI / DGLI 短效授權。
3. 直接在此電腦連 MT WebSocket，並以本機 Edge 擷取 DG 官方桌況。
4. 將已標準化的最新 MT / DG JSON POST 至 Render；觀看端只讀 Render 的共享資料。

它不包含投注功能、不儲存上游封包，也不將官方帳密傳給 Render。

## 一次性 Render 設定

在公開 `QQ_websocket` 服務新增環境變數 `COLLECTOR_INGEST_KEY`：隨機 32 字元以上字串。這個值只填入備用 PC 的「採集器上傳金鑰」欄位；不要放在一般觀看端網址或聊天訊息。

公開服務的新 API 為：

- `GET /api/collector/demand`：讀取 Render 的觀看需求。
- `POST /api/collector/ingest/MT`
- `POST /api/collector/ingest/DG`

三者都必須使用 `X-Collector-Ingest-Key`；採集器的金鑰與官方帳密在 Windows 上以目前使用者的 DPAPI 加密保存。

## 發行給備用 PC

在開發電腦執行：

```powershell
dotnet publish backend/CollectorDesktop/CollectorDesktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o .\dist\JshenCollector
```

將 `dist\JshenCollector` 整個資料夾複製到備用 PC，執行 `CollectorDesktop.exe`。首次填入 Render 網址、採集器金鑰、官方採集帳密後按「啟動採集端」。Windows Edge 必須已安裝。

## 可驗證的狀態

- Render：採集器能否讀取觀看需求。
- 需求：目前是否有人登入觀看端。
- 官方：官方登入與 MTLI/DGLI 授權。
- MT：官方 WebSocket、桌數與最後一次 POST。
- DG：本機 Edge、官方 WebSocket、桌數與最後一次 POST。

任何平台失敗只標記該平台並上傳離線狀態；不會清除另一個平台已發布的快照。
