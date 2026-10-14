# Async Exact-Duplicate Signal V1 — 本機候選

基準為 `487bb56ce9f757d4a106eca76f0352f0cc889946`，分支 `codex/pre-frontend-sprint`。
這份實作不啟用 Production。同步 SHA 優化維持 STOP；既有 Production CPU NO-GO 不因本機測試解除。

## 接受案件與保存可信來源

沿用 prepare → private R2 PUT → complete → createCase。**complete 保存完成上傳；既有 createCase 才建立案件**。
沒有合併 API、改收件回條或把 complete 誤當已有 case。R2 原生 SHA checksum 驗證、ETag／MIME／size、
Origin／CSRF、會員 session、Campaign、submission gate、idempotency 及 commit 時權威檢查均保留。
Browser SHA 仍只是 claim，不能單獨寫入可信 hash。

case／proof／proof_exact_hashes 同一 D1 transaction 保存。0013 的 AFTER INSERT trigger 同交易建立
proof_duplicate_jobs，並以單筆 scope PK UPSERT 維護排序 metadata 最小值；**沒有查詢 matching/prior proofs，
沒有產生 clear／exact_duplicate 結果**。這是額外 SQL trigger 工作，不能說 CPU 成本為零。
它避免接受成功卻沒有 durable job 的窗口，也避免同步重設大量舊結果。

與先前 `.wrangler/first-cpu-profile/async-design.md` 的差異：保留既有同步 verified hash 保存；不再把 SHA index
寫入假稱為 duplicate lookup。新增分離的 job／scope metadata／request receipt table。Admin 只讀持久結果與版本，
不在查閱時比對 SHA。未新增會員 UI、Queue、付費服務或 Production Cron。

## Migration 與狀態

`0013_async_proof_duplicates.sql` 保留 0001–0012 的內容。新增三張表與 scoped／ready／lease／reconciliation indexes，
移除已廢止的 global SHA lookup index；不刪業務資料。
0012 已有的 verified metadata 只轉為 pending jobs，沒有讀 R2、計算歷史 hash 或完成分類。
正式 Production 0012 尚未套用的已知基準，未在本次重新連線核對或套用。
Migration 依 Wrangler registry 一次執行；registry 重跑為 no-op，裸 SQL 並非 IF NOT EXISTS。

proof_duplicate_jobs 每 proof 唯一，記錄 server member／Campaign、authoritative SHA、case 時間與 ID、state、attempts、
safe last_error、claimed_at／lease_token／lease_until、canonical proof／case、completed_at／updated_at。
source metadata 受 FK／immutability／binding trigger 保護；canonical reference 必須同 scope、較早且非自己。

`pending → processing → clear | exact_duplicate`；暫時失敗為 `failed`，帶 next_attempt_at。
lease 過期可 reclaim。最多 5 attempts；第 5 次 crash 的 expired lease 在後續 invocation 轉為 terminal failed。
SOURCE_CHANGED 為 terminal；其餘錯誤僅保存 PROCESSOR_UNAVAILABLE，不保存 exception、SQL 或 secret。
Guest 沒有 member identity，明確為 `not_applicable`，不比較兩個 NULL；缺 historical hash 為 `unknown`。

## Processor 與 canonical

`POST /api/internal/proof-duplicates/process` 只接受 `{request_id: UUID}`。
預設停用；須獨立 `DUPLICATE_PROCESSOR_ENABLED=true` 與 `DUPLICATE_PROCESSOR_SECRET`。
64 位 hex secret 僅在 Authorization Bearer header；query／Origin 請求拒絕，redirect 不跟隨。
不沿用 Drive secret、backup queue／lock、member session 或 public endpoint。

request receipt 與 lease claim 同一 D1 batch，request_id 永遠綁定同 proof。
不同 request 的 concurrent claim 只會成功一次；120 秒 lease，generation／cursor CAS 保護 reconciliation。
丟失 claim／classification ACK 後，同 request replay 不會處理其他工作。
completed replay 不新增 signal；stale lease／另一 attempt 無法覆寫結果。
暫時失敗 backoff 30、60、120、240 秒，最多 3600 秒；新 request ID 才取得重試 lease。

canonical 查詢只用 `(member_id,campaign_id,sha256)` indexed seek，依
`(case_created_at,case_internal_id,file_id)` 升冪 `LIMIT 1`。
查詢包含所有已接受可信 proof，不論 pending／processing／failed／completed，故 job B 先跑仍找到 A。
來源再驗證與 canonical／結果更新使用 lease CAS；更新 SQL 再核對 source binding。
canonical 自己 clear，其餘 proof exact_duplicate 並指向 canonical；不改 review／points／Drive。

