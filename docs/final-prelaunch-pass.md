# FINAL PRE-LAUNCH PASS READY — 本機實作紀錄

分支：`codex/solo-total-leaderboard-fix`。接續 `badf9eb`，本輪只做 source、local tests、隔離 Preview 與 local commit。沒有 push、merge、遠端 API、Production migration 或 deploy；Production submissions 沿用 operator 既有 OFF 狀態，未重新遠端確認。

## A. 原規格 1–11

1. 會員／首頁公開排名取所有合格公開榜的最小正整數名次，不依 API 陣列順序；無名次顯示「尚未上榜」。
2. 本次回歸必須由管理員明確指定，無任意 fallback。其他活動榜保留各自名稱按鈕，系統固定榜使用中性標示。
3. 排行榜活動選單使用分頁 Admin API，保留歷史 closed／archived reference；自訂榜可以不指定活動。
4. 活動代號標示必填，保留英文、數字、連字號與底線規則。
5. 新活動預設 10 點、無每日上限、active；新榜預設 top 10、公開、active。既有設定不覆寫。
6. Google Drive 備份獨立為管理頁籤，不嵌入工作總覽或案件清單；案件原有個別備份資訊保留，relay contract 不變。
7. Gate OFF／讀取錯誤使用危險色膠囊，Dark／Light 一致；不修改 Gate 授權或正式設定。
8. Desktop 頂部圓形「？」與標題、帳號控制項靠左，間距 18px；手機導覽保留，側欄底部應援卡使用 margin-top:auto。
9. 首頁案件查詢圖示為 ▣，原連結與無障礙文字保留。
10. 投票日期使用瀏覽器本地日曆日期，依活動上下限 clamp；手動修改後不被活動切換覆寫。
11. completed 匯出包可再次下載，讀取原 snapshot／attempt，不改完成狀態；失敗、取消不得降級。批次全下載包含 completed 包，依序一包一 Worker／buffer，不合併大 ZIP、不寫 R2；保留停止／取消及瀏覽器多檔下載提示。

## B. 本次回歸資料模型

0020 新增 leaderboard.is_current_comeback，預設 false；partial unique index 限制最多一個。Trigger 限定非 archived 的 campaign 榜。切換、CAS、舊榜版本與雙方 audit 在同一 D1 batch；MFA 中途失效也會 rollback。僅變更指定狀態時保留已發布成績；統計規則變動仍使 snapshot 失效。沒有替既有榜自動指定。

## C. Leaderboard ID

省略建立 ID 時由 backend 產生 board-UUID；明確指定舊 ID 仍相容。編輯頁只讀顯示 stable identity，與名稱分開。

## 管理員／審核員

只有既有 DB super_admin 能看到最右側「管理員管理」。不以 client email 授權，不新增或改動正式主管理員身份。對方需先用該 Google 帳號登入並完成會員資料，之後可授予 admin 或 reviewer；不建立假會員、不預佔陌生 Google 身份。Backend 原子檢查 Google identity、會員狀態、操作者 MFA／RBAC，並記錄不含信箱的權限 audit。一般 Admin 無管理員管理頁；Reviewer 僅工作總覽、案件審核、圖片批次匯出。授權後仍須 MFA 才能使用後台。

## E/L. Migration 與資料安全

- 0020_current_comeback.sql：新增欄位、唯一 index 與 guard triggers，無歷史成績重算。
- 0021_campaign_content_announcements.sql：只新增 campaign_example_assets、campaign_content、site_announcements、admin_content_audit 及 indexes／immutable audit triggers；不修改既有表。
- 0019 與更早 migration 未改。新的兩支 migration 都沒有套到 Production。
- 0021 populated 0020 copy 使用 Wrangler splitter，逐一比較全部原有表資料與 schema，FK=0、quick_check=ok；保留已有 Direct Case、files、ledger、members、auth、backup。
- 未新增 Cron、relay 工作或圖片內容 heuristic。

## J. Campaign 投稿範例／說明

建立／編輯活動可選填多行公開說明與 PNG／JPEG／WEBP 圖片（最多 5 MiB），支援預覽、替換與移除。圖片 binary 不存 D1；R2 維持 private，使用 server 產生的 campaign-assets/{campaign_id}/example/{asset_id}.{ext}。Admin upload 維持 auth／RBAC／MFA／CSRF／Origin，檢查 MIME、signature、串流大小，不接受任意 object key。

先 put 新圖，儲存成功才切 reference 並清理舊範例；退役資產不能再掛回，避免併發清理破壞現有 reference。清理失敗不把成功儲存誤報失敗，會回 asset_cleanup_pending。未成功掛接的 staged 圖片保留在獨立 namespace，沒有自動啟用清理工作。所有刪除限制在同活動範例 namespace，proof 不動。

公開投稿透過 Worker curated read 取得圖片，無 bucket URL／key；切活動更新內容，兩者皆空隱藏。Native dialog 放大、Escape、關閉回焦點、手機圖片自適應。說明與圖片操作都有 audit。

## K. 彈窗公告 CMS

導覽為工作總覽 → 案件審核 → Google Drive 備份 → 彈窗公告 → 圖片批次匯出 → 活動管理等。可管理標題、內文、開放／關閉、可選起訖時間、允許關閉、按鈕文字與 http(s) 連結；預覽後儲存。版本、updated_at／by 與每次 mutation audit 持久保存，不另建完整 draft system。

