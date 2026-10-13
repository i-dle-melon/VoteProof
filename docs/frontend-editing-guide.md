# VoteProof 前端修改指南

正式頁面與 UI 預覽共用 `public/`，沒有另一份需要同步的 HTML。

## 改文字

1. 在 GitHub 開啟 `public/index.html`，按鉛筆。
2. 搜尋你想改的中文，依 `HOME`、`LOGIN`、`MEMBER` 等區塊註解找到位置。
3. 修改標題、說明或按鈕文字；完整卡片只能在同一授權容器內移動，請勿拆開表單，或將會員／管理區移到公開區。
4. **不要改 `DO NOT CHANGE` 標示的 id、data-*、name、表單限制、hidden 或 script src。** 不要刪除 API 容器、Turnstile／安全流程掛點。
5. 按 Commit。若測試指出 DOM hook 遺失，恢復原屬性，不要改測試清單來跳過檢查。

管理頁文字集中在 HTML 最下方 `ADMIN EDITABLE COPY` 的 `<template>`；修改 span 裡的中文即可，保留 span id。動態表格、表單欄位與安全確認仍由 JS 建立。提示錯誤、登入步驟、計分規則等依狀態變動的文字不屬於一般靜態文案。

## 改顏色、間距與版型

開啟 `public/css/app.css`，先看頂部「常用 UI 修改區」：

- `--bg` 背景、`--card` 卡片、`--text` 文字、`--primary` 主色、`--line` 邊線。
- `--radius` 圓角、`--sidebar-width` 側欄、`--content-width` 內容寬、`--page-padding` 桌面間距。
- 淺色顏色在緊接的 `html[data-theme="light"]` 區塊；手機規則在各功能的 `MOBILE` 區塊。

修改後 Commit。保留 `[hidden]`、`.sr-only`、focus、disabled／inert 與 safe-area 規則；不要用 CSS 強制顯示管理入口或啟用投稿。

## 手機預覽

等待 Actions → **VoteProof UI Preview** 成功，在該次 Pages deployment 開啟預覽網址。必須看見 **「UI PREVIEW · 非正式網站」**。

Pages 是公開的視覺預覽，只保留首頁、投稿暫停版型、案件查詢、排行榜、登入外觀與說明。活動標示非正式資料；排行榜與案件不使用正式資料。登入、投稿不執行，也不會連線正式 API。

會員中心依本人 API 資料顯示點數、目前等級與一張對應圖案，不展示完整等級清單。升級進度只使用 API 選出的下一個啟用等級與有效門檻；未設定時顯示「升級門檻尚未設定」，已達最高啟用等級時不顯示進度條。日後在管理後台設定門檻，會員重新載入便會反映真實進度。八級清單與管理功能只在正式網站「管理後台 → 會員等級」顯示，依既有管理授權檢查；Pages 產物不包含會員頁、等級圖案與其程式檔。

投稿一次可選最多 20 張 PNG／JPEG／WebP，每張上限 5 MiB。一張圖片各自上傳、建立一個案件，獨立審核並由既有活動規則計分；批次不是共用計分案件。逐張狀態與成功案件的查詢資訊會顯示在頁面。部分失敗時按重試只處理未成功項目，已收到成功結果的案件不會重送；回應中斷則沿用該張的原請求與冪等鍵。請保持分頁開啟並保存成功案件資訊，重試狀態僅存在記憶體，重新整理或關閉分頁不會保留。本次改動不新增 API 或更改既有歷史案件，每個新的上傳請求只含一張圖；後端仍負責投稿開關、活動資格、會員身份與點數交易。

建置時會從同一份 `public/` 移除會員管理、安全驗證、TOTP／復原、審核與管理介面、管理文案 template，以及相關程式檔。`?ui=admin#admin` 也無法顯示管理頁；這不是用前端登入假裝授權。完整管理與安全畫面只在正式網站經既有授權驗證後使用，私人 Staging 另行處理。

本機也可執行 `npm ci` → `npm run dev:preview`，開啟 `http://127.0.0.1:4174/VoteProof/`；Ctrl+C 關閉。產出位於 gitignored `.wrangler/pages-preview/`，請勿修改產出；回到 `public/` 修改再重啟即可。

## 正式發布（只在確認後手動執行）

