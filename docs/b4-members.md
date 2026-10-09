# B4.x final member authentication — local checkpoint

目前只完成本機 backend。Production 只有 0001/0002；沒有 remote migration、push、deploy、前端或 Cloudflare 設定變更。

## Identity and schema

`login_name` trim/lowercase，4..32 個 ASCII `a-z0-9._-`，NOCASE UNIQUE，DB CHECK 同時限制 normalized value。它是私人登入名稱，不是 nickname/player_id/public member_id；不回 public member/profile/leaderboard API。
`member_id` 仍為 server CSPRNG `M-<UUID>`，profile 可修改 nickname/player_id，不能改身份或角色。

重寫未發布 `0003_member_identity.sql`，0001/0002、0004..0007 完全不改：

- `members`: login_name、public identity/profile、active/suspended、timestamps。
- `member_credentials`: salted password record；AES-GCM TOTP ciphertext/IV/key_version；last_used_time_step；credential version；recovery_generation。
- `auth_transactions`: register/login/password_recovery/totp_recovery/totp_reset，UUID handle、browser hash、member reference、bounded payload、expiry/attempts/consumption。Pending registration 只保存 password hash 和 encrypted TOTP，不创建正式 member。
- `auth_sessions`: 256-bit token hash、member reference、absolute expiry/revocation、elevated_until、reauthenticated_until。
- `trusted_devices`: UUID id、member reference、256-bit token hash、created/last_used/expiry/revocation；nullable label，不做 fingerprint。
- `recovery_codes`: member/generation/code_hash composite PK、created/used timestamps。
- `auth_rate_limits`: HMAC scope hash、fixed window、atomic capped counter/expiry。
- `auth_atomic_guards`: transaction-local CHECK assertion。D1 batch 先 ASSERT 所有条件，再 mutation，最後刪除 guard；成功後沒有 guard rows。失敗整個 batch rollback，不留下 claim。

Indexes: transaction expiry/member；session member/expiry；device member/expiry；recovery member/generation/used；rate expiry；existing member case cursor。

## Password KDF and Workers budget

使用正式 dependency `@noble/hashes` scrypt，N=32768 (2^15)、r=8、p=3、dkLen=32；每次 random 16-byte salt，固定 maxmem=34 MiB。Password 先經獨立 AUTH_PASSWORD_PEPPER HMAC-SHA256 domain separation，再進 scrypt。DB record 保存 algorithm/version/parameters/salt/hash，不保存 password/pepper。

