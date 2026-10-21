# VoteProof Google MFA V1.1：實作與 IC 交接

基準 main：b97accb8762a9899bc59ab9be9197fc54db2853c；開發分支 codex/google-mfa-optional-v1。

本輪僅本機開發與隔離測試。沒有修改 main、Production、正式會員／Session／投稿設定、R2／Drive／Supabase、Secrets 或部署保護；沒有 push 或正式部署。A、B、C 分開提交，後續 GPT IC 補正另立提交，最終 SHA 以交接 README 及 git log 為準。

本輪補正差異、重新執行的測試及完整原始輸出索引，見 [GPT IC 補正紀錄](google-mfa-ic-corrections.md)。以下初版測試數保留為歷史紀錄，不與補正後的執行數重複加總。

## A：Google 可選式 MFA

- 無政策列視為關閉。新會員與已存在會員都不會因已有 Authenticator 而自動開啟 Google MFA。
- 啟用時重用 OAuth State、PKCE、瀏覽器綁定的 google transaction。設定 QR、驗證設定、保存復原碼、輸入下一組有效 TOTP 後，才更新政策。
- 啟用後 Google OAuth／Confirm 只回傳待驗證挑戰，不核發會員 Session。TOTP 或一次性復原碼成功後，與交易消耗、稽核及 Session 建立在同一 D1 batch 原子完成。
- 7／30 天登入期限不變。Google MFA 登入不建立 Google 信任裝置，也不自動給管理員 elevation；敏感管理操作仍需原有明確 step-up。
- 啟用／停用遞增 generation 並原子撤銷舊 Google Session。若操作來自 Google Session，旋轉目前 Session 並保留其原到期時間；密碼 Session、信任裝置及 30 天規則不變。
- Google OAuth＋任一有效且未使用的復原碼，皆可在登入中明確勾選並再次確認停用 Google MFA，不受剩餘組數限制。請求必須同時包含布林值 disable_mfa=true、confirmed=true；缺少、錯誤型別或錯誤確認均拒絕。驗碼消耗、政策更新、撤銷 Google Session 與新登入同批完成。未明確選擇時，復原碼登入不改政策。此流程不刪 Authenticator、不修改密碼 MFA、不授予管理權限。
- GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED 預設未設定／false，只封鎖新啟用，不關閉既有政策驗證，也不阻擋停用或復原。

### Migration 0028

檔案：migrations/0028_google_login_mfa.sql。

新增 google_login_mfa（會員 PK、enabled、generation、updated_at）與不可改寫／刪除的 google_login_mfa_events。auth_google_flows 只新增 nullable mfa_policy_action；auth_sessions 新增預設 0 的 google_mfa_generation／google_mfa_verified 收據欄位。

不重建 auth_transactions、不修改 kind CHECK、不重寫舊 Migration、不建立 Google trusted-device table／token／cookie。Migration 本身不建立政策列、不撤銷既有 Session；只有日後經驗證的政策異動會撤銷 Google Session。

DB trigger 對啟用 MFA 會員的 Google Session INSERT 強制驗證收據與政策版本。舊 Worker 不認識此機制時會拒絕登入，而不是繞過 MFA。政策不可直接 DELETE／REPLACE，generation 必須逐次遞增。

### API 合約

所有 POST 保留同源 Origin、自訂請求標頭；已登入操作另保留 Session CSRF。交易 ID、瀏覽器 Cookie、期限、會員／Google 身分、政策版本與因素均由後端驗證。

| API | 輸入／回應重點 |
|---|---|
| GET /api/auth/login-security | 原 DTO 加 google.mfa={enabled,generation,available}；在原身分 SELECT 中 indexed LEFT JOIN，不增加 D1 往返 |
| POST /api/auth/google/start | 原欄位；政策操作加 mfa_policy_action=enable/disable，只允許 purpose=security、confirmed=true 與合法會員 |
| GET /api/auth/google/result | 加 mfa_policy_action、mfa_required；政策流程回傳 authenticator_configured，便於重新載入續行 |
| POST /api/auth/google/confirm | 原輸入；啟用政策時 HTTP 202 GOOGLE_MFA_REQUIRED，沒有會員 Session Cookie |
| POST /api/auth/google/mfa/verify | transaction_id、code；成功回傳既有會員 Session DTO |
| POST /api/auth/google/mfa/recovery | transaction_id、任一有效未使用 recovery_code；剩餘多組或單組皆適用。停用時必須同時傳布林 disable_mfa=true、confirmed=true；兩者皆省略則只登入、不停用 |
| POST /api/auth/google/mfa/enroll/start | 綁定啟用政策的 transaction_id；回傳本機 QR URI，加密設定保存在同一交易，不旋轉瀏覽器綁定 Cookie |
| POST /api/auth/google/mfa/enroll/verify | transaction_id、code；只註冊 Authenticator，回傳一次性 recovery_codes 與 google_mfa_enabled=false |
| POST /api/auth/google/mfa/enable | transaction_id、code、recovery_confirmed=true；需未消耗的有效 TOTP 與可用復原碼 |
| POST /api/auth/google/mfa/disable | transaction_id，加 code 或 recovery_code，二擇一；須新鮮且動作綁定的 Google OAuth |

