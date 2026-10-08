# B2 私人 R2 直接上傳

B2 實作 upload API；Production 設定由使用者完成，程式不自動修改 Cloudflare Dashboard。
本機驗收後可依使用者授權 commit／push，由既有 Cloudflare Git deployment 部署；live 驗收見 [b2-production-acceptance.md](b2-production-acceptance.md)。
既有首頁、B1 三個 API、`wrangler.jsonc` 的 Assets／`PROOFS_BUCKET`／`keep_vars: true` 全部保留。

## 資料流程與範圍

瀏覽器先以 JSON metadata 呼叫 prepare，Worker 必須呼叫官方 Turnstile Siteverify。
通過後取得 server 產生的 staging key 與短效 R2 PUT URL，圖片內容由瀏覽器直接送到 R2 S3 endpoint。
瀏覽器 PUT 成功後以 session_id／keys 呼叫 complete，Worker 用 `PROOFS_BUCKET.head()` 再驗證實際 object。
Worker 不接受或代理圖片 request body；JSON metadata 本身限制為 16 KiB。

本階段不建立 Cases，不寫 Google Sheets，不加入會員／管理員系統，不提供圖片讀取或 public URL，也不接前端 file picker。B3 等使用者確認。

## Prepare contract

`POST /api/uploads/prepare`，`Content-Type: application/json`：

```json
{
  "turnstile_token": "<browser Turnstile token>",
  "files": [{ "name": "example.png", "type": "image/png", "size": 123456 }]
}
```

只接受 1～5 個檔案，每個 size 為正整數且不超過 5 MiB，整批最多 25 MiB。
MIME 只允許 `image/png`、`image/jpeg`、`image/webp`。名稱只做基本檢查，簽名 key 與回應不包含原始名稱或其他 PII，也不接受 client 指定 key。
限制集中在 `src/api/upload-validation.js` 的 `UPLOAD_LIMITS`；名稱最多 255 字元，Turnstile token 最多 2048 字元。

Worker 先檢查設定，再向官方 Siteverify POST `secret`、`response`，有 CF-Connecting-IP 時附上 `remoteip`；連線與讀取回應共用 5 秒 timeout。
驗證成功才用 `crypto.randomUUID()` 建立 session 與每個檔案 key，日期使用 UTC。

HTTP 200 成功回應：

```json
{
  "ok": true,
  "data": {
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "expires_in": 300,
    "uploads": [{
      "key": "proofs/staging/2026/10/08/550e8400-e29b-41d4-a716-446655440000/2cb3b938-1a34-4515-9bf2-a616be0f4bf0.png",
      "method": "PUT",
      "upload_url": "<short-lived R2 S3 presigned PUT URL>",
      "headers": { "Content-Type": "image/png" }
    }]
  }
}
```

瀏覽器必須以回傳的 Content-Type 直接 PUT 圖片到 upload_url，再呼叫 complete。
簽名使用正式 dependency `aws4fetch`，`X-Amz-Expires=300`，`allHeaders: true` 確保精確 Content-Type 與 host 一起簽入；更改 method、key 或 Content-Type 會使簽名不符。
標準 S3 SigV4 URL 的 `X-Amz-Credential` 必須含 Access Key ID，使用者已確認接受此格式；其他回應欄位與 log 不輸出憑證，Secret Access Key 絕不回傳。
upload_url 是短效上傳能力資料，避免記錄或分享。成功與錯誤回應皆為 `Cache-Control: no-store`。

