# B4 Member identity（本機完成，尚未發布）

沿用 B1 router／JSON helper、B2 私人 R2、B3 Guest cases／upload consumption／query key／idempotency。
不儲存密碼、不增加 admin role、審核、積分或排行榜寫入。`public/index.html` 完全保持原樣；現有會員按鈕仍是示範，正式會員功能由以下 API 提供，這次沒有接線或新增可見頁面。

## Architecture 與資料

採 Email OTP，同時支援首次驗證建立會員與既有會員登入。使用固定 `https://api.resend.com/emails` 的 server-side fetch adapter，無額外 npm dependency，5 秒 timeout 包含回應 JSON。Production 不使用本機 mock，也沒有 bypass。
寄信的收件 email／OTP 必須交由郵件供應商處理；Worker 不記錄 OTP、email、session、CSRF credential 或供應商 response。

`0003_member_identity.sql` 新增四個 tables：

- `members`：UUID internal id、server 隨機 `M-<UUID>` member_id、normalized email、profile、active/suspended、時間欄位。email（NOCASE）與 member_id unique。Email-only identity 直接放 members，不額外建立無用途的 identities table。
- `auth_challenges`：UUID handle、private email、browser cookie hash、OTP HMAC、delivered、attempts、expiry、consumption。
- `auth_sessions`：256-bit session token 的 SHA-256 hash、member_id FK、絕對 expiry、revoked_at。
- `auth_rate_limits`：HMAC scope hash、fixed-window counter、expiry；不存原始 IP。

六個新增 indexes：challenge expiry/email、session member/expiry、rate expiry、`cases(member_id, created_at DESC, id DESC)` pagination index。
既有 `cases.member_id` nullable 保留；Guest 為 null，Member 為經 server 驗證的 public member_id。既有 case/upload UNIQUE、FK、transaction 與 compensation 不變。Member case insert 在同一 D1 batch 再核對 active member 與尚有效的 session，防止複製 R2 期間 suspension/revocation race。

## API contract

所有成功／錯誤／405 使用既有 JSON 格式，均 `Cache-Control: no-store`。不支援跨 origin CORS。

| Endpoint | Request / 結果 |
| --- | --- |
| `POST /api/auth/start` | JSON `{email, turnstile_token}`；server-side Siteverify。202 `data: {challenge_id, expires_in:600, message}`，設定 login cookie。 |
| `POST /api/auth/verify` | JSON `{challenge_id, code}`，code 為收到的 8 位數字 string；必須帶該次 login cookie。200 `{member, csrf_token, expires_in:604800}`，換發 session cookie、移除 login cookie。 |
| `GET /api/auth/me` | session cookie；200 `{member, csrf_token, expires_at}`，expiry 為 Unix seconds。未登入／無效／已過期 401 `AUTH_REQUIRED`。 |
| `POST /api/auth/logout` | exact origin＋custom header；revoke current session，清除兩個 cookies，200 `{logged_out:true}`。suspended/expired/damaged cookie 均可清除，不需要重新取得 CSRF token 才能返回 Guest。 |
| `PATCH /api/me/profile` | session＋CSRF；JSON 可部分更新 nickname（1～50 Unicode code points）、player_id（1～100），trim、拒絕 control characters／未知欄位／空更新。200 `{member}`。 |
| `GET /api/me/cases?limit=20&cursor=...` | session；owner-only `{cases, next_cursor}`。limit 1～50，預設 20；created_at/id keyset pagination，兩個 bounded prepared queries。 |
| `GET /api/me/cases/:caseId` | session；只允許 owner，回應同 Guest 查詢的公開欄位 whitelist；別人的案件與不存在統一 404 `CASE_NOT_FOUND`。 |

`member` 僅回 member_id、nickname、player_id、status、created_at、updated_at、last_login_at；不回 email、internal id、session hash。第一次登入 profile 為 nickname「會員」、player_id null，可自行更新。
案件列表／細節只回 case_id、created_at、nickname、campaign_id、vote_type、vote_date、status、points_awarded、files（content_type/size）；無 private R2 keys／URL、query_key_hash、reviewer、note、player_id 或憑證。
Cursor 是位置編碼，不是 credential；就算偽造 cursor，SQL 的 member_id 條件仍由 session 決定。

