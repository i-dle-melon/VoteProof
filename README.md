# VoteProof API

## B4 Member identity（僅本機，未發布）

Email OTP、D1 members/challenges/sessions/rate limits、HttpOnly cookies／CSRF、profile 與 owner-only cases API，見 [docs/b4-members.md](docs/b4-members.md)。
`0003_member_identity.sql` 只在本機 apply；新 Secrets 為 `AUTH_SECRET`／`AUTH_EMAIL_API_KEY`，Variables 為 `AUTH_ORIGIN`／`AUTH_EMAIL_FROM`，Production 必須由使用者手動設定。
`npm run test:auth-smoke` 使用 disposable local workerd/D1/R2 與 mock email，沒有寄送真實郵件或 Production bypass。
首頁保持原樣，會員按鈕仍為原有示範；本次會員身份功能由 API 提供，Guest flow 與 B3 query key 保留，不做管理員後台／積分／排行榜改寫，不自行 push 或 deploy。

## B3 既有基礎

D1 Guest 案件、upload consumption、私人 R2 archival、query key、migration 與手動 rollout，見 [docs/b3-cases.md](docs/b3-cases.md)。
新增 `POST /api/cases` 與 `GET /api/cases/:caseId`；`npm run test:cases-smoke` 在本機 workerd/D1/R2 驗證案件流程。
`DB` 已綁定既有 Production D1 `voteproof-cases`；0001/0002 與 B3/B3.1 已通過 Production 驗收。B4 不修改既有 binding，也不自行 apply remote migration。
首頁與所有現有 B1/B2/Guest 功能保留。

B3.1 本機收尾加入持久化 `Idempotency-Key`，相同 normalized request 可重取原 HTTP 201、case_id 與 query credential；不同 payload 回 409。
需另外手動設定專用 Worker Secret `CASE_QUERY_KEY_SECRET`（獨立安全隨機 32 bytes／64 字元 hex），不得重用 Turnstile／R2 secrets、提交 Git 或貼入聊天。
新增 `0002_case_idempotency.sql`，未使用的 completed upload 固定 24 小時到期；成功 replay 不受 upload TTL 影響。R2 copy／D1 已知失敗會立即 best-effort cleanup，安全摘要不包含 keys 或錯誤原文。
Schema、Secret 維護限制、replay contract 與清理例外，詳見上述 B3 文件。本次不 push／部署／建立 Production D1／執行 remote migration。

## B2 本機開發

B2 私人 R2 上傳的 contract、Production 變數／secrets、CORS 與 lifecycle 說明見 [docs/b2-uploads.md](docs/b2-uploads.md)。
新增正式依賴 `aws4fetch`，所有 Production 憑證仍只由使用者在 Cloudflare 設定；不寫入 Git 或聊天。
既有 `npm test` 保留全部 B1 測試並加入 B2 測試；`npm run test:uploads-smoke` 使用本機 workerd/R2，不操作 Production 或提供 Production bypass。
Git deployment 後的逐步 Production 驗收、正常 Turnstile／PUT／到期與 staging 清理，見 [docs/b2-production-acceptance.md](docs/b2-production-acceptance.md)。

以下為原有 B1 的實作與驗收紀錄。

本次以 `i-dle-melon/VoteProof` 的 main commit `37c4583` 為基礎，檢查了 repository 內原有的全部四個檔案。
`public/index.html` 保持原樣；`wrangler.jsonc` 僅新增頂層 `keep_vars: true`。既有視覺、前端示範功能、Assets 路由及私有 R2 binding 全部保留。

## API contract

所有 `/api/*` 由 Worker 回傳 JSON，其他請求沿用 `env.ASSETS.fetch(request)`。
已知 endpoint 只接受 GET，其他 method 回傳 405、`METHOD_NOT_ALLOWED`、`Allow: GET`；未知 API 回傳 404、`NOT_FOUND`。

| Endpoint | 結果 | Cache-Control |
| --- | --- | --- |
| `GET /api/health` | 200，`{ "ok": true, "data": { "service": "VoteProof API", "status": "ok", "version": "b1" } }` | `no-store` |
| `GET /api/campaigns` | 200，`{ "ok": true, "data": { "campaigns": [] } }` | `no-store` |
| `GET /api/leaderboards` | 200，`data.generated_at`、`data.leaderboards` | `public, max-age=30` |
| `GET /api/leaderboards?id=LB-SOLO` | 將 id 安全轉送 Google Public API，並只回傳該排行榜；查無資料為空陣列 | `public, max-age=30` |
| `GET /api/unknown` | 404，`{ "ok": false, "error": { "code": "NOT_FOUND", "message": "API endpoint not found" } }` | `no-store` |

