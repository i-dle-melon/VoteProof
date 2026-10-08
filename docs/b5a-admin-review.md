# B5A：管理員授權與案件審核後端（僅本機）

B4 Email OTP／Resend 版本已保存為本機 checkpoint，身份驗證方案凍結。
未來 password／TOTP／trusted device／recovery／passkey 的評估不在本次範圍。
本次不 push、不 deploy、不 remote migration、不建立 Production admin、不寄送真實郵件、不做首頁或 admin login UI。
Production 仍使用 B3；0003、0004 尚未遠端套用。B5A 不開展 B5B points/campaign 或 B6。

## 身份界線與 RBAC

`admin-identity.js` 只使用 VoteProof 的 `memberSession`／`memberCsrf`：
verified session → active member → D1 active membership → server role。
沒有引用 auth login API、OTP、Resend、email address。日後登入 provider 更換時維持這個界線即可。
每次已知 admin endpoint request 都重新查 D1；過期、撤銷、偽造 session 回 401，suspended member 回 403，無有效 role 回 403 `ADMIN_FORBIDDEN`。
client role／member_id／headers 不能賦予權限。

| 操作 | reviewer | admin | super_admin |
| --- | --- | --- | --- |
| 身份、queue、detail、proof | 可 | 可 | 可 |
| approve / reject / mark_duplicate | 可 | 可 | 可 |
| complete / revoke | 拒絕 | 可 | 可 |
| audit logs | 拒絕 | 可 | 可 |

未實作 membership 管理 API；super_admin 的未來管理權限只由本次 schema 留待擴充。
不新增 Secret／Variable；使用現有 session/CSRF 契約的 `AUTH_SECRET`／`AUTH_ORIGIN`，不依賴 email provider 設定。
所有 JSON response 使用 B1 helper、`Cache-Control: no-store`，錯誤沒有 stack、內部 SQL、R2 key 或 env。
review 使用 HttpOnly host cookie，必須 exact `Origin: AUTH_ORIGIN` + `X-CSRF-Token`，拒絕 cross-site Fetch Metadata。
SameSite=Lax 作輔助；GET 不改資料。沒有 permissive CORS。

## 0004 schema

- `admin_memberships`：UUID id，public member_id FK，UNIQUE member_id（disabled 也只有一列）、role CHECK、status active/disabled、timestamps、created_by member FK。
- `cases` 新增 status_reason（500 字）、status_updated_at/by（member FK）、duplicate_of_case_id（internal case FK）、version（初始 0）、last_review_id（unique mutation marker）。原 reviewed_at/reviewer_id 沿用，不重複新增。
- `admin_audit_logs`：actor member FK、role、action、target、version、安全前後摘要、reason、timestamp；UNIQUE target_type/target_id/target_version。
- queue priority/date/id、duplicate target、audit cursor/target/actor indexes。
- audit UPDATE/DELETE 與衝突 INSERT（含 INSERT OR REPLACE）有 SQLite ABORT triggers；沒有對外修改／刪除 route。duplicate insert/update trigger 強制 status／flag／reference 一致，禁止 self reference。
- `0001`／`0002`／`0003` 不改。舊 pending 案件取得 version=0；沒有預設 role 或 fixture INSERT。

append-only 保護是應用與 schema 規則；持有 D1 schema 管理權限的人仍能移除 trigger，需獨立限制 Cloudflare 維運權限與留存操作紀錄。

## APIs

| Method | Path | 成功 data |
| --- | --- | --- |
| GET | /api/admin/me | member_id, role, csrf_token |
| GET | /api/admin/cases | cases[], next_cursor |
| GET | /api/admin/cases/:caseId | reviewer metadata、files[]（file_id/type/size/date） |
| POST | /api/admin/cases/:caseId/review | case_id/status/version/status_updated_at/by/duplicate_of_case_id |
| GET | /api/admin/cases/:caseId/files/:fileId | authorized raster stream |
| GET | /api/admin/audit-logs | logs[], next_cursor（僅 admin/super_admin） |

