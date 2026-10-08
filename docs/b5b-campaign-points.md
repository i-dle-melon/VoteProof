# B5B Campaign + Point Ledger（本機 checkpoint）

B4 auth 繼續凍結。B5A checkpoint：`cd6a5a31d79a11fab0dcdc9831dfc20d22034129`。
本次只做正式 Campaign／append-only 點數帳本後端；不 push、deploy、remote migrate、不改首頁、登入 provider 或 Admin UI，不進 B5C/B6。
不新增 Secret／Variable。Admin/Member APIs 只依賴既有 verified session/member 與 CSRF。
Google Sheet/Apps Script 不寫入、不做雙向同步；既有 B1 leaderboard 讀取保留，新 leaderboard 留 B5C。

## Schema / migration

新增 `0005_campaign_point_ledger.sql`，0001..0004 完全不改。

`campaigns`：immutable PK campaign_id（1..100 ASCII identifier）、name/category、UTC start_at/end_at、IANA campaign_timezone、server-derived vote_start_date/vote_end_date、points_per_proof、daily_limit、draft/active/closed/archived、note、created/updated timestamps/actors、version、private mutation marker。
points_per_proof 是 0..1,000,000 integer；daily_limit 是 0..1,000 integer。DB CHECK 日期順序、integer/type/bounds、status；FK 綁定 member actors。
正常 admin API 的 actors 由 session 決定；nullable actor 欄位留給未來獨立授權的資料匯入與 disposable local fixtures，本次沒有 Production seed/import。
公開 list index：status/start_at/campaign_id；admin cursor index：created_at/campaign_id。
DB triggers 禁止改 ID、刪除、REPLACE，並強制 status/window 更新政策。

`point_transactions`：transaction_id PK、created_at、member_id FK、nullable internal case_id/campaign_id FK、category、vote_type/vote_date、integer points、required reason、created_by FK、reference_transaction_id self FK、safe metadata_json、manual-adjustment idempotency/request hashes。
類別：proof_approved（正值）、proof_revoked（負值）、manual_adjustment（非零正/負）、預留 proof_reapproved（未提供 API）。
Manual adjustment 的 case/campaign/vote/reference 必須 null；proof transaction 必須綁定案件、會員、活動與 vote_date，不能替 Guest 發點。
每案唯一原始 award；每原始 award 唯一 reversal；每 actor-scoped adjustment key 唯一 hash。
DB triggers 禁止 UPDATE/DELETE/REPLACE，檢查 case ownership/fields/status 與 reversal 的精確負值。
Indexes 只覆蓋 member/date、member/campaign/vote_date/category、case 查詢及 award/reversal uniqueness；沒有另外加未使用的全域 category/date index。

`cases` 沿用 points_awarded/point_status，只新增 nullable `point_transaction_id` FK。Guest points snapshot 在 DB insert/update trigger 強制為 0。
Snapshot 用於案件顯示，會員總分 source of truth 永遠是 `SUM(point_transactions.points)`。

B5A audit 的 CHECK enum 需要新 action/target，0005 以新表複製所有既有列、替換原表、重建 indexes/append-only triggers。
已有 audit rows 保持原內容；有 migration preservation test。沒有修改 0004 歷史或清空 audit。
所有 migration 不插入假 Campaign、不補發歷史點數。

## Campaign policy / timezone

API datetime 必須是 UTC `YYYY-MM-DDTHH:mm:ss.sssZ`，start_at < end_at。Submission interval 是 `[start_at, end_at)`。
campaign_timezone 是經 Intl 驗證/正規化的 IANA timezone，省略時使用明確 UTC；不使用 client/browser/server 預設時區。
vote_date 是 Campaign 時區的 YYYY-MM-DD，不由 client timezone 再轉換。
vote_start_date 取 start_at 的當地日期；vote_end_date 取 end_at−1ms 的當地日期。
因此只有與活動 instant window 重疊的當地日期可投稿；午夜 exclusive end 不會多接受一天，DST 也由 IANA 規則決定。
因票據目前只有日期，邊界日可驗證到「日期有重疊」，無法驗證該日實際投票時刻；如需精確時刻必須另定義 metadata。
B3 既有 vote_date 格式、最早日期與 future-day validation 保留。

建立可為 draft 或 active。State transitions：draft→active/archived、active→closed、closed→archived；同狀態可更新，archived 完全 immutable。
離開 draft 後 start/end/timezone 固定，避免改變歷史票據日期資格；不開放 reopen。
points/daily_limit/category/name/note 可在非 archived 狀態以 expected_version 更新，適用後續 approval，不改已有交易。
降低 daily_limit 不撤回歷史有效 awards；只有新的 approval 用當下上限。