缺 Migration／D1 故障回 503，不降級免 MFA。政策或交易競態拒絕，須重新驗證；不自動重送不確定變更。未套 0028 的新 Worker 會安全拒絕 Google 流程，因此部署必須先 Migration。

### 威脅模型

| 風險 | 防護及證據 |
|---|---|
| OAuth／CSRF／跨瀏覽器登入交換 | 沿用 State、PKCE、browser hash、Session hash、精確 Origin／CSRF；原 OAuth callback 重播與跨瀏覽器測試保留 |
| MFA 前取得會員資料 | Confirm 202 不發 Session；verify/recovery 成功 batch 才 INSERT Session |
| TOTP／復原碼重播、併發登入 | credential version、last-used step、recovery generation、used_at 與交易 one-use guard 同批檢查 |
| 政策與登入／設定／重設競態 | OAuth 綁定 generation；CAS payload、active identity/session、D1 原子 guard；政策 trigger 原子撤銷舊 Google Session |
| 稽核寫入或資料庫故障 | 整批 rollback，不消耗因素或發布 Session；明確重試仍受交易／因素 guard 保護 |
| 舊 Worker 回退繞過 | DB Session insert gate 保留政策與收據檢查；不可移除政策來回退 |
| Google MFA 誤升管理權限 | 一般登入 mfa elevation 保持 0；政策 OAuth proof 不能借用為 admin step-up；三種管理角色均測試 |
| 不必要裝置信任／每日成本 | 不新增 Google trust；不在一般 memberSession、投稿、PUT 或排行榜讀取政策；沒有排程／輪詢 |

## B：密碼登入信任裝置 UI

標題：**密碼登入信任裝置**。

說明：**此功能僅適用於「密碼」登入，信任期限為 30 天。(Google免設定)**。

空清單：**目前沒有已信任的裝置。**

依既有 password.configured 判定：Google-only（包含 MFA 已啟用）在安全設定及會員總覽都隱藏整個區塊，且不送裝置清單請求；密碼-only／雙登入會員照常顯示。建立、最後使用、到期時間與原撤銷 API／CSRF 均保留。不改 trusted_devices、Cookie、30 天機制或後端 API。

Google免設定僅指不需要設定密碼信任裝置；主動開啟 Google MFA 後仍需第二因素。

## C：本次回歸膠囊

只將排行榜管理的本次回歸 span 改用 status.comeback，與 status.completed 共用綠色文字、半透明背景、圓角、padding、字級與字重；不加入 completed 的勾號。

「開放」、「公開」原標籤及樣式未改；is_current_comeback、計分、重建、排序、API 與正式資料均未改。

## 初版測試紀錄（歷史）

- 既有 Auth／Google／Session／RBAC 核心：125 PASS；本功能最終獨立套件 20 PASS（含新增補充案例，與核心有重疊，勿直接相加）。安全狀態 JOIN 調整另有 3 項對應測試 PASS。
- 真實 Wrangler 本機 populated Migration 0019→0028 registry：1 PASS。既有資料、Session、待驗證交易、投稿設定與 PK/FK 保留，quick_check=ok。新政策表空白、Session 收據預設 0。Windows 本機測試採短暫存路徑並清理，未連正式 D1。
- 前端單元／相關本機整合：90 PASS。
- Pages build／隔離：2 PASS。
- 跨 Desktop Chrome／Android Chrome／iPhone WebKit 整合：162 個不同案例均已驗證通過。整輪先有 159 PASS，3 項舊測試仍期待舊空文案；更新為需求指定新文案後，三平台針對重跑 3/3 PASS。沒有為此修改產品安全規則。
- 新功能 A 瀏覽器 84 個、B 18 個、C 3 個案例均在上述範圍；支援 320／390／430／1024／1440、Dark／Light，相關既有會員表單也涵蓋 375／768。
- 一項 100 ms 到期 fixture 原在 WebKit 操作前已過期；固定測試時鐘後三平台 PASS，正式到期規則未改。
- Syntax、frontend hooks、public assets、敏感資料掃描、git diff --check：PASS；沒有重跑全 backend 或雲端 CI。

復現指令：

```text
node --test --test-concurrency=1 test/auth-google.test.js test/google-login-mfa.test.js test/auth.test.js test/admin-session-mfa.test.js
node --test test/rc-migration-chain.test.js
npm run test:frontend-unit
node --test test/pages-public-build.test.js
npx playwright test frontend-tests/google-login-mfa.spec.js frontend-tests/password-trusted-ui.spec.js frontend-tests/comeback-pill.spec.js frontend-tests/google.spec.js frontend-tests/member.spec.js frontend-tests/admin.spec.js frontend-tests/ci-smoke.spec.js --grep 'google-login-mfa.spec|password-trusted-ui.spec|comeback-pill.spec|google.spec|member.spec.*(trusted login|untrusted login|full password recovery|logged-in center|revoked session|auth sensitive|auth forms|session expiry|pagehide)|admin.spec.*(admin nav|MFA|Google security|password step-up|security devices|Google-only enrollment)|Pages shared UI'
```

