# 前端重設計契約（本機候選）

本階段未做視覺重設計。Production 仍使用 91e0a70；SHA evidence 是本機 additive candidate。
此文件與 `.wrangler/frontend-contracts/` 的自動 inventory 一起使用。

## 實際畫面與 API／UI matrix

共同回應 envelope：成功 `{ok:true,data}`，失敗 `{ok:false,error:{code,message}}`。
敏感 API no-store；前端不直接顯示 upstream exception。讀取需 loading／empty／error 分開；
uncertain mutation 不自動重送（batch successful item 只重用既有 idempotent result）。

| 畫面／模組 | 真實 endpoint／method | 授權 | 請求／主要 response | 空／錯誤／OFF 契約 |
|---|---|---|---|---|
| Home／活動 | GET /api/campaigns | public | current campaign IDs、name、window、points_per_proof、daily_limit | 無活動／載入失敗分開；OFF 不偽造可投稿 |
| 全站收件狀態 | GET /api/submissions/status | public | submissions_enabled、submissions_message | 失敗保守暫停；OFF 禁止 prepare／complete／new case |
| 登入 | POST /api/auth/login；POST /api/auth/login/totp | password transaction | email、password、remember_me → transaction_id；transaction_id、code、trust_this_device | AUTH_REQUIRED／LOGIN_FAILED／rate limit；MFA 前無有效會員狀態 |
| 註冊 | GET /api/auth/registration-status；POST /api/auth/register/start、resend、verify-email、credentials、verify-totp | bounded enrollment | email、login_name／nickname／player_id／password、challenge/code（各步依 auth schema） | signup capacity／email challenge／TOTP readiness；不跳步、不重設 Production policy |
| Google 登入／確認 | POST /api/auth/google/start、confirm、cancel；GET callback、result、login-security | OAuth state／PKCE／purpose binding | purpose、confirmed；flow result/code，server decides identity | 取消／失敗清理；callback 不當作 Admin elevation 自行信任 |
| Submission／batch | POST /api/uploads/prepare、complete；POST /api/cases | Turnstile；optional session／CSRF／Origin | prepare turnstile_token＋files(name/type/size)；complete session_id＋keys；case nickname/player_id/campaign_id/vote_type/vote_date/note/upload_session，Idempotency-Key | 最多20張 frontend逐張→獨立case；backend舊contract最多5 files/request。FILE_TOO_LARGE／UPLOAD_INCOMPLETE／UPLOAD_CHANGED／CAMPAIGN_*／SUBMISSIONS_DISABLED；已成功item不重建 |
| Case lookup | GET /api/cases/{case_id} | query key，優先 X-Case-Query-Key；舊 query key 相容 | case/status/date/points、files MIME/size | 不存在／錯 key 相同404；不公開R2／其他會員／hash evidence |
| Member Center | GET /api/auth/me；PATCH /api/me/profile；GET /api/me/points | active verified member session；writes CSRF/Origin | member nickname/player_id、total_points、tier、next_tier、tier_progress／configuration_ready | Guest 導登入；unconfigured Tier 顯示普通／門檻未設定；最高無 next |
| My Cases／detail | GET /api/me/cases；GET /api/me/cases/{case_id} | server owner binding | cursor filters、自己的 case summary/details | empty 不當error；ownership404；OFF仍可讀已有案件 |
| Leaderboard | GET /api/leaderboards | public published snapshot only | id／filters；rankings、published board、generated_at | 無snapshot／empty／fetch error 分開；不做client計分 |
| Security／sessions | POST /api/auth/step-up、password/change/start、password/change、recovery-codes/regenerate、totp/reset/start、totp/reset/verify；GET trusted-devices；POST trusted-devices/{id}/revoke、revoke-others | active session；recent step-up where required；CSRF/Origin | password/code／challenge/recovery；safe device IDs metadata | invalid proof／expired challenge／rate limits fail closed；不改 server timestamps |
| Recovery／dual methods | POST /api/auth/recovery/password/start、finish、totp/start、finish；password/add/start、verify；google/totp/enroll/start、verify；google/step-up | bound server recovery/enrollment/security transactions | email/code/challenge/password depending step | no enumeration；one-time challenge／attempt bounds；不公開 recovery/hash secrets |
| Admin 入口／login gate | GET /api/admin/me | verified active membership＋server MFA elevation | role、csrf_token | role 不採localStorage；403／ADMIN_STEP_UP_REQUIRED關閉特權content |
| Admin review／private proof | GET /api/admin/cases；GET /api/admin/cases/{id}；GET /api/admin/cases/{id}/files/{file_id}；POST /api/admin/cases/{id}/review | reviewer/admin/super_admin；writes MFA/CSRF/Origin及mutation guards | filters/cursor；expected_version、action、reason、duplicate_of_case_id；proof為授權private blob | reviewer不能complete/revoke；409需fresh read；blob URL離開即revoke |
| Exact evidence（候選） | existing GET /api/admin/cases/{id} 的 duplicate_evidence | same Admin protections | hash_state、exact_match_detected、matches relationship／previous case/status/time、truncated | not_verified不說無重複；無public endpoint；never auto-reject |
| Campaign 管理 | GET/POST /api/admin/campaigns；GET /api/admin/campaigns/{id}；POST /api/admin/campaigns/{id}/update | verified Admin reads；elevated admin/super_admin＋CSRF writes | campaign windows/timezone、vote dates、points_per_proof、daily_limit、status、expected_version、reason（更新依既有schema） | validation/version conflict保護；daily_limit null=unlimited、0=no award |
| Tier 管理 | GET /api/admin/member-tiers；POST /api/admin/member-tiers/{id}/update | elevated admin/super_admin＋CSRF | min_points、status、expected_version、reason；immutable 8 identities | conflict不儲存；disabled參與threshold排序；本機CLI preview無save |
| Points／audit | GET /api/admin/members/{id}/points；POST /api/admin/points/adjustments；GET /api/admin/audit-logs | elevated admin/super_admin；adjust idempotency/CSRF | member_id、points、reason、Idempotency-Key；ledger/audit summary | 不直接寫member cached tier/points；audit append-only；manual adjustment需明確人工作業 |
| Leaderboard 管理 | GET/POST /api/admin/leaderboards；GET /api/admin/leaderboards/{id}；POST /api/admin/leaderboards/{id}/update、/{id}/rebuild；GET /api/admin/leaderboards/{id}/results | elevated admin/super_admin；CSRF/step-up writes | definitions、expected_version、explicit rebuild；archive 是 update 的 status，不是獨立endpoint | published results來自ledger；client不擅自rebuild |
| Drive backup | GET /api/admin/backups；GET /api/admin/cases/{id}/backups；POST /api/admin/backups/backfill、{id}/retry、{id}/process | elevated admin/super_admin；MFA/CSRF writes | counts／transport／ready／blocked；dry_run、limit、after、file_ids；retry expected_version | current apps_script_pull下direct process回410；backfill需要人審清單；無publicDrive links |
| 收件管理 | GET /api/admin/submissions；POST /api/admin/submissions/update | elevated admin/super_admin；CSRF/step-up | submissions_enabled、submissions_message、expected_version、reason | 不在本階段打開OFF；失敗維持server值 |
| 私人 relay（非前端） | POST /api/internal/drive-backup/claim；/{id}/identity、complete、failed；GET /{id}/content | dedicated Bearer secret，拒絕browser Origin；lease/attempt | max1 job／idle、reserved IDs、metadata receipt | 前端與Pages永不呼叫；開關/secret/lease不符fail closed |