這是 [OWASP 支援的 scrypt 32 MiB 組合](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。Argon2id 仍是首選；此專案沒有既有 audited Workers Argon2id/WASM adapter。[Noble 的 audit scope](https://github.com/paulmillr/noble-hashes) 涵蓋 scrypt、未涵蓋其較晚加入的 Argon2。為本次最小、可驗證實作選擇已受審計的 scrypt，未退到 PBKDF2。

`npm run benchmark:auth-kdf` 在實際 local workerd 執行相同 production KDF；從 host 測量 dispatch wall time（Workers 內時鐘不能可靠量測純 CPU），只輸出時間與參數。2026-10-09 獨立執行5次：hash 240/214/214/213/214 ms，中位214 ms；hash+verify 422/426/421/430/426 ms。包含 IPC/HMAC；**不是 Production CPU billing 實測**。

[Workers Free 只有10 ms CPU，Paid 可用更高預算](https://developers.cloudflare.com/workers/platform/limits/)。本方案發布前必須確認 Paid plan／足夠 CPU 預算，並在目標環境重新量測 p95/concurrency；不要為符合 Free budget 降低 KDF。wrangler.jsonc 未改；Paid 預設預算遠高於本機成本，具體 limits 於 rollout 審閱。

scrypt 採同步 bounded allocation，單一 isolate 的 JS 不會重疊執行多個32 MiB KDF，不使用 in-memory auth/rate state。代價是計算期間阻塞該 isolate；公開登入已先做 D1 account/IP/global quota，但仍需 Production load acceptance。
Password 12..128 Unicode code points、最多512 UTF-8 bytes，允許長密碼/空格/Unicode，不trim、不作composition rules；NUL及無效Unicode surrogate拒絕（避免UTF-8 replacement使不同密碼碰撞）。未知帳號跑同參數 dummy KDF；錯密碼、不存在、suspended 都回同一401 AUTH_LOGIN_FAILED，不回帳號是否存在。有效密碼才回 MFA_REQUIRED。

## Secrets / Variables

使用者於未來 rollout 手動設定三組**獨立** CSPRNG 32 bytes / 64 hex Worker Secrets：

| Secret | 用途 |
| --- | --- |
| AUTH_SECRET | CSRF HMAC、privacy-preserving rate-limit scope HMAC |
| AUTH_PASSWORD_PEPPER | password prehash HMAC；不能直接換掉，須設計 password migration/reset |
| AUTH_TOTP_ENCRYPTION_KEY | AES-256-GCM TOTP storage；不能直接換掉，須先完成 version-aware re-encryption |

Variable `AUTH_ORIGIN`: 正式 exact HTTPS origin `https://voteproof.i-dle-melon.workers.dev`，無path/尾斜線；本機只允許 localhost/loopback HTTP。
Optional `AUTH_TOTP_KEY_VERSION`: 正整數，預設1，已存於每份 encrypted record；AAD綁定version/member_id。現階段只讀目前key version，未知version fail closed；**未實作雙key讀取或自動rotation**。未來rotation要加入舊key reader/遷移流程才換key/version。
三組secret不得互相或與 case/Turnstile/R2 secret共用；程式檢查常見誤用。既有 CASE_QUERY_KEY_SECRET、TURNSTILE_SECRET_KEY、R2 secrets/bindings 保持獨立。
不需要郵件供應商、自有網域、SMS、LINE或Passkey。不要把secret貼聊天、寫Git、test fixtures、logs或client。

## API contract

所有回應沿用 `{ok,data}` / `{ok:false,error:{code,message}}`，Cache-Control:no-store。
Login/registration/recovery POST: exact Origin + `X-VoteProof-Request: 1`，JSON最多16 KiB；transaction verification 同時要求 browser cookie。
Session-auth mutations: exact Origin + `X-CSRF-Token`（從me取得、HMAC綁session），不是用client member_id授權。

| Endpoint | JSON / response |
| --- | --- |
| POST /api/auth/register/start | `{login_name,password,nickname,player_id?,turnstile_token}`；server Siteverify，202 `{transaction_id,expires_in:600,otpauth_uri}`，browser cookie。新/既有名字start形狀相同；duplicate finalize統一 verification failure。 |
| POST /api/auth/register/verify-totp | `{transaction_id,code,trust_this_device?,remember_me?}`；只在正確TOTP後原子建立member/credentials/10 recovery codes/session/trust，200 member/CSRF/TTL/recovery_codes。 |
| POST /api/auth/login | `{login_name,password,remember_me?}`；valid trust+password回200 session；否則202 `{status:'MFA_REQUIRED',transaction_id,expires_in:600}`。 |
| POST /api/auth/login/totp | `{transaction_id,code,trust_this_device?}`；成功消耗transaction/step，200 session，無recovery codes。 |
| GET /api/auth/me | public member、csrf_token、expires_at、elevated_until、reauthenticated_until；不回login_name或bearer token。 |
| POST /api/auth/logout | exact Origin/custom header，可清除損壞/過期/suspended cookie並回Guest；revoke當前session，保留trusted-device選擇。 |
| POST /api/auth/step-up | cookie+CSRF，`{password,code}`；驗證兩者並consume新TOTP step，更新兩個elevation deadlines。 |
| POST /api/auth/password/change | recent security step-up，`{new_password}`；新salt/hash/version，revoke全部sessions/devices，回logged_out。 |
| GET /api/auth/trusted-devices | own live devices，最多100；只回id/created_at/last_used_at/expires_at/label，不回hash。 |
| POST /api/auth/trusted-devices/:id/revoke | recent step-up，`{}`；owner-scoped，其他owner id不洩漏存在。 |
| POST /api/auth/trusted-devices/revoke-others | recent step-up，`{}`；只保留當前匹配device cookie，沒cookie則撤銷全部。 |
| POST /api/auth/recovery-codes/regenerate | recent step-up，`{}`；新generation/version，舊批立即失效，raw新10組只在此成功response回一次。 |
| POST /api/auth/totp/reset/start | recent step-up，`{}`；202新enrollment transaction/URI，綁當前session。 |
| POST /api/auth/totp/reset/verify | 同一session+recent step-up+CSRF+browser cookie，`{transaction_id,code}`；驗證新TOTP後替換secret/version/step/recovery batch，revoke全部session/device，回新codes和logged_out。 |
| POST /api/auth/recovery/password/start | `{login_name,recovery_code}`；202短transaction，不登入、不消耗code直到commit。 |
| POST /api/auth/recovery/password/finish | `{transaction_id,new_password}`；原子consumecode、改密碼/version、revoke全部session/device；回login_required，不建立session，原TOTP保留。 |
| POST /api/auth/recovery/totp/start | `{login_name,password,recovery_code}`；驗證密碼+code，202新TOTP URI/transaction；旧secret仍有效直到verify。 |
| POST /api/auth/recovery/totp/verify | `{transaction_id,code}`；正確新TOTP後替換secret/version/step、consumecode、換新recovery generation、revoke全部session/device；回新codes/login_required，不直接登入。 |

忘記密碼且遺失Authenticator：先用一組code恢復密碼，再用另一組code+新密碼重新enroll；沒有長期MFA bypass。所有codes和Authenticator都丟失則無自動recovery；客服人工身份恢復流程未做。
Setup URI含一次enrollment secret，屬必要敏感回應：只能短期呈現/建立QR，勿log/持久存client。Raw recovery codes僅成功建立/換批response返回，client要離線安全保存；HTTP斷線不能重新取同一批，正常MFA登入後可step-up換批。

## TOTP, sessions, trust and step-up

正式依賴 `otpauth`，RFC6238 SHA1、6 digits、30sec、±1step、issuer VoteProof。每次成功驗證把實際step原子存D1，必須嚴格大於last_used_time_step；同step不能再用於login/step-up。使用future drift code後需等待時間趕上再用新step。
AES-GCM random12-byteIV + authenticatedtag，AAD綁member_id/keyversion，ciphertext換到另一member會驗證失敗；rawsecret不進D1。

| Item | TTL / behavior |
| --- | --- |
| normal session | 7天 absolute；256-bit opaque、DB hash-only |
| remember_me | 30天 absolute；無sliding forever |
| trusted device | 30天 absolute；獨立token，password仍必要；最多100個live devices，新trust自動撤銷過期/最舊超額記錄 |
| auth transaction | 10分鐘，browser-bound，最多5次attempt，one-time |
| admin elevation | 1小時，TOTP login/enrollment或password+TOTP step-up取得；trusted password-only login為0 |
| high-risk security reauth | 5分鐘，password change/codes/device revoke/TOTP reset使用；非30天session自動授權 |

Cookies：`__Host-vp-session`、`__Host-vp-login`、`__Host-voteproof_device`，HttpOnly/Secure/SameSite=Lax/Path=/，無Domain。不放localStorage、URL或JSON bearer token。Session登入時旋轉並撤銷browser前一session；trust與remember獨立。

所有admin endpoints（含read/privateproof）在`adminIdentity`要求角色+active member+session+recent MFA；reviewer也適用。所有B5mutation D1 authorization guard再次驗session/角色/expiry/elevated_until，避免stale actor寫入。角色不因tier或trusted device取得。
Suspended login與一般badcredentials同401；已登入member/admin API 403 MEMBER_SUSPENDED，trust不繞過。Guest無cookie流程、query-key查詢仍保持；Member案件ownership/idempotency仍用server member_id，query credential仍向後相容。

## Atomicity, rate limits and retention

D1 batch内assert active-member/credential-version/transaction/browser/expiry/unconsumed/code-generation/TOTP-step/live-session條件，再寫入credentials/counter/codes/session/device/consumption。CHECK失敗整批rollback，對client只回統一verification failure，沒有process-localmutex。Password/reset/generation version變更會使舊login/recovery交易失效；同code兩個recovery交易只能一次commit。
Recovery codes每組256-bit隨機base64url，SHA256 domain/member-bound hash，used_at一次性。DB單獨read無法取得password、TOTP、session/device/recovery bearer。

D1 fixed-window 15分temporarythrottle，scope HMAC含domain，不保存rawIP/loginname作rate metadata：
- registration：account3/window；其他password/recovery/step-up account10/window。
- 每種scope IP40/window；CF-Connecting-IP缺少用shared unknown，不信任clientXForwardedFor。
- auth transaction verification：handle10/window＋transaction總5attempt。每個transaction只能完成一次。
- 跨KDF route共享global200/hour，避免分散account/IP觸發無限昂貴計算。
- security mutation共用member10/window，加個別scope。429 Retry-After900或3600；無永久account lock。
窗口自然到期恢復，不需管理員unlock。公開quota可被惡意觸發temporarydenial，因此Production仍需容量/abuse評估；沒有安全bypass flags。
新transaction會以indexed query最多100筆lazy prune過期transaction/rate rows；expired pending永遠不能active。Session/device/code revocation/expiry強制查驗，不依賴cleanup成功。長期expired/revoked資料retention排程留TODO，不在本次實作排程。

## Migration, checks and rollout prerequisites

舊local Email OTP DB不能原地繼續apply重寫的0003。先停dev，保存所需local fixture，再使用**新的空 --persist-to 目錄**；不要刪/改Production database。`npm run check:admin-schema`自動用ignored隨機local目錄驗證0001→0007、tables/indexes/FK/quick_check，無remote。

```
npm test
npm run test:smoke
npm run test:uploads-smoke
npm run test:cases-smoke
npm run test:auth-smoke
npm run test:admin-smoke
npm run test:points-smoke
npm run test:leaderboards-smoke
npm run test:tiers-smoke
npm run check:admin-schema
npm run benchmark:auth-kdf
npm run check
npm audit
```

移除舊`/api/auth/start`、`/api/auth/verify`及寄信adapter/設定/測試，現在回unknown404。正式程式只有Turnstileoutbound；testfixtures随机credential仅存在disposablememory/D1，沒有Production認證bypass。
API不console log密碼/code/secret/URI/cookie/hash，error不回DB/upstream原文。未來Cloudflare observability也不得收集auth request/responsebody、Cookie、CSRF headers、setup/recovery資料。

Production prerequisites（本次未執行）：手動三組Secrets＋AUTH_ORIGIN、Paid/CPU/load確認，審閱0003..0007 migration與rolesbootstrap授權，再另行批准remote migration/deploy/liveacceptance。Frontend後續用標準autocomplete=username/current-password/new-password，Password Managers可自行FaceID填寫；VoteProof不接觸生物資料。Passkey可新增獨立credential表/step-up adapter，不在此checkpoint。

## Final local acceptance (2026-10-09)

- npm test：502/502，0 failed/skipped；password/TOTP/auth crypto專用57項，保留其餘B1～B5D/Guest/Member回歸。
- B1/B2/B3/B4.x/B5A/B5B/B5C/B5D八套smoke全PASS，首頁bytes unchanged；覆蓋真實workerd登入/記憶/信任/恢復與case owner隔離。
- 新空local D1 0001..0007全部成功；新auth tables/indexes/FKs驗證；foreign_key_check=[]，quick_check=ok；0業務/credential/guard fixtures；僅既有8個tier identity seeds。
- Wrangler4.149.0 dry-run成功：242.49 KiB / gzip55.40 KiB；原DB/PROOFS_BUCKET/ASSETS bindings保留，未上傳。
- npm audit（包含dev）0 vulnerabilities。更新原Wrangler開發依賴的transitive安全修正版；@noble/hashes、otpauth為正式production依賴。
- Git-sensitive literal scan與diff check通過，無實際secret/key/URL/token/local credential；wrangler.jsonc/public/index.html和0001/0002/0004..0007無diff。
- Known caveats：Production Paid CPU/load尚待驗收；key rotation reader/reencryption、retention排程、失去全部factor的人工recovery、Passkey與frontend留後續。原Email auth local DB須reset/newpersist；本次沒有remote操作。

## Checkpoint file inventory

30 modified、6 new、1 deleted；共37檔，全部屬B4.x auth/相容fixture/驗收/文件/依賴。

### Modified

- `README.md`
- `docs/b4-members.md`
- `docs/b5a-admin-review.md`
- `docs/b5b-campaign-points.md`
- `docs/b5c-leaderboards.md`
- `docs/b5d-member-tiers.md`
- `migrations/0003_member_identity.sql`
- `package-lock.json`
- `package.json`
- `scripts/check-admin-schema.mjs`
- `scripts/lib/local-admin-runtime.mjs`
- `scripts/lib/local-auth-runtime.mjs`
- `scripts/lib/local-case-runtime.mjs`
- `scripts/smoke-admin.mjs`
- `scripts/smoke-auth.mjs`
- `scripts/smoke-leaderboards.mjs`
- `scripts/smoke-points.mjs`
- `scripts/smoke-tiers.mjs`
- `src/api/auth-validation.js`
- `src/api/auth.js`
- `src/api/router.js`
- `src/lib/admin-identity.js`
- `src/lib/auth-session.js`
- `src/lib/auth-store.js`
- `test/admin.test.js`
- `test/auth.test.js`
- `test/campaign-points.test.js`
- `test/leaderboards.test.js`
- `test/member-tiers.test.js`
- `test/members.test.js`

### New

- `scripts/benchmark-auth-kdf.mjs`
- `src/api/auth-login.js`
- `src/api/auth-recovery.js`
- `src/api/auth-security.js`
- `src/lib/auth-crypto.js`
- `test/auth-crypto.test.js`

### Deleted

- `src/lib/auth-email.js`
