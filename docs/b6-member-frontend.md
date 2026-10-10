# B6 — 公開與會員前端，本機 checkpoint

基線 `b156988e8ea7ff27d670e8e2698db4d01dbaed7a`（B4S）與 `be935b58953322ad8d30ba2ab647306ba8aae846`（provider live 修正）。開始時 main 工作目錄乾淨，領先 origin/main 10 commits。保留 B6A Guest/public 的 HTML/CSS/ES modules；沒有 framework、SSR、Admin UI、password KDF、browser provider SDK 或新 binding/schema。

## Routes 與畫面

同一 `/` 靜態頁以 hash 導覽：`#home`、`#submit`、`#lookup`、`#leaderboards`、`#about`、`#register`、`#login`、`#recover`、`#member`。未知 hash 回首頁，`/admin` 不納入此版本。側欄／手機底部保留四個公開入口；頂部呈現登入或會員中心／登出。既有深色背景、VoteProof green 與淺色 CHIC VIOLET 保留。會員等級使用 CSS 指示與後端名稱，沒有示意圖裁切或 badge metadata requests。

## 會員流程

註冊六步：信箱／Turnstile → 信箱六位碼（整段貼上保留前導零）→ 12～128 Unicode 字元密碼／確認／顯示切換 → 本機 TOTP QR／manual key／六位碼 → 十組一次性復原碼／複製／「我已保存」確認 → 完成／會員中心。每步使用後端 transaction、browser Cookie 與 expiry；重寄至少等 60 秒，429 Retry-After 延長等待。quota 不可用時呈現一般暫停訊息，不公布數量。

登入只送 Worker email/password/remember_me；後端確認信任裝置時直接登入，否則顯示 TOTP 與 trust_this_device。Cookie session 通常 7 天，remember 最長 30 天；信任裝置最長 30 天，仍需密碼。密碼不 trim、不改寫、不增加 composition 規則。服務失敗／登入失敗使用固定訊息，不顯示 upstream 文本或帳號存在／停權細節。

密碼復原：email＋TOTP＋一組未使用 recovery code → new_password／confirmation → 後端完成驗證與撤銷 → 強制重新登入。start 的 generic 202 不會被宣稱身份已驗證；finish 才是成功判定。不使用 email reset links。

TOTP QR 使用本機固定版 [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator/blob/master/js/README.md)，Canvas 畫真正 QR modules、四格 quiet zone、黑白對比。URI 僅短暫留在函式中，manual key 取自 backend otpauth contract；沒有第三方 QR URL。`npm run build:frontend-qr` 以鎖定 dependency 重建 MIT 署名的 browser ESM vendor；`npm ci` 後可重現。

## Session、資料與清除

`member-api.js` 僅接受 Worker-relative auth/member/case 路徑，`credentials: same-origin`、request `cache: no-store`、no-referrer；mutation 加 X-VoteProof-Request 與 session CSRF。Origin 由瀏覽器產生，backend exact Origin/CSRF/RBAC 不變。session/device 原始 token 僅存在 backend HttpOnly/Secure/SameSite Cookie，JavaScript 不讀寫。

開站一次 `/api/auth/me`，進會員中心／明確重新載入／會員 case POST 前再驗證；不做 polling 或失效 redirect loop。401 AUTH_REQUIRED／403 MEMBER_SUSPENDED 清掉會員 UI。舊請求失敗不能清除較新的登入。session deadline 到期只清會員狀態，Guest 草稿、圖片與 pending idempotent submission 保留。登出實際呼叫 backend revoke；失敗保留狀態並提供重試。

密碼／六位碼送出後清空欄位；離開 auth route、pagehide／BFCache 清空表單、transactions、QR、manual key、復原碼與畫面，並 abort 等待中的 fetch。過時 async response 不得重插敏感資料。復原碼確認完成後立即清除。這是 JavaScript/UI reference 清除，不能保證瀏覽器／GC 的底層記憶體抹除；不新增 analytics、logging、localStorage/sessionStorage/IndexedDB。唯一持久化前端資料仍是主題偏好。使用者按「複製」後的 OS clipboard／密碼管理器由使用者控制。