| 狀況 | HTTP | code |
| --- | --- | --- |
| JSON 格式錯誤／非 JSON | 400 | `INVALID_JSON` |
| 無 files、0 個、名稱或 size 格式錯誤 | 400 | `INVALID_UPLOAD_REQUEST` |
| metadata body 超過 16 KiB | 413 | `INVALID_UPLOAD_REQUEST` |
| 超過 5 個檔案 | 400 | `TOO_MANY_FILES` |
| 單檔／整批過大 | 400 | `FILE_TOO_LARGE` |
| MIME 不允許 | 400 | `UNSUPPORTED_FILE_TYPE` |
| token 空白／缺失 | 400 | `TURNSTILE_REQUIRED` |
| 未設定 Turnstile secret | 503 | `TURNSTILE_NOT_CONFIGURED` |
| Siteverify success = false | 403 | `TURNSTILE_INVALID` |
| Siteverify timeout／HTTP／JSON 錯誤 | 502 | `TURNSTILE_UPSTREAM_ERROR` |
| 缺少或無效 R2 presign 設定 | 503 | `R2_UPLOAD_NOT_CONFIGURED` |

兩個 uploads endpoint 的其他 method 均回 405 `METHOD_NOT_ALLOWED`、`Allow: POST`；未知 API 保持 B1 的 404。

## Complete contract

`POST /api/uploads/complete`，`Content-Type: application/json`：

```json
{
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "keys": [
    "proofs/staging/2026/10/08/550e8400-e29b-41d4-a716-446655440000/2cb3b938-1a34-4515-9bf2-a616be0f4bf0.png"
  ]
}
```

只接受 1～5 個不重複 key；session_id 與檔案部分必須是 UUID；日期必須有效。
key 必須精確匹配 `proofs/staging/YYYY/MM/DD/<session_id>/<file_uuid>.<png|jpg|webp>`。
不同 session、不同 prefix、`../`、百分比編碼 traversal、任意檔案路徑與額外子目錄都在呼叫 R2 前拒絕。

成功為 HTTP 200，`ok: true`、`data.session_id`、`data.files`。
files 每筆只有 `key`、R2 HEAD 的實際 `size`、`httpMetadata.contentType` 作為 `type`、`etag`。不回 public URL。
Content-Type 為 `application/json; charset=utf-8`，Cache-Control 為 `no-store`。

實際 size 必須為正整數且不超過 5 MiB；Content-Type 必須精確為 PNG／JPEG／WEBP 且符合 key 副檔名。
不合格物件立即 delete；即使同批另有缺失物件，也會繼續檢查其他物件，移除已識別的不合格物件。

整批只有全部成功才回傳成功，沒有部分成功回應：

| 狀況 | HTTP | code |
| --- | --- | --- |
| JSON 格式錯誤／非 JSON | 400 | `INVALID_JSON` |
| metadata body 超過 16 KiB | 413 | `INVALID_UPLOAD_REQUEST` |
| session／key／數量不足／重複錯誤 | 400 | `INVALID_UPLOAD_REQUEST` |
| 超過 5 個 key | 400 | `TOO_MANY_FILES` |
| 未設定 R2 binding | 503 | `R2_UPLOAD_NOT_CONFIGURED` |
| R2 HEAD／delete 操作失敗 | 502 | `R2_UPLOAD_ERROR` |
| 任一實際物件驗證失敗 | 400 | `UPLOAD_VALIDATION_FAILED` |
| 物件尚不存在 | 400 | `UPLOAD_INCOMPLETE` |

混合批次的錯誤優先順序為 storage error、validation failed、incomplete。錯誤只使用 B1 的 `ok: false, error: { code, message }`，不回 stack、env、原始上游內容或部分成功列表。

## Production 手動設定

只由使用者在 Cloudflare 操作；不要把 secret 貼進聊天或提交 Git。

Worker Production 新增 variables：

- `R2_ACCOUNT_ID`：Cloudflare Account ID。
- `R2_BUCKET_NAME`：設定為 `voteproof-proofs`，必須與 `PROOFS_BUCKET` binding 指向同一個 bucket。

Worker Production 新增 secrets：

- `R2_ACCESS_KEY_ID`
- `R2_SECRET_ACCESS_KEY`

