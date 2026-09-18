# 歐博常駐串流

入口固定為 https://www.cali7777.net/，使用 DG_BACKEND_USERNAME / DG_BACKEND_PASSWORD。
帳密只由後台送往指定登入頁，不回傳前端、不寫入來源碼。

登入監控系統後切換「歐博」，前端呼叫 `/api/ab/start` 取得單次票券，
再連接 `/ws/ab`。後台為歐博啟動獨立 Edge 瀏覽器；與 DG 各自保有自己的
登入工作階段、WebSocket、解碼器、快取與復原流程。前端離開分頁不關閉瀏覽器。
服務重新啟動後，各平台於下一次訂閱時重新啟動瀏覽器。

平台官網正常登入並自行管理上游訂閱與心跳；監控只接收桌況，沒有投注操作。
歐博已觀察到的 WebSocket 網域為 maofeiyan.com、51shengce.com 的子網域。
若平台日後換線，需核對後更新 allowlist。

資料欄位依官方公開前端 V4.23.29 的 TableDO / BacRoadmap 解碼：
getGameHall.D（AA 桌號、BB 桿名、DD 遊戲類型、II 荷官、HH 狀態、WW3 路單），
pushGameStatus、getCountDown、getRoadData、pushGameTableResults、pushGHDealer。
只保留百家樂類型 101、1011、1012、103、104、110、111。
路單按原順序；勝方 0/3/4 和、1/5 莊、2/6 閒；第 2、3 碼是莊閒點數。
狀態 102 對應洗牌中。沒有提供人數、照片或視訊時顯示缺少資料狀態。

2026-09-18 本機測試：36 桌快照及後續更新成功；再次訂閱 6 ms，generation 維持 1。
`node tests/ab-persistent-live.mjs` 是需要外部登入的手動測試。
`node --experimental-transform-types --test tests/ab-card.test.mjs tests/dg-card.test.mjs`
及 `dotnet run --project backend/DgRelay.Tests/DgRelay.Tests.csproj` 檢查路單與後台狀態處理。
健康狀態可由 `/health/ab` 讀取；`/health` 繼續提供 DG 狀態。

荷官照片使用完整 II / pushGHDealer.BB 檔名，不只使用顯示姓名。
AbMediaCatalog 讀取官方公開 kp.js 與 system-ab-v9.json，按官方 DES3 CBC 格式
解析媒體設定；只採用 dealer 路徑與 HTTPS 第 4 線 FLV，依桌名配對串流。
這些是公開客戶端設定，不是登入 Token；不執行下載的 JavaScript，也不回傳帳密。
媒體主機採明確 allowlist，官方換線時需重新核對。媒體設定於後台工作階段啟動時載入。
照片隨荷官更換更新；視訊僅由使用者開啟時載入，關閉或離開分頁時釋放播放器。
2026-09-18 已在本機確認照片載入及 B201 FLV 1920×1080 實際播放。
長時間／雲端運作尚未驗證。

## Optional proxy test

For a temporary cloud-egress test, set these Render environment variables for
the relay service using a Webshare proxy (HTTP or SOCKS5):

```text
AB_PROXY_SERVER=http://host:port
AB_PROXY_USERNAME=<proxy username>
AB_PROXY_PASSWORD=<proxy password>
```

The values are read only by the AB browser worker and are not logged. Remove
the three variables to return to the direct connection path. Free shared
proxies are for connectivity testing only and may be blocked by the upstream.
