# 方案 A：R2 容量管理及 7 天封存（實作候選）

狀態：開發分支 `codex/storage-archive-7d`；**Production NO-GO**。已確認保留期限從 30 天改為 **結案後 7 天**。舊的 Google Drive → Worker → Browser 大圖片即時冷讀已取消；R2 清理後只提供管理員手動開啟受限 Drive 備份。

- 十進位容量預算 10,000,000,000 bytes；90%（9 GB）啟動清理，直到 85%（8.5 GB），95%（9.5 GB）阻擋新 R2 PUT。恢復需可信盤點且低於 90%，不自動開投稿。
- 只清理已審核結案（completed/rejected/revoked）、結案滿 7 天、Drive confirmed 且可再次驗證原始 bytes SHA-256 的案例圖片。其他圖片、投稿素材、D1 案件及 Google Drive 備份不得刪除。
- Apps Script `archive_verify` 使用原私有 Drive API 權限，重新驗證檔案、四層私有階層、SHA-256，僅回傳小型 HMAC 收據；Workers 不再解碼 5 MiB Base64 / 大型 JSON。沒有可信原生 R2 SHA-256 或 Drive 不一致時不刪。
- 清理使用 D1 lease、來源 ETag/version/大小/原生 SHA、案件與備份版本、匯出佔用、唯一 writer attestation、immutable audit。R2.delete 無 conditional version，因此不允許未確認外部 writer 或 multipart；刪除 ACK 不明時保留 deleting，重新核對後再恢復。已清理圖片的 Admin GET 回 410 `PROOF_ARCHIVED_IN_DRIVE`；匯出含已封存圖片明確拒絕。
- `STORAGE_CLEANUP_LIVE_ENABLED` **預設 OFF**；只有正式另行設定精確 `true` 才允許每次 maintenance tick 最多刪 1 張。Admin 手動預覽永遠不刪。實際釋放容量由 R2 全量 inventory 重新確認，不憑 DELETE 直接減少計數。
- 如需查看已清理圖片，管理員在「Google Drive 備份」個案區使用受限 Drive 連結手動查看。暫不新增自動 Drive 取回或繞過 95% 限制的 R2 還原入口。
- 仍待驗證：完整 GitHub CI、隔離環境真實 Apps Script 5 MiB 原圖回讀、Workers Free archive 驗證/清理 CPU、R2 刪除 lost-ACK、並發匯出、Production pre-0025 backup、migration、安全切換及受控 pilot。前次 **390 ms 冷讀 CPU FAIL** 不再是本方案的執行路徑，但不能因此宣稱新的清理路徑 CPU PASS。

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