新案件必須 Campaign 存在、active 且現在落在 submission interval，vote_date 落在 derived 日期範圍。
不存在/draft/closed/archived/尚未開始/已結束拒絕。closed 不提供補交 policy；之後若需補交須另設明確政策。
Campaign version/open/window 在 R2 copy 前檢查，case D1 guarded INSERT 內再驗，失敗沿用 B3 私人 copy compensation。
B3 persistent case replay 先於 Campaign policy 檢查，既有成功案件在 Campaign 關閉後仍可重取原 logical response/query credential。
已投稿的 pending case 可在 active/closed Campaign 中核准；archived 禁止新 approval，仍允許已有 award 的 revoke。

## APIs

| Method | Route | 權限 / contract |
| --- | --- | --- |
| GET | /api/campaigns | public，`{campaigns: [...]}`，只含 active 且目前在期間內 |
| GET | /api/admin/campaigns | reviewer+，status/limit/cursor pagination |
| POST | /api/admin/campaigns | admin+，validated full create body，201 |
| GET | /api/admin/campaigns/:campaignId | reviewer+，campaign metadata |
| POST | /api/admin/campaigns/:campaignId/update | admin+，完整 editable fields + expected_version，200 |
| POST | /api/admin/points/adjustments | admin+，Idempotency-Key 必填，201 |
| GET | /api/me/points | active authenticated member 的 `{total_points}` |
| GET | /api/admin/members/:memberId/points | admin+，指定既有 member 的 `{total_points}` |

Public fields：campaign_id/name/category/start_at/end_at/campaign_timezone/vote_start_date/vote_end_date/points_per_proof/daily_limit/status。
不回 actor/version/note/private marker。正式 D1 空 registry 回 []；DB 未配置/尚未 migration/儲存失敗回 sanitized 503，不能假裝 [] 以掩蓋故障。
Admin list limit=1..50（default20），created_at/campaign_id DESC keyset cursor，status filter scope 綁定 cursor。
Update 不接受 campaign_id 或 client actors。Archived/stale version/非法 policy 回 409 CAMPAIGN_CONFLICT；重複 create 回 409 CAMPAIGN_EXISTS。
新稿資格錯誤：CAMPAIGN_NOT_FOUND / CAMPAIGN_NOT_OPEN / VOTE_DATE_OUTSIDE_CAMPAIGN；R2 copy 期間 version 改變回 CAMPAIGN_CONFLICT。
review policy 不允許時回 409 CAMPAIGN_NOT_REVIEWABLE；review transaction guard 失敗維持 409 CASE_STATUS_CONFLICT。
所有 JSON／auth response no-store，mutation exact Origin + CSRF，body limit 16KiB，prepared statements，unknown API 404/method 405。

## Approve / daily limit / complete

單一 D1 batch：

1. CAS case status/version，重驗 actor active member、active role、session expiry/revocation、duplicate policy、Campaign version/status/date。
2. 依 member_id + campaign_id + vote_date 在 transaction 內計算 net rewarded count：proof_approved + reserved proof_reapproved − proof_revoked。
3. 若 Member、points_per_proof>0、net count < daily_limit，append 原始 award；metadata 保存當下 Campaign version/category/timezone/points/daily_limit。
4. 從 ledger 算案件 snapshot，設 point_status 與 transaction reference。
5. Append audit（actor/status/version/points before/after/transaction ID），在同一 batch 取得結果。

