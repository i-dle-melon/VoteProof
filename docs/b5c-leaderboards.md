# B5C D1 Leaderboard（本機 checkpoint）

只做 backend、本機 migration/test/commit。B4.x auth僅本機，不 push/deploy/remote apply、不改 Production，不做 UI/獎品/通知，不進 B6。
沒有新增 Secret/Variable。首頁、wrangler.jsonc、0001..0005、auth modules 不改。

## Source / scope

唯一點數 source 是 D1 `point_transactions`，不是 cases snapshot、members.total_points、Google Sheets 或舊 results。
Snapshot 是可重新生成的衍生資料。沒有 backfill/seed/Google 同步。

Definition types：

| type | campaign_id | dates | scope |
| --- | --- | --- | --- |
| all_time | null | null | 所有歷史；vote_type 可獨立篩選 |
| campaign | 必填、存在 | null | transaction.campaign_id 相符 |
| custom | 可選、存在 | 必填 start_date/end_date | transaction.vote_date 在 inclusive 日期區間 |

vote_type：null / Solo / 團體，套用 transaction 的 exact matching filter。
Custom 不使用 review/created_at；日期是既有 Campaign calendar vote_date，不轉成 browser/UTC 日期。
跨 Campaign custom 比較各 Campaign 已定義的 calendar vote_date，沒有宣稱它們代表同一全球 instant。

B5B manual_adjustment 強制 campaign_id/vote_type/vote_date=null。因此目前只有「未加 vote_type 篩選的 all_time」包含它；campaign/custom/Solo/團體榜均排除。
未來要支援 scoped adjustment，需另定 schema/API validation，不把未分類交易硬塞進某榜。Manual points 可正可負，proof_count 永遠增量0。

## Schema / constraints

新增 `0006_leaderboards.sql`：

- leaderboards：immutable leaderboard_id PK、name、type、campaign FK、nullable dates/vote_type、top_n（integer1..100）、is_public、draft/active/archived、timestamps/actor FKs/version/private marker/current_run_id。
- leaderboard_runs：run_id PK、leaderboard FK、generated_at、definition_version/definition_json snapshot、source_count/source_last_transaction_id、row_count、building/success、integrity_errors=0 CHECK。
- leaderboard_results：run/board composite FK、rank/member/nickname/points/proof_count/reached_at；UNIQUE(run_id,rank)、UNIQUE(run_id,member_id)。member_id 是既有公開 M-UUID，非 members.id。

Results 是 nickname snapshot，之後改 profile 不會改歷史 run；積分 integer>0、proof_count integer>=0，safe integer bounds。
DB triggers 禁止結果 UPDATE/DELETE/REPLACE，禁止插入成功 run，限制 rank <= definition.top_n。
Run 完成時檢查 row_count/rank；成功 run 不可再修改/刪除/REPLACE。
Board ID 不可改/刪除/REPLACE；archived 不可修改；published pointer 必須引用同榜 success run。
Composite FK 防止串錯 run/board。Indexes 覆蓋公開 board、admin pagination、run history；results PK 適用 current run/rank 讀取。

0006 擴充 audit action/target enum，複製所有舊 rows 並重建原保護與 indexes。0001..0005 原樣；populated B5B ledger/audit 升級保存測試通過。

## Ranking / reached_at 精確定義

以 scoped ledger 對每會員按以下**明確**順序建立 running totals：

1. created_at ASC。
2. 同時間戳：非 proof_revoked 先，proof_revoked 後，避免同毫秒的合法 reversal 先於 award。
3. 同前兩項：transaction_id ASC。

不依賴未排序的 database rows，也不以 nickname 排序。
proof delta：proof_approved/proof_reapproved +1，proof_revoked −1，manual_adjustment 0。
points 是 scoped SUM(points)；proof_count 是 scoped SUM(delta)。Completed 沒有新 ledger row，不增加任何數值。

