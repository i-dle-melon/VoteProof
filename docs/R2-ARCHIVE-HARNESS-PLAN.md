# 新 Canary A/B 隔離 CPU Harness：準備完成，尚未授權雲端執行

## 入口及測量差異

- `scripts/prepare-archive-canary-harness.mjs <new-local-directory>`：只在本機 bundle、產生18個合成 PNG／FIXTURES.json／setup SQL／migration 副本／PLAN.json，拒絕覆寫。不登入、不建立任何雲端資源。
- `scripts/lib/archive-canary-cloud-worker.mjs`：以真 `src/index.js` router 處理嚴格新 A/B。測試專用 bundle 將裸 fetch 注入為 AsyncLocalStorage request context 的 MOCK_RELAY service binding。Production source 不改寫。
- mock 只接受固定 inert Google fixture path；所有真正對外 fetch 被本機測試封鎖。mock 驗證請求 HMAC／時間／單次 nonce，回傳隔離 D1 已知的合成來源收據。**不是 Google bytes 重新驗證的驗收**；原 Code.gs VM 證據保留在前份 ZIP。
- native 模式不包裝 runtime DB/R2，CPU 包含額外外層授權、budget CAS、mock adapter 開銷；mock 是另一 invocation，要另報，不當成 A/B CPU。
- operations 模式另一次隔離設定部署，樣本前綴 `ops-`，用 wrapper 取得 D1 meta／statement/trip／R2方法次數。CPU 不得混入 `arc-` native 組。
- 每個 test Worker 要素：獨立隨機 access secret＋原 relay Bearer、正向 origin、最長24h expiry、無 Origin header、只准指定路徑、每角色持久 budget／pause。沒有 public seed、全桶 delete 或 cleanup endpoint。上傳只限預先寫入測試 D1 的合成 fixture key、固定大小及 SHA。

## 待授權資源與預算（本輪實際建立數0）

| 資源 | 數量／限制 |
|---|---|
| Workers Free | 1，名稱 `voteproof-archive-canary-test-<run>`；mock self service binding，兩個模式的隔離測試部署 |
| D1 | 1，與Worker同名前綴；只套用此 repo schema 的隔離副本＋合成資料；拒絕正式UUID |
| R2 | 1，與Worker同名前綴；不綁正式 bucket |
| 合成 PNG | native 15張＋operations 3張；1/3/5 MiB 各6張；峰值54 MiB＝56,623,104 bytes |
| native CPU | 5組×3尺寸×A/B＝30次HTTP；15次mock invocation |
| operations profile | 3尺寸×A/B＝6次；3次mock |
| seed / snapshot | 各18次HTTP |
| 全部 Worker invocation 硬上限 | request36＋relay18＋seed18＋snapshot18＝90；預檢及失敗也占各自配額，不自動補滿或重試 |
| R2 API正常路徑 | 18 PUT；archive90 HEAD＋seed18 HEAD＋snapshot18 HEAD＝126 HEAD；18 DELETE（全部合成） |
| 郵件、真Drive API、R2 GET、Cron、Google Trigger | Harness 0；不提供正式刪除入口 |

預算為**付費新增0、不得升級**。帳號目前剩餘 Free 額度、self binding 雲端可用性及當時供應商計費資格都尚未讀取，為 UNKNOWN；不得把少量用量當成已證明免費。另行授權後先確認 Free／剩餘額度，資源會觸發費用就停止，不自動建立。預設測試結束需清理這三項隔離資源，但清理需在下一次授權清單內，不能誤套正式資源。

本機一組 profile（不是完整雲端帳單）：A 9 statements／6 trips、22 rows read／10 written、2 HEAD；B 13／7、30／16、3 HEAD＋1 DELETE。另有每次外層 budget 1 SQL，mock 3 SQL（budget＋payload查詢＋nonce寫入）、seed／snapshot／schema setup 的成本。SQL Trigger 的內部查詢沒有列入 statement/trip 計數；rows 是當地 D1 回傳 meta，不宣稱完整雲端計費。18組 core 合計約396 statements，加外層、mock及setup；Rows 隨資料量、索引與執行結果變動，不以固定數值假報雲端消耗。

## 後續經授權的操作順序（本輪不執行）

1. 核准資源清單、≤90 invocation、兩個隔離模式部署、synthetic PUT/DELETE、測試Secrets及結束清理；不含任何正式或Google授權。
2. 檢查帳號Free額度，記錄隔離名稱／UUID；用 `isolatedConfig({name,account,accountId,databaseId,expires})` 建立**只綁獨立資源**的設定並逐項人工核對。account 是 workers.dev 子網域；accountId 是 Cloudflare 帳號ID。全部 Secrets 由安全本機環境輸入，不在args／對話／repo。
3. Worker 尚未部署前，對空測試D1依序套用 offline migration 副本，再執行 `synthetic-setup.sql`。這份setup內已含 `test-schema.sql`，不要重複套用。只在離線 fixture 準備時暫停三個投稿 gate，按最新 migration 版本原樣還原；本機完整鏈已驗證。正式資料不得使用這份SQL。
4. 部署 native test bundle／設定，開啟100% observation並開始原生 tail；這些都要下一輪授權。本機 self binding／ALS PASS 不冒充雲端部署 PASS。
5. 執行 `node scripts/run-archive-canary-harness.mjs --authorized-isolated <isolated-config.json> <offline-fixture-directory> <new-result-directory>`。只有精確隔離origin／resources／expiry與安全環境中的 `CANARY_TEST_ACCESS`、`CANARY_RELAY_SECRET` 能執行。順序為seed一張→A→同handoff B→snapshot，再下一張；錯誤即 durable hold，不自動補跑。
6. 各 pair 先把Journal寫入並fsync，才發HTTP。handOff只在RAM，不輸出。狀態回覆丟失就停止；保留 R2／D1 做唯讀核對，不重播、不改成功數。
7. 原生 `wrangler tail <isolated-name> --config <isolated-config.json> --format json` 的 stdout **直接pipe**進 `node scripts/report-archive-canary-traces.mjs <requests.json> <new-report-dir>`，在完整有限樣本與tail排空後結束。不要落地未去識別化headers。先開始tail，requests ledger檔可於stdin結束時再讀。不要以console.log的自製CPU代替原生欄位。
8. CSV/JSON按尺寸與A/B輸出 P50/P95/P99/Max、成功／失敗、native exceededCpu、HTTP1102及缺失樣本；缺失、衝突、無cpuTime都不判PASS。若tail不提供足夠原生CPU，readiness UNKNOWN，不能改用wall time。少樣本P99只是該批樣本最大附近，不能宣稱生產尾延遲已受控。
9. native完成後才切 operations 模式，同bundle、只改TEST_PROFILE；先核對隔離版本，再跑3組新fixture，保留ops raw meta。此模式不是native CPU證據。檢查snapshot cold、R2不存在、Drive備份record confirmed、terminal audit恰好1、沒有其他fixture被選。
10. 不反覆加樣本；超10ms或1102即FAIL，缺traces即UNKNOWN。保留證據後停止並交GPT審查，不直接啟用正式清理。

記憶體峰值與limit events若平台未提供，維持UNKNOWN。CPU報告不把wall time／本機CPU／本機workerd時間當成Cloudflare CPU。原生tail輸入未授權／未執行，所以本輪有效雲端CPU樣本0，missing為null（不是測過且遺失0）。
