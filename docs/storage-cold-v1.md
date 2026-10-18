# 方案 A：R2 容量管理及 7 天封存（隔離驗收候選）

開發分支 `codex/storage-archive-7d`；驗收基線 `6a436d3e7b5e496940288deec2ffcf714d17226f`。本輪只執行本機與一次性 Cloudflare 隔離驗證，**Production NO-GO**。沒有正式 migration、R2 刪圖、Google Drive 變更、Email、Pages 發布或投稿啟用。

## 規則與驗收邊界

- 十進位管理預算 10,000,000,000 bytes，並非 R2 硬上限。9,000,000,000 啟動清理，8,500,000,000（包含等於）停止；9,500,000,000 拒絕新 PUT。恢復須可信 inventory 且低於 9,000,000,000，從不自動開啟投稿。
- 只有 completed / rejected / revoked、已審核且結案滿 7 天、Drive confirmed 的 case proof 能成為候選。未結案、未審核、未滿 7 天、沒有可信原生 R2 SHA-256、身分／大小／MIME／SHA／ETag／version 不符均不刪。
- `STORAGE_CLEANUP_LIVE_ENABLED` 預設 OFF；精確 `true` 才能 live，每次最多一張。Admin 預覽固定 dry-run。實際容量只由全 Bucket inventory 重新確認，不從 DELETE 回應直接減帳。
- 方案 A 不再同步回傳 Drive 圖片 bytes：已封存 Admin proof API 為 410 `PROOF_ARCHIVED_IN_DRIVE`，含封存圖片的 ZIP 明確拒絕；管理員另以受限 Drive 連結手動查看。這是既有方案 A 的產品取捨，並非本輪新增自動冷讀或還原。

## 本輪發現及修正

1. 8.5 GB 恰好達標時原本仍會多刪一張，改為 `<= target` 停止。
2. Drive 驗證期間同內容重新 PUT 可以保持相同 ETag，但 version 已變；現在把初次 HEAD version 一路比對到最後 HEAD，不接受換版。
3. 交易檢查之後仍可能進入新的容量 reservation：在尚未正式套用的 `0025_storage_cold_v1.sql` 增加 `archive_writer_reservation_guard`，禁止 verifying / deleting / cold key 新增 writer reservation。現有 in-flight reservation 仍使清理 fail closed；同步 schema 檢查清單。
4. lost-ACK 重試原本先把 deleting 降回 verifying，破壞持久刪除 pin；現在 claim 保留 deleting。缺檔恢復重新驗證 Drive 與已保存版本／大小，原物件仍存在則必須符合已保存 R2 version。任何不確定狀態維持 pin，不重複刪除、不開放審核或新匯出。
5. 限定清理路徑效能調整：每 invocation 共用一把 HMAC CryptoKey，原生 `subtle.verify` 驗證回覆，保留 canonical signature、nonce、timestamp、來源身分與完整 SHA 檢查；刪除一個緊鄰且重複的 HEAD。仍保留初次、Drive 後、持久 deleting claim 後刪除前、刪除後四次 HEAD，未取消安全驗證。

## 隔離方法、成本及證據

測試入口 `scripts/validate-archive-cloud.mjs` 必須明確帶 `--isolated-synthetic-only --account-id=<test-account> --samples=40`。每次建立獨立 reader Worker、mock relay Worker、D1、私有 R2；名稱全部為 `voteproof-archive-e2e-*`。啟動時確認帳戶 `free_tier=true`，不啟用付費功能。D1 明確排除正式 UUID，config 與 mutations guard 只允許本次建立的資源；正式 bucket 從未綁定。

