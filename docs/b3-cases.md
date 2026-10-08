# B3：D1 Guest 案件提交與查詢

B3 僅本機完成與 commit，尚未 push／部署／執行 Production migration。首頁檔案保持不變，現有前端仍是示範流程，沒有接上正式 Cases API。
沒有會員、email、審核、點數寫入、Google Sheets 同步或圖片下載 endpoint。

## 修改／新增檔案

- 新增 `src/api/cases.js`、`src/api/case-validation.js`：Cases API、JSON／欄位驗證、Guest lookup。
- 新增 `src/lib/case-keys.js`、`src/lib/completed-uploads.js`：安全案號／query key／hash、D1 completed upload state。
- 新增 `src/lib/case-files.js`、`src/lib/case-store.js`：私人 R2 snapshot archival、D1 atomic consumption、失敗回滾／清理。
- 新增 `migrations/0001_cases.sql`：四個正式資料表、外鍵、狀態與大小限制、唯一約束與 indexes。
- 修改 `src/api/uploads.js`、`src/api/upload-validation.js`：共用實際物件驗證、complete 成功後保存完成紀錄。
- 修改 `src/api/router.js`、`src/api/response.js`：Cases collection／item 路由、統一 helper 支援 201。
- 新增 `test/cases.test.js`、`scripts/lib/local-case-runtime.mjs`、`scripts/smoke-cases.mjs`：43 B3 tests、本機 workerd/D1/R2 harness 與 smoke。
- 修改 `package.json`：加入 test:cases-smoke；依賴與 lockfile 不變。
- 修改 `wrangler.jsonc`：只新增 DB placeholder binding；原 bindings／vars／assets／main／compatibility_date 保留。
- 新增 `docs/b3-cases.md`、修改 `README.md`：contract、取捨、測試結果、手動 migration／rollout 與 TODO。

共 18 個檔案；`public/index.html`、B1／B2 tests 與 Production 驗收工具不變。

## D1 schema

Migration：`migrations/0001_cases.sql`。

- `cases`：規格要求的 id、case_id、timestamps、member_id、nickname、player_id、campaign_id、vote_type、vote_date、status、query_key_hash、note、source、duplicate_flag、reviewed_at、reviewer_id、points_awarded、point_status；另有唯一的 `upload_session_id`。
- `case_files`：規格要求的 id、case_id、object_key、original_name、content_type、size、etag、created_at；另有唯一的 `upload_object_key`，指向驗證過的 staging 原件。
- `completed_uploads`：session UUID、完成 manifest 的 SHA-256、完成時間、consumed_case_id、consumed_at。
- `completed_upload_files`：每個完成 session 的 staging key 與 R2 HEAD 實際 MIME、size、etag。

`cases.id` 是內部 UUID；`cases.case_id` 才是公開案號。`case_files.case_id` 與 `completed_uploads.consumed_case_id` 外鍵指向內部 UUID。
唯一約束包含公開案號、案件的 upload_session_id、case_files 的原始 staging key 與 archive key。
有 query lookup、created_at、status、campaign_id 與 case_files 外鍵 indexes。
狀態 CHECK 預留 pending／approved／completed／rejected／duplicate／revoked，但 API 只能建立 pending。
新案 member_id／reviewer／reviewed_at／point_status 為 NULL，source 為 guest，duplicate_flag／points_awarded 為 0。

## API contract

全部沿用 B1 JSON helper，`Cache-Control: no-store`。Cases JSON body 沿用 B2 串流 reader，上限 16 KiB，必須是 application/json。

### POST /api/cases

```json
{
  "nickname": "訪客暱稱",
  "player_id": "投票平台帳號",
  "campaign_id": "YOUR_CAMPAIGN_ID",
  "vote_type": "Solo",
  "vote_date": "2026-10-08",
  "note": "可省略",
  "upload_session": {
    "session_id": "<prepare 回傳的 UUID>",
    "keys": ["<complete 成功驗證的 staging key>"]
  }
}
```

nickname／player_id／campaign_id trim 後必填，分別至多 50／100／100 個 Unicode 字元。
campaign_id 只接受英數、底線、連字號，第一字元需為英數。
vote_type 只接受 `Solo` 或 `團體`。vote_date 必須是有效 ISO 日期，範圍為 2000-01-01 至 UTC 今天＋1 日（容許使用者所在時區的當天日期）。
note 可省略或 NULL，trim 後最多 500 個字元，允許換行。拒絕額外欄位，包括 status、case_id、member_id、points_awarded 和任意 files metadata。

upload_session 直接延用 B2 complete 的 `{ session_id, keys }`。必須與 D1 保存的完整完成批次相同；順序可不同，不接受 subset、額外 key、其他 session 或其他 prefix。