常見錯誤：`INVALID_JSON`、`INVALID_AUTH_REQUEST`、`AUTH_REQUIRED`、`AUTH_VERIFICATION_FAILED`（wrong/expired/used/browser mismatch）、`MEMBER_SUSPENDED`、`CSRF_REJECTED`、`AUTH_RATE_LIMITED`、`AUTH_NOT_CONFIGURED`、`AUTH_EMAIL_NOT_CONFIGURED`、`AUTH_EMAIL_UNAVAILABLE`、`AUTH_SERVICE_UNAVAILABLE`、`INVALID_PAGINATION`，另沿用 B2 Turnstile 與 B3 case errors。錯誤無 stack／env／上游原文。

## Cookie、CSRF 與 session lifecycle

Cookies 均為 host-only `__Host-`、`Path=/; HttpOnly; Secure; SameSite=Lax`、無 Domain：

- `__Host-vp-login`：server 256-bit random bearer，600 秒，D1 僅存 purpose-prefixed SHA-256；綁定 challenge/browser，防止攻擊者把自己的 OTP 登入結果植入另一 browser。
- `__Host-vp-session`：每次驗證重新 random 256-bit，604800 秒（7 天 absolute TTL，無滑動延長）。D1 僅 hash。成功登入原子 revoke 該 browser 原 session；其他裝置的 sessions 保留。Logout revoke current session。Suspension 在每次身份檢查生效，包含 case replay。

`AUTH_SECRET` 為獨立安全隨機 32 bytes／64 hex。OTP HMAC、CSRF HMAC 與 rate-limit HMAC 各有不同 purpose，和 B3 `CASE_QUERY_KEY_SECRET`／Turnstile／R2 完全分離。短 OTP 不使用無 secret 的裸 hash，以免單獨讀取 D1 就能離線枚舉驗證碼。
CSRF token 由 AUTH_SECRET＋session hash 重建，不是登入 token；僅放 client 記憶體。Session bearer 只放 HttpOnly cookie，禁止 localStorage；任何 member response 都不回 session bearer。

CSRF threat model：其他網站可能誘使 browser 自動攜帶 cookies，所以 SameSite 只是額外保護。

- start/verify/logout 要求 `Origin` **完全等於** `AUTH_ORIGIN`、`X-VoteProof-Request: 1`，拒絕 `Sec-Fetch-Site: cross-site`。不允許任意請求 Origin 決定信任範圍。
- profile、Member case 另要求該 session 的 `X-CSRF-Token`；由 verify 或 auth/me 取得。跨會員 CSRF token 無效。logout 以 exact Origin＋non-simple custom header（無跨 origin CORS）保護，讓無法再取得 auth/me 的訪客仍能安全清除身份。
- 驗證／狀態更新使用 JSON，無放寬 OPTIONS/CORS；跨站不能透過 simple form 或 custom-header preflight 完成上述請求。
- GET 無修改資料。Same-origin XSS 可代表使用者發出請求，Cookie／CSRF 無法防禦 XSS；前端接線時仍須避免不安全 HTML 插入。

範例呼叫順序：start（新的 Turnstile token）→ 收取 OTP → verify（browser 自動帶 login cookie）→ auth/me → profile／Member case（`credentials:'same-origin'`、合法 Origin、`X-CSRF-Token`）→ logout（另帶 `X-VoteProof-Request:1`）。B2 prepare 需要另一個新 Turnstile token；Siteverify token 不可重用。
Email 採 ASCII mailbox、trim/lowercase，不移除 plus aliases 或 dots；不支援國際化 mailbox。Email 不能透過 profile 改寫。

## Abuse protection 與 enumeration

- OTP random 8 digits（無 modulo bias），10 分鐘，最多 5 次（包括成功的嘗試）。D1 atomic UPDATE reservation 防止並發繞過次數；challenge consumption、會員建立、session issue 與舊 session revoke 同一 batch。
- D1 fixed windows：每 email 3 次／15 分、每 CF-Connecting-IP 20 次 start／15 分及 60 次 verify／15 分、整體 200 次 start／小時。IP 缺少時使用 shared unknown scope，不信任 X-Forwarded-For。Counters 持久化且原子 cap，Worker 重啟不重設。
- email quota 達上限仍回完全相同的 202 shape/message 與 random handle，但不寄信；IP/global 限制回 429＋Retry-After。已有／新／suspended email 都回相同 start 格式，不讀 member existence 決定 start response。
- 只有正確 OTP＋原 browser 才能得知 suspended；不靠公開 start 洩漏註冊狀態。
- Fixed-window 邊界可短暫允許兩個視窗的額度；不是 rolling window。全域 cap 可能在大量合法登入時造成暫時不可用，調整前需評估寄信費用。D1 counter 不能阻擋所有網路層 DoS，Production 可另外設定 Cloudflare perimeter rate rules，本次沒有修改 Dashboard。
- 寄信 timeout／invalid JSON／HTTP error 不啟用 delivered，失敗 challenge 無法登入；provider 可能已寄送但回應遺失，使用者應重新 start。verify 回應遺失同樣應重新 start；B4 未提供登入回應 idempotency。
- Expiry 在 DB 查詢即時判定，無需 scheduler 才會失效。日後維運可小批清理超過 24 小時的 expired/consumed challenges、expired/revoked sessions 與 expired rate rows；本次無 cron、遠端 cleanup、排程或 migration 附帶刪除。

