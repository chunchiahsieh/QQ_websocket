# DG 後端轉接

## 目前流程：TZ 一次登入，前端分別取得各遊戲授權

採集端 A 只登入一次 `https://www.tz6868.com/`，再並行呼叫 `MTLI`、`DGLI` 與 `AB01`，取得三個各自的短效遊戲網址。DG 的網址例如
`https://new-dd-cn.ahsy114.com/ddnewpc/index.html?token=...&type=5&return=dggw.vip`；其中 token 每次登入都會變，不能寫死。

DG 前端把 DGLI 網址交給 `/api/dg/start`，C# 只負責用受限的無介面 Edge 開啟該網址、讀取官方 WebSocket、解碼桌況並廣播 JSON。Render 不再保存或使用 DG 官方帳密，也不再從 `dg18.cc` 登入。

一般使用者 B/C 不會重複登入官方，只訂閱共享 `/ws/dg`。所有平台各自有獨立遊戲網址、WebSocket、解碼器與快取；但共用同一組 TZ 帳號與一次登入流程。

採集端登入時啟動共享採集；最後一位觀看者離開後保留 15 分鐘，逾時自動關閉 Edge。再次有人觀看時，若授權網址仍有效則沿用快取，否則由採集端重新取得 DGLI。

MT 與 DG 現已共用 BaccaratTableCard：雙欄、照片、倒數及五種路單。DG 點數未經核對，不顯示猜測值；DG 視訊來源尚未接入，開關保持停用。

在本機忽略版控的 `.env.local` 設定：

```dotenv
MONITOR_SESSION_SECRET=自行產生的至少32字元隨機密鑰
```

正式環境必須設定穩定的 `MONITOR_SESSION_SECRET`。DG Relay 只接受採集端提供的 HTTPS DGLI 網址，並限制在官方 DG 網域（含輪替的 `*.ywjxi.com`、`*.dingdangmail.com`）；不接受任意代理網址。
