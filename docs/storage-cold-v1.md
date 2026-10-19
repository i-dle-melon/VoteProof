# 第三階段：A 單頁原子 CAS 優化（2026-10-20，本輪）

**本機／安全 90 PASS；單輪隔離 Workers Free CPU PASS；Production 未修改。**
完整證據：[A page-CAS 原始量測](evidence/storage-inventory-page-cas/results.json)。
基準 codex/storage-archive-7d / 698400282a386412aa5c9093497f220893d5f430；
保留所有前輪工作與失敗證據。本輪達標，依 Operator 授權 Commit／Push 開發分支，
不合併 main、不發布正式環境、不等待 GitHub CI。

## 13 ms 分析與最小改動

唯一 13 ms 是前輪 201 物件 scan18/page2，固定 50 個 metadata、累計到第150筆。
其他19次相同頁 CPU 4–7 ms；沒有 claim／finalize、額外 JSON 解析或 SQL 分支。
wall 約1215 ms（native event wall 958 ms）不能當 CPU 根因。現有 trace 不足以
將超限歸因於某函式、GC、JIT、D1 或 host；不以猜測作結論。

可避免的成本是 A 單列更新使用 authAtomic 通用交易：guard INSERT、UPDATE、
guard DELETE，含一次 guard UUID 與多條 SQL 的 preparation／batch 編碼。
改成一條 SQLite 原子 UPDATE … RETURNING，WHERE 保留 id=1、inventory_id、
version、phase=scan、reserved_bytes=0；沒有匹配列即409，SQL失敗也不當成功。
同一 statement 只更新 cursor／累計／phase／version，仍不發布 used_bytes、audit
或可信期限。B 的完整交易及函式內容完全不變，hash 記於證據。

A 首頁由5降為3 statements，後續頁4降為2；往返仍3／2。
整輪 P 頁加 B 為2P+7 statements／2P+3 trips／P+1 HTTP；quota另加1／1／1。
34物件每5分鐘，含quota為每日2880 statements／1728 trips／864 HTTP，
LIST與About各288次；不是D1計費rows或整個帳號額度保證。
95%預檢、90/85門檻、600秒期限、完整cursor、pin、audit、outbox去重均保留。

**A1/A2評估：本輪不採用。** 持久保存待提交頁至少增加一次write/read、
每頁多一個HTTP與驗證／JSON處理，並引入pending receipt重放協定；A1仍要承擔
native LIST。未見足夠收益，先採移除兩條冗餘SQL、保留單列原子CAS的較小改法。
沒有新增第三段、pending table或本輪migration；0027仍是前輪本機／隔離候選，
正式D1未套用。

## 必要驗證

90項相關測試PASS：tick21、Apps inventory33、backup9、storage安全22、
trace4、populated migration1。新增：LIST期間ID／version／phase／reservation
任一變更不能累計；更新失敗原cursor／總額保留；更新成功但ACK遺失，依持久
cursor續跑不重複加總。既有併發、95%、failed finalize、quota、runBackup回歸PASS。
首次沙箱內loopback與local R2存取受限；同一組相關測試經授權在沙箱外通過，
未修改產品繞過環境限制。syntax／diff／新增檔案whitespace檢查PASS。

只做一輪相同合成workload：34與201物件各20輪，A最多LIST50，B另HTTP。
兩路獨立Cloudflare native cpuTime均完整，160個不同CF-Ray；CPU含原有isolated
防濫用budget SQL／trip及log，不扣除，也不合併A+B當單次CPU。

| 階段 | Requests | 有效 / 缺失 | P50 / P95 / Max ms | >10 ms |
|---|---:|---:|---|---:|
| A scan | 120 | 120 / 0 | 5 / 7 / 8 | 0 |
| B finalize（未修改） | 40 | 40 / 0 | 3 / 5 / 5 | 0 |

HTTP全200，0 HTTP1102、0 exceededCpu、0 collector parse errors／CPU mismatch。
raw收到162事件、CLI161事件（含各自連線barrier）；benchmark各160筆完整。
本輪無收集中斷錯誤訊號，正常停止收集不當故障。head sampling=1。
首次觀測保留，但不能宣稱所有first皆為cold isolate。僅是一輪有界PASS，
不能保證未來零偶發超限，也不是interleaved A/B的精確改善百分比。
A wall P50/P95/Max約317/451/952 ms；B206/261/404 ms，不替代CPU。