- 1 / 3 / 5 MiB 高熵、有效合成 PNG；R2 PUT 使用 provider-native SHA-256 驗證。容量用隔離 D1 模擬 9 / 8.5 / 9.5 GB，沒有上傳 9 GB。
- 完整 migrations 只套用本機 disposable DB 與新隔離 DB。歷史測試資料在 Worker 尚未建立前匯入，三個投稿 INSERT trigger 暫停後原樣恢復；submission_settings 始終 OFF。
- 入口有 256-bit 隨機存取限制、固定 origin、不接受瀏覽器 Origin、一小時有效期、D1 持久有限請求配額。隨機密鑰與 OAuth token 只在記憶體，不寫入結果、config、repo 或 console。
- CPU 路徑為真正 `authenticateRelay → cleanupArchive → verifyDriveArchive → D1 → R2 HEAD/DELETE`。只替換 relay transport；另一個 Free Worker 核對 request HMAC，使用獨立預先計算 SHA 的 fixture 簽小收據，模擬 ContentService redirect。不回傳圖 bytes、不呼叫 Google API。
- CPU 取 Cloudflare tail 的 `cpuTime`，不是 Node CPU 或 wall time。CPU phase 直接使用原生 DB/R2 binding；SDK 操作量另用 instrumented phase 每尺寸 3 筆量測，不把估算冒充每個 CPU request 的實測操作數。測試防濫用的額外一個 D1 budget UPDATE 與 trace log 成本均包含在 CPU，沒有事後扣除。
- 正常清理每張觀測為 **13 D1 statements / 7 trips + 1 harness budget statement/trip、4 R2 HEAD + 1 DELETE、0 GET / PUT、2 mock HTTP calls**。D1 statements 不是 rows read/written；trigger 與 index 會增加 row operations。圖尺寸不增加 Worker 圖 bytes 處理量。
- 真實 Apps Script 預估每次驗證 4 metadata GET、4 Permissions.list、1 media GET、1 次原圖 SHA-256；這是 source 計數，並非已量到 Google quota／延遲。Worker mock 不證明 Google 端到端可用。
- 真實 Production `/storage/tick` 還包含 evaluateCapacity、inventoryPage、alerts；本輪獨立驗證 inventory 正確性，**未量測完整 maintenance tick CPU**。不得把各 invocation CPU 相加當作一個可用的單 request 上限，或把 core 結果宣稱成整條排程已驗收。

## 真實 CPU 結果：FAIL

完整原始資料與資源清理證據：[evidence 目錄](evidence/storage-archive-7d/README.md)。

第一輪 `67447ae42d27`：26 個隔離情境 PASS，instrumented CPU 取得 55 / 55 traces；1 / 3 / 5 MiB 的 P50 為 11 / 10 / 10 ms，P95 為 14 / 13 / 13 ms，max 為 14 / 13 / 13 ms。21 筆 >10 ms，沒有 1102 或 exceededCpu。下一張未量測的 seed PUT 遇到 `TypeError: fetch failed`，故提前結束；完整錯誤與部分樣本保留，不冒稱完成全部樣本。

第二輪 `1427b4b800e2`：28 個情境全部 PASS，9 個 instrumented 操作量樣本完成；原生 DB/R2 binding CPU 原計畫每尺寸 40 次，於完成 94 次後，下一張未量測 seed PUT 再發生 transport error，安全停止並清除資源。不是 cleanup API 失敗，未盲目重試任何 DELETE。

| 合成圖片 | 原計畫 / 已發送 | 成功 cold | 有效 CPU / 缺失 UNKNOWN | P50 / P95 / P99 / Max ms | >10 ms |
|---|---:|---:|---:|---|---:|
| 1 MiB | 40 / 31 | 31 | 29 / 2 | 10 / 13 / 13 / 13 | 11 |
| 3 MiB | 40 / 31 | 31 | 30 / 1 | 10 / 13 / 14 / 14 | 14 |
| 5 MiB | 40 / 32 | 32 | 31 / 1 | 10 / 13 / 13 / 13 | 10 |

