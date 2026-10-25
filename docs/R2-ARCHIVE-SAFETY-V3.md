# Archive Safety V3：單一寫入前提、統一暫停與恢復

日期：2026-10-24（台灣）。本機基準 `ad528e81e755de315d80d1a07fc297a917ebcc48`。
此文件優先於 V2 的啟用／恢復提案。**只完成本機候選，Production NO-GO，沒有部署。**

## 外部 PUT 風險的修正界線

Cloudflare R2 Binding 的 delete 只有 key/key[]，沒有 conditional version 參數。PUT 有原生 onlyIf；HEAD 是觀察，不是跨服務鎖。參考 [官方 Worker API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。Bucket lock 保留期結束後也不能代替 HEAD→DELETE 的原子版本條件，沒有新增 bucket lock 或付費機制。

本候選對**所有應用程式 PUT** 強制 `If-None-Match:*`，呼叫者不能用 options 改回 overwrite。既有各路徑共用 `capacityPut`：v1 staging、v2/final/Direct、案件私有副本、Admin 範例圖。key 由伺服器 UUID 產生；既有 cold_proofs pin 繼續永久阻止已封存 key 的 reservation／重新建立。未知 native PUT 的 reservation/write_token 不因逾時自清。v1 ACK-lost 同內容重試可回讀已存在且符合 grant SHA/size/MIME 的原物件，不重寫、不重複計容量；這不是替不同 replay bytes 做驗證。

**這不能約束持有獨立 S3 寫入憑證或 raw binding 的外部服務。** V2 的外部 raw PUT 對抗測試仍可在伪造「全部已確認」前提時重現刪到覆寫版本，因此不能把 create-only 或 D1 evidence hash 說成帳號層級的不可覆寫保證。

實際啟用必須排除其他 R2 寫入權限與在途 PUT；本輪 Token list 403／9109，Multipart 沒有合法 S3 query 憑證，兩項都 UNKNOWN，不能啟用。Worker 的 writer_evidence 是經授權 Operator 審閱證據後的**有時效、可稽核聲明**，不是 Worker 自己讀到 Cloudflare 全帳號權限，也不是簽章認證證書。填 true／填雜湊不能代替盤點。若無法取得完整、可審查的單一寫入證據，保持 PAUSED／live OFF，不接受假設。

## 控制面盤點

本輪只做 Cloudflare GET，無 D1 或 R2 object API 操作。完整可見帳號下 5 個 Worker 的目前設定、最新 active deployment 與其流量版本均讀取；只有 voteproof 的 PROOFS_BUCKET 綁 voteproof-proofs。Sippy 為 false；讀到一條啟用的 abortMultipartUploadsTransition lifecycle，沒有讀到 object expiry/delete lifecycle。這不證明 multipart=0。

Account API Tokens 與 User API Tokens 分開查詢，均403／9109；空 visible list **不是0組寫入憑證**。目前程序的 AWS/R2 S3 key 環境變數不存在；不能因此推定其他機器、AWS profile、rclone、Dashboard upload 或外部服務沒有憑證。舊兩組 Token 的歷史撤銷結論不重做、不修改。

尚缺：Operator 在 R2 Overview → Manage API Tokens 分別查 Account/User 有效權限；列出可對目標 bucket 寫入的直接憑證與可簽發憑證的控制面身分，逐一對應服務及撤銷／縮限證據；S3 ListMultipartUploads 全分頁；已發 presigned URL 的失效證據與在途 PUT 結束證據；外部 CLI/排程與舊 Worker 版本確認。不得把 Secrets 貼進對話或 Git。沒有資料就 UNKNOWN，不再重試相同403。

## D1 全域 fencing

新增 additive `0029_archive_fencing.sql`，不改0025～0028：

- storage_archive_control：單一 mode/epoch、writer policy、證據文件hash、verified_until。預設 paused/epoch1，證據空。
- cold_proofs.archive_epoch：nullable；A把控制epoch與已驗證來源一起持久保存。停用／恢復後 epoch 增加，舊 handoff 無效，必須重新A。
- storage_archive_dispatches：持久 DELETE 許可／結果；reserved、ambiguous、completed。來源 identity 不可變、不可刪／replace、completed 不可改寫。
- 兩個 partial pending 索引，pending 查詢不掃 completed 歷史。全域 admission 同時排除任何 pending dispatch/deleting proof；未知結果即使自動 pause 寫入失敗，仍由持久 pin 擋住新清理。

所有 live cleanup 經 archiveAdmission，並在 A 保存、B deleting claim、最後 dispatch transaction 以 epoch CAS 重驗。原 Admin dry-run 繼續非破壞 preview；純 inventory/quota、runBackup 不需要清理控制開啟。

**舊公開 `/storage/archive {}` 回傳 legacy_disabled，不能再從 A 隱式進B。** 新 Canary A/B 仍綁隔離 origin，不因這次變更成為 Production 執行器。其他帳號的舊 Trigger 即使還在，也不能經新版舊API刪圖；但舊 binary／其他 raw binding 不會自動取得本候選的保護，部署與寫入者盤點仍須排除。

## 停機線性化與在途請求

1. A 驗證 Drive、保存 epoch；未刪R2。
2. B重核版本、取得D1 deleting pin、最後HEAD。
3. **dispatch transaction** 再驗 epoch、writer證據期限、容量期限與安全占用，持久寫入 reserved 許可及 immutable audit。這是刪除許可的線性化點，不是另一個HEAD。
4. 確認transaction ACK後才呼叫 native DELETE，再HEAD absence，原子寫cold＋terminal audit＋dispatch completed。

pause 將epoch加1。若在步驟3前生效，沒有新 DELETE；若已取得許可，pause 必須回 draining，直到已授權操作完成或受控對帳。不能保證取消已進入 R2 的請求，也不會假報即時排空。

drained=true 僅在 mode=paused 且 pending dispatch=0、deleting proof=0。A的非破壞讀取、備份、容量盤點可仍在執行；drained不是全面停寫。移除某Script Trigger、Script Journal或server live OFF，都不是已發 native DELETE 的撤銷證明。

## 權限、失敗與人工恢復

新 `/api/admin/storage/archive-control` GET/POST 僅 super_admin，沿用 Session/MFA/Origin/CSRF，寫入 transaction 內再次檢查相同角色／Session；不可用 relay Bearer 冒充管理員。沒有新增 UI 或輪詢。

pause/resume/settle 需 confirmed 與 expected_epoch；resume 另需完整、未過期且最多1小時的 writer_evidence，capacity可信、無reservation/unknown writer/deleting/dispatch。資料格式驗證不等於外部事實驗證。每次控制變更保留 immutable audit 與伺服器取得的操作身分。

- dispatch transaction ACK遺失：不能發DELETE，保留可能已commit的許可，central pause。
- DELETE／confirm／terminal transaction不明：保留 deleting pin＋reserved/ambiguous，不以lease到期放行，停止其他清理。
- terminal commit已成功但ACK遺失：completed和cold保留，重試B不重刪／不重複terminal audit。
- 自動pause遇到D1故障：pending dispatch/deleting admission仍封鎖；缺失schema或D1查詢失敗亦不發DELETE。

人工 `reconcile` 另需 Operator 明確確認原 invocation **已結束**、其完成證據hash、新鮮writer證據與當下epoch；只有等lease、看到HEAD缺檔都不夠。Worker會重新驗真Drive receipt/SHA/身分，再核R2與D1版本、export/backup/write占用。

- R2仍是原版本：不重送DELETE，將許可結案為abandoned、proof blocked，保留原圖／audit。
- R2已不存在：不呼叫DELETE，確認備份後將proof cold與terminal audit一次提交。
- R2版本、Drive內容、來源版本不一致，或invocation未證明結束：保留阻擋。

這是人工作業、經審查的完成聲明；Worker不能從任意hash自動證明Cloudflare invocation結束。完成證據必須同時涵蓋原 invocation 及其 native R2 I/O 已結束；單一 trace ended／1102、lease 到期或 HEAD 都不能證明後端請求已排空。沒有這項證據就不得呼叫 reconcile，繼續保留 pin。完成後仍需明確 settle，再取得新證據與授權才resume。沒有自動清pin／整庫restore，也不會把Drive圖片還原R2。

## 驗收與不變項

本機涵蓋 pause-before/after-dispatch、pause-during-A、lost ACK各階段、pause寫入失敗、B replay/CAS、lease expiry、缺schema／缺證據、create-only重試與cold key防重建、人工對帳。真Code.gs以VM讀合成bytes；真Google E2E仍PENDING。

保留7天結案、十進位10GB預算、90/95/85%門檻、600秒容量可信期限、Drive SHA/HMAC、資料夾／身分／MIME驗證、D1 CAS與immutable audit。V2封存UI/410/ZIP拒絕四檔raw hash保持一致；不新增冷讀、自動還原或cold ZIP。
