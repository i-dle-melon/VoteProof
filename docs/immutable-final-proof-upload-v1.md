# Immutable Final Proof Upload V1

本機候選；Production Worker、D1、R2、投稿設定、Async rollout 均未操作。CPU readiness 以本文最後的真 Cloudflare 隔離量測為準，功能正確不等於 Workers Free GO。

## 範圍與相容性

只實作 Option B。V1 沒有 `storage_version:2`，保留原 staging → complete → create archive；既有 completed upload、案件和 proof 不需搬遷。V2 prepare 帶 `storage_version:2`、`campaign_id`，限定一張圖片；20 張仍由 `BatchSubmission` sequential 建立 20 個 intent、20 個獨立案件和各自的重試 key。

新增 additive `0017_immutable_final_uploads.sql`；只新增 intent table、索引與 guards，不刪既有欄位或表。未套 Production migration。舊 staging grant 仍可解密，新 grant 版本為 2。

## Object lifecycle

Prepare 建立 `session_id`、獨立 `proof_id`、`proofs/final/<session>/<proof>.<ext>`，不提前建立案件。Intent 綁 member 或 guest capability hash、Campaign、MIME、size、預期 SHA、grant expiry、intent expiry。預期 SHA 在 R2 成功驗證前只是 client claim。

會員 prepare／complete 使用 fresh session、Origin、CSRF；PUT 使用同源 scoped encrypted grant 並核對 fresh member。訪客持有 RAM-only 隨機 capability；原始值不寫 DB、URL、browser storage 或 log。新案件仍 fresh 驗 auth、CSRF／Origin、Gate、Campaign／類型／日期，不能跨會員或活動 claim。

PUT 先取得持久 `write_token`，原生 stream 直接傳 R2，強制 `If-None-Match: *` 與 native SHA verification。不同 bytes 不可覆寫。現有物件的重送不回傳「已驗證新 body」：API 回覆 409 `UPLOAD_ALREADY_UPLOADED`；browser 隨後以 complete 驗證原始物件的 authoritative checksum。Checksum mismatch 也可能由 provider 先拒絕而得到 502，兩者均 fail closed。

Complete 使用 HEAD 核對 key／size／MIME／native SHA，原子保存 completed manifest、checksum、sealed state，並 read back。相同 manifest 可重試；未知 metadata 欄位、不同 key 或損壞物件會拒絕。沒有檔案內容 buffer 或 Worker whole-file digest。

Create 在既有 preflight JOIN 取得 intent，使用一次 metadata HEAD 驗證物件仍存在，直接將原 `proof_id` 與 final key 寫入 `case_files`。Case、file、verified hash、completed consumption、idempotency 沿用原 batch；新增 DB trigger 在同一 transaction 消費 intent。舊 V1 才會進 `archiveCaseFiles`。

| 單張建案，idempotency + backup ready | V1 | V2 |
|---|---:|---:|
| R2 GET / PUT / DELETE | 1 / 1 / 1 | 0 / 0 / 0 |
| R2 metadata HEAD | 0 | 1 |
| 會員 D1 statements / binding trips | 9 / 5 | 9 / 5 |
| 訪客 D1 statements / binding trips | 8 / 4 | 8 / 4 |

Trigger 內部 SQL 不算額外 binding call；D1 內部工作並非完全相同。Backup enqueue 保留原語意；Admin 私有圖片、Drive relay、SHA evidence 都從原 case_files metadata 找來源。沒有新增 public R2 URL，也沒有 points 或審核規則變更。

需要明確區分整體成本：新的 ownership／writer pin／seal 增加上游工作，並非整條投稿流程的 D1 都不變。正常會員的 prepare／PUT／complete／create 合計預期為 17 → 28 statements、10 → 20 binding trips；訪客為 16 → 24 statements、9 → 16 trips。這不含 browser MemberSession 的 session refresh。Case 本身沒有增加 D1 往返；其他 endpoint 的 CPU 也必須另列，不能只看建案變快就宣稱全流程 Free readiness。

V2 的 intent consumption trigger 會使 D1 `meta.changes` 包含額外寫入，因此 Case 成功判斷改用 guarded INSERT 的 `RETURNING id`。否則會誤走已提交結果的 replay 分支，漏掉原本的 backup enqueue；對應的 final object → Admin image／Drive relay integration 已加入回歸。

## Cleanup 與中斷

`cleanupFinalUploads` 沒有 public route 或 scheduler，也沒有新增 Cron。只接受 bounded batch，先在 DB 原子標記 expired、未消費、未連結且無 active writer 的 intent 為 deleting，再刪 R2，最後留下 deleted tombstone。它與 Case transaction 使用同一 D1 序列化：Case 成功則不可清；cleanup 先成功則不可建案。刪除失敗保留 deleting，下次可重試。

沒有按時間自動接管未知 native PUT 的 lease。`write_token` 持久 pin 尚未確認的寫入，避免「清掉物件後舊 PUT 才落地」。新的過期 PUT、deleted intent、舊 grant 都不能重新開始寫入。

每次 native conditional PUT 同時保存 server-generated `voteproof_upload`／`voteproof_write` metadata。若 ACK 遺失，只有 HEAD 顯示該 exact writer 的 marker、正確 checksum／metadata，才能證明該原子 PUT 已落地並解除 pin。若物件不存在或 marker 不符，持續隔離；不能因年齡推斷安全。這類 DB intent 可能需後續操作員處理，但不會刪仍在寫入的 proof。若遲到寫入之後落地，後續 bounded sweep 可依 marker 回收。

Browser 遇到不確定的 PUT，收到 `UPLOAD_REPREPARE_REQUIRED`，只在尚未送出 Case payload 前重新 prepare；其他已成功圖片不重建。Case payload 一旦建立即固定，lost response 重送同一 body/key；不得換 reference 掩蓋已提交結果。

