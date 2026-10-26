# 圖片維護控制（本機候選，尚未發布）

基底：`5e3a9d608f2b85718526dc6467a5415e61f4f2b7`。新增 `0030_image_maintenance.sql`，不是 V4 A1/A2；不改既有 0029、投稿 Gate、Drive Script/Trigger 或 Cleanup ON 設定。

## 最小持久範圍

- `image_maintenance_control`：open / draining / closed、CAS version、DELETE generation、舊 cohort 的獨立 Operator 證據狀態。
- `image_mutation_operations`：只有 Admin 圖片工作、native DELETE、inventory pin。沿用既有 PUT reservation，沒有為每個 HTTP/會員/審核/讀取建立全站 Journal。
- 所有 Runtime R2 DELETE 都呼叫 `deleteImage`：先 D1 admission + Audit，再唯一一次原生 DELETE，最後持久 ACK。Native ACK 不明保留 unknown；D1 終態 ACK 不明會回報 HOLD，保留可能已提交的 receipt 供後續唯讀核對，禁止重做 DELETE。程式本身沒有自動重試或到期回收。
- Admin 上傳驗證格式後、第一次副作用前取得工作紀錄；活動圖片/內容變更在提交前取得紀錄。已受理 Admin 工作在 draining 仍可完成其已追蹤子 DELETE，維護不能跳過 active/unknown 工作。
- 一般 GET、讀圖及 `runBackup` 不受這個寫入控制封鎖。備份 Script 原文未改。會員/匿名 PUT 由既有 reservation 加新增 DB 維護 guard 約束；補償 DELETE 也必須經同一個 admission。

## API

`GET /api/admin/storage/image-maintenance`：admin / super_admin + 有效 MFA；只回狀態及 pending 類型數，不回傳物件 Key 或 Session。

`POST` 同一路徑：super_admin + 有效 MFA + 同源 CSRF，使用既有 `MemberSession.adminRequest`；不允許 query 或任意子路徑。每次 Body 必須有 `action`、新鮮 `expected_version`、`confirmed:true`。

|action|條件及效果|
|---|---|
|pause|open→draining；拒絕新圖片工作/PUT/DELETE，令容量 blocked、trust 失效；保留所有 pin；同時停用 Archive admission，不自動恢復 Archive|
|attest_legacy|僅 draining、沒有未決作業；另提供 `evidence_sha256` 指向已獨立審查的舊 cohort 證據。這是 Operator attestation，**不是 Runtime 技術排空證明**|
|settle|draining、舊證據已登記、沒有 active/unknown operation、reservation、write pin、Dispatch/deleting、inventory，且投稿 Gate OFF，才轉 closed|
|abort_inventory|draining/closed；另提供精確 `inventory_id` / 整數 `inventory_version`，D1 CAS、Audit 與 blocked=1/trusted_until=0 同事務完成；不發布 used_bytes、不清 anomaly、不動任何 DELETE/Upload pin|
|resume|closed、舊證據、無未決狀態、Gate OFF、沒有 inventory、容量可信且無 anomaly；僅恢復 image admission，不改 Gate、不 Resume Archive、不安裝 Trigger|

pause 即使還有在途作業也會先關 admission，回傳 draining/pending；不能將 HTTP 成功解讀為已排空。每次 pause 都重設舊 cohort 證據狀態為 unknown。沒有提供/審查真實證據，不得呼叫 attest_legacy 來填平 UNKNOWN。

## Inventory 與 DELETE

資料庫 Trigger 同時保護 legacy 與分段 inventory：claim 不能越過 active/unknown 圖片作業；pin 存在時不能新 admit DELETE。Inventory admission 捕捉 generation；publish 再核對 generation、控制狀態、舊 cohort 證據及未決作業。中途 pause 會阻止 finalize；必須合法取消或待證據充分後續跑。

取消與 finalize 使用原 inventory ID/version 及 D1 事務競爭，只有一方可提交。取消保留不可變 Audit、把 inventory operation 記為 aborted，不當成一次成功盤點。重新完整 scan/finalize 後才能依原程式更新可信容量。

`active`、`unknown` 不會自動到期。`completed`、`aborted` 及 unknown 紀錄不提供任意覆寫/刪除介面。若已有未知 native DELETE，應停止並保留資料，另案實作/批准受保護的個案對帳；本候選沒有「直接清除 unknown」捷徑。這也不包含 Dispatch9 恢復。

## 發布及相容性限制

正式維護/部署仍 HOLD。正式 DB 不能只停在 0029 卻宣稱圖片維護功能已可用；必須另批完整新 Schema 驗收，再另批新精確 SHA/CI/受保護部署。0030 為新增式；正常 admission 初始 open，舊 cohort 初始 unknown，Archive 仍沿用 0029 paused/OFF。尚未證明舊 I/O 排空前，不應把新 Schema/Runtime 的空紀錄當證據；盤點 publication 會 fail closed。

舊 Runtime 不經新 DELETE helper 的 I/O 仍是外部缺口。DB 能阻擋其稍後 reserve，不能撤回已開始的 R2 I/O。外部 Dashboard/S3/CLI Writer 亦不會被這些 DB guard 技術阻止，仍需要獨立窗口控制及證據。

未變動 90% 啟動、85% 目標、95% 上傳阻擋、600 秒 trust、7 天結案、Drive SHA/HMAC、R2 版本及既有 immutable Audit/Dispatch。未來安裝 `runStorageMaintenance` 及 Cleanup ON 必須獨立驗收與授權。沒有執行任何正式操作。

## 成本界線

未新增輪詢、R2 讀取或背景 consumer。每個 native DELETE 多兩個 D1 atomic batch（admission/terminal），各四個顯式 statements；Trigger 內部查詢/寫入另計，不假裝包含在 trip 數內。每個 Admin 圖片 workflow 多 admission、pending 檢查及 terminal，正常三個 trips。PUT 沿用 reservation，增加 DB guard；inventory 的既有 trip 內增加 pin/Audit/terminal Trigger 寫入。純備份及一般讀取沒有新增的圖片維護查詢。

Cloudflare 原生 CPU、真實 Rows Read/Written 仍 UNKNOWN，本機時間不是 CPU。未知紀錄不自動刪除，容量及 D1 留存成本需後續監測；不能在免費額度壓力下偷偷清 Audit。
