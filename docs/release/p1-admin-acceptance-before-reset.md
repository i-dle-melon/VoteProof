# VoteProof｜P1 管理後台功能實際 Production 發布與正式開站資料清理前驗收

## 授權界線

Operator 已授權將「會員管理總覽 V1」與「系統健康監控 V1」完成並部署 Production，先利用**既存測試資料**驗收。
**未授權現階段刪除任何 D1 會員、投稿、積分、R2 物件或 Google Drive 圖片。**
目前 R2 自動清理維持 OFF；Dispatch9 與舊 DELETE 未知 ACK 保留未解除狀態。不能自行提交無證據的 legacy attestation。

## 發布前需全部符合

1. 基於 `codex/leaderboard-v1-release-20261022` 已驗證的 `a2b229351face524a8fba36a16ca34532f822542`，新候選分支精確 SHA 的 7/7 Branch Validation PASS。
2. 已驗證 `0031_admin_insights_indexes.sql` 為純新增索引；本地從 0028 舊 Schema 順序套用 0029、0030、0031，foreign_key_check/quick_check PASS，資料不被清除。
3. 先唯讀檢查 Production Worker 實際版本、D1 已套用 migration、投稿 gate、R2 清理與備份排程。
4. 評估舊 Worker DELETE/Write Pin 與備份活動的安全隔離；資料留存驗收不需要捏造舊 ACK 的成功結果，也不能開啟新盤點或 Cleanup。
5. 確保有受控且限制存取的復原點；若不能驗證 Production 的安全切換與部署條件，停止 Production 操作。

## 上線順序（需具 Production 寫入權限的 Operator/Work 才能操作）

1. 核准維護時段，嚴格控管新寫入，處理後續備份/匯出與舊程式進行中的請求；切勿以僅等待固定時間代替安全隔離。
2. 檢查並以正常 Wrangler Production migration 流程按序套用 0029、0030、0031；不能跳過 0029/0030 或重新執行已套用的 migration。
3. 使用 Production Workflow 的受保護 `workflow_dispatch` 發布精確候選 SHA；原工作流只部署 Worker/內含靜態資產，不會替你執行 Migration。
4. 如目前公開網頁仍由 GitHub Pages 提供，使用 Pages Workflow 的精確 SHA 手動發布，避免前端新版 API 配到舊 Worker。
5. 確認公開 `/api/health`、`/api/submissions/status`，以及實際 admin/super_admin MFA 登入後的兩個管理分頁。
6. 不啟用 R2 Cleanup，不執行未授權 Reconcile、Drive 刪除或資料重置；驗收期間保留舊會員、圖片、積分、審核與歷史排行榜。

## 用舊資料的驗收清單

- 會員列表每次最多 20 位；粉絲 ID 精確搜尋、暱稱前綴搜尋、正常／封鎖篩選、游標下一頁，登入/會員身分/封鎖狀態不變。
- 選一位有歷史投稿與積分的測試會員，核對列表、會員等級、積分、狀態及案件紀錄，確認**確實讀出舊資料**。
- 會員詳細頁才顯示登入方式；已驗證 Email 只能透過原有受稽核查詢，列表不會帶出 Email、Token、Hash 或加密欄位。
- 封鎖／恢復、手動積分、聯絡會員使用既有安全流程；若需要操作驗收，僅對事先授權的測試帳號操作並留下稽核。
- 健康摘要、異常類型、處理狀態、台灣日期區間、每頁最多 20 筆；沒有來源的上傳失敗數顯示「資料不完整」，絕非 0。
- 60 秒刷新只在管理員開頁、勾選後且分頁可見時觸發；退出即停止。所有新 GET 不得觸發 R2 List、Delete、Google Drive Verify、Reconcile 或郵件。
- 比對 Cloudflare Worker CPU、D1 Rows Read／Written 及 R2 操作量；不能只靠本機效能推估。驗收中已有異常時，保留記錄及處理前後證據。
- 只有成功確認 Worker/Pages 新版本、路由、會員舊資料與安全/資源指標後，才算 P1 Production 功能驗收完成。

## 下一階段：正式公開前重置（此次**不執行**）

待 Operator 明確確認兩個新頁面在 Production 使用舊測試資料驗收通過，另行啟動
**Pre-Launch Reset**：保留會員身分、粉絲 ID、暱稱、密碼/Google/MFA、管理員權限及站台設定；
清除會員與匿名測試投稿、積分、等級進度、排行榜成績及 R2/Drive 對應的測試圖片與作業索引。
要另作逐表 FK/Trigger/immutable-ledger 相容清理，建立可恢復點、完成安全隔離、檢查 R2/Drive 真實刪除終態；
不能把 0030 的 `legacy_status='unknown'` 強制當作 PASS。

**禁止用本 Runbook 當作已取得「正式資料刪除」授權的依據。**