沿用既有 Production `TURNSTILE_SECRET_KEY`。B1 的 `GOOGLE_PUBLIC_API_URL` 不需改動。
不在 `wrangler.jsonc` 新增真實值；原有 `keep_vars: true` 保留 Dashboard variables。

先在 Cloudflare 的 R2 API Tokens 管理介面建立 R2 API Token，權限為 **Object Read & Write**，只套用 **voteproof-proofs**，不要選全部 buckets。
建立後取得 Access Key ID 與 Secret Access Key，分別填入上述 Worker secrets。

## R2 CORS

在 Cloudflare → R2 → voteproof-proofs → Settings → CORS 設定 `docs/r2-cors.json`。
此檔案採 Dashboard 支援的 S3-style policy array，直接貼入 CORS Policy 的 JSON 欄位。Wrangler CLI 的 CORS 設定檔使用另一種 schema，不能只把這份陣列加上 wrapper 當作 CLI 設定。

只允許 Production origin `https://voteproof.i-dle-melon.workers.dev`、method `PUT`、header `Content-Type`，曝露 `ETag`，preflight cache 3600 秒。
Production origin 沒有 `*`。CORS 只控制瀏覽器跨來源請求，不會使 bucket 公開；Public Development URL 與 public bucket 保持關閉。

## Staging lifecycle 與 B3 交接

建議日後只針對 `proofs/staging/` 設定 lifecycle，清除長時間未被完成／歸檔的 orphan uploads，例如依人工確認的保留期限清除。
本階段只新增此建議，不自動修改 lifecycle；B3 才決定正式 Case 歸檔及 retention。

## 已知限制

- declared size 只做第一層檢查，不限制 presigned PUT 的實際 Content-Length；complete 必須用 R2 HEAD 二次檢查並刪除過大檔案。
- MIME metadata 及副檔名不等於圖片內容驗證。B2 沒有讀取、解碼或掃描圖片內容，B3 接收正式證明前應評估內容驗證。
- presigned PUT 在有效期間可以重複使用並覆蓋同一 key，complete 並不凍結檔案；B3 正式歸檔前必須重新驗證／處理覆寫競爭。
- complete 無會員登入或持久化 session registry；隨機 session_id 與完整 keys 應作為敏感能力資料保存，B3 必須再建立案件授權，不能把 UUID 視為會員身份。
- complete 只有 HEAD／delete，不 list bucket，不建立 public GET URL；外部未知 key 在 R2 存取前拒絕。
- CORS、Production Turnstile token 與真實 R2 憑證需在使用者設定後另做瀏覽器／R2 端到端驗收，本機測試不能宣稱已驗證正式 R2 的 signature 或 CORS 行為。

## 本機驗收

- `npm test`：保留 25 個 B1 測試，新增 86 個 B2 測試，涵蓋 metadata、Siteverify timeout／錯誤、簽名、實際物件驗證與刪除。
- `npm run test:smoke`：沿用 B1 本機 Wrangler smoke，包括 Assets 與排行榜上游錯誤。
- `npm run test:uploads-smoke`：實際 Worker entrypoint 在本機 workerd 執行 prepare 簽名與 complete；只在測試 harness mock 官方 Siteverify，並以本機 R2 寫入測試物件驗證 HEAD／delete。使用執行時隨機產生的模擬憑證，不連 Production R2。
- `npm run check`：Wrangler dry-run，不部署。

程式沒有 DISABLE_TURNSTILE、SKIP_SECURITY 或可由 Production 設定啟用的測試 bypass。

2026-10-08 本機驗收結果：111/111 unit tests 通過（B1 25、B2 86），B1 smoke、B2 workerd smoke 與 Wrangler dry-run 全部通過。`public/index.html`、`wrangler.jsonc`、B1 測試檔沒有修改。

官方參考：[R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)、[R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)、[R2 API tokens](https://developers.cloudflare.com/r2/api/tokens/)、[Turnstile Siteverify](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)。
