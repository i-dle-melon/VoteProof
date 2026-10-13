# 重設計前 security／release／free-tier 審查

查核日 2026-10-13。範圍為 checked-out local candidate 與唯讀 Production baseline。
本文件不是滲透測試證書；真實 provider outage、完整流量、最大檔案 Workers CPU 與長期 quotas
仍需 release 前量測。沒有修改 auth policy／secret／Production 業務資料。

## Source 保護與驗證範圍

| 範圍 | Source／保護 | 核對 |
|---|---|---|
| Session／member | auth-session.js、auth-store.js；hashed session、active member、expiry/revocation、atomic authorization guard | existing unit/integration tests；無 client role 信任 |
| Google／signup | auth-google.js、auth-registration.js、auth-methods.js、supabase-auth.js；bound state/PKCE/purpose、email enrollment／TOTP transaction | 不繞過provider證明、不將Google callback當Admin驗證 |
| Password／TOTP／recovery | auth-crypto.js、auth-identity.js、password-operation.js、auth-security.js、auth-recovery.js；KDF／encrypted TOTP／one-time code／attempt bounds／rate limit | 未降成本以繞過安全；不rotate長期keys |
| MFA／step-up | auth-elevation.js、admin-identity.js；server membership決定elevation，Admin MFA可綁session，敏感安全操作另查近期 reauthenticated_until | 不把固定一小時限制擅自加回已接受的Admin契約 |
| Admin／reviewer | admin-identity.js、admin-store.js；active membership、role guards、CSRF／Origin、expected_version、transaction authorization recheck | reviewer範圍保留；new duplicate evidence只在既有Admin detail，previous member身份不回傳 |
| CSRF／Origin | memberCsrf／adminCsrf；same-origin cookie requests與server checks | public Pages與foreign Origin不具權限 |
| Relay | drive-backup-relay.js、internal-drive-backups.js；Bearer format／constant-time digest comparison、拒絕Origin、600s lease、attempt／source pin | max1 claim、reserved ID、receipt replay；local測得max6 statements，非Productionstatement實測 |
| R2／Drive | proof stream需Admin／lease；raster MIME、size、ETag；Drive owner-only helper實際驗證 | bucket非public，無新public link；backfill工具不寫R2；不新增自動刪除 |
| Errors／logging | router.js sanitized error；frontend usesPublicError及textContent；sanitized tail不保存headers/body/log text | no image/OCR/private identity/digest lists logging |
| Pages | build-pages-preview.mjs explicit allowlist、balanced protected-view removal、connect-src none；check-public-assets.mjs | 新admin-duplicate.js僅准入Production assets，未准入Pages；3 safety tests |
| Data／migration | additive0012；source metadata guard、immutable hash更新；FK／quick_check；proof/case/ledger links | local migration preservation tests及readonly Production registry；0010／0011未改 |

## Legacy backup

正常路徑為 Apps Script pull；GOOGLE_DRIVE_BACKUP_ENABLED 是共同 enable gate，需 true 才可claim。
Legacy只有明確 DRIVE_BACKUP_TRANSPORT=worker_oauth_legacy 才可scheduled／direct process；目前
Production transport=apps_script_pull、Cron=0，舊Google OAuth bindings不存在。現有legacy executor／
OAuth setup／comparison tests 保留為 rollback compatibility／dormant path，沒有刪除或自動fallback。
舊 setup docs中direct processing描述需搭配transport註記理解，是未來清理候選。

## Free-tier 建築風險（當日官方文件核對）

