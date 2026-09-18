# DG 入口操作與連線查核紀錄

日期：2026-09-18。僅記錄本次助手操作，不代表瀏覽器全程錄影或網路封包錄製。

## 操作

1. 查看使用者已登入的 https://www.tz6868.com/，未重新輸入或保存帳密。
2. 點選 DG 真人文字，當下未觀察到頁面變化。
3. 展開頂部「真人」選單，點選可見的 DG 真人卡片。
4. 檢查分頁清單，觀察到兩個 DG 啟動頁：new-dd-cn.20299999.com 與 new-dd-cn.ahsy114.com；不能確定兩次點擊與兩頁的精確對應。
5. 查看 ahsy114.com 分頁：DG 3.3.3 大廳成功顯示百家樂 RB01–RB05、S01 等桌況。
6. 未下注、轉點、儲值或修改帳號。

## Token

DG 啟動 URL 的 token 查詢參數存在且非空。未將其明文存入本檔案或程式碼。

遮蔽後格式：
https://new-dd-cn.ahsy114.com/ddnewpc/index.html?token=[REDACTED]&type=5&return=dggw.vip

此為官方頁面此次啟動的 DG Token，不是 MT Token；未將此瀏覽器 Token 複製至本機系統，也未測試其可否重複使用。

## 公開連線設定

讀取官方 /ddnewpc/index.js，確認引用 game_settings.json；讀取同目錄設定得到 HTTP 200。

- 預設 game_wss：wss://hwdata-new.taxyss.com
- 台灣 game_wss_tw：wss://appatw.kindlestone.com
- 備用 line2：wss://newappa0.ywjxi.com
- 備用 line3：wss://newappa1.ywjxi.com
- 備用 line4：wss://newappa2.ywjxi.com

以上僅為設定候選值，不是網路面板實際觀測的完整 WebSocket URL。

## 尚未取得的證據

目前瀏覽器工具未提供 Network / WebSocket 封包紀錄功能，因此未取得這次官方客戶端實際使用的 Request URL、查詢簽章、Origin、子協定或 HTTP 101 握手紀錄。
不能從 Token 存在或設定網址推定握手簽章正確；也不能以本機系統先前 HTTP 403 推定帳密錯誤。

下一步需要官方成功連線的開發者工具 Network → WS → Headers 紀錄，或官方介接文件。不要公開 Token、Cookie、Authorization 或完整未遮蔽的 HAR。