- 94 / 94 成功，35 / 90 有效 CPU traces 超過 10 ms；4 筆缺失不是 0。尚未送出的 26 次不是 missing trace。樣本不足原計畫但已實測多筆超限，故嚴格 CPU readiness 為 **FAIL**，不是 PASS，也不隱藏為 UNKNOWN。
- 每尺寸 client wall P50 約 3.54 / 3.58 / 3.57 秒，P95 約 3.82 / 3.75 / 3.81 秒；Cloudflare provider wallTime 分列於 summary.json。延遲包含跨服務與 D1，不能當成 CPU。
- CPU phase 觀測 HTTP failure / 1102 / exceededCpu / exceededMemory 均為 0；測試注入的 response-lost 503 是預期故障，不混入正常 CPU 成功率。記憶體 peak / 上限 readiness **UNKNOWN**，未取得 heap 指標。
- 第二輪 collector 一次啟動，0 parse errors，6 個符合 error/disconnect/reconnect 字樣的 stderr chunks；沒有保存原診斷，不能換算確切事件／重連次數。歷史 sampling_signals 是 stdout 關鍵字粗略計數（含 JSON 欄位名），不是實際丟 trace 數；以 sample ID 對應的 4 筆缺失為準。後續 runner 已區分欄位與診斷。
- 兩輪 instrumentation 不同且非交錯 A/B，不作為優化收益或回歸的因果比較。已知改善僅是少一個 HEAD 與少一次 importKey；實測仍不足以符合 10 ms。
- 熱點只能作結構分析：Worker 圖 bytes / Base64 / 大型 JSON／逐像素 SHA 已不在此路徑；仍有多次 D1/native subrequests、auth、bounded JSON、HMAC 及兩個資料夾 key hash、序列化與 response/log。未取得逐函式 CPU attribution，不猜是哪一個佔最多，也未做 native profiler hunting。

補充 `727786352ed1` cloud inventory-only **PASS**：真實刪除 5 MiB，保留 1 MiB 物件，正式 inventoryPage 盤點為 1,048,576 bytes、blocked=0、cleanup_requested=0；兩筆 Drive backup 保留、foreign_key_check=0、quick_check=ok、投稿 OFF。此 run 不量 CPU，readiness=UNKNOWN 不參與 CPU 結論。

補充的 cloud inventory-only 驗證另列於 evidence，專門補足中斷前未到達的重新盤點／Drive records／OFF 檢查，不重新跑舊冷讀或整輪 CPU。合成 seed 已增加可重入處理：只能重用未進入 cold_proofs 且 checksum/size/MIME 一致的物件，保留 version；有 pin 一律拒絕。僅 seed transport failure 可有限重試，破壞性清理 request 絕不自動重送。


## 測試資源清單與清除

| Run / Worker 前綴（另有 -relay） | 隔離 D1 UUID | 隔離 R2 | 清理 |
|---|---|---|---|
| `voteproof-archive-e2e-1427b4b800e2` | `d81ab9aa-3b02-4533-ade3-74fe5dc4b66e` | `voteproof-archive-e2e-1427b4b800e2-data` | 兩 Worker / D1 / R2 皆 DELETE 後 GET 404 |
| `voteproof-archive-e2e-67447ae42d27` | `cd79fa41-dff4-447a-9fd5-c493aa5c5ce6` | `voteproof-archive-e2e-67447ae42d27-data` | 兩 Worker / D1 / R2 皆 DELETE 後 GET 404 |
| `voteproof-archive-e2e-727786352ed1` | `1d1479e2-bf2d-4f9c-9f0c-f1976d821900` | `voteproof-archive-e2e-727786352ed1-data` | 兩 Worker / D1 / R2 皆 DELETE 後 GET 404 |

三輪共 6 Workers、3 D1、3 R2 Buckets 均已清除；沒有保留可被外部呼叫的測試 endpoint。合成物件清除不涉及任何 Google Drive 備份。建議只保留 repo 中的 sanitized evidence，未來另建短期隔離環境，不保留長期測試 credentials。

