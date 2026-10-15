# Backend Simplification V1 — Direct Intent → Case POC

僅 LOCAL implementation / test。基線 `6febd2f6642e7605b1b0c5c7075133c6c31169ad`，分支 `codex/backend-simplification-v1`。沒有 remote 操作、deploy、雲端 migration、雲端資源建立或設定修改。

## 實作與開關

新流程為 Prepare → 現有 Worker streaming PUT → `POST /api/cases/direct`。Prepare 使用既有 `storage_version:2`，明確增加 `completion_mode:'direct'`，不是第三套 completed model。伺服器僅在 `DIRECT_INTENT_CASE_ENABLED === 'true'` 時簽發 direct intent；未設定預設關閉。停止簽發後，既有 direct intent 仍可完成建案。`IMMUTABLE_FINAL_UPLOAD_ENABLED='false'` 仍可停止全部新 V2 intent。

前端只在 localhost／loopback／保留測試網域 `voteproof.example`，且 URL 有 `?upload-flow=direct` 時選擇 POC。原本的 Prepare → PUT → Complete → Case 保留為預設。正式 hostname 與 GitHub Pages hostname 不會因 query 進入 POC。Pages fixture adapter 僅補齊共用模組的 export，相同 renderer 可繼續載入；本輪未發布 Pages。

本機重現：`node scripts/smoke-direct-intent.mjs`。此工具啟用 disposable Miniflare D1/R2、既有前端 source，使用 Chrome，所有 HTTPS `.example` 請求均導向本機；不連 Cloudflare、真正登入供應商或 Production API。

## Case 與儲存約束

1. 有界 JSON、嚴格 Origin；會員 fresh session + CSRF，匿名 capability hash。
2. 必填 Idempotency-Key；直接路徑的 request hash 加上模式與匿名 capability hash，保持 legacy hash byte compatibility。
3. 一次 policy SELECT 同時讀 Gate、Campaign、intent、owner、expiry、cleanup/consumed state。
4. 單次 R2 HEAD 驗證 server-bound key、實際 size、MIME、provider-verified SHA-256、非空 ETag。Case 不讀取 proof bytes，也不做 whole-file SHA。
5. 同一 D1 batch 插入 Case、case_file、idempotency；Case INSERT trigger 原子 consume intent，guard 再驗 Gate／Campaign version／時間／type／session revocation／會員狀態。
6. 保留 foreground `ensureCaseBackups` 後回覆 pending。發點仍只發生於既有人工核准交易。

`0018_direct_intent_cases.sql` 是 local-only migration。SQLite 既有 NOT NULL/FK 需要受控重建 `cases`／`case_files`：複製全部 legacy 欄位與 ID、恢復索引／政策 triggers，保留 completed／checksum／duplicate legacy tables。既有列的新增 reference 為 NULL。

新列使用唯一 `upload_intent_id`；legacy/direct reference 必須恰有一個。直接 Case → file 的 deferred FK 與 file linkage trigger，使獨立 Case/consume 不能在缺 file 時 commit。任一步 SQL failure 都 rollback。D1 binding `batch` 是交易邊界，不使用 `waitUntil` 保證正確性。

Direct intent domain state 是 `prepared → consumed`。PUT 的 `write_token` 仍只負責 transport safety，正常成功會清除，不寫 `uploaded_at`／`sealed_at`。未知 native PUT 結果保留 pin；若 R2 已存在正確 immutable object，Case 可經 HEAD 建案。cleanup 只回收 expired、unconsumed、未被 Case/file reference 且無未知 writer 的 intent；provider operation marker 才可解開未知 writer pin，不能單靠 timeout。

新路徑不呼叫 Complete、不建立 completed_uploads／completed_upload_files／proof_upload_checksums、manifest 或 exact-hash/duplicate jobs/requests/groups。Admin 對 direct Case 不讀 duplicate evidence；legacy evidence UI 保留。匯出不再 JOIN proof_exact_hashes，保留 CSV 欄位與 filename mapping，sha256 為空值，供日後本機分析器計算。

## 實際 binding 操作量

數字由 `test/direct-intent-metrics.test.js` 包裝實際 handler 與 disposable D1/R2，從成功請求量得。D1 是應用提交的 statements／binding trips，**不包含 trigger 內部 SQL 數量**。保留 backup ready 與真實本機 job enqueue。OLD 是這次 source 保留的 legacy V2 對照路徑，基線 P1 Complete 邏輯未改。

| Stage | OLD 會員 D1 | NEW 會員 D1 | OLD 匿名 D1 | NEW 匿名 D1 | OLD R2 | NEW R2 |
|---|---:|---:|---:|---:|---|---|
| Prepare | 4 / 4 | 4 / 4 | 3 / 3 | 3 / 3 | 0 | 0 |
| PUT | 5 / 5 | 5 / 5 | 4 / 4 | 4 / 4 | PUT 1 | PUT 1 |
| Complete | 9 / 5 | 不呼叫 | 8 / 4 | 不呼叫 | HEAD 1 | 0 |
| Case（含 backup） | 9 / 5 | 7 / 5 | 8 / 4 | 6 / 4 | HEAD 1 | HEAD 1 |
| 全流程 | **27 / 19** | **16 / 14** | **23 / 15** | **13 / 11** | PUT 1、HEAD 2 | PUT 1、HEAD 1 |