`reached_at` 定義為：會員**最後一次到達最終 (points, proof_count) pair，且其後一直維持該 pair**的交易 created_at。
SQL window history 找出最後一個「running pair 不等於 final pair」的 step，取之後 suffix 的第一個 timestamp。
例如 +10(t1)、+5(t2)、−5(t3)：final=(10,0)，reached_at=t3，不是 t1。
兩份 +10 proof(t1/t2)，撤銷第二份(t3)：final=(10,1)，reached_at=t3。
若歷史曾離開又回到最終成績，以最後回到的時間算，不沿用更早但已失去的成績。
這不是 MIN(transaction.created_at)，也不是未定義的 MAX；選擇此語意是因 repository 沒有 Apps Script 原算法，只保留 B1 response contract。

排序：points DESC → proof_count DESC → reached_at ASC → member_id ASC（SQLite BINARY text order）。
ROW_NUMBER 連續 rank，無並列 rank/跳號；Top N 截取完整 deterministic 排序後前N名。

僅列出 scoped points>0 的 active member。沒有交易的會員、零分、負分、suspended 不列出；純正值 manual activity 的 all-time 會員可列出且 proof_count=0。
不是將全部零分 members 放榜尾。被完全撤銷的 proof 淨points/proof_count=0，若無其他正值活動便不出榜。

對所有 scoped history（包括最終不出榜或 suspended）檢查 proof prefix 不為負、integer/safe range 與 timestamp shape；異常使整個 generation 回滾。
不 clamp 負 proof_count 以掩蓋 bug。若 imported timestamps 把 reversal 放在原 award 之前，需修正匯入政策，不能改寫帳本或假裝榜正確。

## Rebuild / concurrency / snapshot boundary

Admin POST rebuild 必填 expected_version。單一 D1 batch：

1. 重新驗證 actor/member/session/active elevated role、board version/status，插入 building run；固定定義 snapshot、全域 ledger count/最後插入交易 ID與完整性檢查。
2. 同一 transaction 內，SQL CTE/window 從 scoped ledger 生成 Top N results（包括當下 nickname/member status）。
3. 計數結果，將 run 改 success。
4. CAS 將 current_run_id 指向新 run，board version+1。
5. Append 精簡 audit：leaderboard_id/run_id/row_count/generated_at/actor；不塞完整 rankings。

參考 [Cloudflare D1 batch transaction guarantee](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)。
沒有 process mutex、Map、服務外先算點數、先刪舊結果、逐頁掃 ledger 混用不同時刻。
同時兩個相同 expected_version rebuild：一個200、一個409 LEADERBOARD_CONFLICT；失敗者不留 run/results/audit。
Update vs rebuild 同樣 CAS；不會把舊 scope 的榜發布到新 definition。
其他點數寫入只能整批在 rebuild 前或後提交；同一 run 的 count/history/totals/nickname/result 不混 impossible state。
source_count/source_last_transaction_id 表示**全域 append-only ledger boundary**，不是 scoped count；generated_at 是本次 rebuild 開始的 server UTC timestamp，不是 vote_date filter。

任何 SQL/result/run/pointer/audit failure：整批回滾，前一 published run 完整保留，回 sanitized503 LEADERBOARD_REBUILD_FAILED。
Ack 遺失時只按本次随机 run_id 查已成功的 persistent run，不重新寫結果。
Run 查詢只在 admin，public 沒有 source metadata。

## Definition / Campaign policy

Create draft/active；draft→active/archived、active→archived；不 reopen。Update 是完整 validated editable fields＋expected_version，不是 generic SQL PATCH。
日期 YYYY-MM-DD 真實日期、start<=end，campaign FK 存在。
普通 definition update 清 current pointer（舊 runs 保留），須重新 rebuild 才公開，避免舊 scope/name/Top N 冒充新定義。
Archive 操作只改 status，保留舊 current run 供 admin preview，public 隱藏；archived board 不可修改/rebuild。

Campaign archived 不刪 board/results。已有依賴榜可以讀历史、為後續 revoke 修正而 rebuild。
不能新建指向 archived Campaign 的 board，也不能改變已 archived Campaign 榜的 scope；只可改非 scope 展示/Top N/privacy 或 archive，再明確 rebuild。
此政策在 mutation SQL 裡重驗，不只相信服務外讀取。

## APIs / B1 compatibility / cache