40輪容量與同bucket原handler全相同：34物件2312bytes、201物件13668bytes。
最終reserved=0、anomaly=NULL、pin/phase=NULL、blocked=0、trust delta=600秒，
quick_check=ok、FK無違規、submissions=0、deliveries=0、cold_proofs=0、quota known=1。
沒有archive或真實Google呼叫。新Apps Script編排仍是本機測試覆蓋，並未再部署
Google測試Script；前輪About／quota真實驗收證據保留。

臨時Free Worker／D1／R2 voteproof-inventory-test-23dad6c5dc均已清理，逐項GET404；
本機一次性測試憑證已丟棄。沒有正式Worker／D1／R2／Script／Trigger變更，
沒有開投稿、清理、告警，也沒有寄信或刪正式圖片。

## 後續啟用界線

本輪CPU已達標，不繼續拆分、不追加雲端量測。正式0027／Worker／Script與Trigger
仍須另行授權並遵守exact-SHA既有發布保護。
若Operator日後選擇有限Production試運行，建議先只人工啟動最多5輪完整盤點、
30分鐘內結束，不建立Trigger；保留投稿／清理／告警OFF與既有容量門檻，
每輪監看原生CPU及D1 pin/version/freshness、history/audit、quota。
若出現>10 ms、1102／5xx、未解釋trace缺失或容量不符，即停止新增輪次；
先讀持久狀態，已提交頁不能重算，未完成保持有效封鎖，不能強清pin／anomaly。
回復優先停止維護呼叫與相容Worker版本；先由新版安全完成active scan/finalize
才考慮回退舊Worker，保留0027與期間新資料，不自動down migration／整庫還原。
這只是後續風險／回復方案，未執行、也不視為已獲正式試運行授權。

---

# 第三階段：分段 HTTP 盤點（2026-10-20，前輪歷史）

**功能／安全驗證 PASS；Workers Free CPU FAIL；未 Commit／Push，Production 未操作。**
依授權只做一輪有界隔離量測，完成後停止調校。完整原始事件、HTTP、容量對照、
收集器診斷與修正後統計：[分段證據](evidence/storage-inventory-segmented/results.json)。
基準仍為 codex/storage-archive-7d / 698400282a386412aa5c9093497f220893d5f430，
所有本機既有變更保留。

## 實作與安全

- A：每次獨立 HTTP 驗證後，讀取最多 50 個 R2 metadata，D1 CAS 保存
  inventory_id／cursor／version／分頁累計。最後一頁只標 ready；不更新
  used_bytes／observed_at／可信期限／history／完成 audit。claim 將 trusted_until
  歸零，既有 pin／freshness 保護在整輪完成前持續封鎖 PUT。
- B：另一個獨立驗證的 finalize HTTP，只接受 server-issued id + version，
  不做 R2 LIST。以 guarded atomic D1 batch 寫 history、immutable audit、容量、
  600 秒可信期限、90／95／85 門檻與 deduplicated alert outbox。無 mail delivery、
  無 archive。回應遺失後以持久 receipt 重播，不延長原期限、不干擾下一輪。
- nullable inventory_phase 新增於 migration 0027；NULL 保留既有 0026 legacy
  scan 語意，CHECK 避免舊程式清掉 phased pin。只套本機與隔離 D1，未套正式。
- Apps Script 保留 quota About.get、LockService、runBackup、60 秒軟預算、
  50 頁上限；ready 後另發 finalize HTTP，時間不足則下輪續跑。未完整不刷新信任，
  失敗不強行清 pin／anomaly。沒有正式 Script／Trigger 變更。
- 相關 **87 PASS**：tick 18、Apps inventory 33、backup 9、storage safety 22、
  trace 4、populated migration 1。涵蓋重複頁／完成重播、併發 CAS、
  transaction rollback／重試、錯誤版本、auth／Origin、95%／恢復與告警去重、
  0026 帶資料／既有 cursor 升級。新 Script orchestration 本輪只做本機 VM 驗證，
  前輪真實 Google About／quota 成功不能等同新版本已發布驗收。

## 唯一一輪 Cloudflare 原生 CPU 實測

