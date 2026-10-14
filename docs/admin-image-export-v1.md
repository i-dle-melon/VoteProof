# Admin Image Batch Export V1

ZIP 在 Admin Browser Web Worker 產生；Worker API 只查詢 D1、保存快照與狀態、串流私人 R2 proof。沒有壓縮、重新計算 SHA、建立 ZIP blob 的 Cloudflare 路徑。投稿、審核、points 與備份語意不變。

## 查詢與快照

輸入台灣時間 `YYYY-MM-DDTHH:mm`，伺服器轉成 UTC，使用 `cases.created_at >= from_utc AND cases.created_at < to_utc`。整個活動模式只使用指定 Campaign 的 authoritative `start_at/end_at`。來源以 `member_id IS NULL` 判定匿名。狀態 mapping：待審核 `pending`；已通過 `approved/completed`；未通過 `rejected/duplicate`；其他 `revoked`。`review_stage` 保留在 CSV 快照中。

`0016_admin_image_exports.sql` 新增 `export_jobs/export_job_items/export_packages`，不修改既有資料表。每次最多 20,000 張。SQL `INSERT SELECT`、ROW_NUMBER、recursive CTE 在同一 D1 batch 固定排序、狀態、活動、MIME、容量、ETag 與 package boundaries；不逐張發 D1 寫入請求。既有 case/time/file 索引沿用。新表 package/owner 索引由 targeted EXPLAIN 檢查。Job 以 client UUID + normalized filters idempotent 建立，僅原建立 Admin 可讀取，API 有效期 7 天。

到期僅停止 API 使用；V1 沒有自動清理排程。儲存保留／清除政策需獨立決定，未新增 Cron。沒有 `case_files.exported`。

## API

| Method | Endpoint（省略 `/api/admin/image-exports`） | 行為 |
|---|---|---|
| GET | 根路徑 | 最近 10 個本人未到期工作 |
| POST | `/query` | D1 COUNT/SUM，無 proof bytes |
| POST | `/jobs` | `{job_id,filters}` 建立 immutable snapshot |
| GET | `/jobs/:job` | 快照摘要與 package 狀態 |
| POST | `/jobs/:job/packages/:number/start` | `{attempt_id,expected_attempt_id}` CAS；回傳最多 500 筆 metadata |
| GET | `/jobs/:job/packages/:number/attempts/:attempt/files/:file` | 原 private proof transport；驗證 job/attempt/file 與 snapshot ETag/size/MIME |
| POST | `/jobs/:job/packages/:number/state` | `{attempt_id,status,error_code?}`；completed/failed acknowledgement |

全部沿用 opaque cookie/session + active membership + MFA elevation，限定 admin/super_admin，reviewer 不可用；POST 另驗 CSRF 與 exact Origin。寫入 transaction 內重驗 session/role。對外不傳 object_key、auth identity、query key、憑證或永久 URL。R2 read 共用既有 integrity-checked raster response，no-store、nosniff、same-origin。原審核 proof API 與權限保持相容。

重試使用新 attempt，需傳目前 expected attempt；舊 attempt 無法讀取或完成新一輪。已完成包不可被延遲 failed 回覆降級。lost start 回覆可用同 attempt 重送；lost complete 回覆可僅重送 metadata。重新整理可從工作列表讀回 failed/in_progress，獨立重試；其他完成包不會重送。

## ZIP 與記憶體

設定集中於 `public/js/export-format.js`：500 張／512 MiB 圖片任一先到即分包，concurrency=1。ZIP32 STORE + UTF-8 names + data descriptors + CRC32，central directory 僅保存最多 501 個小 metadata entries。圖片以 stream chunks 處理；worker→main output 逐塊 ACK，形成回壓。

支援 `showSaveFilePicker` 時，每包 ZIP 逐塊寫入選定檔案，最後 `close()` 成功才 acknowledgement；失敗／取消 `abort()`。不支援或改用相容模式則規劃 64 MiB 包，暫存單包 ZIP chunks，再產生下載 Blob。這不是 stream-to-disk；Blob 建構可能有副本，最壞至少預留約 130 MiB 外加瀏覽器、其他 UI／GC 使用量。程式限制實際 ZIP output 為 64 MiB + 1 MiB，完成／失敗釋放 chunks，30 秒 revoke download blob URL。瀏覽器下載 API 無法確認 OS 儲存動作，completed 表示 ZIP 成功產生並交給下載流程。

取消中止 worker/fetch/ZIP，不標 completed。缺圖、HTTP error、MIME/length 不符、truncated stream 或改版 ETag 均整包失敗，不跳過檔案偽裝完成。

檔名用 trusted case/file IDs + MIME extension，不採原始 filename。Campaign slug 排除路徑、保留字與 controls、長度上限與 fallback。CSV UTF-8 BOM、完整 quoting 與 formula neutralization，包含 filename/case/file/time/campaign/type/source/status/stage/MIME/size/ETag。SHA 只讀既有 R2-verified record 且 source metadata 相符；沒有值則空白，不重新 hash。未輸出不可信 original filename。

## Preview 與部署邊界

Pages 共用正式 renderer/ZIP worker，僅換成 build-only session/fixture adapter。控制列有 Normal 4,386 張／6.7 GB／14 包、Small 76 張／93 MB／1 包、Empty、Error。包狀態與重試只改 RAM，下載 ZIP 明確標示為 3 張 synthetic sample + CSV，不生成數 GB fixture。沒有 Production API/R2 連線或真實憑證。

本輪僅 local/source migration + Pages 發布；沒有 Production deploy/migration/D1/R2/CORS/Cron/Drive/Async 操作，正式 submissions 維持 OFF。