會員中心：後端安全 nickname/player_id/member_id；profile PATCH 只送 nickname/player_id。API 沒有 email，頁面因此不顯示／推測登入 email。一次 `/api/me/points` 取得 ledger total、tier、next_tier、gap、progress、tier_configuration_ready；未設定時明確顯示「會員等級門檻尚未設定」。我的案件使用 owner API、cursor limit=10、明確載入更多與 owner detail；結果只顯示安全欄位，沒有 private object／reviewer／query hash。

## Guest／會員投稿與 lookup

投稿預設明確 Guest，可選「會員」後用 profile 預填 nickname/player_id；這兩項仍為案件 metadata snapshot，可依投票資料修正。member_id 永遠不在 request body，由 server session 綁定。Guest adapter 永遠 `credentials: omit`，包含在已登入／session 失效／provider outage 時；準備／complete 仍是原 public upload API，圖片只經瀏覽器 direct R2 PUT。

一筆 logical submission 生成 32 隨機 bytes Idempotency-Key，固定 normalized metadata、files、transport/owner；case POST 前序列化 payload 一次，重試 body/key 完全相同。會員 transport 捕捉原 member_id，每次 case POST 重新核對實際 Cookie owner／更新 CSRF；登出、cross-tab 切換帳號、session 失效不能降為 Guest 或替換 owner。可登入原會員後重試，或明確放棄，放棄前警告可能遺失已成功回應的查詢碼。沒有 long-term pending submission storage。

成功顯示 case_id/query_key、複製 ID／key／全部與保存警告。Guest 查詢透過既有 `X-Case-Query-Key` header，API/browser URL 都不帶 key；B3 query-string 相容 contract 未改。錯 key／不存在使用相同訊息。六種狀態中文映射保留。Campaign／leaderboard 使用 backend data；排名、proof_count 不在 client 重算，沒有會員／badge N+1。

## 本機驗證

`npm test` 包含原 568 項與 15 項新 member transport/validation/QR/ownership tests；performance benchmark 不混入。Playwright 覆蓋 desktop Chrome、Android Chrome、iPhone WebKit 模擬與 320/375/390/430/768/1280 寬度、兩主題、label/focus/16px inputs、表單重複提交、auth/Guest 故障隔離、敏感資料清除。這是裝置模擬，不能等同實機 Safari／Android。

`test:frontend-smoke` 用真實 disposable Worker/D1/R2 驗證 Guest 丟失 201 replay。`test:member-frontend-smoke` 用 HTTPS `.example` 全部本機路由、真實 backend auth/cases/ledger 和隔離 provider fixture：信箱／TOTP／Cookie flags、profile、points/tier、簽名 PUT/HEAD、ONE Member case replay、Guest header query、trusted password login、recovery consumption、sessions/devices revoked、fresh TOTP required。fixture credentials 全在記憶體隨機產生，未讀 ignored live config，沒有真實寄信／provider user。

`check:admin-schema` 新建忽略的本機空 DB apply 0001～0007，foreign_key_check、quick_check、indexes/triggers/schema 正常；本階段不新增 migration。`check:public-assets` 審閱 deployable 11-file allowlist、module graph、無敏感值／storage／admin calls。`check:frontend-sensitive` 掃描 Git reviewable changes，不讀本機 credentials。`git diff --check` 與手動 diff review；`npm run check` Wrangler **dry-run only**。

## 已知限制與 Production rollout 前置

沒有新增安全 bypass 或未完成可見測試頁。後端已接受的限制保留：若 credentials/TOTP activation 回應遺失或放棄 pending TOTP enrollment，registration 不具持久化成功重放；可能需既有受控 reconciliation。復原碼只回一次，不能從 UI/DB 重新取回；請完成註冊步驟並保存。未新增 backend reset／scheduler。`otpauth_uri` format 必須符合既有 SHA1/6/30/20-byte backend contract。OS clipboard 只經明確 Copy 操作寫入，不會自動清除。

正式發布另需使用者批准並逐項完成，這次未操作：