## CPU／D1 證據及限制

google-mfa-local-metrics.json 保存 Windows、Node 24、Miniflare/workerd、隔離 D1/R2 與模擬 Google 的一次有界流程實測。原 statement/trip 量測只攔截 Worker 呼叫的 D1 prepare／batch API，包含限流／交易 guard，不是計費 rows。**D1 SQL Trigger 內部查詢及其內部執行成本未列入原 statement/trip 數字；這些數字不是完整 DB 工作量或總成本。** Trigger 仍實際執行，未因量測而跳過。Wall Time 包含本機 dispatch/I/O，只是樣本，不是 CPU 或 P95。

| 登入流程 | HTTP 次數 | SELECT statements | Write statements | D1 trips | 合計樣本 Wall ms |
|---|---:|---:|---:|---:|---:|
| Google MFA OFF：start/callback/result/confirm | 4 | 10 | 19 | 20 | 41.56 |
| Google MFA ON：start/callback/result/challenge/verify | 5 | 12 | 27 | 28 | 57.51 |

新增寫入是驗證限流、挑戰、一次性因素、guard、audit 與 Session，不是 Google 信任裝置。Session INSERT trigger 有 indexed 政策核對，只在建立 Google Session 時執行。

一般 /auth/me、/me/cases、投稿狀態、排行榜、prepare、圖片 PUT、Complete、Case 建立實測均為 **0 次 Worker 顯式 Google 政策 SELECT**，且完整隔離投稿成功。此計數不涵蓋 D1 Trigger 內部查詢，不能據此宣稱底層沒有任何政策核對或 CPU 成本。login-security 必須讀自己的設定，因此在原身分 SELECT 併入 indexed JOIN，沒有新增一個往返。原有 memberSession 檔案不變。首次排行榜既有 materialization 寫入與 MFA 無關。

**Cloudflare 真實 Worker CPU：UNKNOWN（未取得真實 traces）。Workers Free CPU readiness：UNKNOWN。** 沒有部署隔離或正式 Cloudflare Worker；不能把本機 wall time、statement/trip 或 Trigger 靜態分析當 CPU 或宣稱 CPU PASS。模擬 Provider 也不等於真實 Google／Supabase 端到端驗收。

## 安全發布與 Rollback（僅方案，未執行）

1. IC 通過、另獲精確 SHA 正式授權後，先評估／備份並套 0028；不能先發布依賴新 schema 的 Worker。
2. 發布相容 Worker，GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED 保持未設定／false，會員政策預設關閉。
3. 相容前端及隔離驗收通過，再由 Operator 另行授權受控驗收、真實 Provider／CPU 驗證及開放會員 opt-in。
4. 若須停止新啟用，關閉 opt-in flag；既有 MFA 驗證、停用、復原仍要繼續服務。
5. 已有 MFA 啟用會員時，只以具備政策驗證的相容 Worker 回退。保留 Migration、政策、收據與 Audit。舊 Worker 會被 DB gate 安全拒絕 Google 登入，會影響可用性，不能當正常回退版本；不得刪政策、刪 schema 或整庫復原來繞過。
6. 投稿、自動清理、告警、R2／Drive 與其他正式設定不屬本輪變更。

## ChatGPT IC 檢查清單

- 先核對遠端 main 與基準 SHA，保留後續提交；A／B／C 依序獨立審查。不得強推或未授權合併 main。
- 逐一路由確認 Google MFA 啟用後沒有未驗第二因素的 issueSession 路徑；舊 Worker 的 DB 降級防護不可移除。
- 檢查政策動作與 OAuth／Session／瀏覽器綁定、generation CAS、TOTP 重播、recovery 一次性、稽核與 batch rollback。
- 特別審查任一有效未使用復原碼的明確停用選項：剩餘多組或單組都適用，必須 disable_mfa=true 且 confirmed=true，不能自動降級，也不能授予管理權限。
- 驗證預設 opt-in flag 關閉時仍強制既有 MFA；Migration 缺失或 D1 故障不能 fallback。
- 檢查無 Google trust 新表／Token／Cookie，密碼信任裝置機制未改，Google-only UI 隱藏且不查裝置。
- 檢查本次回歸只加 comeback class，開放／公開、分數／排序／API 都未改。
- 沿用已記錄的本機證據，針對差異執行 IC；正式發布仍需另一份 Operator 授權。
- 明列真實 Google／Supabase E2E 與 Cloudflare CPU 尚未量測；如需建立／使用隔離雲端或測試 Provider，先取得該範圍授權。

## 檔案與尚未解決項目

主要檔案：src/api/auth-google.js、auth-google-mfa.js、auth-methods.js、auth.js、router.js；src/lib/google-login-mfa.js；Migration 0028；public/index.html、css/app.css、js/member.js、js/member-api.js、js/admin.js。其餘是隔離 harness、測試、Pages DTO 及本報告／量測 JSON；完整清單見交接 README／patch。

程式與本機隔離驗證已完成；尚缺 IC、真實 Provider 受控驗收及真實 Cloudflare CPU。沒有 Production 發布授權，亦沒有自動部署、正式 migration 或正式資料變更。