成功 HTTP 201：

```json
{
  "ok": true,
  "data": {
    "case_id": "<server 產生的案號>",
    "query_key": "<本次建立時取得，請妥善保存>",
    "status": "pending"
  }
}
```

case_id 格式 `VP-YYYYMMDD-` 加 16 個安全隨機字元，避免 O／0／I／1；隨機尾碼為 80-bit，並有 D1 unique constraint。
query_key 是 server `crypto.getRandomValues()` 產生的 32 bytes（256-bit），轉 base64url 共 43 字元。
D1 只存 query_key 的 SHA-256，不存原文、可解密副本或回應 body。只在建案成功的 201 回傳；查詢不再回傳。

### GET /api/cases/:caseId?key=...

正確案號與 query key 才回 200。也接受 `X-Case-Query-Key` header，建議正式 client 優先使用 header，避免查詢碼進入 URL／瀏覽器 history／平台 request logs。
若 header 與 query 同時提供，兩者必須相同；重複 key 參數拒絕。

```json
{
  "ok": true,
  "data": {
    "case_id": "<案號>",
    "created_at": "<ISO timestamp>",
    "nickname": "訪客暱稱",
    "campaign_id": "YOUR_CAMPAIGN_ID",
    "vote_type": "Solo",
    "vote_date": "2026-10-08",
    "status": "pending",
    "points_awarded": 0,
    "files": [{ "content_type": "image/png", "size": 123456 }]
  }
}
```

不回 query_key／hash、player_id、note、member_id、reviewer、etag、原始檔名、內部 id、raw object key 或任何 URL。
query hash 使用 Workers 的 `crypto.subtle.timingSafeEqual` 比較；不存在案件用等長 dummy hash。
錯 key、缺 key、錯案號與不存在案件統一 404 `CASE_NOT_FOUND`／`Case not found`。
程式不記錄 query key、request URL、env、SQL error 原文或 R2 response。

### 錯誤

| HTTP | code | 說明 |
| --- | --- | --- |
| 400 | INVALID_JSON | JSON／Content-Type 不正確 |
| 400／413 | INVALID_CASE_REQUEST | 欄位或 body 限制不符 |
| 400 | INVALID_UPLOAD_REFERENCE | session／keys 非合法 staging reference，或與完成批次不同 |
| 400 | UPLOAD_NOT_COMPLETED | D1 沒有成功完成紀錄 |
| 400 | UPLOAD_INCOMPLETE | 完成後原件消失 |
| 400 | UPLOAD_VALIDATION_FAILED | 實際物件不符 B2 限制，並刪除無效 staging 物件 |
| 409 | UPLOAD_CHANGED | 完成後物件被覆寫，必須重新 prepare 新 session |
| 409 | UPLOAD_ALREADY_USED | session 已綁定另一案件 |
| 409 | UPLOAD_SESSION_CONFLICT | complete 嘗試改變既有完成 manifest |
| 400 | IDEMPOTENCY_NOT_SUPPORTED | B3 不接受 Idempotency-Key |
| 404 | CASE_NOT_FOUND | Guest 無法驗證案件 |
| 405 | METHOD_NOT_ALLOWED | collection 只允許 POST，item 只允許 GET |
| 503 | DB_NOT_CONFIGURED | 缺 DB binding |
| 503 | R2_UPLOAD_NOT_CONFIGURED | 缺必要 R2 binding 方法 |
| 500 | DATABASE_ERROR／R2_STORAGE_ERROR | D1／R2 失敗；不回內部錯誤 |

## 完成 upload 與案件的綁定

1. B2 prepare／直接 PUT／complete 的 request 和成功 response 維持不變。
2. 有 DB binding 時，complete 在所有 R2 HEAD 驗證通過後，以 D1 batch 保存實際 files 與 manifest hash；保存失敗不回成功。未綁定 DB 時仍提供原 B2 功能，這些完成結果不能直接建立 B3 案件，需在 DB 可用後重新 complete。
3. 相同 session／manifest 的 complete 可重試；manifest 不可被更改，已 consumption 的 session 不能重用。
4. 建案只讀 D1 記錄，拒絕 client 偽造 key 或自行聲稱上傳成功。
5. 以 R2 conditional GET（etagMatches）取得先前驗證的版本，重檢實際 size／MIME／etag，串流複製到 server 產生的 `proofs/cases/<internal_case_uuid>/<file_uuid>.<ext>`。
6. Browser 仍直接 PUT R2，圖片沒有經過 Worker request body。這一步是內部 R2-to-R2 archival，沒有對外讀取 URL。
7. 用單一 D1 batch 原子寫入案件、全部 case_files、consumption。guarded INSERT 與 unique session／source key constraints 確保並發也只能成功一次。
8. 成功後只清理該完成 session 的 staging keys；失敗清理本次產生的 archive keys，不掃 bucket 或其他案件。

