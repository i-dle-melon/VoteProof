# VoteProof API

## 現行方向：B6A-Free Guest / Public first（本機，未發布）

第一版以 **固定成本 $0／月** 為硬性設計前提，使用 Cloudflare Free tier 與 R2／D1 free allowance；不要求 Workers Paid、付費第三方、密碼登入或 Admin auth 才能發布公開網站。這不是無限免費：R2 超過免費額度可能計費；D1 Free 超過每日讀寫或儲存限制會拒絕操作，需監測用量。

B4.x 密碼／TOTP／Trusted Device／Recovery Codes 保留為凍結的本機可選功能，安全 scrypt 參數不降級，也不作為第一版 Production 前提。以下 B1～B5 文件是各階段紀錄；目前發布方向以本節與 [B6A-Free 文件](docs/b6a-free-frontend.md) 為準。

公開前端改為 Cloudflare Assets 提供的 HTML／CSS／ES modules：首頁、Guest 投稿與查詢、API Campaign、公開排行榜、深／淺色及說明。沒有 Member／Admin UI、SSR、Worker 圖片處理或新增 Production binding；B4/B5 後端保留。

```sh
npm test
npm run test:frontend
npm run test:frontend-smoke
npm run check:public-assets
npm run check
```

瀏覽器測試使用本機 Chrome 與 Playwright WebKit；需安裝 Chrome 並執行 `npx playwright install webkit`。Android／iPhone 採裝置模擬，實機驗收另列 TODO。測試、benchmark、DB、截圖與 fixture 都在 `public/` 外。

B6A 只完成本機驗收與 commit；不 push／deploy／remote migration，不進 B6B。正式切換前仍需明確批准 B5 migration／D1 Campaign 與 leaderboard source rollout，並驗收真實 Turnstile、R2 CORS 與 Free 用量；目前不執行這些操作。

## B5D Member Tier（本機 checkpoint，未發布）

固定八階 identity 與 dynamic ledger-net tier/progress 已實作，見 [B5D 文件](docs/b5d-member-tiers.md)。0007 只設定普通0，其餘七階門檻null/disabled，等待明確批准；未完成設定時points API回普通與ready=false。
Member/Admin points保留total_points並新增tier/progress；等級不改RBAC、獎勵倍率或leaderboard排名。只做本機，B4.x auth僅本機，未push/deploy/remote migrate，無frontend/正式徽章。

## B5C D1 Leaderboard（本機 checkpoint，未發布）

D1 leaderboard backend 已實作：以 append-only point_transactions 為唯一點數來源，原子 rebuild/publish、deterministic ranking、公開 snapshot API 與 admin RBAC。完整 schema、reached_at、scope、B1 contract 與切源差異見 [B5C 文件](docs/b5c-leaderboards.md)。

只做本機；B4.x auth僅本機，未 push/deploy/remote migrate。Production Apps Script 舊來源未切換。


## B5B Campaign／Point Ledger（本機 checkpoint，未發布）

正式 D1 Campaign、append-only Point Ledger、member/campaign/vote_date daily limit、atomic approve/revoke/audit、idempotent manual adjustments 與 ledger SUM，見 [docs/b5b-campaign-points.md](docs/b5b-campaign-points.md)。
新增 0005；0001..0004 未改。`test:points-smoke` 驗證流程，`check:admin-schema` 從空 local DB 驗證 0001..0005。
Campaign timezone 固定、closed 不接受新投稿，Guest 永遠零分；不重算歷史交易，不寫 Google Sheets，不做 B5C leaderboard。
B4.x auth已在本機完成，B4/B5 不 remote migrate／push／deploy，首頁保持原樣。

## B5A 管理員授權／案件審核（僅本機，未發布）

B4.x會員身份方案見下方最終auth。B5A 只依賴已驗證的 VoteProof session/member，不引用登入 provider 或 email 作授權。
新增 RBAC、私人 proof stream、版本衝突檢查與 append-only audit，詳見 [docs/b5a-admin-review.md](docs/b5a-admin-review.md)。
`0004_admin_review.sql` 只在本機驗證；無 Production admin／remote migration，無首頁改動或Production操作。`npm run test:admin-smoke` 使用 disposable local fixtures。
尚未 push／deploy，不進 B5B 積分／Campaign 或 B6；B4.x 最終auth僅本機。

## B4.x final Member auth（本機，未發布）

帳號＋密碼、強制Authenticator TOTP、Trusted Device、Remember Me、Recovery Codes已替換舊未發布auth。完整schema/API/KDF實測/Secret/CSRF/TTL/rotation限制見 [B4.x文件](docs/b4-members.md)。
0003重寫為最終auth；0001/0002及0004..0007保持原樣，舊local auth DB需要新的空persist目錄。Session/member/cases/Guest契約保留，所有admin API新增1小時MFA elevation。
手動Secrets為AUTH_SECRET、AUTH_PASSWORD_PEPPER、AUTH_TOTP_ENCRYPTION_KEY；Variable為AUTH_ORIGIN。強scrypt需要Workers Paid/適當CPU預算，發布前需Productionload驗收。
`test:auth-smoke`執行真實local workerd/D1/password/TOTP流程，`benchmark:auth-kdf`只輸出成本。沒有Production bypass；首頁完全不變，沒有frontend、push/deploy/remote migration。

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
