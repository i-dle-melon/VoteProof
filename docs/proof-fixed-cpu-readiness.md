# Proof request 固定 CPU 成本優化：仍為 NO-GO

起始基準 `3b852d7068ffc0a99e45ab6976cabea13fe6f3d6`。本次只有本機候選及隔離驗收；Production 保持 `91e0a707d0f1155907ebf3a15d3d6564d72a98ad`、0012 未套用、投稿 OFF，歷史 hash backfill 未執行。

## 實際來源與安全優化

正常 router 沒有另一層 auth middleware：memberSession 在 case handler 執行一次。它解析單一 session cookie、SHA token domain hash，以 token_hash 索引讀取 session／member，排除 revoked／expired／suspended／pending password operation，再驗證精確 Origin 與 HMAC CSRF。Session 是 opaque random token，不是需要 Supabase/JWT signature 驗證的 token。proof request 沒有 Supabase fetch、trusted-device／Tier／role lookup；Admin evidence 另外執行 fresh member／membership／MFA 驗證。schema 沒有 security_version 欄位，不能捏造該欄位的測試；既有憑證變更透過撤銷、pending operation、secret rotation 與最近提升狀態檢查，本次完全保留。

沒有刪除任何 auth 工作，也沒有加入跨請求 auth／gate／Campaign cache。每次新 request 都重新讀取權威狀態。

1. `casePreflight` 用一個 indexed LEFT JOIN 讀取同請求的 submission setting、Campaign 必要欄位、completed session、每個完成 proof 與 verified checksum。沿用原 gate → Campaign → completion 驗證與 error 優先序；讀取失敗仍 fail closed。anchor 保留缺 setting／Campaign／session 的明確拒絕。不要 LIMIT 掉多餘完成檔案；原 manifest／keys 一致性檢查仍會拒絕不一致資料。
2. `requireCompletedUploadSnapshot` 只處理上述同請求伺服器快照；沒有 client-authoritative context。Campaign version 供原 guarded INSERT 使用；commit 仍重新檢查當下 gate trigger、Campaign version/window/status、member/session revocation/expiry、completed session TTL／consumption，故不能用舊快照繞過 R2 歸檔期間的狀態變動。
3. 備份入列重用已原子提交的 server-generated file IDs，少一次 SELECT。每筆 backup INSERT 仍以 SQL 驗證 `c.id=?`，不會把另一案件 proof 排入這個 case。一般 reconciliation caller 未提供 IDs 時仍讀取 DB。失敗不改案件正確性，原 durable reconciliation 保留。
4. complete 的兩個 readback SELECT 使用同一 D1 batch，保留所有 manifest、TTL、consumption、R2 HEAD 與 SHA 核對。沒有刪除 readback，也沒有將 ambiguous write ACK 當成成功。

正常會員 case：**13 → 9 D1 statements，9 → 5 binding 往返**。complete：6 statements 不變，4 → 3 往返。prepare／PUT 各1；Admin evidence6；replay2 不變。case preflight 只選必要欄位，沒有大型 object clone 或 proof body buffer。

EXPLAIN 確認 session token PK、member identity unique index、pending-password index、Campaign PK、completed session PK、completed files `(session_id,object_key)` PK、checksum object_key PK、idempotency PK、case/proof linkage indexes、SHA historical range index 均有效。join 只掃單一 constant anchor，proof rows 按既有 session key 索引取回；可能的 ORDER BY temporary B-tree 僅排序單 session 的上傳 metadata。未發現需要新增索引的缺口，**未新增 migration／index，也未改 0012**。查詢完整順序及 provider query plan 保存在隔離報告的 `queries-before.json`／`queries-after.json`，沒有參數值或憑證。

## 真實 Worker 前後量測

同一專用隔離 Worker／D1／R2，合成資料；來源正常 auth／CSRF／gate／Campaign／checksum／archive／atomic commit／backup enqueue 均實際執行。CPU 為 Wrangler invocation cpuTime，wall 分開記錄；不能把 stage wall delta 當 CPU。不同 controlled path 只作統計差異，不能宣稱單函式精確 CPU 切片。

