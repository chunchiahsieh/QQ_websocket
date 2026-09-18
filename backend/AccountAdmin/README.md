# 獨立 MVC 帳號管理網站

## 同站管理入口（現行方式）

使用前台網站的 `/admin`（本機 http://localhost:3000/admin），前台已加入「管理中心」入口。
Next route 將允許的 MVC 管理動作轉交同機 C# 5092；不公開 `/internal` API，不接受任意代理路徑。
使用管理員 cookie 與 MVC 防偽 token，與牌桌平台登入分離。這是同一網站入口，C# 仍為內部帳號儲存服務，部署時仍須啟動它。
`ACCOUNT_ADMIN_URL` 可設定內部服务網址，預設 http://127.0.0.1:5092。
管理員最低密碼 4 字元（依本機測試需求），一般使用者仍至少 6 字元。
對外上線前務必更換測試管理員密碼，不要把短測試密碼當成正式憑證。

以下的獨立埠操作仍可用於維護，不是使用者需要另開的管理入口。

與牌桌前端及 DgRelay 分別編譯、啟動、部署。無外部資料庫服務。

## 本機啟動

在 PowerShell 執行 `./backend/AccountAdmin/start-local.ps1`。
首次啟動若帳號留白，會以 `admin` 建立管理員；也可輸入其他管理員帳號。密碼至少 4 字元，且不沿用平台帳密。
開啟 http://127.0.0.1:5092。再次啟動會讀既有檔案，不會重建管理員。
管理員可設定四類派彩獎池、指定使用者派彩、建立帳號、修改台灣時間 UTC+8 的到期時間、停用、刪除、重設密碼，及變更自己的密碼。派彩完成後會將該類獎池回到下限並記錄於 payout-records.json；派彩類別固定提供，不設啟用／停用開關。

## 資料與安全

`ADMIN_DATA_DIR` 必須在此應用程式目录之外；預設為目前服務使用者的 LocalApplicationData/TableAccountAdmin。
內含 accounts.json、payout-settings.json、payout-records.json、各檔案上一次原子替換的 .bak、Data Protection keys 及 writer.lock。
密碼使用 ASP.NET Core Identity PBKDF2（210,000 次），含隨機 salt，不存明文。
檔案不對外提供，不啟用 static files；JSON、備份及金鑰都不可複製到公開網站目錄。
單程序鎖防止多個實例覆寫；檔案毀損時啟動失敗，絕不默默建立空資料。
停用、改期限或重設密碼都更新 stamp，讓舊驗證憑據無效。
登入有 IP 頻率限制；管理表單防 CSRF；登入 cookie 僅管理站可用，30 分鐘失效。

## 同一台主機正式部署

- 分別部署前端、DgRelay、AccountAdmin；管理站使用獨立主機名稱（如 admin.example.com）。
- IIS/Nginx 以 HTTPS 提供管理站，內部服務埠 5092 限 loopback，防火牆禁止外部直連。
- 設定 ASPNETCORE_ENVIRONMENT=Production。Cookie 強制 Secure；TLS 若由反向代理終止，需由部署者設定受信任代理與 HTTPS scheme，不能無條件信任所有 forwarded headers。
- 服務使用專用 OS 帳號。Linux 資料目錄權限 0700、檔案 0600；Windows 需在資料資料夾安全性設定只授予服務帳號、SYSTEM 與管理員，移除一般使用者存取。
- JSON 與 keys 存在持久化磁碟，勿使用暫存容器磁碟／共享網路磁碟。定期離線加密備份，不把 .bak 當成完整備份制度。
- 管理站建議再加 VPN 或 IP 白名單。`/internal/` 不應由公網反向代理，僅允許同機服務呼叫。
- `ADMIN_INTERNAL_KEY` 設為至少 32 字元隨機值，僅存伺服器秘密設定。未設定時內部 API 拒絕所有請求。
- 正式部署前核對並升級到仍受支援的 .NET runtime；目前使用與現有後台一致的 net9.0。

## 內部 API（已完成，牌桌端尚未接入）

POST `/internal/accounts/login`，Header `X-Internal-Key`，JSON `{ "username": "...", "password": "..." }`。
成功回傳 id、username、expiresAt、stamp；失敗統一 401，不洩漏帳號是否存在。
POST `/internal/accounts/validate`，同 Header，JSON `{ "id": "...", "stamp": "..." }`，回傳 `{ "valid": true/false }`。
stamp 只應放在伺服器或加密 HttpOnly session，不當作公開身分資訊。

**重要：現有牌桌登入仍是平台登入，本專案不會自動使牌桌端帳號到期限制生效。**
後續整合須先驗證系統帳號，再使用伺服器端獨立 MT/DG/歐博授權；每次 API 與長連線定期驗證 stamp／期限，失敗立即停止轉送。
尤其 MT 目前由使用者瀏覽器直連平台；若要強制限制期限，須改成後端代理，不能僅隱藏 UI。
本次前端僅保留即時桌況，不再提供原始訊息串流頁；管理站尚未接入平台原始訊息檢視。

## 測試

`dotnet build backend/AccountAdmin/AccountAdmin.csproj`

`node tests/account-admin.integration.mjs`

測試使用 OS 暫存資料夾、隨機帳密、15092 埠，不修改正式使用者檔。