## Rollback

未操作任何 Production environment variable。未來若需停止發出 V2，可在另行授權的部署中將 `IMMUTABLE_FINAL_UPLOAD_ENABLED=false`；新的 V2 prepare fail closed，已有 V2 complete／create reader 仍可 drain，V1 相容路徑仍存在。不能直接退回不認識 V2 的舊 binary 或刪 0017，否則會中斷既有 intent。

## 驗證方式

`test/immutable-uploads.test.js` 包含 storage conditional write、capability／owner／Campaign、seal、missing object、lost ACK、concurrent replay、cleanup／create／PUT race、20-image partial failure、max 5 MiB、rollback、Admin image／Drive relay integration。

Cloud benchmark 明確要求 `--isolated-synthetic-only`，只建立唯一 `voteproof-immutable-*` Worker、D1、R2，使用隨機 synthetic session／secret 與官方 Turnstile test key；有 mutation allowlist，既有 Production bindings 不載入。完成後清除所有自有測試資源。`cleanup-immutable-benchmark.mjs` 只可處理該工具記錄的自有 bucket，不能傳任意資源名稱。

Before 來源固定為啟動工具時的 Git HEAD，After 使用候選 source；兩者使用同一 additive schema、同樣 wrapper、backup ready。預設每階段 3 次版本部署，每版會員／訪客各 20 案（小圖 10、5 MiB 10），每案立即重播，共 120 新建案／階段。`--after-only --short-matrix` 可沿用已完成的 Before 證據，單獨執行 After，每版 20 sequential independent Cases（兩種身份、兩種大小各 5），共 60 案。實際有效樣本與中斷原因必須以結果段落為準。

部署後第一筆案件前已有版本確認及 prepare／PUT／complete，不能稱為已證明物理新 isolate。新版 header 只在單次 ready 出現仍可能遇到舊版本，工具等待版本分布後，仍要求每次 operation 的 header 精確相符；不送額外案件做預熱。

CPU 只採 Wrangler invocation traces；wall time、binding 次數分開。缺失 trace 不當成 0，少於 20 筆不列 p95。平台非 JSON 404 等 transport failure 也保留，不當作 Worker CPU 值。

## CPU 結果與決策

基準 HEAD：`9ee795b6d105355ca08a8539adb8f55bbf5f62fc`。下表是這輪實際 Cloudflare invocation CPU，單位 ms；不是本機 V8 samples，也不是 wall time。

| Cases | 成功請求／CPU traces | min | median | p95 | max | >10ms |
|---|---:|---:|---:|---:|---:|---:|
| Before 全部 | 80／79 | 3 | 5 | 8 | 13 | 1 |
| After 全部 | 60／58 | 2 | 3 | 8 | 10 | 0 |
| Before 部署後首案 | 2／2 | 10 | 11.5 | — | 13 | 1 |
| After 部署後首案 | 3／3 | 7 | 8 | — | 10 | 0 |
| Before 後續案件 | 78／77 | 3 | 5 | 6 | 9 | 0 |
| After 後續案件 | 57／55 | 2 | 3 | 6 | 10 | 0 |
| Before idempotent retry | 80／77 | 1 | 2 | 6 | 9 | 0 |
| After idempotent retry | 60／57 | 1 | 1 | 4 | 5 | 0 |

部署後首案 Before 為 **10、13**；After 為 **8、10、7**。未取得的 traces 保持缺失；首案樣本不足，不列 p95。After 每筆新建案的 R2 都是 GET=0、PUT=0、DELETE=0、HEAD=1，會員 D1=9／5、訪客=8／4 已逐筆驗證。

Before 的第三次部署曾在 PUT 收到舊版本 header，工具立即停止，沒有把它算成該版首案；故保留兩次部署的 80 個有效案件。After 在另一套專用 synthetic resources 重新測三次部署，每版 20 個 sequential independent Cases，完成 60 案。兩邊資源不同、樣本數不同，不能把 CPU 差額宣稱為單函式精確 attribution。三個 After bundle SHA 相同。

前兩次工具啟動亦遇到非 JSON 404，沒有當成 CPU trace 或補成 0。所有嘗試的自有 Worker／D1／R2 已刪除；一次 bucket 清理由受限 recovery tool 完成。After 最終刪除 60 個物件；D1 foreign_key_check=0、quick_check=ok、point_transactions=0。

相關 unit／integration 回歸 **381 PASS**，額外 Admin export／review／product rules **55 PASS**；最新 immutable 專項 **19 PASS**（與主回歸重疊，不重複加總）。Browser **6 PASS**，包含 guest capability RAM-only、member credentials／CSRF transport、20-image partial retry，以及 320／390／430、Dark／Light 的投稿結果畫面。

**Case Creation Workers Free readiness：NO-GO。** Option B 已達成「建案不再搬存 proof」，這輪 After 未重現 >10ms，但首案與後續案件仍到 **10ms**，缺乏穩定低於限制的餘裕，且不能證明物理 cold isolate 已充分覆蓋。不能因 median 3ms 或功能測試 PASS 自動宣告解決。下一個最小 blocker 是剩餘 auth／idempotency／metadata／D1 commit 固定路徑的尾端；需要先取得針對該路徑的受控 CPU attribution，不能憑 wall time 指定某個函式。本輪沒有開始下一輪架構修改。

Production deploy／migration／D1 mutation／R2 mutation 均 NO；Production submissions 未操作，依既定要求維持 OFF，未遠端重新查驗。Async SHA Production rollout 仍 NO-GO。沒有 push 或 Pages 發布。