known route 的錯誤 method 回 405 + Allow；未知 API 維持 B1 404。
caseId 是 B3 public `VP-...` ID，fileId 是 server UUID。
admin JSON 不回 query key/hash、session token/hash、upload reference、R2 key、credential 或 presigned upload URL。
reviewer detail 可看 submitted nickname/player_id/member_id/note 與審核狀態，但不回 email。

Queue filters：status、campaign_id（現有 cases 欄位，尚無 campaign registry）、vote_type、duplicate_flag=0/1、created_from/to（UTC YYYY-MM-DD，兩端日期均包含）。
limit 1..50，預設 20；cursor 有格式、長度、filter scope 檢查。
預設 pending 優先，同 priority 以 created_at DESC、internal UUID DESC 排序；keyset cursor 不用 OFFSET。
同一資料狀態下排序穩定。佇列是 live view，review 改變 priority 或新建案時不是 frozen snapshot；需要 refresh，不保證跨變更的完整 snapshot。
Audit filters：action、target_type、target_id、admin_member_id、UTC created_from/to；相同 limit，created_at/id DESC cursor。

Review body（JSON 最多 16 KiB，禁止額外欄位）：

```json
{ "action": "approve", "expected_version": 0, "reason": "已核對票據" }
```

reason 最多 500 字且拒絕控制字元；reject/mark_duplicate/revoke 必填非空理由，approve/complete 可省略。
mark_duplicate 另需 `duplicate_of_case_id`（public caseId），其他 action 不接受該欄位。
客戶端不得傳 status、member_id 或 role；actor 一律由 server verified identity 決定。
理由是經授權審核員撰寫的業務備註，應只填審核原因，不可貼 Secret、credential 或 URL；系統不會從 request headers/env/token 產生 audit 內容。

## 中央狀態轉換

| Action | From | To | 權限 |
| --- | --- | --- | --- |
| approve | pending | approved | reviewer+ |
| reject | pending | rejected | reviewer+ |
| mark_duplicate | pending | duplicate | reviewer+ |
| complete | approved | completed | admin+ |
| revoke | approved / completed | revoked | admin+ |

其他 transition 或 stale expected_version 回 409 `CASE_STATUS_CONFLICT`。
duplicate canonical target 必須為不同且存在的 approved/completed 案件；transaction 內再確認 target 狀態，禁止指向 pending/rejected/duplicate/revoked，避免 duplicate chain/cycle。
target 日後 revoke 不會改寫歷史 duplicate 決策；如需重新審核，須另行定義 audited transition。
Repository 沒有正式 Apps Script 狀態 service，首頁 demo 無法作為正式業務規則。因此 revoked restoration 尚未啟用，等待確認 legacy 規則。

`case-review.js` 集中 action/role/transition/version validation 與 B5B TODO hook。
沒有修改 points_awarded、point_status 或 member totals；未建立 ledger 或假 campaign Production data。

## 並發與 audit

