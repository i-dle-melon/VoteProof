# B6A-Free：公開網站與 Guest 投稿

狀態：本機完成，未 push／deploy／remote migration。第一版固定成本 $0／月，不要求 Workers Paid 或付費第三方。B4.x auth／B5 backend 保留；B4.x 凍結且不上 Production；本階段無 Member／Admin UI，不進 B6B。

## 架構與畫面

`public/index.html` 是 static shell，`css/app.css` 延續深色 #121212、亮綠、cards、手機 bottom navigation；淺色使用 #5E0E8B。沒有 framework、SSR 或 build pipeline。`js/app.js` 負責呈現／hash navigation，`api.js` 負責公開 API 與 R2 PUT，`submission.js` 管理投稿 context，`turnstile.js` 延遲載入官方 widget。`_headers` 只套用 static assets 的 CSP／no-referrer／nosniff 等 headers；API 自己的 no-store 規則不變。

首頁：用途、快速投稿／查詢／排行榜 CTA、三步驟、開放中的 Campaign、基本公開說明。Navigation 僅首頁／快速投稿／案件查詢／排行榜，說明從頁尾進入。移除舊示範案件、假排行榜與未實作的登入入口，不改後端商業規則。

## API 使用

| 畫面／動作 | 既有 endpoint | 語意 |
| --- | --- | --- |
| 首頁／活動選單 | `GET /api/campaigns` | 使用 server 提供的開放中活動，沒有 hardcoded ID 或示範 fallback |
| 上傳準備 | `POST /api/uploads/prepare` | 正常 Turnstile token 與檔案 metadata |
| 圖片傳輸 | 短效 presigned `PUT` 至 R2 | 精確 Content-Type；圖片不經 Worker request body |
| 上傳完成 | `POST /api/uploads/complete` | server HEAD／manifest 驗證 |
| 建案 | `POST /api/cases` | B3 Guest body 與 Idempotency-Key，成功仍為 HTTP 201 |
| 案件查詢 | `GET /api/cases/:caseId?key=...` | 保留 B3 query credential／enumeration protection |
| 排行榜 | `GET /api/leaderboards`、`?id=...` | 沿用 `data.leaderboards[].rankings` shape，不自行計算排名 |

所有 API fetch 使用 `credentials: omit`，不呼叫 auth／me／admin endpoint；既有 Member cookie 不會將快速投稿轉為 Member case。伺服器仍是 validation、authorization 與 source of truth。

沒有 active Campaign 時顯示「目前沒有開放中的投票活動」，停用投稿並提供重新載入。顯示投票期間／活動時區；server 決定日期是否有效。沒有公開 leaderboard 時顯示 empty state；列表／detail 都只使用公開 API，無 member N+1、tier 猜測或本機計分。

## Guest 上傳與重試

支援多張選擇、object URL preview、單張移除、逐張上傳進度、loading／disabled／中文 error。PNG／JPEG／WebP，1～5 張，每張 >0 且 ≤5 MiB，整批 ≤25 MiB。前端只提前提示；complete 實際 HEAD 檢查仍是安全邊界。原專案未整合 compression；第一版保留原圖，不新增 Worker resize／decode 或改動圖片證據。

每次 start 產生 32-byte secure random Idempotency-Key，固定 trimmed metadata／files。送出中共用同一 promise，避免雙擊。prepare／PUT／complete 使用既有 contract；PUT 只傳 signed MIME，XHR 顯示真實 upload progress。未到期的部分上傳重試跳過已成功的圖片；grant 到期且尚未嘗試建案時可重新驗證／prepare。這可能留下 staging orphan，仍由既有暫存政策／未來 reconciliation 處理，不新增排程。

建案前只序列化一次 body，固定 upload reference。建案網路失敗（包含 server 已建案但 browser 遺失 201）重送**同一 body 與 key**，不重新上傳、不重新產生 key。Replay 作為同一成功案件。成功或使用者明確確認放棄才結束 context；失敗時欄位鎖定並保留重試／放棄選項。

Context 僅保留分頁記憶體，不寫 credential 至 localStorage／sessionStorage／analytics／console。未完成時 beforeunload 提醒，但瀏覽器關閉或重新整理會失去 context；第一版不提供跨 reload 恢復。查詢碼也不長期保存，成功頁醒目提醒自行保存，提供複製案件編號／查詢碼／全部三個按鈕。複製全部格式：

```text
VoteProof
案件編號：<case_id>
查詢碼：<query_key>
```

案件／查詢碼不寫入頁面的 shareable URL。依 B3 contract，查詢請求的 network URL 仍包含 key；no-referrer、no-store 與不使用 analytics 避免應用層擴散。沒有把 R2 key／URL 或完整 response 寫入頁面或 log。