1. 檢查 Production 仍只套用的 migrations／schema；備份並安排依序 0003～0007（包含 B4S 重寫的未發布 0003），不得直接覆蓋已有舊版 auth schema。檢查 FK／quick_check；不帶入本機 fixture。
2. Worker-only Secrets：獨立 64-hex AUTH_SECRET 與 AUTH_TOTP_ENCRYPTION_KEY；SUPABASE_SECRET_KEY；MAIL_RELAY_URL／MAIL_RELAY_SECRET（見 [Mail relay](mail-relay.md)）。Variables：AUTH_ORIGIN（正式 exact origin）、SUPABASE_URL／SUPABASE_PUBLISHABLE_KEY；可選既有 email quota／key version。GMAIL_* 為 legacy，保留既有 Production 值作回退，未刪除。保留 CASE_QUERY_KEY_SECRET、Turnstile/R2/DB/ASSETS、keep_vars。從 Dashboard 管理值，不寫入 static assets/Git。
3. Supabase public signup/anonymous 關閉、email confirmation 啟用、server admin create；確認 password policy 與前端 12～128 bounds相容。不得開放 browser provider login。
4. MailApp relay 正式寄信 gate：設定獨立 MAIL_RELAY_URL／MAIL_RELAY_SECRET，驗證 HMAC、重放拒絕、轉址與真實註冊；Worker soft 60／hard 80，relay provider reserve 20。此路徑不依賴 Gmail OAuth Testing refresh token；既有 Gmail 設定只保留作回退。本機驗收不等於 Production 已可長期寄信。
5. 設定正式 Campaign、leaderboard snapshots、tier thresholds（未設定仍能正確呈現 fallback），選擇 D1 leaderboard/campaign source rollout；不刪 Apps Script／改 Production traffic 作為此本機任務的一部分。
6. 確認正式 site key 配對、domain與 Turnstile；R2 CORS exact Production origin、Content-Type PUT、private bucket；驗收真正 browser CORS/session Cookies/provider 登入、Guest regression、backend quotas/Free CPU／D1/R2 allowance與 orphan/enrollment 運維清理。
7. 在真實 iOS Safari/Android 手機檢查 QR 掃描／manual input、跨 App 驗證、密碼管理器、剪貼簿與 touch/keyboard；Google Authenticator enrollment 本次本機 fixture only。

不 push、不 deploy、不 remote migration、不改 Production D1/R2、不建立 Production users、不進 B6B Admin UI。

## 本次檔案清單與最終結果

| 分組 | 修改／新增檔案 |
| --- | --- |
| 原有前端（修改） | public/index.html、public/css/app.css、public/js/app.js、public/js/submission.js、public/js/turnstile.js |
| 會員／QR（新增） | public/js/member-api.js、public/js/member.js、public/js/qr.js、public/js/vendor/qrcode.js |
| 瀏覽器（修改／新增） | frontend-tests/public.spec.js；frontend-tests/member.spec.js、frontend-tests/member-fixture.mjs |
| Node 測試（新增） | test/frontend-member.test.js |
| 工具（修改／新增） | scripts/check-public-assets.mjs；scripts/build-frontend-qr.mjs、scripts/check-frontend-sensitive.mjs、scripts/smoke-member-frontend.mjs |
| Dependency／文件（修改／新增） | package.json、package-lock.json、README.md；docs/b6-member-frontend.md |

共 21 個檔案（10 modified＋11 new），沒有刪除檔案。src/、migrations/、wrangler.jsonc、public/_headers 都未改動。

| 驗收 | 結果 |
| --- | --- |
| npm test | 583／583，既有 568 全數保留，加 15 member frontend tests |
| Playwright | 174／174（58 scenarios × desktop Chrome／Android Chrome／iPhone WebKit），含六種寬度及 both themes |
| Backend smoke | B1、B2、B3、B4S、B5A、B5B、B5C、B5D 八套 PASS |
| Browser + real local backend smoke | Guest／Member 兩套 PASS，provider 為隔離 fixture |
| Empty local D1 0001～0007 | PASS；foreign_key_check PASS；quick_check ok；fixture_rows=0 |
| Wrangler dry-run | PASS；DB／PROOFS_BUCKET／ASSETS 不變；254.41 KiB / gzip 58.91 KiB |
| Static asset／Git sensitive scan | 11 deployable assets／21 Git changes，0 findings，沒有讀 ignored credentials |
| Diff review | 只包含 B6 scope；git diff --check PASS；本機 commit 後工作目錄 clean |

未完成實機／Production 瀏覽器驗收，已知 provider/enrollment 運維前置如上；不宣稱本機 fixture 是正式 provider delivery 或 Production rollout。