Free Worker／D1／R2 均為 voteproof-inventory-test-e1ae156efa；
無正式 binding。34 與 201 個合成 PNG，各 20 輪完整掃描，合計 120 次 A、
40 次 B。R2 只讀 metadata；使用真實 storageRoute／relay auth／D1／R2 路徑。
每次 measured start 至少間隔 1.5 秒，並作輪間唯讀核對；不代表 burst 壓力保證。
CPU 包含隔離防濫用 budget UPDATE／trip 與小型 log，未扣除此負擔。
CPU 來自 Cloudflare trace cpuTime，沒有以 Node CPU／wall time 取代，
也沒有將 A+B 相加視為單次 invocation。

| 階段 | HTTP requests | 有效 / 缺失 UNKNOWN | P50 / P95 / Max ms | >10 ms |
|---|---:|---:|---|---:|
| A：scan | 120 | 119 / 1 | 5 / 7 / 13 | 1 |
| B：finalize | 40 | 39 / 1 | 3 / 5 / 6 | 0 |

160 次 HTTP 全為 200，CF-Ray 各自不同，HTTP1102=0，已取得 exceededCpu=0。
首筆 34 物件 scan=7 ms／finalize=3 ms；201 物件首輪 scan=6/5/6/5/4、
finalize=4 ms。保留首次觀測，但無法證明它們全是 cold isolate。
Wall time P50/P95/Max：A 約 834/1046/4421 ms，B 約 570/611/618 ms；
這些值不是 CPU，也未取得可靠 heap／memory-limit metrics。

**統計修正及 trace 缺失**：原始 WS 收到 150/160，Wrangler CLI 收到 158/160。
原先自動 summary 只用 WS，顯示 A Max=8、B Max=6、readiness UNKNOWN，
漏看 CLI 獨有的 13 ms。本次保留原 summary，新增雙端 exact sample ID 合併
統計，並修正 harness 及新增回歸測試，避免再次漏掉單端超限。
150 筆重疊 CPU 完全一致，CLI 補回 8 筆，真正缺失 2 筆，均不填 0：
inv-split-201-scan-18-4、inv-split-201-finalize-18-0。
raw WS close=1006；CLI 有 1 次 error／disconnect／reconnect 文字訊號，
停止收集時 SIGTERM 另列。兩端 parse_errors／unmatched／missing_cpu=0，
head sampling=1 且無 sampling warning。可確認 stream 中斷與交付缺失，
不能斷言精確平台內部根因或保證持久 logs 可補齊。
已知 13 ms 足以判本輪 **FAIL**；其餘兩筆仍 UNKNOWN，B 不單獨宣稱完整 PASS。
沒有為補齊樣本再發 benchmark。

## 結果一致性、成本與收尾

40 輪全部與同一隔離 bucket 上 legacy handler 的 used/count/staging/other/
blocked/anomaly/cleanup 相同。34 物件=2,312 bytes；201 物件=13,668 bytes。
最終 staging=4,556、other=4,556、reserved=0、anomaly=NULL、pin/phase=NULL、
blocked=0，trust delta=600 秒。quick_check=ok、FK 無違規，
submissions=0、deliveries=0、cold_proofs=0、quota known=1。
重複 ready 不多 LIST，重複 finalize 不更新 trusted_until；未完成前沒有新 audit/
history／可信發布。隔離 D1 結果僅證明本次測試，並非讀取正式資料。

正常低容量 P 頁：A 首頁 5 statements／3 trips，其後 4／2；B 6／2、0 LIST。
整輪 4P+7 statements、2P+3 trips、P+1 HTTP、P LIST；
quota 另 1 statement／trip／HTTP。34 物件每 5 分鐘（288 次／日）：
864 Worker／UrlFetch、288 R2 LIST、288 About、3,456 D1 statements、
1,728 trips；D1 計費 rows 與帳號其他工作仍須另計。不是啟用正式排程的授權。

臨時 Worker、合成 R2 物件／bucket、D1 已全部清理，每項 GET 404 核對；
本機一次性測試憑證已丟棄。未操作正式 Worker／D1／R2／Google／Trigger，
未開投稿、刪圖或寄信。

## 發布與回復界線、下一步（只建議，未實作）

0027 必須先經獨立正式發布授權，nullable additive migration 保留舊資料；
新版 Worker 再到新版 Script，最後另授權 Trigger。目前 CPU FAIL，停止發布。
如未來回退 Script／Worker，先讓新版完成 active scan/finalize；不要用舊程式
強行清 phased pin。保留新增 nullable 欄位與資料，不自動 down migration／整庫還原。