有效獎勵單位是一個 approved case，與該 case 附幾張圖片無關。
Guest、zero-value Campaign、每日容量已滿皆可正常 approved 並得 0，不創建零值 point transaction。
point_status：awarded / guest_no_points / daily_limit / zero_value_campaign；pending 初始 null。
daily_limit=0 表示不給任何 proof award，並非 unlimited；points_per_proof=0 的原因優先為 zero_value_campaign。
只有實際正值獎勵占每日容量，日期取 vote_date，不取 review/created date。Manual adjustments 不影響容量。
容量以 D1 序列化的 successful transaction 順序分配；同時核准不同案件可以都成功 approved，但最後一個 slot 只有一案獲得正值 points。
`approved→completed` 不寫 ledger，保留原 snapshot，不 double award。
參考 [D1 batch transaction guarantees](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。沒有 process Map/lock 或服務外先算 usage。

## Revoke

同一 review batch 改為 revoked，對原實際正值 award append `proof_revoked = -original.points`，reference 指向原交易。
Campaign 後續 points 修改不影響補償；原 row 不改、不刪，原 metadata 亦保留。
case points_awarded 更新為 ledger net（正常為0），point_status=revoked，reference 指向 reversal；audit 同批。
零分案/Guest 沒有原始 positive award，不創造負交易。Unique reference + case version 防 double reversal，retry/stale request 回409。
撤銷釋放一個 slot；既有因 daily limit 得0的 approved 案不自動補分，新 approval 才使用釋放容量。
不開放 revoked→approved/completed；reserved proof_reapproved 的正式流程須另做 audited state machine / active-award design。

## Manual adjustment / summary

Request：`{member_id, points, reason}`，points 為非零 integer，abs <=1,000,000，reason 非空 <=500 字。
只允許 admin/super_admin；actor 由 session 決定。可對任何既有 member（包括 suspended recipient）作正式帳本修正，但 suspended member 仍不可使用 member APIs。
Idempotency-Key 格式 ASCII `[A-Za-z0-9._-]`、16..128，scope 包含 verified actor.member_id。
D1 ledger 只存 SHA-256 namespace/key hash 与 normalized member_id/points/trimmed reason request hash，不存原 key。
相同 actor/key/payload replay 相同 201/transaction_id/member_id/points；不同 payload 409 IDEMPOTENCY_CONFLICT。
Concurrent retry 用 UNIQUE hash + guarded INSERT，audit 只 SELECT 本次真正新增 transaction；全批 atomic。
Actor/session/role 在 INSERT guard 中重驗；失敗或 acknowledgement 遺失時查 persistent replay，不重複追加。
不同 admin 同一字串 key 是獨立 scope。

Summary 直接 SUM ledger，包括撤銷與正/負 manual adjustments，可為負數；不建立 mutable members.total_points，不依赖 cases convenience snapshot。
只回 total_points，不回 auth/email/hash/private proof/internal reviewer metadata。結果不在 JS safe-integer 範圍時 fail closed，不回有精度問題的 totals。

## Audit / privacy / rollout TODO

Campaign create/update、manual adjustment、approve/revoke 都記 audit。Ledger/audit 失敗使整批 status/config/points 回滾。
不從 headers/env 產生紀錄，不 log exception/body/key；摘要沒有 query key/hash、token、presigned URL 或 credentials。
人工 reason/note 僅應填業務原因，不能貼 credentials；API 不會主動取用/複製任何 Secret。
No auth provider changes、Resend outbound、points 雙 source-of-truth。B4 regression 的 email 僅由本機 mocks 處理。

Production rollout 暫停：B4 方案確認前不套 0003..0005；未建立 admin 或 Campaign。
既有 legacy case 若 campaign_id 尚無正式 registry 不會默默核准給分，需日後經 review 的 Campaign 資料銜接政策，不能用假資料補足。
沒有歷史 award backfill、leaderboard（B5C）、UI、Google 雙向同步、補交/reopen、revoked restoration、自動 orphan reconciliation。
現有 admin bootstrap 仍依 B5A 文件，未執行。

## 本機驗收 / files

`npm test` 保留全部 319 個既有測試，新增 61 個 B5B 測試（合計380）；只因正式 Campaign/audit contract 更新對應 regression fixtures/assertions，不刪除測試。
B1 HTTP smoke 先建立 disposable 空 D1 再套 migrations，維持 empty Campaign contract；所有 fixtures 僅在本機 harness。
六套 smoke：test:smoke / test:uploads-smoke / test:cases-smoke / test:auth-smoke / test:admin-smoke / test:points-smoke。
`check:admin-schema` 從全新 local DB 套 0001..0005，檢查 tables/indexes/16 triggers/FK/quick_check 與零業務資料；沒有 --remote。
另測帶既有 audit rows 的 0004→0005 升級，紀錄保留與不可修改保護通過。
Wrangler dry-run 113.54 KiB / gzip 28.02 KiB。首頁、wrangler.jsonc、lockfile、0001..0004、frozen auth modules 保持原樣。

修改：README.md、package.json、scripts/check-admin-schema.mjs、scripts/lib/local-admin-runtime.mjs、scripts/lib/local-case-runtime.mjs、scripts/smoke.mjs、src/api/admin-validation.js、src/api/admin.js、src/api/campaigns.js、src/api/case-validation.js、src/api/cases.js、src/api/router.js、src/lib/admin-identity.js、src/lib/admin-store.js、src/lib/case-review.js、src/lib/case-store.js、test/admin.test.js、test/api.test.js。

新增：

- docs/b5b-campaign-points.md
- migrations/0005_campaign_point_ledger.sql
- scripts/smoke-points.mjs
- src/api/admin-campaigns.js
- src/api/admin-response.js
- src/api/points.js
- src/lib/campaign-policy.js
- src/lib/campaign-store.js
- src/lib/point-ledger.js
- test/campaign-points.test.js