1. 確認手機與桌面預覽，複製該次 main commit 的完整 40 字元 SHA。
2. Actions → **VoteProof Production Deploy** → Run workflow，選 main，填 `approved_sha`。
3. 工作流程檢查 exact SHA、DOM hooks、單元／前端／三種瀏覽器、敏感值及 Wrangler dry-run；任一失敗都不部署。
4. 經 `production` environment gate 後，只部署該份 Worker 一次。輸出會列明 commit SHA。
5. 部署不會執行 migrations、不改 D1/R2、不切投稿開關。發布後仍要確認正式 health、登入與投稿狀態；Production submissions 保持原本設定。

## 發布設定

- 將這次 commit 推上 main 後，Repository Settings → Pages → Source 選 **GitHub Actions**。目前沒有其他追蹤中的 Pages workflow；若 GitHub 端另有舊 branch publishing，改為 Actions，避免發布舊 HTML。
- 在 GitHub `production` environment 設定 `CLOUDFLARE_API_TOKEN`、`CLOUDFLARE_ACCOUNT_ID`，只放 GitHub Secrets；使用限定 VoteProof 帳戶的 Worker 部署權限，不授予 D1/R2 資料寫入權。依帳戶需要的綁定 metadata 讀取權限設定，首次執行若權限不足應停止，不要擴成管理員 token。
- 建議限制 `production` environment 只允許 main，並設定部署審核（依 GitHub 帳戶方案可用能力）。
- Cloudflare 原有 Git 自動部署必須保持停用；Pages push 與 Production 手動部署互相獨立。
- Pages 預覽網址為 `https://i-dle-melon.github.io/VoteProof/`；每次確認 Actions 的實際 deployment 對應你要發布的 commit。

## 千萬不要為了改 UI 修改

JS auth/security、API endpoint、migrations、secrets、Wrangler bindings、`public/_headers`、DOM hook 測試清單。不要把活動名、會員身份、分數、等級門檻或審核狀態硬寫進動態容器。

可選：本機 `npm run format:frontend` 整理 HTML/CSS 排版；它不改功能 JS。

流程依 [GitHub Pages 官方文件](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages) 與 [Cloudflare GitHub Actions 部署文件](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)；認證值不應加入 Git 或前端。

## 重設計前的契約基線（2026-10-13）

先讀 [frontend-contract-freeze.md](frontend-contract-freeze.md)，再執行
`node scripts/audit-frontend-contracts.mjs`；完整 DOM／data／form／JS／test selector、copy、token
清單在 ignored `.wrangler/frontend-contracts/`。固定 IDs 與 fixture hooks MUST PRESERVE；
動態 view-/admin-field-/security hook 改名必須同步 JS，不能只改 HTML。
class 是否 CSS-only 要以 inventory 的 JS／test 使用位置複核。

每次改版驗證 `npm run check:frontend-hooks`、frontend unit、全部三 browser；mobile 至少
320、375、390、430、768，dark/light 都測。建立本機 fixture server 後可跑
`node scripts/audit-frontend-mobile.mjs`，實測 overflow／labels／tap targets／contrast candidates。
fixtures 是合成 API，不代表真實會員或 Production 授權驗收。focus-visible、heading order、
dialog return-focus／Escape、form error association 必須另查 keyboard workflow。

公開 Pages allowlist 只包含 public preview 檔；新的 admin-duplicate.js 也不進 Pages。
不要把 Admin 頁開放到 Pages 或設定 Production API base URL：Pages 沒有同站 session／CSRF／
Origin 授權，且是公開產物，不能包含 private proof、member、MFA 或 relay secret。
Preview 的 connect-src none 與非正式標記保留。檢查 build output，不只相信隱藏 UI。

目前 Production 91e0a70 的 Drive transport 是 Apps Script pull；Worker Cron=0。
核准排程 rollout 的 enable flag 需 true，但不需要舊 Google OAuth credentials。
後續 deploy 應先讀真實 Worker bindings／旗標／queue，保留該已批准配置；checked-in disabled
default 不等於當前 Production 值。不要讓前端 release 重設備份開關或收件 OFF。
本次 source release 沿用既有一次性手動 Wrangler 路徑，未呼叫 Production workflow_dispatch；
下一次發布應在 review 時選定既有入口並驗證 exact SHA、migrations（另批准）、保留 bindings。

Rollback 必須使用已確認的完整 Worker version/source，保留 D1 additive schema、R2／Drive data
及 IDs。若需要暫停 Drive，先 removeTriggers()、按批准計畫關 relay flag；不可清空 queue。
SHA 候選新增 0012 尚未部署，不可混入只改 frontend 的 Production release；選定基底／
commit 範圍後先檢查 migration compatibility，禁止 force push、reset 或刪除資料。