Backend 依 UTC 時間與 enabled 篩選公開公告，拒絕非 http(s)／帶 credential URL；內容以純文字與換行渲染，無 HTML execution。Native modal 支援 focus trap、依 dismissible 決定 Escape；保留登入與安全入口並避開 auth／recovery／security／投稿／Admin 流程。localStorage 只記公開公告 UUID／版本；同版本關閉後不重複，新發布版本會再次出現。

## Preview

仍共用 public/index.html、app.css、app.js、member.js、admin.js 與 UI modules；只替換 transport／fixture。新增假範例圖與公告記憶體資料，控制列新增公告關閉／可關閉／不可關閉／未開始／已結束，身份新增展示主管理員及審核員。Production 的 Preview marker 固定 false，不存在 fallback。這輪沒有發布線上 Pages。

## F. 驗證與限制

- 153 項選定 unit／domain／安全／frontend／native migration 測試 PASS，另 1 項 native completed-export 真實 handlers／SQLite 測試 PASS，共 154 項。
- Pages shared-source build 測試 2 PASS；隔離 Pages build PASS。
- 共用 renderer 瀏覽器測試 84 PASS，另公開新版本／XSS 3 PASS，共 87 PASS（Desktop Chrome／Android Chrome／iPhone WebKit）。含 320／390／430／1024／1440、Dark／Light、圖片與公告 dialog、CMS 與角色權限。
- 真實 ZIP Worker／私有 transport／writable sink／取消／ack recovery／Reviewer 入口 5 PASS。Browser 相關合計 92 PASS。
- Worker esbuild write:false PASS；public assets 36 檔、sensitive findings=0；frontend hooks 517 IDs PASS；git diff --check PASS。
- Real Miniflare 仍因 connect EACCES 127.0.0.1 在 setup 受阻，包含新增 content integration；測試保留啟用於 CI，沒有改成 skip。
- npm run check:admin-schema 因外部 Wrangler log 目錄 EPERM 受阻，strict full trigger set 驗證保留，不能算 PASS。
- 兩個既有 file-backed browser 實際 Blob 下載用例仍未通過：download.path canceled／缺 download event。沒有弱化 assertions；ZIP stream／sink 與 UI 下載排序另有上列通過測試。尚不能宣稱 OS 實際下載與完整 release regression 全 PASS。
- 未 push，因此本輪沒有新的 GitHub CI run。後續仍須乾淨 runner 完整 Miniflare／schema／browser download 驗證，才可另行評估 Production rollout。
- 參考網站被 saved browser permission 拒絕；沒有繞過，也沒有宣稱精確比對 UI。

## D. 本輪修改檔案

- `.github/workflows/branch-validation.yml`
- `frontend-tests/admin-export-transport.spec.js`
- `frontend-tests/admin-fixture.mjs`
- `frontend-tests/admin.spec.js`
- `frontend-tests/backup.spec.js`
- `frontend-tests/redesign.spec.js`
- `public/css/app.css`
- `public/index.html`
- `public/js/admin-api.js`
- `public/js/admin-export.js`
- `public/js/admin.js`
- `public/js/api.js`
- `public/js/app.js`
- `public/js/member-api.js`
- `scripts/build-pages-preview.mjs`
- `scripts/check-admin-schema.mjs`
- `scripts/check-public-assets.mjs`
- `scripts/lib/pages-preview-controls.html`
- `scripts/lib/pages-preview-exports.js`
- `scripts/lib/pages-preview-fixtures.js`
- `scripts/lib/pages-preview-runtime.js`
- `scripts/lib/pages-preview-state.js`
- `scripts/lib/pages-public-ui.js`
- `src/api/admin-campaigns.js`
- `src/api/admin-image-exports.js`
- `src/api/admin-validation.js`
- `src/api/router.js`
- `src/lib/admin-store.js`
- `src/lib/campaign-policy.js`
- `src/lib/campaign-store.js`
- `src/lib/image-export.js`
- `src/lib/leaderboard-policy.js`
- `src/lib/leaderboard-store.js`
- `test/admin-image-export.test.js`
- `test/campaign-category-registry.test.js`
- `test/pages-public-build.test.js`
- `test/solo-target-registry-migration.test.js`
- `docs/final-prelaunch-pass.md`
- `frontend-tests/content.spec.js`
- `frontend-tests/prelaunch.spec.js`
- `migrations/0020_current_comeback.sql`
- `migrations/0021_campaign_content_announcements.sql`
- `playwright.prelaunch.config.js`
- `public/js/announcements.js`
- `public/js/campaign-guidance.js`
- `public/js/leaderboard-ui.js`
- `public/js/vote-date.js`
- `scripts/lib/pages-preview-content.js`
- `src/api/admin-staff.js`
- `src/api/site-content.js`
- `src/lib/site-content.js`
- `test/admin-staff.test.js`
- `test/current-comeback-migration.test.js`
- `test/current-comeback.test.js`
- `test/helpers/current-comeback-migration.mjs`
- `test/prelaunch-export.test.js`
- `test/prelaunch-ui.test.js`
- `test/site-content-migration.test.js`
- `test/site-content-miniflare.test.js`
- `test/site-content.test.js`