表格採功能摘要；完整 static／regex route declaration 的 file/line 見 endpoint-source-inventory.json。
auth 各步字段請以 src/api/auth-*.js validator 為准，不能將不同步驟表單合併或自行省略challenge。
所有method/path在改設計前必須以 source inventory 複核；不得以 UI fixture 擴充Production端點。

## DOM／copy／tokens

執行 `node scripts/audit-frontend-contracts.mjs` 產出 IDs、form attributes、data-*、JS/test selector source
line inventory；固定 hook 一律 MUST PRESERVE。CSS-only class 可在同步 CSS／test review 後改名；
動態 class／admin-field／view-/security IDs 必須同步JS。不要放寬 hook fixture 掩蓋 breaking change。
copy inventory 區分 HTML／JS（含插值）並列重複；Admin template 的 span IDs 是 copy contracts。
設計 tokens 保留 dark #121212、bright green #00cd3c、light #5E0E8B；audit列完整variables、fonts、
spacing、radii、shadows、breakpoints，不在這階段統一文字或改style。

## 下一階段執行順序

| 步驟 | 預期修改檔案 | 必驗契約 |
|---|---|---|
| 1 tokens/shell | public/css/app.css、public/index.html | hidden／focus／safe-area／兩theme |
| 2 header/nav | index.html、app.css、必要時app.js | hash routing、data-view、Admin gate |
| 3 homepage | index.html、app.css | campaign/server收件狀態 |
| 4 auth | index.html、app.css、member.js | signup/login/Google/TOTP/recovery逐步state |
| 5 submission | index.html、app.css、submission.js | limits／OFF／Turnstile／idempotency |
| 6 batch results | 同上 |20獨立items、success不重建、partial retry |
| 7 member | index.html、app.css、member.js、tier-artwork.js、member-tier-progress.js |server points/current/next Tier |
| 8 cases | index.html、app.css、app.js、member.js |query-key privacy、owner filter |
| 9 leaderboard | index.html、app.css、app.js |published snapshot、empty/error |
| 10 Admin | index.html、app.css、admin.js、admin-backup.js、admin-duplicate.js |role/MFA、expected_version、proof blob lifecycle |
| 11 mobile polish | app.css |320/375/390/430/768、long IDs、safe-area |
| 12 accessibility | HTML/CSS/affected modules |labels、focus、dialog、error association、contrast |
| 13 visual regression | frontend-tests、existing hook fixtures仅必要同步 |dark/light、threebrowser、Pages safety |

開始條件：先選定 Tier 產品方向；套用Production仍另需 explicit authorization。
尚未批准 SHA candidate 上線不妨礙本機contract／設計，但不可把未部署的evidence欄位當成Production必有。