## 本機檢查與回歸

- 新隔離 E2E：31 PASS（28 個故障／邊界／併發情境、原生 binding CPU profile、seed 重試不能重置 cold pin、inventory / immutable audit / OFF）。
- 既有 archive 2、容量及 storage 22、populated migration 1、Apps Script archive_verify 1、Admin export 35、direct-intent migration 1；合計 **93 個不同相關測試 PASS**。重跑次數不重複計入。
- Apps Script 測試新增「重新簽名的錯 SHA」以確實到達原始 bytes digest 驗證，並確認過期 timestamp / 非法 nonce 不讀 media；不是只因 stale HMAC 而拒絕。
- Local migration registry replay、foreign_key_check、quick_check PASS；空資料庫未寫入會員／案件 fixture，投稿 OFF，容量預設 unknown + blocked。
- 8 個變動 JS/MJS syntax、Worker deploy dry-run build、`git diff --check` PASS。未重跑無關 backend 全套或舊 5 MiB Base64 雲端冷讀。
- 基線 6a436d3 的 GitHub Backend 1246 / migration / Desktop / Android / WebKit PASS 為使用者已確認的既有結果，本輪不冒稱重新執行。新 commit push 後依指示停止，不等待、查詢或分析 GitHub CI。

## 真實 Drive E2E 尚缺與 Production 阻擋

Apps Script `archive_verify` source / 本機測試確認：先 HMAC，nonce / timestamp window，私有檔案與四層資料夾身分，重新讀取原始 media bytes 算 SHA，回傳 <=4 KiB 小收據而非圖 bytes／Google credentials。真實 Google 端尚未驗收；需要另行授權專用測試 Google 帳號、私有測試 root/folders、合成檔案、Apps Script 測試部署及 Drive API 權限，再測 permissions、SHA 改變、移動／trash、quota、逾時與 ContentService redirect。**本輪沒有登入 Google、建資料夾、部署 Apps Script 或呼叫真實 Drive API。**

- Workers Free CPU 結果未達標前，維持 live OFF、Production NO-GO。即使有 HTTP 200 或沒有 1102，也不能掩蓋 >10 ms 樣本。下一輪先設計清理專用 durable 分段 invocation，保留完整 signed receipt 綁定、freshness、lease、容量與版本重查，再獨立量測；本輪不擴張實作。
- 真實 Drive E2E 與完整 maintenance tick CPU 均為阻擋條件。平台未提供 peak heap，不能宣稱記憶體達標。
- R2.delete 沒有 conditional version：四次 HEAD 與 D1 pin 仍依賴 exclusive writer；必須先確認沒有外部 S3 writer、既有 presigned URL、multipart 或其他未受控寫入。對不合作的外部 writer 不能宣稱消除最後 HEAD → DELETE 的競爭窗口。
- 沒有原生可信 R2 checksum 的舊物件 fail closed，不以 Drive 自報 SHA 或任意 metadata 取代。Google owner 之後修改／刪除備份也不是 Worker 可以保證的長期不可變性，需要營運權限與保留策略。
- 正式 0025 從未套用；修改的是未上線 migration 草稿，不可拿來覆寫已套用環境的 migration registry。正式前先檢查實際 schema／備份及升級計畫，必要時另建前向 migration。
- 回復：保留 live OFF、投稿 OFF；未知／失敗維持封鎖或 deleting pin，不粗暴清 lease。尚未刪除時可回復程式；已真實刪除圖片不能靠 DB rollback 還原，必須另行授權受控 Drive 還原流程。Google Drive 備份永不因本輪清理而刪除。