所有 API 的 Content-Type 均為 `application/json; charset=utf-8`。
排行榜尚未設定上游網址時為 503、`UPSTREAM_NOT_CONFIGURED`。
上游連線失敗、8 秒逾時、HTTP error、HTML／非 JSON、格式錯誤或 `ok: false` 均為 502、`UPSTREAM_ERROR`，不快取錯誤。
逾時包含讀取回應內容。程式只取公開排行榜欄位，不回傳上游額外欄位或錯誤原文。

## 檔案修改

- `src/index.js`：轉交 API router，其他請求維持原本 Assets 邏輯。
- `src/api/router.js`：三個 endpoint 路由、405／404／500 JSON 錯誤。
- `src/api/response.js`：統一成功與錯誤格式、Content-Type、快取 headers。
- `src/api/health.js`：獨立 health 回應，不存取外部服務或 env bindings。
- `src/api/campaigns.js`：空的 campaign contract 與指定 B2/B3 TODO。
- `src/api/leaderboards.js`：env 上游網址、URLSearchParams、ID 過濾、公開欄位整理、8 秒 AbortController、502／503 與短快取。
- `wrangler.jsonc`：新增 `keep_vars: true`，自動部署時保留 Dashboard 設定的變數，原有 bindings 不變。
- `package.json`：ES modules 及本機開發、測試、dry-run 指令。
- `package-lock.json`：固定本次安裝的開發相依版本，支援 `npm ci`。
- `.gitignore`：排除套件、本機 Wrangler 狀態、`.dev.vars*` 與 `.env*`。
- `test/api.test.js`：25 項 API 與 Assets 自動測試。
- `scripts/smoke.mjs`：Wrangler/workerd 實際 HTTP 驗收，使用本機上游測試伺服器，自動停止測試程序。
- `README.md`：API、Cloudflare 設定、驗收與剩餘工作說明。

## Environment variable 與 Cloudflare 手動設定

新增程式支援 `env.GOOGLE_PUBLIC_API_URL`，沒有將正式網址或任何 secret 寫入 repository，沒有在 `wrangler.jsonc` 填入真實值。

1. 將審閱後的 B1 程式碼部署至原有的 `voteproof` Worker。
2. 在 Cloudflare Workers & Pages → `voteproof` → Settings → Variables and Secrets 新增 `GOOGLE_PUBLIC_API_URL`，值為既有 Google Apps Script Public API 的部署網址。請在 Cloudflare 填入，不要提交到 Git。
3. 儲存／Deploy 設定後，驗收 `/api/leaderboards` 與 `/api/leaderboards?id=LB-SOLO`。

`wrangler.jsonc` 已設定 `keep_vars: true`，Wrangler CLI 與 GitHub / Cloudflare Builds 使用此設定部署時會保留 Dashboard vars；不要以 `--keep-vars=false` 覆蓋此設定。
B1 開發驗證僅執行本機測試與 `--dry-run`，不直接部署到 production 或修改遠端 Cloudflare Dashboard。

`TURNSTILE_SECRET_KEY` 及 `PROOFS_BUCKET` 本階段未被程式使用。原有 secret 與私有 R2 binding 不需調整；沒有新增 R2 公開 URL。

## 本機驗收

需要 Node.js 22 以上。

```sh
npm ci
npm test
npm run test:smoke
npm run check
```

本次驗收結果：

- `npm test`：25 項全數通過，含完整 JSON／headers、缺少設定、ID query 安全組合、欄位整理、網路失敗、HTML／JSON／schema 錯誤、8 秒 fetch／response-body 逾時、405、未知 API 404、Assets 原 request／response 保留。
- `npm run test:smoke`：在本機 Wrangler/workerd 實際發出 HTTP 請求，health 200、campaigns 200、未設定上游的 leaderboards 503、unknown 404；設定本機上游後 leaderboards 200、LB-SOLO 200、上游 HTTP error／HTML error／實際 8 秒逾時均為 JSON 502。
- `/` 與 `/index.html`：Wrangler 回傳 200，內容 bytes 與原有 `public/index.html` 完全一致；不存在的靜態檔案仍由 Assets 回傳 404。原 repository 只有首頁這一個靜態檔案，其他靜態路徑的轉送另有自動測試覆蓋。
- `npm run check`：Wrangler dry-run 打包成功，仍包含原有 Assets 與 `PROOFS_BUCKET` bindings；未上傳 Worker。

Google Apps Script 正式網址尚未提供，所以正式 Google 連線與 production 部署後驗收尚未完成。
本機成功回應使用明確的測試 fixture，不是正式排行榜驗證。

## TODO 與範圍

唯一後續程式 TODO 為 `TODO B2/B3: connect production campaign source`。
B1 暫停於此，等待使用者確認後再做 B2。
本次沒有新增登入、註冊、圖片／R2 上傳、Turnstile、Cases POST、點數寫入、管理員 API 或資料庫，也沒有將 API 接到既有 frontend。