讀取 case 後，D1 batch 的條件 UPDATE 比對 expected_version + 原 status，並同時重驗 session 未撤銷/過期、active member、active membership 與 server role。
duplicate target 也在相同 UPDATE guard 重新檢查。
成功更新 version+1 並產生 unique last_review_id；audit INSERT SELECT 只接受該 marker。
競爭輸家 update/audit 都是零列並回 409；audit write error 使整個 batch rollback。
參考 [Cloudflare D1 batch transaction](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。
即使網路遺失 review 成功 response，重新 GET detail/audit 可查版本與決策；review endpoint 不做 B3 建案式 idempotency，也不允許用 stale version 重新審核。
before/after 只有 status、version、public duplicate target；不記 query key、圖片 key、token、email、完整 request 或 env。
此模組完全不輸出 console log。

## 私人 proof 讀取

Worker 驗證身份/RBAC，D1 JOIN 檢查 file 屬於 case，再透過 `PROOFS_BUCKET.get` 讀私人 archive。
依 D1 content_type/size/ETag 比對實際 R2 object，只接受 PNG/JPEG/WEBP。
只輸出可信的固定 header，Content-Type、Content-Length、inline、no-store、nosniff、same-origin CORP、sandbox CSP、no-referrer。
不存在/錯誤關係回 404，完整性不符回 409 `PROOF_INTEGRITY_ERROR`。
直接串流，無 signed GET、public bucket、永久 URL 或 raw key JSON。
實作依据 [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。
授權在 request 入口檢查；已發出的 bytes 無法在中途收回。下一個 request 會重新驗證 membership/session。

## Production bootstrap 設計（本次不執行）

1. 等 B4 auth 方案確定並完成獨立 Production 驗收後，擁有者以正式登入流程建立自己的 active member；不要靠第一個 member 自動升權。
2. 經人工確認已驗證的 public member_id、操作者、授權依據與變更 ticket。不要使用 email 當 authorization，也不要輸出 session/token。
3. 經 review 的一次性維運操作使用 D1 prepared statements + 同一 `DB.batch`：INSERT membership SELECT 該既有 active member（role super_admin、created_by 該 member），再 INSERT audit SELECT 本次指定 membership UUID，action bootstrap_membership、target_type admin_membership、before `{}`、after 僅 member_id/role/status、reason 填 ticket 與操作者。
4. 用 UNIQUE member_id 防止重複／覆蓋；任何 INSERT/audit 失敗整批 rollback。先在 disposable local DB 驗證。不使用 INSERT OR REPLACE、預設 member_id、password 或 hidden endpoint。
5. 保存維運執行紀錄；操作後查 role/audit/FK。後續 membership 異動亦需獨立可審計流程，本次不提供管理 API。

沒有提供可直接執行 Production 的 bootstrap script；不建立任何 Production admin。本機 fixtures 只寫 disposable DB，不觸發 login/OTP/Resend。

## 本機驗證與後續

`npm test` 保留 B1/B2/B3/B4；新增 B5A authorization、review race/atomic audit rollback、duplicate、pagination、CSRF、proof、Guest/Member regression。
`npm run test:admin-smoke` 透過實際 local workerd/D1/R2 執行，email adapter 一旦被使用便失敗。
B4 既有 tests/smoke 只用本機 mocked email，沒有呼叫外部 Resend。
test migration loader 使用 Wrangler SQL splitter 保留 trigger BEGIN/END；empty local DB 另由 Wrangler 正式 migration runner 驗證。
`npm run check:admin-schema` 每次建立全新的 ignored local D1，驗證空 DB → 0001..0004、indexes/FK/triggers/quick_check、業務 tables 零資料；不使用 --remote。

未完成：B4 auth 重新評估、Production 0003/0004 rollout、人工 bootstrap、正式 admin UI、revoked restoration 業務規則、B5B ledger/campaign、長期 orphan reconciliation。
以上均不在本次執行，不進 B5B/B6。

## 本次檔案與驗收結果

修改 4 檔：`README.md`、`package.json`、`scripts/lib/local-case-runtime.mjs`、`src/api/router.js`。

新增 11 檔：

- `docs/b5a-admin-review.md`
- `migrations/0004_admin_review.sql`
- `scripts/check-admin-schema.mjs`
- `scripts/lib/local-admin-runtime.mjs`
- `scripts/smoke-admin.mjs`
- `src/api/admin-validation.js`
- `src/api/admin.js`
- `src/lib/admin-identity.js`
- `src/lib/admin-store.js`
- `src/lib/case-review.js`
- `test/admin.test.js`

本機 `npm test`：319/319（既有 247 + B5A 72）；B1/B2/B3/B4/B5A smoke 全部通過。
全新 local Wrangler D1：0001..0004、tables/indexes/5 triggers/FK/quick_check 全部通過，業務資料為空。
Wrangler dry-run：88.88 KiB / gzip 22.26 KiB，DB/PROOFS_BUCKET/ASSETS 綁定保留。
65 個 tracked/new 檔案敏感值掃描無發現；首頁、wrangler.jsonc、lockfile、0001..0003 保持 checkpoint 內容。
B4 checkpoint：`d0cff9c11ba525e66ee27b19f9a119024e02192f`。
所有 B5A 變更未提交；main 相較 origin/main 僅領先此 1 個本機 B4 checkpoint。沒有 push/deploy/remote migration。