本輪完成後只 commit / push `codex/storage-archive-7d`。該分支 push 僅觸發 Branch Validation；Production workflow 只接受 main 的手動 dispatch，Pages push 只限 main。工作流程：[VoteProof Branch Validation](https://github.com/i-dle-melon/VoteProof/actions/workflows/branch-validation.yml?query=branch%3Acodex%2Fstorage-archive-7d)。

以下保留 4328870 原報告作為歷史參考；其中「30 天候選」、「即時冷讀」、「無 live 刪除程式」屬舊版狀態，以本段為準。

---

# R2 容量保護與 Drive 冷儲存 V1（本機／Pages 候選）

狀態：本機功能與 fixture Preview；Production NO-GO。未部署 Worker、未套 remote migration、未改 secrets、未裝 Apps Script trigger、未寄正式告警、未清理正式圖片、未更改 submission_settings。30 天僅 dry-run 提案，尚未批准。此版沒有實際刪除歷史圖片的 endpoint、排程或可切成 live 的開關。

## 差異與信任邊界

| 項目 | 既有 | V1 |
|---|---|---|
| 容量 | 無統一 reservation | 每個 R2 PUT 之前由 D1 原子預留；全 Bucket list 建可信 baseline |
| 90% / 95% | 無統一規則 | 9,000,000,000 啟動 dry-run；9,500,000,000 拒絕 PUT；預計寫入達停止線也提前拒絕 |
| 恢復 | 無 | 重新全量盤點且低於 9,000,000,000；不會打開投稿 |
| 清理目標 | 無 | 8,500,000,000；90% 到 85% 為持續清理區間，僅計畫不刪除 |
| confirmed backup | metadata 收據 | 再讀 Drive 原始 bytes、SHA-256、私有權限／root／兩層資料夾／來源身分／MIME／大小 |
| Admin / ZIP | 只讀 R2 | 共用 privateProofResponse；R2 缺檔才讀 Drive，不能用 Drive 掩蓋仍存在但損壞的 R2 |
| 告警 | 無獨立通道 | 獨立 purpose、secret、Apps Script 專案、D1 outbox、配額與 immutable audit |
| Drive quota | 無 | Apps Script About.get(storageQuota) → authenticated Worker endpoint → D1 snapshot → 同一 Admin renderer |

所有容量使用十進位 bytes。10,000,000,000 為管理預算，並非 R2 硬上限，也不是保證免費：R2 免費額度按整個帳戶用量／計費週期計算，不只這個 Bucket。

### 容量正確性

- 盤點不設 prefix，包含 staging、case/final、無主物件、Admin assets 及其他物件；不把 case_files 的 SUM 當成 Bucket 真相。
- 盤點時 D1 持久 scan pin 暫停新 PUT，每 invocation 最多 list 200 物件，cursor/version CAS 防止重複累計。最後一頁、歷史快照、恢復決策在同一 transaction；中斷可續跑。
- PUT 必須先通過 SQLite trigger 的容量條件再呼叫 R2。預留與計數在同一交易；並行 request 無法一起拿到相同剩餘容量。
- 成功把預留轉為已用；覆寫按完整新尺寸保守加計，刪除不直接減額，下一次可信盤點才校正。因此可能提前封鎖，不會低估。
- R2 明確 conditional null 才釋放該次預留。Timeout／斷線／D1 ACK 不明的預留不會因 TTL 自行消失；重試可以另外預留，所有不確定寫入均保守計入。
- 不確定預留會阻止新盤點；可信快照 600 秒到期後封鎖。這是刻意的 fail-closed，需要管理員先停寫、確認原 request 已結束與 R2 真實內容，再另行授權維護處理。此版不提供一鍵強制釋放，不能以「head 沒找到」推定晚到 PUT 不存在。
- 發現未入帳增量或大小異常後持續封鎖；後續重掃不會默默清除 anomaly。GraphQL 不是放行依據，也沒有 fallback 到它。
- **所有可信容量保證都有必要前提**：部署前須確認 Bucket 的唯一寫入來源為本服務、外部 S3 寫入憑證／舊 presigned URL 不可再寫、沒有未完成 multipart／其他 writer，才可設定 `R2_EXCLUSIVE_WRITER_CONFIRMED=true`。Workers binding 的 list 不包含未完成 multipart；未完成這項預檢就不能聲稱覆蓋它，inventory 會拒絕啟動。無法在任意外部寫入者仍活動時單靠 D1 保證總容量。
- Migration 預設 unknown + blocked。沒有任何 migration 自動 attestation、啟用投稿或清理。

### 冷儲存與 dry-run

- Admin 私有 proof API、inline review／相簿與 export package 使用同一圖片讀取函式。原本 auth/RBAC/MFA/Origin/CSRF、job owner、package attempt 與 immutable file snapshot 規則保留。
- Worker → Apps Script 新 cold_read purpose，HMAC 綁定 nonce／時間／file ID；回覆 HMAC 綁定 nonce／時間／整份 payload。只允許固定 Apps Script HTTPS host 與 ContentService GET redirect，不重送敏感 POST 至其他 host。
- Google OAuth token 只在 Apps Script 呼叫 Drive 時使用，不回傳 Worker／瀏覽器／D1。前端只取得私有圖片 bytes；無 public R2 URL、永久 blob URL或 Google token。
- 驗證已持久登記的 Drive file/folder/root、兩層 folder-key SHA、私有 owner-only 權限、metadata source/storage_source/case/proof IDs、大小、MIME、名稱，再對重新下載的 bytes 做 SHA-256。資料不符或 Drive 失效回 503，不能偽造圖或刪 R2。
- 舊案沒有可信 SHA 時，不以 Drive 自報 checksum 放行。dry-run 可重新讀取 R2 bytes 計算，與 Drive 比對後保存 manifest；已有可信 R2 checksum 則必須一致。
- dry-run 預設每 tick 一張，最多五張；只選 completed/rejected/revoked、已 reviewed、從結案時間（status_updated_at，舊資料保守採 updated_at）達提案保留天數且 confirmed 的歷史圖片。approved 尚未完成的案、pending、staging、孤兒與 Admin asset 均不清理。
- D1 verifying → dry_run / blocked；lease 過期可重新驗證，終態不重複執行。完成前再 HEAD 比較 R2 version/ETag/size，並在交易中重查 case/backup versions、預留 writer、進行中的 export、job lease，immutable audit 記錄結果。此版不發出任何歷史圖片 DELETE，Drive 永不刪備份。
- **未來 live deletion 仍是另一個驗收閘門**：R2 binding delete 沒有 conditional version 參數；必須先有覆蓋所有 read/write/review/export/backup 的持久物件占用協定，與排他 writer 環境，再重新驗證後刪除並做 lost-ACK 恢復。不可把本版 dry-run manifest 當成永久有效刪除許可。沒有 retention 批准前不能加入實際刪圖路徑。

## 告警

`storage_alerts` 以 episode + kind 去重（90/95/cleanup_failed/recovered）。收件人是 active admin/super_admin 的已啟用 verified auth identities，沿用既有安全解密／正規化，再固定加入兩個指定信箱並去重；reviewer、停權身分、未驗證 challenge 不加入。個別 Email 解密失敗不洩漏資料，記錄 sanitized audit。

專用 `STORAGE_ALERT_RELAY_URL` / `STORAGE_ALERT_RELAY_SECRET` / `STORAGE_ALERT_ENABLED`（預設未設定＝停用），不得共用驗證／客服通道的 secret 或 URL。From 固定 idle.voteproof.verify@gmail.com，Apps Script 必須由該帳號執行。每位收件人獨立投遞，不揭露整份 To 名單。

D1 先持久 reservation 才寄，每小時最多 5、每日最多 20 位收件人；超額保留 pending，下次續寄且跳過已送項目。Relay 也檢查專用配額及 MailApp 可用額度。寄送中斷／不明保留 ambiguous，不自動重送；D1 與 Apps Script 各自 durable dedup。Apps Script 保留七天收據（超過兩分鐘簽章 replay window），D1 永久去重；只清理專用 Script Properties 舊收據／quota counter，不觸碰 Drive 圖片。Crash 後 alert claim 可續跑，reserved delivery 不會重寄。既有 verify_email 與 admin_member_message protocol 完全未改。

## 操作量、成本與 CPU 評估

下列是此版 source 結構／本機 instrumentation，不是 Production CPU 或帳單量測。

| 操作 | 增量操作 |
|---|---|
| 正常新 R2 PUT，低於 90% | D1 3 statements / 3 trips（reserve INSERT、commit UPDATE、容量 SELECT），table writes 至少 4，加上 indexes；不新增 R2 request、不讀入或 JS hash 上傳 body |
| 超過 90% 的 PUT | 上述再加 cleanup flag + 去重告警 INSERT；95% 拒絕時不發 R2 PUT |
| 盤點 | 每 200 物件 1 次 R2 LIST；D1 pin／CAS transaction；最後一頁 history／audit／alert 狀態。沒有每物件 D1 loop |
| 冷讀一張 | 原私有 API 的 R2 GET miss + D1 context query；Apps Script 4 metadata GET + 4 Permissions.list + 1 media GET（約 9 Google calls）；Worker 1 POST + ContentService GET redirect；重新驗證 1 次檔案 SHA |
| dry-run 一張 | D1 候選／claim／版本與占用 guards／狀態／audit；R2 GET + HEAD；上面的 Drive 冷讀；另外計算來源 R2 SHA。每 request 限 1 張為預設 |
| Drive quota | 每次獨立維護執行 1 次 About.get + 1 authenticated snapshot write（不是每次 Admin 開頁） |
| 告警 | 每收件人 1 專用 relay invocation；D1 dedup／reservation／audit；額外消耗 MailApp recipient quota |

容量 freshness 600 秒。可在另獲授權後使用既有 Apps Script 設一個**獨立** maintenance trigger（例如 5 分鐘），不改 runBackup trigger；一次最多 10 次小批 tick（最多盤點 2,000 objects）。N 個物件完整盤點約 ceil(N/200) LIST；若每五分鐘一次，月 LIST 約 8,640×ceil(N/200)。例如 2,000 個物件約 86,400 LIST/月，另加既有 PUT/LIST。超過 2,000 物件可能跨多個 trigger，掃描期間上傳停用，需先評估維護窗口與 fresh timeout；這是 V1 可用性取捨。

參考現行官方價格：R2 Standard $0.015/GB-month、Class A $4.50/百萬、Class B $0.36/百萬；Standard 免費額度 10 GB-month、100 萬 A、1,000 萬 B/月。D1 Free 每日 500 萬 rows read／10 萬 rows written，包含 trigger/index 的實際 row operations，而非只看 statement 數。Google Drive API 本身不另外按 request 收費，仍有 API／Apps Script／帳號儲存額度與限制。不可把管理預算與帳單免費額度畫等號。

- https://developers.cloudflare.com/r2/pricing/
- https://developers.cloudflare.com/d1/platform/pricing/
- https://developers.google.com/workspace/drive/api/guides/limits
- https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

**CPU：熱上傳只新增 D1 記帳，不搬移原生串流或重做 upload hash。冷讀則要處理最多 5 MiB／約 7 MiB signed JSON/base64，加 HMAC/SHA 與解碼，不能假定符合 Workers Free 10 ms。** 本機最大檔案測試觀察到約 112 ms wall / 125 ms process CPU（包含 mock 回覆編碼；硬體、並行負載會改變結果），不等於 Cloudflare invocation CPU。尚無 isolated Cloudflare trace；Free CPU readiness = UNKNOWN／不可正式啟用冷刪除。正式前需要獨立、另授權的 cold-read/dry-run CPU 驗證；這輪不為測量建立或部署任何 cloud resource。

## Migration、啟用與回復

新增 `0025_storage_cold_v1.sql`，8 個專用表（capacity/reservations/history/audit/cold_proofs/quota/alerts/deliveries）與必要索引／trigger；不重寫既有 cases/members/backups，不更改 submission_settings。只在 disposable local D1 測試 migration、foreign_key_check、quick_check。

正式啟用需逐項授權：版本與 D1 備份 → additive migration → 封鎖外部 writer／multipart 預檢 → Worker source deploy → Apps Script cold-read web-app 與專用告警部署 → secrets/vars → 初次可信盤點 → 維護 trigger → isolated CPU/端到端冷讀及匯出驗收。投稿始終獨立 OFF。保留天數與 live deletion 要最後單獨批准；本版不能直接啟用 live deletion。

回復：停用專用 maintenance trigger、STORAGE_ALERT_ENABLED，保留既有 runBackup；停用冷清理（本版原本就 dry-run）。保留 additive tables、manifest、audit，不 DROP、不覆寫或刪除 Drive 備份、不自動開投稿。尚未刪任何 R2 圖時可回到舊 Worker；未來若已有 cold-only 圖，**不可**回到沒有 cold reader 的舊 Worker，必須保留 reader 或經另授權完成容量受控的還原。未知預留不可藉 rollback 任意抹除。

## 本機／Preview 驗收

結果記錄於本輪回報；安全測試覆蓋：併發 reservation、95% 各類 HTTP PUT、unknown/stale/D1 error、全 Bucket inventory、CAS／中斷續跑、Drive mismatch/私有 folder/metadata/body SHA、R2 版本改變、案件與 export ownership、冷讀匯出、告警 dedup/配額/ambiguous、Drive quota unknown、RBAC/MFA/CSRF/Origin 與 submissions OFF。

Pages 使用 Production `admin.js` + `admin-storage.js`，只替換 fixture adapter；Admin → Google Drive 備份可見容量。預覽控制列的「儲存情境」提供正常／90%／95%／恢復／未知／Drive error／清理失敗。所有「盤點／dry-run」按鈕只在 fixture memory 模擬，不連 Worker、Drive 或正式告警。

本輪本機結果：相關 backend/domain/frontend unit/policy 466 PASS；其中新 storage/GAS 測試 26 PASS（已包含於相關集合，不重複加總）。相關瀏覽器 87 PASS（三個 project；含各寬度與 Dark/Light）。Worker dry-run build、Pages isolation/build、public asset／sensitive 掃描、frontend hooks 與 diff check PASS。最大檔案 cold transport 為本機測試，不是 Cloudflare CPU trace。正式公開 submission status 唯讀確認為 OFF。

歷史 migration fixture 改用明確的舊資料 writer 來種資料；目前 schema 的 fixture 才初始化 test-only capacity。沒有在正式程式加入「表不存在就略過容量檢查」的 fallback。新增 populated 0024→0025 驗證原資料／物件／投稿 OFF 保留，且新容量 unknown 時真實 PUT 必須拒絕；實際 Wrangler `--local` migration chain 延伸至 0025。

補充升級相容性驗證：57 項相關 migration/storage 測試 PASS（包含重測的 storage integration，不與前述數字重複加總）；實際 Wrangler --local registry 至 0025，投稿 OFF、既有資料／物件、FK 與 quick_check 均保留。線上 Pages 15 項 smoke PASS，沒有正式 API／mutation request。

結構量測補充：相同 immutable V2 舊 flow / Direct flow 都新增容量預留的 3 statements / 3 trips，Case 本身不增加額外 R2 工作。含 foreground backup 的 Direct member 為 19/17、guest 為 16/14；舊 immutable+Complete member 為 30/22、guest 為 26/18。R2 仍各 PUT 1，Direct HEAD 1、舊 flow HEAD 2。這是結構計數，不能拿來宣稱 CPU 10 ms PASS。
