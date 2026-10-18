# CI 與發布流程

此文件更新歷史 release runbook 中「Production 一律重新跑完整測試」的規定。安全閘門保留，但同一 SHA 的成功驗證改為重用，Preview 與 Production 分開。

## 一般迭代

- Pages Preview 自行執行 frontend hooks、資產／敏感資料掃描、共用 UI build、fixture 隔離測試與快速瀏覽器 smoke。它不等待完整 backend CI，也不具備 Cloudflare 憑證或 Worker 部署命令。
- 分支 CI 依 `scripts/ci/plan.mjs` 選測試；基準是同 repo、可信分支、push／手動觸發、已成功且在目前 HEAD 歷史上的 CI commit。找不到基準則完整驗證，不能直接取前一個失敗 push。
- CSS／文案／HTML：frontend unit、相關頁面與手機／深淺色 smoke；不跑 backend 或額外 schema job。會員／Admin 等 JS 有各自相關測試集合。Auth endpoint／密碼操作修改保留 auth、RBAC、ownership 與會員流程；共用 auth 核心與未知路徑退回全套。
- 單一 spec／unit 修正只執行對應 suite；若之前的產品變更尚未成功，會一起納入變更範圍。測試 fixture／helper 或 CI policy 修改保守跑全套。
- migration／schema／依賴／Wrangler 設定變更，或手動 `full_regression=true`，才增加獨立 LOCAL schema safety job。沒有任何自動 remote migration。
- 完整瀏覽器 coverage 仍包含 desktop Chrome、Android Chrome、iPhone WebKit，但三個獨立 runner 平行，各自維持單一 worker 與隔離伺服器。縮短等待時間，不減少完整模式的 coverage；runner 總用量不保證因此降低。
- CI summary 顯示基準 SHA、full／affected、測試檔數與 migration 選擇。plan artifact 只含 SHA／測試路徑，執行時再核對 checkout SHA。

## Production

`production-deploy.yml` 仍只接受 main 手動 dispatch 與完整 `approved_sha`，不因 push 自動部署。

1. 核對 main checkout 與 approved SHA。
2. 重用 `branch-validation.yml` 同 repo、同 SHA 的成功結果；若正在執行就等待，不重新開另一輪。已有失敗／取消結果就停止，不盲目重跑。
3. 沒有驗證結果時，確認 main 未移動，再 dispatch 一次附 approved SHA 的分支驗證。等待及 timeout 都在 CI 程序內完成，不需要模型反覆輪詢。
4. 驗證成功才進入 Production environment。CI／Pages／Production 統一 Node 24；移除舊的重複 `npm test`、frontend-unit 與完整 browser gates。
5. 保留一次精確 Worker deploy、`--keep-vars`、既有 routing、Production environment protection；只以 GET 核對 health 及部署前後 submission gate 相同。不開投稿、不改 secrets、不套 migration，也不自動重試不明確的部署結果。

Production workflow 的 validation job 僅有 contents read／actions write，用來觸發必要的 CI；Cloudflare secrets 仍只提供給 environment-protected deploy job。失敗、不同 SHA、fork／PR provenance、API 錯誤或等待逾時都不能放行。

## 監控與驗證範圍

一個 workflow 使用一個監控程序，只讀簡短狀態；有失敗才取該 job 的必要 log。不要反覆掃整個 repo、重讀全部 log，或為等待產生大量無新資訊的分析。

本流程優化本身不授權 Production deployment。Production 真實發佈需另有使用者授權；本機可測 reuse／dispatch／失敗／逾時分支，不能為了驗證改善而部署 Worker。