若晚到的 hash／延後 commit 引入更早原件，同步只更新一筆 scope generation／最小排序 metadata。
舊 final 結果的 effective Admin state **立即 pending**，canonical reference 不顯示。
背景每 invocation 最多走一個 dirty group／一個 proof 的 cursor，重排一個 stale result；不在 submission 大量 UPDATE。
每 invocation 另外只處理一個 job、一個 exhausted lease。持續呼叫才會排空佇列；未設定 executor 時維持 pending。
active processor 原子查目前所有可信 proof，可得到最新 canonical。failed 不會被當成 clear。

## Admin 與隱私

顯示尚未分析、分析中、未發現相同檔案、發現同會員同活動相同檔案、分析失敗／待重試。
只顯示同 scope canonical case／proof；不回傳 SHA、member ID、object key、lease token 或跨會員／跨活動關係。
既有 Admin role／fresh MFA 保留。一般會員 API／收件回條未新增 SHA 搜尋能力。
舊 global／cross-member／cross-Campaign tests 改成「無分類、無 evidence」；不是只隱藏 UI。
clear 僅表示目前可信 hash 範圍沒有較早 exact bytes；不表示未知歷史資料完成分析，更不是自動審核結果。

## Executor 與 historical 計畫

`apps-script/proof-duplicates/` 是可選的**獨立私人 Apps Script project**，只需 external_request scope。
nonce、Lock 與 Properties 不屬於 Drive project；network／lost ACK 保留 nonce。
沒有 installTrigger／ScriptApp／Drive 呼叫。本次沒有上傳、執行或安裝這個 executor。
未新增固定付費基礎設施。

`scripts/backfill-proof-hashes-local.mjs` 保留 local-only，預設 dry-run：

```text
node scripts/backfill-proof-hashes-local.mjs --limit=10 --after=<file_id> --exclude-case=<case_id>
```

`--apply-local` 才可寫 local fixture；limit 1–20、cursor resume、最多 20 個排除 case。
資料來源以條件式 R2 read、ETag／size／MIME 綁定及 server hash 驗證，hash 寫入自動 enqueue。
回報 written 只計 hash INSERT RETURNING，不計 D1 trigger 的其他 changes。
排除只影響此批 hash backfill，不撤銷既有 verified metadata。
此 script 本次**未執行於現有歷史資料**；測試只有新建合成 fixture。
若將來新增 remote historical runner，另案建立 operator scope、canary exclusions、dry-run snapshot 與批准紀錄。
UUID cursor 中斷後需從空 cursor 再掃 missing hashes，以涵蓋後來插入但排序較早的 proof；寫入仍 idempotent。

## 量測與 rollout

`scripts/measure-async-duplicates-local.mjs` 只建立 disposable 本機 workerd／D1／R2，從 git show 讀 487bb56，
不 reset／checkout／部署、不寫 credential。13,082 bytes 與 5 MiB、before／after 各兩輪，分別量 complete、
create 首案／第二案／warm，以及 processor 首次 no-match／warm duplicate／completed replay。
104 個獨立 HTTP request；缺 sample 保存 null，不補 0。不把不同 request CPU 相加。

D1 binding statements／round trips 是可直接核對的數字；trigger 內部 SQL 不包含在此數量中。
complete 6／3、create 9／5，before／after 相同，同步分類 lookup 0。
一般 async classify 7／6；completed replay 6／5、idle 5／4。
dirty reconciliation 本身最多 4 statements／3 trips（相較平常的 1／1，增量最多 3／2）。
canonical SQL EXPLAIN 為 scoped covering index seek；reconciliation 用 scoped file cursor index。

V8 profile 的 sampled active JS self-time 排除 idle／program／root，是**本機估計**；有 host scheduling／GC／
Miniflare IPC／profiler 干擾，不是 Cloudflare invocation CPU。小样本或大幅抖動不能證明無 regression。
實際 min／median／p95／max／missing 在驗收報告與 JSON；沒有新的 Cloudflare CPU samples，
因此 Production CPU readiness 維持未證明，不宣稱 async 解決首案 >10 ms。

未執行的未來 rollout：local regression → 另行授權 isolated cloud/source/schema 測試與 CPU observation →
獨立批准後 migration 0012+0013（submission OFF）→ processor canary → same-member duplicate canary →
historical dry-run → 另行批准 bounded historical hash/enqueue → 確認排空與備份獨立 → 另行批准 Production enable。
任何正式 CPU regression／來源不一致／privacy failure 皆阻止 enable；維持既有 backup executor。
本次沒有 push、Production deploy／migration／backfill／Cron／trigger／submissions 切換／Tier 修改或 R2 刪除。
