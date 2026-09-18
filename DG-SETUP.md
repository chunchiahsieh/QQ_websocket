# DG 後端轉接

## 最新：C# 官方瀏覽器模式已通過本機實測

DG 後台使用 `.env.local` 的 `DG_BACKEND_USERNAME`、`DG_BACKEND_PASSWORD` 獨立登入 https://dg18.cc/，不再經過 TZ 授權 DG。
這些設定不得使用 NEXT_PUBLIC 前綴。專用帳密缺少或登入失敗時不會改用前台帳號；帳密只由 C# 送到指定的 DG 入口。

前端 DG 現在呼叫 `/api/dg/start`，再透過自己的 WebSocket `/ws/dg` 接收 C# 解析的 JSON。
C# 在切換 DG 分頁時啟動獨立無介面 Edge，登入 dg18.cc 並點選「进入游戏」，由官方頁面處理 DG 授權、連線及心跳。遇到人工驗證不會繞過。
2026-09-18 已實測新入口：建立工作階段 HTTP 200，收到 13 桌快照及後續單桌更新。
目前採常駐模式：首次切入 DG 啟動一個後台瀏覽器，切回 MT 只停止前端訂閱，後台持續接收資料。再切入 DG 時健康則立即傳送完整快照，異常才復原；不會每次重新登入。
本機已實測首次 13 桌約 11.3 秒、再次訂閱約 11 毫秒，瀏覽器 generation 維持 1。此為單次本機量測，不代表部署後保證延遲。
啟動與限制請見 `backend/DgRelay/README.md`；測試紀錄見 `backend/DgRelay/TEST-RESULTS.md`。
MT 與 DG 現已共用 BaccaratTableCard：雙欄、照片、倒數及五種路單。DG 點數未經核對，不顯示猜測值；DG 視訊來源尚未接入，開關保持停用。

## 以下為先前直連模式紀錄（非目前 DG 前端路徑）

- 登入後並行呼叫 MTLI/DGLI 授權入口，分別取得 Token；其中一方失敗不阻擋另一方。
- DG Token 封裝於一小時 AES-GCM 加密 HttpOnly 工作階段，前端 JSON 不包含 DG Token。MT 分頁使用原本 MT 連線。
- DG 分頁向同源 `/api/dg/stream` 取 SSE；切走會取消請求並關閉上游。
- DG 使用現有 `dg-client.ts` 的簽章、登入封包及 `dg-protobuf.ts` 解碼。
  這些協定尚未經目前 DG 平台驗證；收到可解碼桌況前不顯示已連線。
- 不借用朋友的後端，不將明文 DG Token 回傳瀏覽器，不以 MT 路單格式猜測 DG 路單。

後端依使用者指定，先握手 `wss://hwdata-new.taxyss.com`，失敗再嘗試
`wss://appatw.kindlestone.com`。每條線最多等待 12 秒；切離 DG 分頁即取消，成功握手後不建立第二條連線。
兩條線共用此次登入取得的獨立 DG Token（不使用 MT Token）。此備援僅處理握手失敗，不會在授權封包失敗後自動重登。
`DG_WS_URL` 舊覆寫已停用，避免繞過指定線路。
官方 V3.3.3 遊戲頁與大廳已確認可開啟；後端授權及封包仍待驗證。

在本機忽略版控的 `.env.local` 設定：

```dotenv
MONITOR_SESSION_SECRET=自行產生的至少32字元隨機密鑰
```

正式環境必須設定穩定的 `MONITOR_SESSION_SECRET`。開發環境未設定時使用記憶體隨機密鑰，重啟後須重新登入。
此版使用 Cloudflare Workers 的 outbound WebSocket fetch/accept API。
DG_TOKEN 環境變數已停用，DG 串流僅接受此次登入取得的 DG Token。更新後舊 cookie 失效，需重新登入。
2026-09-18 本機實測登入 HTTP 200，MT 與 DG 授權皆成功；新 DG Token 握手仍 HTTP 403。
目前 dg-client.ts 簽章尚未與官方或參考網站後端核對，不能宣稱 DG 串流已完成。
參考網站公開前端僅暴露 /api/dg/start 轉接呼叫，不含伺服器握手簽章；需獲取授權的後端簽章模組或官方介接文件。
心跳、訂閱協定與 DG 路單欄位也尚未核對。
需以有效官方 DG 遊戲頁或平台技術文件核對後，才能完成 DG 即時串流與牌卡驗收。
