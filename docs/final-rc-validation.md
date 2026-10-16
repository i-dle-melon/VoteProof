# FINAL RC validation（不部署）

本輪接續 7f6408472ec0de9a2e4f0834ec23d1e88db25ca0，僅補驗證及修正舊測試預期，沒有新增產品功能。GitHub branch validation 的完整結果以最終回覆所列 exact commit/run 為準；本文不預先宣稱 CI GREEN。

## 實際 Blob 下載原始失敗

1. frontend-tests/admin-export-transport.spec.js:131「real Worker transport: private proof fetch then valid ZIP, completed reload」。原失敗行 138，expected=成功取得 download.path 並解開 4 entries ZIP；actual=download.path: canceled。Stack：TestContext → admin-export-transport.spec.js:138:66（await file.path）。該次 7.3 秒內失敗，早於程式 30 秒 revoke timer，不能歸因過早 revoke。原始紀錄無底層 OS/Chromium 錯誤，不能事後猜成特定 Windows ACL。
2. 同檔原行 155「missing proof fails without download, retry succeeds」。原失敗行 170，expected download event count=1，actual=0。Stack：TestContext → admin-export-transport.spec.js:170:17。舊 assertion 等 UI completed 後立即數事件；這沒有保證瀏覽器已交付 download event。本輪改為先註冊 waitForEvent，再等待實際檔案成功、解 ZIP，最後仍嚴格要求 count=1；沒有弱化或 mock-only。

同一個未修改的 7f64084，本輪 Windows 原兩項皆已實際 PASS。第一項歷史 canceled 未能重現，保留 unknown 根因，不以推測宣稱環境問題。後續必須有 Linux clean runner 同項 PASS 才能關閉 blocker。

新增 actual Blob regression：completed 再次下載與第一次 ZIP 內容相同；不新增 completed state write、不換原 attempt；再次下載失敗/取消保持 completed 且沒有新 download/state；batch-all 包含已完成包，產生三個獨立 ZIP，private fetch 共九張、start 次序 1/2/3、同時只有一個真實 Worker，不建立 combined ZIP。使用真實 download.path()/failure() 與 unzip，沒有替換 Worker 或下載 API。原 30 秒 URL 延後撤銷未改；ZIP 完整讀取成功驗證瀏覽器取得檔案。多檔下載權限提示及各包再次下載入口仍存在。

## RBAC security matrix

| 操作 | super_admin | admin | reviewer | member/guest |
|---|---|---|---|---|
| 列出/授予管理權限 | 允許，且唯一 active owner | 403 | 403 | 403/401 |
| 授予 super_admin | 400，不支援 | 403 | 403 | 403/401 |
| 自己降級/移除最後 owner | 拒絕 | 拒絕 | 拒絕 | 拒絕 |
| 隨意 email / 未註冊 Google identity | 拒絕 | 403 | 403 | 403/401 |
| suspended target | 拒絕，無 membership | 403 | 403 | 403/401 |
| 一般後台管理 | 允許 | 允許 | 403 | 403/401 |
| 案件初審/詳細審核/匯出 | 允許 | 允許 | 指定範圍 | 403/401 |
| complete/revoke Case/手動 points | 允許 | 允許 | 403 | 403/401 |

授權以 DB role、active member/membership、session、MFA 為準，不信任 UI。每次寫入保留 Origin/CSRF；Google identity 與權限在交易內再次驗證。Grant 與 reviewer→admin 更新都寫既有 bootstrap_membership audit，不保存 email/provider identity。此版本**沒有角色 revoke/delete API/UI**；PATCH/DELETE=405，偽造 action=revoke=400，所以沒有未記 audit 的應用撤權路徑，也不能從這個功能移除主管理員。偵測多個 active super_admin 時 fail closed。新增功能不以 email 建立新會員。

### Reviewer 三個頁籤與 API scope

- 工作總覽：GET /api/admin/me、/api/admin/cases（統計已載入資料）。
- 案件審核：GET /api/admin/cases、/:case_id、/:case_id/files/:file_id；POST /api/admin/cases/:case_id/review（approve/reject/mark_duplicate/flag_detailed）及 /api/admin/cases/batch-approve。complete/revoke=403。
- 圖片批次匯出：GET /api/admin/image-exports、/jobs/:id；POST /query、/jobs、/jobs/:id/packages/:n/start、/state；GET /jobs/:id/packages/:n/attempts/:attempt/files/:file_id。仍受擁有者、快照期限及 MFA 限制。
- 共用篩選 metadata：GET /api/admin/campaigns、/api/admin/campaigns/:id、/api/admin/solo-targets；不允許 mutation。一般會員自己的 auth/security API 仍依原規則。
- 排行榜管理、活動 mutation、Tier、Gate、Drive 管理、公告、Campaign asset upload/private admin read、audit、staff、手動 points 皆無權限。

## 連續 migration

test/rc-migration-chain.test.js 建立全新隔離 local D1，透過 Wrangler migrations apply 先套到 0019，seed 假會員/主管理員、V1/V2 legacy cases/files、approved ledger、audit、backup、歷史 board。Seed 在 migration 前結束，Gate OFF/version16。derived duplicate jobs/groups 由原 trigger 產生，避免重複匯入。然後只加入 0020、apply、加入 0021、apply；每步 FK=0，逐表比較全部原有資料及原有 schema（僅 leaderboards additive column 例外），quick_check=ok，registry 全名稱清單精確到 0021；再 replay 確認沒有重跑。沒有 DROP、歷史 ledger/Case/Campaign rewrite，沒有讀取 Production 資料或備份。

check:admin-schema 保留 strict deepEqual 全 trigger set，包含 0019 stable identity 及 0020/0021 新 trigger。本輪 Windows 原檢查已實際 PASS。

## Campaign / announcement

新增 real Miniflare/R2 integration，驗證 asset auth、Reviewer denial、MIME/signature/5 MiB、private campaign-assets key、guest curated public read 的 nosniff、先存新圖再切換/清理、刪除只影響 example、proof 不受干擾。Announcement 保留純文字/XSS/URL防護、Admin audit、版本及 dismiss、disabled 與 future/expired；補 exact start inclusive / end exclusive 測試。

## 完整 CI

.github/workflows/branch-validation.yml 保留 push 原 branch 與 workflow_dispatch；四個 job 跑全部 npm tests/real Miniflare、全部三引擎 frontend/browser（含 actual Blob tests）、Wrangler migration registry/schema + populated chain、Pages/Worker dry-run build、security、diff check。沒有 optional/continue-on-error/skip。Production workflow 僅 main 的手動 approved-SHA dispatch；Pages deploy 僅 main。本輪不 merge main、不觸發任何 deploy workflow。