每個大小各12完整流程，加20獨立混合影像／重試／錯誤checksum。before 429 requests／328 CPU traces；after 429／279。缺 trace 不推估為0。

| Case bytes | before median／p95／max ms | after median／p95／max ms |
| ---: | --- | --- |
| 13,082 | 10／19／19（n9） | 4／23／23（n9） |
| 262,144 | 9／16／16（n12） | 4／6／6（n11） |
| 2,097,152 | 9／13／13（n12） | 4／6／6（n9） |
| 5,242,880 | 7／11／11（n12） | 4／8／8（n12） |

after 所有取得 trace 的 endpoint 合計 median2／p955／max23 ms，不能用此混合統計隱藏首案尾端。23 ms 的真實 request 為新版 D1=9。後續5次版本更新控制，以版本 header 確認新部署生效再送首筆完整流程；5筆首案有4筆 CPU trace，為 **12、14、12、13 ms**；後續 case 約5–7 ms。版本更新不能證明每次都是物理新 isolate，但能證明此部署後首案路徑可重現超限；所以不能當成單一平台雜訊或依賴預熱維持安全。另跑20個正常完整流程（無相符／同會員／跨會員／跨Campaign各5），95 CPU traces，case尾端另見無相符16 ms、同會員11 ms，complete12 ms；全部結果保留，不能只報最有利的一輪。

最大檔暖機請求已達約8 ms p95，但完整請求在部署後首案仍沒有 Workers Free 10 ms CPU 餘裕。剩餘瓶頸定位為 **首次 case 固定路徑成本**（auth／CSRF／idempotency cryptography、request metadata／D1 binding／archive／commit 路徑初始化的組合），而非 proof body hash。現有 invocation 與 controlled-path instrumentation 沒有函式級 CPU flamegraph，不能再把首案成本無證據地全歸給 auth 或 D1。暫時診斷只在 gitignored fixture，正式 source 沒有 log／counter／debug route。

## 若仍要維持零固定成本

| 選項 | 安全／一致性與 UX | 固定成本／複雜度與建議 |
| --- | --- | --- |
| 非安全預處理移到 browser | 現在 SHA 已由 browser宣告、R2驗證；不能把auth/gate/MIME/ownership改給browser | 已採用，沒有額外可安全外移的證據 |
| SHA classification 延後 | 目前exact lookup本來就在Admin detail，不在critical create path；新hash仍原子保存 | 無法解決首案瓶頸；維持現況 |
| Apps Script classification | 須專用job/secret、source/version/lease/replay、受信任compute與callback；延遲證據不得影響案件/點數 | 額外trust boundary／quota／queue；不擴充現有健康backup relay，本次不實作 |
| 非同步 private archive／case finalization | backend必須先權威驗證auth/gate/immutable upload，持久job＋receipt／idempotency，finalizer重新驗證state後原子提交；UI需明確待保存狀態 | 可能拆開每request固定成本，但改變UX/consistency/error lifecycle；僅建議另案隔離設計，不直接實作或啟用新trigger |
| waitUntil 或預熱 | waitUntil不是持久queue，也不能假設CPU budget自動增加；預熱不能保證不出現首次路徑 | 不推薦作為GO依據 |

推薦保留本次可量測的安全改善，**仍不部署 SHA**。下一步先取得首次 case 函式級 CPU profile；若不能在不弱化檢查下消除首案尾端，再另案評估可持久／可重播的非同步 finalization。不要增加付費依賴、不要停止既有 Drive trigger。歷史34筆backfill仍依原受控操作員／來源version綁定設計，不在此任務執行。

官方：[Workers Free HTTP10ms](https://developers.cloudflare.com/workers/platform/limits/)、[D1 batch 與交易語意](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)、[waitUntil](https://developers.cloudflare.com/workers/runtime-apis/context/#waituntil)。