唯一超限 inv-split-201-scan-18-2 是**中間頁**，沒有 claim，也沒有 finalize。
所以「只把 claim 拆開」不能解決這筆已觀測尾端；不再自行細拆／微調。
最小下一驗證方案需另決定：讓同程式的正式 handler 取得可持久查詢的 native
CPU 樣本，確認含防濫用 wrapper 的 13 ms 是否亦出現在代表性正式執行路徑；
不得移除產品 auth／CAS／完整盤點安全。若仍須拆分 LIST 與保存，必須先設計
可信 metadata 交接／重放機制，不能接受任意 client 回傳容量，也不能先保證 <10 ms。
本輪未實作第三段、未追加量測、未 Commit／Push。

---

# 第三階段：盤點 CPU 最小優化（2026-10-19，前輪歷史）

**結果：功能 PASS；Workers Free CPU FAIL；不 Commit／Push，不發布 Production。**
僅做一輪針對性雲端驗證，沒有修改正式 Worker／D1／R2／Apps Script／Trigger，
沒有開投稿、清理或告警。以下較早的測試報告保留作歷史證據。

本輪變更只有：`inventory_only` 每頁 R2 LIST 上限 200→50（Admin／舊模式仍 200），
以及 pre-scan 容量檢查共用同一次 server-read row，省去每頁一個 SELECT／trip。
沒有省略 auth、JSON 限制、95% 預檢、CAS、pin、完整 cursor、600 秒期限或 audit。
相關本機 **75 PASS**，syntax／diff check PASS；Google 配額與 runBackup 沿用既有
真實驗收並跑相關本機回歸，未重做 Google 測試或全 CI。

證據：[本輪 CPU／雙收集端／資源清理](evidence/storage-inventory-cpu-optimization/results.json)。
新建獨立 Free Worker `voteproof-inventory-test-18f3535379`、D1、同名 R2，只有
201 個合成 PNG；key 長度接近正式 proof path，涵蓋 staging／final／其他物件。
每組 30 次完整掃描；保留首次觀測與後續請求。CPU 仍包含隔離 harness 的
budget UPDATE／trip、控制檢查及小型 log，沒有扣除或以 wall time 取代。

| 完整正式 handler | Requests | 有效／缺失 UNKNOWN | P50 / P95 / Max ms | >10 ms |
|---|---:|---:|---|---:|
| 34 物件，1 頁 | 30 | 20 / 10 | 9 / 13 / 14 | 3 |
| 201 物件，5 頁 | 150 | 63 / 87 | 6 / 9 / 16 | 1 |
| 合併 invocation 分布 | 180 | 83 / 97 | 7 / 10 / 16 | 4 |

所有 HTTP 200，0 HTTP1102，已收到的 exceededCpu=0。缺失不當作成功。
新超限為 34 物件 scan0/7/27（12/13/14 ms）及 201 物件 scan18/page0
（16 ms）；不只是首次冷路徑，也不是只有 200 物件 LIST 才可能超限。
不能把這一輪與不同 workload／觀測條件的舊數據直接當精確 A/B 改善百分比。

**瓶頸證據與限制**：舊 5 筆超限都在 200 物件頁；本輪單頁完整流程仍較重，
包括 claim、CAS、完成 history、post-scan 容量讀取及 audit。另作獨立診斷
invocation：control 1 筆有效=1 ms；auth+bounded JSON 3 筆=1 ms；native LIST50
2 筆=2–4 ms；LIST200 4 筆=5–7 ms；正式 handler+真實 D1、以預計算 metadata
替代 R2 的 5 筆=4–9 ms。這些樣本少、仍有 wrapper／不同 SQL 階段，不能
相減／相加當作精確函式 CPU；支持 R2 metadata 與完整 D1 工作均有成本，
不能可靠宣稱某一函式或 GC 是唯一根因。

