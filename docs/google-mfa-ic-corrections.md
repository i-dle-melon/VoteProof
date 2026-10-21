# Google MFA V1.1｜GPT IC 補正紀錄

日期：2026-10-21。分支：`codex/google-mfa-optional-v1`。
本次補正基準：`e0e8d102e9b4e844c0abec11e9e61f646ffeeff8`。最終完整 SHA 記錄在交接包 README 與 `validation-results.json`，避免文件自我引用 Commit SHA。

## 規格與差異

- Google OAuth＋任一有效、未使用的復原碼皆可停用 Google MFA；不要求只剩最後一組。
- 必須同時傳入 JSON 布林 `disable_mfa=true`、`confirmed=true`。缺少確認、false、字串或數字均拒絕。兩者都省略時維持普通復原碼登入，政策不變。
- 後端原本已符合此規格，沒有剩餘組數限制。本次沒有修改 API、Session／因素處理、Schema、Migration 或其他 A/B/C 功能；只修正文案、文件與補強測試。
- UI 明示任一未使用復原碼、不受剩餘組數限制；保留勾選及再次確認。取消確認不送出停用請求。

新增／補強的本機 Worker 證據：

| 情境 | 主要斷言 |
|---|---|
| 剩餘 10 組、剩餘 1 組 | 都可明確停用，只消耗指定的一組；保留 Authenticator 憑證 |
| 錯誤確認欄位 | 8 種無效組合均 400；政策、復原碼、Session、交易均不被消耗或修改；修正後可成功 |
| 成功後重播 | 同一交易／復原碼不能再成功 |
| 同碼／不同碼併發停用 | 都僅一個成功；generation 只遞增一次、僅一筆 disable audit、一組因素消耗、一個新 Session |
| 舊 Google Session | 兩個既有 Google Session 失效；新 Session 正常；既有密碼 Session 規則仍由原測試驗證 |
| reviewer／admin／super_admin | 停用後仍不能進 Admin API；elevated_until／reauthenticated_until=0；角色未變 |
| Audit 寫入失敗 | 政策、因素消耗、Session 撤銷與新建均回滾；原 Session 可用，明確重試可成功 |
| 瀏覽器 | 多組／單組說明與兩階段確認、取消、不勾選只登入；320／390／430 與原 Dark／Light 測試通過 |

## 本輪實際測試

以下為重新執行的最終結果，不與初版歷史數字重複加總。下表命令的最終 Exit Code 均為 **0**，沒有跳過、取消或失敗的測試。收尾敏感資料掃描曾因本文件含本機絕對路徑而拒絕；移除路徑後重跑通過，該次 Exit Code=1 的原始輸出另保留在 `logs/final-checks.initial-failed.raw.log`，未放寬掃描規則。

| 執行 | 結果 | 完整輸出（交接包內） |
|---|---|---|
| Auth／Google／Session／RBAC Node＋本機 Worker | 134 PASS，含 26 項 Google MFA 測試 | `logs/backend.raw.log` |
| 前端 Node 單元／相關整合 | 90 PASS | `logs/frontend-unit.raw.log` |
| Pages build／資料隔離 | 2 PASS | `logs/pages-isolation.raw.log` |
| Worker 本機打包 dry-run | PASS，未部署 | `logs/worker-dry-run.raw.log` |
| 前端 hooks／assets／敏感資料掃描 | PASS | `logs/frontend-hooks.raw.log`、`logs/public-assets.raw.log`、`logs/frontend-sensitive.raw.log` |
| Playwright（Desktop Chrome／Android Chrome／iPhone WebKit） | 111 PASS，workers=1 | `logs/playwright.raw.log` |
| 最終 diff 格式與敏感資料檢查 | PASS | `logs/final-checks.raw.log` |

重現命令（工作目錄為此分支的 Repo）：

```powershell
node --test --test-concurrency=1 test/auth-google.test.js test/google-login-mfa.test.js test/auth.test.js test/admin-session-mfa.test.js
node --test test/frontend.test.js test/frontend-batch.test.js test/frontend-member.test.js test/frontend-admin.test.js test/frontend-tier-artwork.test.js test/frontend-maintenance.test.js test/frontend-backup.test.js
node --test test/pages-public-build.test.js
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir <repo外的本機輸出目錄>
node scripts/check-frontend-hooks.mjs
node scripts/check-public-assets.mjs
node scripts/check-frontend-sensitive.mjs
node node_modules/@playwright/test/cli.js test frontend-tests/google-login-mfa.spec.js frontend-tests/google.spec.js frontend-tests/password-trusted-ui.spec.js frontend-tests/comeback-pill.spec.js --workers=1
git diff --check
```

精確的 executable／argv、實際 outdir、cwd、開始／結束時間、Exit Code、環境版本保存於 `validation-results.json`。`run-validation.cjs` 為 Repo 外的本機輸出收集器；每次測試另存未裁切的 stdout、stderr 及依事件順序合併的 raw log。最終靜態檢查亦另存原始輸出，沒有用工具畫面截斷的摘要取代原始檔。

環境：Windows x64 10.0.26200；Node v24.21.0；Wrangler 4.149.0；Miniflare 5.20261006.1-alpha／workerd 1.20261006.1；Playwright 1.64.0。Worker 測試僅本機隔離 D1／R2、合成會員及模擬 Google Provider。0028 的本機 additive／缺失 Migration 防護案例包含在這次 134 項內；未改 Migration，也沒有執行正式 Migration。

## 效能證據邊界

原 `google-mfa-local-metrics.json` 的數字保留為歷史樣本；本次重跑的逐請求樣本完整保存在 `backend.raw.log` 的 `GOOGLE_MFA_LOCAL_MEASUREMENTS` 行。

statement/trip 僅統計 Worker 顯式執行的 D1 API 呼叫；**D1 SQL Trigger 的內部查詢與內部執行成本未列入原數字**。政策 SELECT=0 僅代表沒有被此攔截器觀測到的顯式 SELECT，不代表 DB Trigger 沒有工作，也不是完整 DB 成本。

**真實 Cloudflare Worker CPU：UNKNOWN。Workers Free CPU readiness：UNKNOWN。** 本機 wall time、SQL 次數及本機打包成功都不能當 Cloudflare CPU 證據；本輪沒有雲端部署或真實 Google／Supabase E2E 驗證。

## 交付範圍

交接包檔名：`VoteProof-Google-MFA-V1.1-IC-fix-20261021.zip`，位於 Repo 外的 Documents／Codex，完整路徑由最終回覆提供。含本輪 delta patch、整體累積 patch、相關最終原始碼、完整測試輸出與命令／環境／Exit Code／SHA manifest。

僅新增一個本機 IC 補正 commit。未 Push、Merge、修改 main、Production、正式 D1／R2、Supabase、Worker、GitHub Environment 或其他正式資源。停止等待 GPT 再次 IC。