## Member cases 與 B3 compatibility

POST cases 的 request／201 response 保留 B3：nickname/player_id 仍是 client 提供且 server 驗證的**案件快照**，與可更新的 profile 分開；登入身份只由 server session 決定。Member 和 Guest 均回 query_key；仍以 B3 HMAC／hash 保護，原 Guest query key 機制可查兩種案件。
`member_id`、status、points 等 client 欄位繼續被拒絕。無 session cookie 時維持 Guest；帶無效／過期／suspended session 時拒絕 POST cases，不悄悄降級 Guest。清除 cookie／登出後可照常 Guest 投稿。Guest query-key GET 不依賴會員狀態，suspended cookie 也不會破壞正確 query key 查詢。
Member Idempotency-Key hash 使用獨立 namespace＋authenticated member_id；normalized payload 也納入 member_id。Guest 的 B3 hashes／query-key reconstruction 完全不變。
同會員跨 session 或 profile 修改仍 replay 同案件／有效憑證；不同會員／Guest 碰巧同 key 無法拿到別人的回應。同 upload 的 consumption UNIQUE 約束繼續跨身份有效。

## 手動 Production prerequisites（本次不執行）

既有 D1／R2／assets／keep_vars／CASE_QUERY_KEY_SECRET 保持原設定。未修改 wrangler binding。

1. 在 Resend 建立並驗證自己的寄件網域（DNS verification／SPF／DKIM），建立限制該網域的 **Sending access** API key。郵件不從 client 呼叫 Resend，不使用示範寄件者上 Production。
2. Worker Production **Secrets**：`AUTH_SECRET`（獨立 CSPRNG 32 bytes／64 hex）、`AUTH_EMAIL_API_KEY`（Resend sending key）。只在 Cloudflare 設定，別貼入聊天或 Git；不得重用其他 secrets。
3. Production **Variables**：`AUTH_ORIGIN` 設為正式網站 origin（無尾端斜線／path）；`AUTH_EMAIL_FROM` 為已驗證網域的單純寄件 email（不含 display name）。AUTH_ORIGIN 必須 https；僅本機 localhost/loopback 開發可用 http，無 bypass flag。
4. 使用者確認 rollout 後，在既有 `voteproof-cases` 手動 apply **0003**，先核對 0001/0002 已 applied。必須先 migration 再發布 B4 Worker，因 B4 cases batch 會參照 members/sessions。這次**僅 local migration**。
5. 再另行授權 push／deploy 與真實 email／Turnstile live acceptance；B4 本機完成不代表郵件供應商送達率或 Production 登入已驗收。
6. AUTH_SECRET rotation 會使未完成 OTP／舊 CSRF token 失效；session hashes 本身仍有效，client 可用 auth/me 更新 CSRF。停用已登入身份應 revoke session／suspend member；本次沒有 admin API。

## 本機驗收

`npm test` 保留全部 B1/B2/B3/B3.1，新增 Auth、profile、ownership、CSRF、OTP/session race、suspension during R2 copy 等測試。
`npm run test:smoke`、`npm run test:uploads-smoke`、`npm run test:cases-smoke`、`npm run test:auth-smoke`、`npm run check`。
`npx wrangler d1 migrations apply voteproof-cases --local` 只套用 checked-in local schema。
測試只有 harness 的 outboundService mock email／Siteverify，OTP 與 fixture credentials 隨機產生且僅留測試記憶體；Worker 沒有測試認證模式、mock provider env 或 Production bypass。

參考：
- [Resend send email API](https://resend.com/docs/api-reference/emails/send-email)
- [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP CSRF prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [Cloudflare D1 batch atomicity](https://developers.cloudflare.com/d1/worker-api/d1-database/)