| 服務 | 查核值與風險 | 決策 |
|---|---|---|
| Workers | Free HTTP CPU 10ms、100,000 requests/day、128MB；IO等待不是CPU。實際Drive idle CPU2–5ms，不能證明SHA處理5MiB在budget內。[官方limits](https://developers.cloudflare.com/workers/platform/limits/) | SHA仍local-only；代表性Workers CPU profiling是該feature下一次Productionrelease門檻 |
| D1 | Free每invocation50queries、每DB500MB、account5GB、TimeTravel7days。statement bounds不同於rows讀寫計價；hash lookup用非unique index。[官方limits](https://developers.cloudflare.com/d1/platform/limits/) | relay max6本機證據保留；Production只報availableaggregate與實際rows變化 |
| R2 | Standard free10GB-month、ClassA1m／ClassB10m每月，egressfree；不是無限storage，IA不套該freeallowance。[官方pricing](https://developers.cloudflare.com/r2/pricing/) | 保留proof來源、不自動delete；storage／operations監控，不新增paid依賴 |
| Apps Script | consumer trigger runtime90min/day、URLFetch20k/day；Workspace不同。五分鐘名義288ticks/day，90min換算平均18.75sec/tick，還與同account其他scripts共享。[官方quotas](https://developers.google.com/apps-script/guides/services/quotas) | idle實測與13KBcanary不保證所有5MiB／長期throughput；later-tick backoff與LockService保留 |
| Drive API | 2026-05-01新project改quota-unit model，2025-11至2026-04已用project可保留舊quota；403/429要backoff，另有Drive storage與projectbilling限制。[官方limits](https://developers.google.com/workspace/drive/api/guides/limits) | 私人project／storage console的實際quota需operator追蹤；不自動增加quota或billing |
| Supabase | Free50kMAU、DB500MB、2activeprojects；一週inactive可pause。[官方pricing](https://supabase.com/pricing) | auth/email/provider outage fail closed；不繞過MFA、不導入paid方案 |
| Turnstile | Free20widgets、10hostnames/widget、unlimited challenges，仍需server Siteverify與hostname/action契約。[官方plans](https://developers.cloudflare.com/turnstile/plans/) | 不因表面免費省略verification；fixture不代表Productionbot防護驗收 |
| GitHub Actions／Pages | standard public/Pages runner使用免費；privateGitHubFree含2kminutes、500MBartifacts；larger runner仍charged。[Actionsbilling](https://docs.github.com/en/billing/concepts/product-billing/github-actions)。Pages1GBpublished、100GB/月softbandwidth、customActionsbuild不受10build/hour規則。[Pageslimits](https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits) | 只公開靜態preview、無ProductionAdminAPI；localcommits不push不消耗新Actionsrun |

以上是當日文件資訊，不是永久配額承諾，也未核准付費項目。SHA採現有@noble/hashes，未增加套件。
Local Node synthetic hash timings僅為Host CPU測量（Windows CPU計時解析度有限），不能替代Workers
Production CPU或免費額度驗收。詳見ignored hash-benchmark.json。

## 重設計待辦與 release gate

手機70個width/theme/surface組合實測：320／375／390／430／768、dark/light；無horizontal overflow、
無unlabeled visible form control、page errors0。20組有小於44px目標（login checkbox本體22px，需核對
label整體可點範圍；member小按鈕42px），25組有contrast candidates；computed ratio需排除透明／
inherited background／disabled／gradient，不能直接當WCAGfailcount。淺色收件OFF文字有約1.9候選，
列為優先人工contrast review。Admin長ID可換行；Member TierArtwork附近留白大，列為設計效率改善。
本階段沒有改CSS／HTML。

優先順序：P1 dark/light OFF/error copy contrast與keyboard／error關聯；P2小tap targets、nativeconfirm
與自訂dialog焦點返回／Escape、fixedbottomnav和軟鍵盤遮擋；P3artwork留白、長ID可讀性及文案一致。
既有browser測試覆蓋batch20、partialretry、mobileoverflow、dialog與keyboard/accessiblelabels。
沒有完整screenreader或專業WCAGmanualaudit，不宣稱整站conformance。

Production backfill等待exact IDs批准，Tier等operator選擇；SHA等待獨立review/migration/CPUgate。
Frontend redesign可以在Tier產品方向確認後進行；不可順帶推送／部署SHA或開publicsubmissions。