R2 與 D1 沒有跨服務 transaction。若 D1 acknowledgement 不明，先從 D1 確認 consumption；無法確認時保留 private copies，避免誤刪可能已提交的證明。程序中斷或清理失敗可能留下 private orphan objects，需後續以 DB 參照做 reconciliation；不要對 `proofs/cases/` 套用 staging 的短期 lifecycle。
staging URL 仍可在 300 秒內重複 PUT，但只能覆寫 staging，無法改寫案件保存的副本。
original_name 留 NULL，因 B2 completion contract 沒有可信原始檔名。

## Retry／idempotency 的取捨

B3 不實作 Idempotency-Key 完整回應重放，也不用 in-memory Map。
原因是 query key 要只回傳一次、DB 只存 hash；完整重放原 201 會需要另存可復原 query key，或新增專用 Secret／衍生機制。
本階段以 D1 唯一約束與 consumption 提供持久化的「最多建案一次」保護。重送相同或不同 payload 使用同一完成 session，均回 409，不能產生第二案。
限制：若 client 遺失成功 201，無法重新取回 query key；前端正式接線時必須處理這個 UX，完整 idempotency／安全復原策略留待後續明確規格。

## 本機驗收

```sh
npm test
npm run test:smoke
npm run test:uploads-smoke
npm run test:cases-smoke
npx wrangler d1 migrations apply voteproof-cases --local
npx wrangler d1 migrations list voteproof-cases --local
npm run check
```

Cases tests 使用實際本機 workerd、D1／SQLite、R2；不是 SQL in-memory Map mock。
只有 test harness mock 官方 Siteverify，正式 Worker 沒有 bypass。
包括完整欄位驗證、Guest hash／資訊隔離、未完成 upload、偽造 key、覆寫、實際不符限制的刪除、並發 consumption、D1 強制失敗回滾、R2 partial failure cleanup 與 lost acknowledgement。
實際結果：保留所有 25 B1／86 B2 tests，新增 43 B3 tests，合計 154／154 通過；B1、B2、B3 smoke 均通過。
Wrangler `--local` 成功套用 0001_cases.sql（10 個 SQL commands），migration list 確認沒有待套用項目。
Wrangler dry-run 成功：42.85 KiB／gzip 11.72 KiB，DB／PROOFS_BUCKET／ASSETS 都保留。Production migrations 未執行。

## Cloudflare 手動 rollout（先驗收 B3，再由使用者操作）

1. 在包含 `voteproof`／`voteproof-proofs` 的 Cloudflare 帳戶，建立 D1 database，建議名稱 `voteproof-cases`。也可由你手動執行 `npx wrangler d1 create voteproof-cases`。
2. 將 `wrangler.jsonc` 的 DB database_id 全零 placeholder 改成真正 database UUID；`binding: DB`、database_name 與 migrations_dir 保持一致。全零只是本機 placeholder，絕不代表 Production DB 已建立。
3. 審核 migration 後，由你明確授權／手動執行：

```sh
npx wrangler d1 migrations apply voteproof-cases --remote
npx wrangler d1 migrations list voteproof-cases --remote
```

4. 再以正常發布流程部署 B3，確認 `DB` 指向這個已 migration 的 Production database。不要先部署指向不存在 database 的 placeholder。
5. 保留 `keep_vars: true`、ASSETS、PROOFS_BUCKET、Turnstile／R2／Google 原有 vars與 secrets。B3 不新增 Secret，也不需要建立新的 R2 token；bucket 繼續 private。
6. 在 request logging／observability 設定中避免保存 query string 的 Guest key；建議所有正式 client 使用 `X-Case-Query-Key`。程式本身沒有敏感 logging，不代表瀏覽器 history 或平台 logs 必然不保存 URL。
7. 以正常 Turnstile 跑 prepare → direct PUT → complete → cases 201 → 正確／錯誤 Guest key → 重複 consumption 409，再驗收 B1/B2。不要把 query key、signed URL 或 Secret 貼进聊天。

## 後續 TODO

- B4/B5 前建立正式 Campaign source；目前只驗格式、長度，不 hardcode 正式活動或建假 campaign DB。
- MIME metadata 驗證不等於完整圖片解碼／內容掃描；沒有新增解碼或掃描功能。
- 正式 frontend 接線、一次性 query key UX、完善 idempotency／復原、orphan reconciliation 與 retention，需後續規格；本次不開始 B4。

參考：[D1 batch](https://developers.cloudflare.com/d1/worker-api/d1-database/)、[D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)、[R2 conditional operations](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[Workers timingSafeEqual](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)。
