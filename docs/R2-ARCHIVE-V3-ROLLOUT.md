# Archive V3 後續啟用、停機與回復計畫（本輪不執行）

**目前NO-GO。** 本機Patch不是正式發布；Token、Multipart、其他機器／帳號與真CPU／真Drive均尚未完整驗收。舊版與V2文件的啟用提案由本文件覆蓋。

## 必要門檻

1. 可審查的完整寫入者清單：活動流量版本的R2 bindings、S3 Account/User token權限與實際服務、控制面可新發憑證的身分、外部CLI、Sippy／同步工具、multipart全分頁、舊presigned及在途PUT。UNVERIFIED不是PASS。工作清單與證據需人工審閱，sha256綁定文件，不能只勾選true。
2. 唯一寫入者的所有PUT路徑使用已驗收create_only_v1；無其他服務可無條件同key PUT，亦無尚未完成的舊PUT。於清理窗口凍結新增憑證／binding／部署權限變動；一旦變動或不能確保，即pause/live OFF。候選**沒有自動監控Cloudflare權限變更**，不能宣稱證據TTL內不可能新增writer。
3. 新Canary在獨立Free環境完成1/3/5MiB原生CPU、trace完整性與故障測試。D1控制增加CPU/SQL成本，V2結果不能代替V3；本機wall不等於CPU。
4. 真Google Drive隔離E2E：新的A/B＋真bytesSHA/私有資料夾/來源/HMAC/nonce/時效；負向驗證、lostACK、pause與受控reconcile。沒有登入／Script安裝或設定授權就PENDING。
5. 目前正式舊API已被本候選退休，新Canary仍只允許隔離origin。**尚未提供正式Production controller／執行入口的啟用版本**；不得改Canary URL硬闖Production。需下一輪明確設計與審查受保護Production A/B執行器，再有精確SHA/CI/發布授權，才討論正式live。

## 後續發布順序

1. 另外取得正式授權；確認所有 active Worker版本、D1 UUID/registry，live OFF、alert OFF。投稿維持當時Operator設定，不由清理流程更動。
2. 確認舊cleanup所有controllers／Triggers停止且在途刪除已結束，沒有未知pin。舊binary不認識D1新control，僅套0029不能讓它安全停機。保留runBackup與純容量盤點。
3. 新鮮Time Travel復原點與資料數摘要私下保存；若正式registry已有同號其他migration，STOP，不修改歷史。
4. 唯一pending且已審核的0029才可套用。只有新控制／dispatch表、nullable epoch、索引／保護Trigger；不回填舊案件、積分、export與audit。seed新control一列paused；DDL與索引仍有D1內部寫入成本，不宣稱免費或0Rows。
5. 正式Worker／前端若獲核准，精確SHA依既有受保護Workflow部署；保留Secrets/Vars/Bindings，live繼續OFF。舊Worker+0029 schema相容，但**不遵守新fence**；新版+缺0029會清理封鎖，故migration先於新版。公開上傳create-only需同步保留v1 retry行為。
6. 確認所有活躍版本都為fenced實作；唯讀核對mode paused、無dispatch/deleting、原圖片及資料完整、舊公開空body不再能清理。不要測真PUT/DELETE或寄信。
7. 再經單獨核准才部署正式controller及live設定；writer證據、真CPU、真Drive、資料一致性所有門檻皆PASS。不能因Controller部署就自動resume或安裝Trigger。

## 正式暫停

透過同源、super_admin/MFA/CSRF控制API `pause`，以當下expected_epoch明確confirmed；核對新epoch與mode。

- paused＋drained=true：沒有未結案刪除許可／deleting pin。
- draining：阻擋新許可，但舊許可仍在途／未知，維持停止；不得只等300秒就清除。
- API結果遺失：先GET讀狀態／audit，不盲目重送。

若需要改server live OFF、停用某些Trigger或回退Worker，都須符合當次授權；這些操作不取代dispatch對帳。Script Journal不會自動變成伺服器pause；遇到client ACK遺失需Operator核對並明確pause。伺服器自己知道的dispatch異常會自動pause，且持久記錄本身也封鎖。

## 恢復／回退

先保留R2、Drive、D1與audit，不整庫restore。逐筆確認原invocation及其 native R2 I/O 都已結束的證據；單一Worker trace結束或1102不足以證明後端請求完成。可控Operator reconcile只核對／寫狀態，不重DELETE、不還原圖片。證據不足或資料不一致就繼續BLOCKED，不以一段等待時間替代。

既有舊版deleting pin沒有新dispatch紀錄時，不自動替它造許可；需另行審查單筆遷移／對帳方案。不得清pin或讓舊API接管。

完成所有已核准對帳、pending=0後，才settle取得paused/drained。重新盤點容量並取得fresh writer evidence，再另行授權resume。恢復不開投稿、不寄告警、不清Drive。

Worker回退只在live OFF、所有刪除已排空且另獲授權後考慮；保留0029和期間新資料。舊Worker會忽略全域fence且可能使用舊overwrite PUT／舊archive API，故**不能把回退當成安全自動恢復清理**。新schema不自動回滾，Time Travel整庫回復需額外授權。

## 成本／CPU

本機native Workerd profile（不是Cloudflare帳單）：V2 A9SQL/6trips、B13/7；V3 A10/7、B19/9。正常A/B仍2/3次R2 HEAD、B1次DELETE，沒有新增R2 GET、LIST或額外HEAD解決競態。create-only正常PUT仍一次；v1重播conditional miss額外HEAD，避免覆寫與重複計帳。

pending查詢使用partial index，completed歷史不在其中；cold deleting使用既有state索引。新dispatch ledger與immutable audit持續成長，不自動刪歷史。SQL Trigger內部查詢未列入statement/trip；Rows Read/Written以各環境原生meta為準。

未新增Cron／輪詢／Google API操作。CPU ms P50/P95/P99/Max、1102與記憶體峰值一律UNKNOWN；不得用本機20～50mswall判Free CPU FAIL或PASS。正式啟用前仍需下一輪有限Cloudflare驗證授權，不自動建立測試資源或改付費方案。