**trace 缺失定位**：原始 `trace-v1` WebSocket 與獨立 Wrangler CLI 同時收集，
benchmark 收到的 sample 集合、CPU 值一致；原始 stream 多收到一個 CLI
連線前的 barrier。兩端 0 parse errors、0 unmatched／missing_cpu／header-log
mismatch、0 非預期 disconnect，未收到 sampling warning。framing 的任意切塊／
跳脫／巢狀資料測試通過。Worker 設定已回讀確認 head sampling=1、persisted
invocation logs enabled。因此本輪缺失在兩個 collector 之前的 Cloudflare 即時
交付邊界，不是本機 JSON parser 或 ID 配對遺漏；**平台內部抽樣／丟棄策略仍
UNKNOWN**，也不能事後還原舊 55 筆缺失的特定原因。
一次 `dry:true`、只篩選本次測試 Worker 的持久 Logs API 查詢回 HTTP403／10000；
沒有擴權或重試。不能因 head sampling=1 就保證 real-time tail 完整。

隔離資料 quick_check=ok、FK=0、used=13,668 bytes／201 物件、reserved=0、
anomaly=NULL、pin=NULL、blocked=0、freshness=600 秒，投稿=0，deliveries=0，
cold_proofs=0。測試沒有 archive endpoint。所有新建 Worker／D1／R2 已清理，
逐一 GET 404 確認，暫時本機憑證已丟棄。

**停止與最小下一方案（尚未實作）**：將完成頁的 immutable audit 與必要容量
threshold outbox 寫入併入原有 guarded D1 batch，減少完成後的 SELECT／獨立 trip，
而不是刪除檢查或改寫容量真相。須保留 CAS／95%／outbox dedup／lost-ACK 安全，
另做有界驗證，不能先保證會低於 10 ms。觀測則需可讀取隔離 Worker 持久日誌的
授權管道（Dashboard 或必要 Observability 權限），以 sample／request ID 對齊 CPU；
目前不自動擴權或追加測試。

目前正常低容量 P 頁：inventory-only `4P+5` statements／`2P+3` trips；另加
quota 1 INSERT／1 trip。R2 LIST／Worker request 隨頁數增加；目前 34 物件仍一頁。
50 頁軟上限最多 2,500 物件／輪，另受 60 秒軟預算限制；未完整不刷新信任期限，
依既有 D1 cursor 續跑，絕不強制放行。