| Method | Endpoint | Contract |
| --- | --- | --- |
| GET | /api/leaderboards | 僅 active/public/current success；B1-compatible list with rankings |
| GET | /api/leaderboards?id=... | 同 envelope，只回該公開榜；未知/private/draft/archived回[] |
| GET / POST | /api/admin/leaderboards | admin/super_admin list/create |
| GET | /api/admin/leaderboards/:id | admin definition |
| POST | /api/admin/leaderboards/:id/update | full fields＋expected_version |
| POST | /api/admin/leaderboards/:id/rebuild | `{expected_version}`；200 run_id/generated_at/row_count/source_count/version |
| GET | /api/admin/leaderboards/:id/results | 現有 current snapshot preview，private/draft/archived可讀 |

List admin limit1..50/default20、created_at/id DESC keyset cursor，status filter 綁定 cursor。
Admin 包括 read 一律 admin/super_admin，reviewer 不授權；mutation exact Origin/CSRF、verified session、16KiB JSON bound、prepared statements、no-store、audit。
不提供 result/points/rank mutation API。

Public envelope 保留：`{ok:true,data:{generated_at,leaderboards:[{leaderboard_id,name,generated_at,rankings:[{rank,member_id,nickname,points,proof_count,reached_at}]}]}}`。
每榜 generated_at 是其 current run；頂層是已回傳 run 的最大 generated_at，空 registry 為 null。
未知 id 保持空陣列200；id 重複或>100字回400，其餘多餘 query parameters 保持 B1忽略行為。
Public 不回 email/player_id/auth/provider/internal member id/private proof/internal reviewer/run/source metadata。
單一 joined SELECT 讀所有返回的 snapshots，並發 publish 不混不同 run 的 rows；public read 不掃 ledger。

Public Cache-Control：`public, max-age=15, must-revalidate`；不使用 Worker Cache API、不加 stale-while-revalidate。
Rebuild/privacy/status 變更最多可有15秒 browser cache 舊公開資料；Admin/Case/Auth仍no-store。
尚無成功 run 的 board 不公開。空 D1正常200/null/[]；缺 DB/缺 migration/儲存錯誤為 sanitized503/no-store，沒有 Google fallback。

B1 retired adapter 放 `src/lib/legacy-leaderboards.js`，只由歷史 contract tests import；Worker graph不引用。
原25 B1 tests保留，舊proxy相關測試明確改為 retired adapter測試；實際 D1 Worker contract/security另有B5C測試及HTTP smoke。
未刪 Google Apps Script，也未改 Production GOOGLE_PUBLIC_API_URL/traffic。正式切源須另外批准完整 migration與deploy；目前Production仍舊部署。

## Verification / TODO

本機驗收：npm test；B1/B2/B3/B4.x/B5A/B5B/B5C 七套 smoke；空 DB local0001..0006、FK/quick_check/schema/26 triggers/零seed；Wrangler dry-run、sensitive scan、diff review。
結果：434/434 tests（既有380＋B5C新增54），七套 smoke 全通過；Wrangler dry-run129.62KiB/gzip30.91KiB。
所有 fixture與故障注入只存在測試／disposable local runtime，不使用外部登入provider、不接Production。

修改8檔：README.md、package.json、scripts/check-admin-schema.mjs、scripts/smoke.mjs、src/api/admin-validation.js、src/api/leaderboards.js、src/api/router.js、test/api.test.js。
新增10檔：docs/b5c-leaderboards.md、migrations/0006_leaderboards.sql、scripts/lib/local-leaderboard-runtime.mjs、scripts/smoke-leaderboards.mjs、src/api/admin-leaderboards.js、src/lib/leaderboard-policy.js、src/lib/leaderboard-ranking.js、src/lib/leaderboard-store.js、src/lib/legacy-leaderboards.js、test/leaderboards.test.js。

TODO：B4 auth定案後才規劃Production0003..0006/正式admin/Campaign/Boardbootstrap及D1切源；沒有自動bootstrap。
Large ledger rebuild 仍受 D1/Worker 執行限制；失敗保留舊run。需有實際規模資料才另設排程/分批一致性方案，本次不做。
歷史run的API pagination/保存容量政策、選擇性scoped adjustment、榜單自動更新/通知/UI都是後續，不在本次擴張。
Snapshot nickname/member status 更新需rebuild；不是即時member查詢。保留所有歷史run，不任意刪歷史資料。