所有 stage 的 R2 GET、DELETE 均為 0，Case PUT 也為 0。NEW Case 的三個 batch statements 為 Case、file、idempotency，consume 在 trigger 內；正常會員另外有 session、replay、policy 三次 read 與 backup 一個 statement/batch。

假設未來證明 missing-job reconciliation 可安全取代 foreground enqueue，僅做算術：NEW Case 會員 **6 / 4**、匿名 **5 / 3**，全流程會員 **15 / 13**、匿名 **12 / 10**，並各少一個 backup UUID。**未實際移除 enqueue，也未聲稱現有 relay claim 已能修復所有 missing job。**

## Crypto 操作

下表依序為 **digest / importKey / sign / encrypt / decrypt / randomUUID / getRandomValues**。僅計 handler 的 WebCrypto/隨機 API 呼叫；SHA 只處理 capability、session、idempotency、query key 等小資料。R2 原生 checksum 驗證不算 JS crypto，瀏覽器檔案 digest 也不算 Worker crypto。Host/native-stream RPC 的 test bridge 會在 fixture 端轉換 bytes，正式 PUT 原始 stream 不受影響；因此本機耗時不能推論 Worker CPU。

| Stage | OLD 會員 | NEW 會員 | OLD 匿名 | NEW 匿名 |
|---|---|---|---|---|
| Prepare | 1/2/1/1/0/2/1 | 相同 | 1/1/0/1/0/2/2 | 相同 |
| PUT | 1/1/0/0/1/1/0 | 相同 | 0/1/0/0/1/1/0 | 相同 |
| Complete | 3/1/1/0/0/0/0 | 0/0/0/0/0/0/0 | 3/0/0/0/0/0/0 | 0/0/0/0/0/0/0 |
| Case | 5/2/2/0/0/2/2 | 4/2/2/0/0/2/2 | 5/1/1/0/0/2/2 | 4/1/1/0/0/2/2 |
| Total | 10/6/4/1/1/5/3 | 6/5/3/1/1/5/3 | 9/3/1/1/1/5/4 | 5/3/1/1/1/5/4 |

重跑測試會產生 `.wrangler/direct-intent-poc/metrics.json`，僅含上述結構量測，無 capability、query key、auth token、私人資料。

## 驗證與邊界

專項測試包含會員／匿名、missing/wrong R2 metadata、owner/capability、Origin/CSRF、Gate/Campaign/session 在 HEAD 後改變、同 key replay、不同 key 併發、一 proof 一 Case、consume/file/idempotency 故障 rollback、獨立 partial Case 的 deferred FK 拒絕、PUT/Case lost ACK、cleanup 兩種先後次序、20 independent Cases/review/points、partial batch retry、拒絕／撤銷、Admin private read、ZIP/CSV mapping。

populated 0017→0018 migration 比較所有既有 tables 的完整 rows、索引與未調整 trigger SQL，保留已核准積分、audit、backup、completed、duplicate rows 與 R2 object；foreign_key_check 空、quick_check=ok，並繼續測 legacy review/reversal/export。

另外修復既有回歸 fixture：匯出測試先於開放期間建立資料，再在 disposable DB 的同一交易暫停／恢復原 trigger 以回填歷史日期；舊 migration fixture 使用舊 schema 的靜態 seed，不再用目前 writer 查詢尚不存在的 Campaign target／intent 欄位。這些調整不改正式 domain policy。

最終驗證：30 個相關 Node test files **681 PASS / 0 FAIL**，含新增 Direct Case 38、migration 1、metrics 1、frontend 8（共 48，已包含在 681，不能重複加總）。另有 Pages build **2 PASS**；桌機／Android 的 Admin review、export、legacy/direct evidence 瀏覽器回歸 **32 PASS**；真實本機 Worker 的 `smoke-direct-intent.mjs` **6 scenarios PASS**。RWD 檢查涵蓋 320／390／430／1440 與 Dark／Light，Preview 既有測試另含 1024。public assets、sensitive scan、frontend hooks、`git diff --check` 均通過。沒有執行 CPU/performance profiling。

重跑專項：`node --test test/direct-intent-cases.test.js test/direct-intent-migration.test.js test/direct-intent-metrics.test.js test/frontend-direct-intent.test.js`；瀏覽器：`node scripts/smoke-direct-intent.mjs`。需要同時測 Pages build 與 Pages browser 時必須依序執行，它們共用 `.wrangler/pages-preview` build output，不能並行覆寫載入中的模組。

CPU：**NOT MEASURED**。既有 immutable benchmark 的本機結果／cleanup records 記載專用 Worker、D1、R2 已移除，沒有可直接重用的現有 isolated environment。依本輪限制，未建立任何新雲端資源。不能宣稱 Workers Free GO；Async Production rollout 仍 NO-GO。

後續值得進 Backend Simplification V2：先獨立安排有授權的 isolated CPU 驗證，再規劃停止新 Complete writes 與 legacy drain。回退本輪 POC 時只停止新 direct issuance、保留 direct drain 與目前 schema，不降版 schema、不刪 direct Case、不刪 legacy readers/history。未知 writer 可能保留 private orphan/pin；這是既有保守的 transport 安全取捨。
