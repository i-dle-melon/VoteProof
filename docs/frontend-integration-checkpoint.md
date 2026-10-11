# Frontend integration 暫停接續紀錄

## 接續完成：2026-10-11

Operator 已指示「繼續」。最新 393/393 browser tests 全部 PASS；本機全新 migration 0001–0009、FK 無違規、quick_check ok、Wrangler 4.149.0 dry-run 與 public assets check 全部 PASS。全 tracked + reviewable files sensitive scan：183 files／0 findings。最近完整單元驗證 752/752 PASS、frontend unit 52/52 PASS，四套 frontend smoke PASS；最終 profile 修正後單元與 Member smoke 也已通過。

已完成未提交差異 review，沒有 backend/schema/bindings/CSP 改動。原定本機 integration commit 可以建立；不 push、不 deploy、不 remote migrate、不操作 Production 投稿開關。新 UI 部署後的實機 smoke 與正式驗收仍是另一步。

以下為暫停當時的歷史快照，未完成項目已由上述接續驗證完成；完整最終功能與驗收見 `frontend-production-integration.md`。

日期：2026-10-11。Operator 要求先整理、告一段落，額度重置後再繼續。尚未建立本階段 commit；不要自行 push/deploy/remote migrate 或修改 Production。正式投稿開關未操作。

## Git 基準

- HEAD：`36da30b51c2e16cf2b19e94cdea2733f28b136c8`，`feat: connect home to production campaign state`。
- 開始時工作目錄只有未追蹤的 `docs/reference/legacy-ui.html`，是使用者提供的視覺參考。
- 本次改動尚未提交；不要 reset、刪除或覆蓋。Backend、migrations、wrangler.jsonc、public/_headers 都沒有改動。
- 完成全部驗證後原訂 commit message：`feat: complete production frontend integration`。

## 已完成程式

- 原有 Home、Campaign 與投稿 fail-closed 接線保留，補齊快速入口與一致空狀態。
- 桌面公共／會員／管理分組，手機固定五格；原品牌、icons、卡片、深綠／淺紫保留。
- Guest header query、會員案件／真實 profile／points／tier；無示範 fallback。
- 正式 Google `purpose: security` callback → TOTP step-up UI，及密碼 step-up。
- Authenticator enrollment/reset、一次性復原碼、trusted-device 撤銷；離頁／權限失效清除敏感顯示。
- 管理 `/api/admin/me` 授權確認、MFA 到期清除、RBAC、CSRF、expected_version、衝突明確重新讀取、變更不自動重送。
- 案件審核、受授權私人圖片 blob preview、活動／排行榜／會員等級／投稿設定／audit UI。
- 每日計分 null＝不限次數、0＝不計分、正整數＝上限；台灣時間輸入轉 UTC。
- API 字串使用 textContent；没有新增 inline script/CSP 放寬。
- 最後補上：管理權限回前景確認不覆蓋未保存 profile 欄位，並加入 browser regression。

完整功能/API/安全設計見 `frontend-production-integration.md`。

## 檔案範圍

修改：

- `public/index.html`、`public/css/app.css`、`public/js/app.js`、`public/js/member-api.js`、`public/js/member.js`。
- `frontend-tests/brand.spec.js`、`google.spec.js`、`member-fixture.mjs`、`member.spec.js`、`public.spec.js`。
- `scripts/check-public-assets.mjs`、`check-frontend-sensitive.mjs`、`smoke-google-frontend.mjs`、`smoke-member-frontend.mjs`、`package.json`。

新增：

- `public/js/admin-api.js`、`public/js/admin.js`。
- `frontend-tests/admin-fixture.mjs`、`frontend-tests/admin.spec.js`、`test/frontend-admin.test.js`。
- `scripts/smoke-admin-frontend.mjs`。
- 本文件與 `docs/frontend-production-integration.md`。
- `docs/reference/legacy-ui.html` 原為未追蹤使用者檔案；計畫作文件參考保留，不部署也不使用其示範資料。

## 已取得的驗證結果

- 最後程式修正後 `npm test`：752/752 PASS。
- Frontend unit：52/52 PASS，已包含在 752 中。
- 完整 browser suite：390/390 PASS（三套 projects），是在最後 profile draft 修正前。最後修正新增一項三套測試，共 393 項；該次完整回歸依 operator 暫停要求中止，沒有宣稱 393 PASS。
- Admin／Google／Member／Submission 四套真實本機 Worker frontend smoke 皆 PASS；最後 profile 修正後 Member smoke 也再次 PASS。
- 本機全新 migration 0001–0009、FK 無違規、quick_check ok 先前 PASS；最後重跑在 schema checker 啟動後依暫停要求中止。
- Wrangler dry-run 先前 PASS；最後修正後尚待最終重跑。
- Public asset check：13 可部署 assets PASS；全 tracked + reviewable files sensitive scan 181 files／0 findings，沒有讀取 ignored live credentials。整理文件新增後尚待最終掃描。
- 本機 desktop／320px dark admin/security 與 390px light member 截圖已檢視；截圖與 helper 只存 gitignored `.wrangler/`。新 UI 實機 smoke 必須留到另行授權部署後。

## 接續順序

1. 讀取本文件與 git diff，確認所有未提交改動仍完整。
2. 重跑完整 `npm run test:frontend`，預期 393 項；使用專案 gitignored WebKit cache（`PLAYWRIGHT_BROWSERS_PATH=.wrangler/b4g-playwright` 的 absolute resolved path）。Windows sandbox 的 workerd SQLite access denial 使用允許的本機測試執行環境，不改 implementation。
3. 完成本機 schema／FK／quick_check、Wrangler dry-run、asset/security checks；視新增修改決定必要 regression，避免無理由重複已通過項目。
4. 最終 diff review，確認只含前端／測試／文件，沒有 backend/schema/Production 設定或敏感資料。
5. 全部 PASS 才 stage 明確檔案並建立原訂 local commit，確認 git status clean，提供一次整合報告。
6. 不 push、不 deploy、不 remote migrate、不開啟投稿。下一步部署、實機驗證及是否 ON 均為分開操作。

## 本機證據位置

- `.wrangler/frontend-integration-final-checks.log`：四套 smoke 與先前單元結果。
- `.wrangler/frontend-integration-unit.log`：最新 752 PASS；後續 schema 重跑被暫停中止。
- `.wrangler/frontend-integration-browser.log`：最後未完成的 393-suite run；不能拿來當完整 PASS 證據。
- `.wrangler/frontend-previews/integration-*.png`：本機 fixture 畫面。

這些檔案均 gitignored，不加入 commit。沒有待執行 Production 動作。