## 查詢與公開資料

輸入 case ID／query key，僅顯示 case_id、建立時間、活動、vote_type、vote_date、中文 status。若活動不在目前 active list，以案件原 campaign_id 顯示，不虛構名稱。錯 key／不存在回同一一般訊息。查詢中停用輸入與按鈕，失敗後可重試。

狀態：pending 待審核、approved 已通過、completed 已完成、rejected 未通過、duplicate 重複投稿、revoked 已撤銷。

排行榜只顯示 server rank、nickname、points、proof_count；保留 server row order。Public result 尚未提供 tier metadata，因此無徽章。所有 API 字串透過 textContent／DOM nodes 呈現，不插入 HTML。

## Accessibility／安全隔離

真正 label、keyboard／skip link、focus-visible、aria-live／alert、可讀取的 progress、loading、非單靠顏色的錯誤、主要至少 48px touch target。320px 版面測試不橫向溢出；主按鈕兩種 theme 文字對比 ≥4.5。Theme 立即切換，避免文字／背景 transition 造成瞬間低對比。只有 theme preference 可寫 localStorage。

Public Turnstile Site Key 是公開設定，可放 HTML；widget 只在投稿需要時載入官方 script，小寬度採 compact。Production Secret 不進 frontend。Test fixture 的 Siteverify／S3 模擬只存在 developer harness，不提供任何 Production bypass。

Unset 全部 B4 auth 設定的本機驗證：public／Guest 正常；login fail closed（503），未登入 current-member 拒絕（401），不造成全站 500。沒有新增 feature flag、改 KDF、刪 auth code 或依賴會員登入。

## Free-plan 性能與成本邊界

HTML／CSS／JS 走 Assets；首頁僅一次 Campaign API，排行榜與 Turnstile 延遲載入。無 SSR、Worker 圖片處理、KDF、背景任務、第三方付費服務或 production frontend dependency。靜態檔約 53KB（逐檔 gzip 約19KB）；JS 編譯檢查 gzip 約8KB，實際採原生 modules，不要求 bundler。

免費額度不是無限承諾：R2 Standard 目前 free allowance 有每月 storage／operations 限額，超額可能計費；D1 Free 超過每日 read／write 或 storage limit 會拒絕操作。需之後用量監測與 Production Guest path CPU 驗收，不能以本機 smoke 推論 Free Production 全負載通過。

官方資料：[R2 pricing](https://developers.cloudflare.com/r2/pricing/)、[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)、[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、[Assets headers](https://developers.cloudflare.com/workers/static-assets/headers/)、[Turnstile widget](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/)。

## 本機驗收

`npm test`：528／528（保留原502＋26 frontend unit／integration）。`npm run test:frontend`：75／75，25項×Desktop Chrome／Android Chrome emulation／iPhone WebKit emulation；實體 iPhone／Android 尚待驗收。沒有把 performance assertions 混入 npm test。

八套 backend smoke：B1、B2、B3、B4.x、B5A、B5B、B5C、B5D。`test:frontend-smoke` 使用真實 disposable workerd／D1／R2、瀏覽器 UI 與 signed PUT 驗證，故意丟棄首次 HTTP 201 後 replay，DB 僅一件 Guest case、兩張 case_files、一次 consumption／idempotency record，成功 query；只有外部 Turnstile／S3 transport 由測試 harness 模擬。

`check:admin-schema`：空 local DB migration 0001～0007、foreign_key_check／quick_check。`check`：Wrangler dry-run。`check:public-assets`：精確檢查7個 public 檔案、module graph／編譯、敏感 literals／logs／非公開 endpoint／storage，確認 benchmark／DB／fixtures／auth artifacts 不進 Assets。B1 Wrangler HTTP smoke 亦檢查實際 static bytes、security headers 與 developer artifact 404。

Browser test artifacts／安全首頁 preview 存 ignored `.wrangler/`；不記錄成功頁 credential screenshot、trace 或 video。不執行任何 Production migration、fixture insert、Dashboard 設定或 rollout。

## 後續 TODO（本階段不執行）

- 實體 iPhone Safari／Android Chrome、真實 Production Turnstile hostname／R2 CORS 與直接 PUT 驗收。
- 明確批准 B5 migration、正式 Campaign／公開 snapshot 設定、Apps Script→D1 切源與 B4 route 發布隔離；目前不切 Production traffic。
- Free quota／Guest API CPU 與流量觀測、staging orphan lifecycle／reconciliation。圖片 compression 與跨 reload 恢復需獨立產品決策。
- B6B admin UI／符合 $0 fixed cost 的 admin auth 另外評估；目前不以 scrypt 密碼 auth 為發布必要條件。