參考：[Cloudflare real-time logs 與 sampling 限制](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/)、
[持久 query API 與權限](https://developers.cloudflare.com/api/resources/workers/subresources/observability/subresources/telemetry/methods/query/)。

---

# 第三階段：tick-only 正式發布前驗證（2026-10-19，前輪）

**結論：功能 PASS；Workers Free 10 ms CPU FAIL；本階段 Production NO-GO。**
未達「必要驗證 PASS 後 Commit / Push」條件，保留本機工作，未 Commit / Push。
以下歷史清理報告不代表本次盤點路徑已通過 CPU。

證據：[完整隔離量測](evidence/storage-inventory-only/results.json)。使用新建
`voteproof-inventory-test-722afbfe30` Worker／R2 及獨立 D1；帳號 Free 設定已確認，
沒有綁定正式資料。只有合成 PNG、暫時 relay/control credentials、4 小時到期與
D1 3,000 次請求上限。測試後 Worker、R2、D1 均已刪除並逐項 GET 404 確認。

| CPU 量測 | Requests | 有效／缺失 trace | P50 / P95 / P99 / Max ms | >10 ms |
|---|---:|---:|---|---:|
| 原包裝，0 物件 | 40 | 23 / 17 | 7 / 11 / 14 / 14 | 2 |
| 原包裝，34 物件 | 40 | 26 / 14 | 8 / 10 / 13 / 13 | 1 |
| 原包裝，201 物件 | 80 | 43 / 37 | 7 / 10 / 13 / 13 | 1 |
| 原包裝，401 物件 | 120 | 64 / 56 | 8 / 11 / 12 / 12 | 7 |
| 移除測試額外 JSON 解析，401 物件 | 120 | 65 / 55 | 7 / 11 / 16 / 16 | 5 |

- 直接呼叫正式 storageRoute、relay auth、JSON validation、D1 CAS／batch 與
  原生 R2 LIST；每頁最多 200，0／34／201／401 分別 1／1／2／3 頁，每組
  40 次完整盤點。原包裝重複解析 request／response JSON，因此保留原始證據，
  只修正測試包裝後補測一次；**沒有修改產品效能程式**。
- 修正後首輪三個 invocation 為 16／12／9 ms；後續仍有 >10 ms，不能只挑
  warm 結果。全部 400 個量測請求 HTTP 200、0 HTTP 1102、已收到 trace 的
  exceededCpu=0；這不代表符合 10 ms。Missing 一律 UNKNOWN，沒有補 0。
  修正後 client wall P50/P95 約 472/756 ms，並非 CPU。
- 每 request 的測試用 budget UPDATE／trip 與小型包裝／log 負擔均包含在 CPU，
  未扣除；因此不能精確歸因產品函式本身，但目前實測**無法證明 Free 合格**。
  Collector 每輪 1 次啟動、0 parse/error/disconnect 訊號；缺失仍按 sample ID 計。
  沒有取得 heap peak，不宣稱記憶體量測完成。
- 受影響本機測試 48 PASS；沒有重跑全 CI。isolated D1 quick_check=ok、FK=0、
  submissions=0、alert deliveries=0、cold_proofs=0；scan 完成、pin=NULL、
  anomaly=NULL、reserved=0、blocked=0。測試 endpoint 不提供 archive。

**真實 Apps Script / Google 配額 PASS**：既有獨立
`VoteProof Isolated Backup Test` 加入同一份 StorageInventory.gs，操作員安全設定
測試專用 properties，沒有新增 OAuth scope。實際 Drive.About.get(storageQuota)
得到 known，隔離 D1 收到 3 筆快照。一次完整 3 頁、刻意在第 1 頁達預算、
下一次從 D1 cursor 續跑剩餘 2 頁，全組約 11.766 秒；runBackup 回 idle，沒有
Drive 圖片讀寫。這不宣稱重新驗收了備份圖片 roundtrip。

實際一次性時間驅動 Trigger 19:52:47 執行，0.817 秒回 overlap_skipped / pages=0；
持 UserLock 期間 runBackup 仍可執行。測試 helper 最後直接刪除已執行的一次性
trigger object 時出錯，鎖已於 finally 釋放；UI 顯示殘留為已停用，已手動移除，
確認 0 triggers。只修正本機測試 helper 改查現存 ID；未重跑此清理分支。
沒有安裝正式或長期測試 trigger。

**真正剩餘阻擋**：有 CPU 超限樣本且 traces 不完整；本輪不再迭代。
下一輪僅針對 tick 的必要工作分配及可代表正式路徑的量測做受限修正／驗證，
保留 auth、D1 CAS、完整 LIST 與 fail-closed，不為了過關刪安全檢查。
正式 Worker／Pages／D1／R2／Google Script／投稿／清理／告警均未操作。

---

# 方案 A：兩階段清理修正（歷史）

基線：`codex/storage-archive-7d` / `6b70f294`（先唯讀確認並 fast-forward，開始時工作樹乾淨）。本輪只調整封存清理，沒有修改 UI、投稿流程、舊冷讀或正式環境。

- **A 驗證**：原 server-only relay auth / bounded JSON；R2 HEAD 原生 SHA、ETag、size、MIME、version；Drive signed receipt 的 SHA-256、HMAC、nonce、timestamp 與完整來源身分核對；再次 HEAD；同一 D1 transaction 保存 manifest、server-owned verification_context、小型簽名收據及 immutable audit。A 的 DELETE 永遠是 0。
- **B 刪除**：新的獨立請求，重新讀可信容量、案件、備份與 persisted manifest。只接受 120 秒內且完整來源／版本仍一致的 A 結果；claim D1 lease，重新核對 native SHA / ETag / version，持久 deleting pin，刪除前最後 HEAD，DELETE，HEAD 確認缺檔，再 transaction 記錄 cold / audit。B 不呼叫 Drive，不重讀圖片或解碼 Base64。此 HMAC 信任來自 A 已驗證並寫入受信任 D1 的結果，並非客戶端 deletion token；API 不接受 file ID、SHA 或 receipt payload。
- 沿用 verifying / deleting / cold 狀態：完成 A 時 verifying 仍阻擋 writer、reopen 與新 export，lease_until=0 代表可由下一次請求 claim。沒有新表、沒有第三套清理系統。過期或來源改變先回到 A 重新驗證，該次請求不刪。deleting pin 不降級；DELETE 或 D1 ACK 不明時，重試只依受限新鮮證據 reconcile；缺檔恢復不再 DELETE，immutable success audit 仍只有一次。
- `storage/tick` 現在只做容量盤點與告警；新增既有 server-only auth 保護的 `POST /api/internal/drive-backup/storage/archive`，每次只做 A 或 B。Apps Script source 的 runStorageMaintenance 在 inventory 完成後送第一個 archive 請求，僅 verification_ready 時送第二個；不在單一 Worker invocation 內串跑 A+B。實際 Apps Script 未部署、trigger 未安裝／修改。
- 7 天結案保留、十進位 10 GB、90% 啟動、85%（含等於）停止、95% 上傳封鎖、低於 90% 可信盤點才恢復、Google Drive 手動查看全部保留。live flag 預設 OFF，任何容量恢復均不開投稿。

## Migration 與回復

新增 `0026_archive_verification_handoff.sql`，只為 cold_proofs 增加 nullable verification_context；未改寫 0025。既有列為 NULL，不能直接跳 B；destructive pin、audit、容量與投稿 OFF 都保持。只套本機與新隔離 D1，未套正式 migration。

啟用前必須先 migration、再相容 Worker／Apps Script caller 的受控發布，保持 live OFF；舊 Apps Script 只呼叫 tick 將不再執行刪圖，是安全停止而非自動沿用舊單階段刪除。回復時關 live 並停止新 archive 呼叫，保留新欄位及不確定 deleting pin；不得以回退到舊版忽略 handoff／lease 的方式恢復自動刪除。已刪圖片不可能靠 DB rollback 還原，Drive 備份永不刪。

## 本輪測試與量測

- 本機相關測試 **48 PASS**：36 個隔離情境、原生 binding profile、seed retry、inventory/audit/OFF、非 JSON lost-response controller、既有 archive 安全／7 天／手動 Drive、continuation auth/Origin/forged body、Apps Script quota/receipt/兩請求 orchestration、兩個 populated migration。
- Local schema migration registry replay / foreign_key_check / quick_check PASS；Worker deploy dry-run build PASS。僅測受影響範圍，未跑全站 browser、舊 5 MiB Base64 雲端冷讀或全 backend release regression。
- 第一輪隔離環境完成 34 個情境後，test controller 把預期 lost-response 的非 JSON body 解讀成物件而中斷；清理程式沒有相應錯誤，資源已 teardown。修正 controller optional handling 並加回歸後，只補 response-lost、upload-stop 兩項，不重跑前 34 項。原始失敗證據保留。

### 結果：功能 PASS；CPU readiness UNKNOWN

原始證據：[split evidence](evidence/storage-archive-split/README.md)。合併兩輪不重複情境共 **36 PASS**；第二輪正常 workload 為 45 張圖片、A/B 各 45 次獨立 invocation，90 / 90 HTTP 200 / 預期狀態成功。

| 階段 | 圖片 | 有效 CPU / requests | 缺失 UNKNOWN | P50 / P95 / P99 / Max ms |
|---|---|---:|---:|---|
| A verify | 1 MiB | 11 / 15 | 4 | 8 / 9 / 9 / 9 |
| A verify | 3 MiB | 14 / 15 | 1 | 6 / 9 / 9 / 9 |
| A verify | 5 MiB | 15 / 15 | 0 | 7 / 10 / 10 / 10 |
| B delete | 1 MiB | 9 / 15 | 6 | 6 / 7 / 7 / 7 |
| B delete | 3 MiB | 15 / 15 | 0 | 6 / 9 / 9 / 9 |
| B delete | 5 MiB | 15 / 15 | 0 | 6 / 9 / 9 / 9 |

- 79 筆有效 CPU 全部 <=10 ms；11 筆缺失不當 0。1 MiB A / B 缺失 4 / 6 筆，超過本輪預設每組最多 10% 的門檻，**不能判 PASS**。3 MiB、5 MiB 觀測通過該 bounded gate；整體仍 UNKNOWN，停止本輪效能迭代。
- 正常 CPU workload 沒有 HTTP failure、1102；已收到 traces 沒有 exceededCpu / exceededMemory。Collector 1 次啟動，0 parse errors、0 error/disconnect/reconnect 訊號；平台未提供的事件／heap peak 不捏造。sampling_text_matches 只是 stdout 字詞計數，不是實際 sampling loss；缺失以 sample ID 對應為準。
- Client wall P50：A 約 0.55 秒，B 約 0.69–0.71 秒；provider wallTime 在 summary.json 分列，均不是 CPU。
- 每階段／尺寸另有 3 個 instrumented 操作樣本：A **D1 9 statements / 6 trips、R2 HEAD 2、DELETE 0、relay HTTP 2**；B **D1 13 / 7、HEAD 3、DELETE 1、relay 0**。每 invocation 額外一個 harness budget SQL / trip 包含在 CPU，未扣除。兩階段 source 合計 D1 22 / 13、HEAD 5，但不能將 A+B CPU 相加冒充單 request CPU。
- 原有 7 天、90 / 85 / 95 門檻、Drive confirmed / raw SHA / HMAC、writer/export/review concurrency、lost-ACK、immutable success audit、95% 無 PUT、可信 inventory 扣帳與 OFF 均通過。Inventory 得到 1,048,576 bytes，56 筆 Drive backup 保留，quick_check=ok、FK errors=0。
- 兩輪各 2 Workers + 1 D1 + 1 R2 均已刪除，8 / 8 獨立 GET 404 確認。沒有長期保留的可呼叫測試 endpoint 或 credentials。Formal source hashes 與兩輪部署證據一致。

**剩餘阻擋**：需要補足可靠 CPU traces（尤其 1 MiB A/B）才能完成 Free readiness，不能因這次有效樣本較舊版下降就推定正式可用；另有真實 Drive E2E、完整 inventory/alert tick CPU 與正式前 schema／唯一 writer 預檢。遵照本輪限制，不再追加雲端測試或微調。Production 保持 NO-GO。


## 真實 Google Drive 最小驗收與授權

本輪 **沒有**登入 Google、建立 Drive 檔案／資料夾、部署 Apps Script、改正式 trigger 或呼叫真實 Drive API。仍需另行授權：

1. 專用測試 Google 帳號、私有測試 root/folders、完全合成 1 / 3 / 5 MiB 檔案；僅測試範圍的檔案建立與讀取權限，不能使用正式備份。
2. 專用 Apps Script 測試部署／Script Properties secret、Advanced Drive API 及必要 scope；使用隔離 Worker 測 archive_verify 正常簽名收據、原始 SHA、私有階層、size/MIME/source，以及錯 SHA、換 folder／權限／trash、過期／nonce／簽章不符與 relay failure。收據不能回傳圖 bytes 或 credentials。
3. 手動執行測試 maintenance，確認 inventory→A→B 確為獨立請求、lost-ACK 安全恢復及 Drive 手動存取權限；不修改正式 Script、trigger 或任何正式 Drive 資料。

Workers Free CPU 未達標、缺少真實 Drive E2E 或正式前 schema/writer exclusivity 預檢時，一律 **Production NO-GO**。R2 DELETE 仍沒有 conditional version，必須排除外部 S3 writer／舊 presigned URL／multipart；兩階段無法取代這項前提。Inventory/alert tick CPU 與 heap peak 不是本輪 A/B 清理 CPU 的驗收結論。

完成後只 commit / push 開發分支，不合併 main、不部署 Production、不套正式 migration、不刪正式圖片、不開投稿、不等 GitHub CI。以下舊報告作歷史參考；本輪以本段與新的 split evidence 為準。

---

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

> 2026-10-19 第三階段本機增量：獨立 tick-only 盤點已加入
> `apps-script/drive-backup/StorageInventory.gs`，Worker `/storage/tick` 增加
> 嚴格的 `inventory_only:true` 模式以跳過寄信；容量／清理規則與既有備份不變。
> 後續本機補強：每輪先以 Drive v3 `About.get(storageQuota)` 讀一次帳號配額，
> 透過既有 `/storage/quota` 更新快照，再盤點 R2；不讀寫 Drive 圖片。
> 配額失敗仍嘗試 R2，回傳明確 partial／error 狀態，不偽造數字或放行。
> 沒有正式部署或建立 Trigger。操作量實測及啟用順序見
> [Apps Script 盤點說明](../apps-script/drive-backup/README.md#獨立-r2-tick-only-盤點2026-10-19本機候選尚未啟用)。
> 新路徑 Workers Free 真實 CPU 尚無量測，readiness = UNKNOWN；不得拿本機
> 測試成功宣稱正式啟用 PASS。以下內容含前階段歷史設計與驗收紀錄。

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
