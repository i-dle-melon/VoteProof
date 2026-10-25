# R2 Archive｜隔離 Canary 審查版（2026-10-24）

基準：`ad528e81e755de315d80d1a07fc297a917ebcc48`。
本機安全候選；**不是正式自動刪圖 GO**。Operator 本輪明確維持禁止部署，
真實 Cloudflare CPU、1102及Free 10ms readiness 一律 UNKNOWN。
本輪沒有建立雲端資源、操作正式 D1/R2、登入 Google、建立 Trigger、Commit 或 Push。

## 輸入候選的審查發現

1. 單一 Production URL denylist 可被大小寫、port及其他hostname形式避開；改為正向隔離測試hostname與獨立origin pin，Worker另有隔離opt-in。
2. 原遇到lost ACK只停當次執行，下次Trigger仍可繼續另一張；新增Script Properties durable journal，所有不明結果保留operator hold，沒有自動到期清除。
3. 原A、B都送空body，B不明確綁定A的物件，第一次重試也可能直接刪圖；新增verify-only A及持久claim綁定B，不影響舊空body API。
4. 原只檢查state列舉，不能辨識假cold、錯誤mode／file或不合理deleted；新增階段與結果一致性檢查。不確定刪除回傳`deleted:null`，不是0。
5. 原installer反覆建立再刪舊Trigger；改為單一owner＋idempotent，重複Trigger／建立ACK不明停止，保留runBackup。移除函式在run flag OFF後仍可安全使用。
6. 刪除前最後HEAD完成時再次檢查本次容量trusted_until，避免請求途中過期仍刪除；失敗保留destructive pin，不強制清除。

## 永久保留的安全規則

- 十進位10,000,000,000 bytes管理預算，不是R2硬上限或帳戶免費額度保證。
- 9,000,000,000啟動；清至8,500,000,000停止；9,500,000,000拒絕新上傳。未可信／異常容量fail closed；恢復需低於90%重新可信盤點。
- 完成審核且completed／rejected／revoked，自結案時間滿7天；未結案、未審核、未滿7天不得刪除。
- Drive backup必須confirmed且沒有lease；重新讀取原bytes SHA-256及file／folder／root／來源／size／MIME／name完整驗證；HMAC／nonce／timestamp防偽造與回覆重播。
- A、B為不同HTTP invocation。R2原生checksum、ETag、version、size、MIME與D1案件／backup版本CAS、reservation、export占用、inventory pin、immutable audit全部保留。
- Drive備份永不因R2清理而刪除。刪R2不直接下修容量，必須經下一次完整inventory。

## 新隔離API協定

原server-only Bearer與Origin限制不變。`POST /api/internal/drive-backup/storage/archive`：

- 舊`{}`：原維護協定，行為保留。
- A：`{"canary":true}`。永遠只驗證，不會因已有ready結果而刪圖，也不自動接管deleting未知pin。
- A成功回傳`verification_ready`、`phase=verify`、`deleted=0`、`file_id`及`handoff`。
- handoff是`file UUID.claim UUID`，claim是A寫入cold_proofs的lease_token；不是物件金鑰／Drive ID，也不能取代Bearer或任何刪除驗證。
- B：`{"canary":true,"handoff":"<A回傳值>"}`。依既有file_id PK找到同一proof與claim；CAS只允許一個consumer。token不符／過期／context變更不會改選另一物件、不會自動改跑A。
- B成功cold後該claim失效。重複B不再刪除或重複寫terminal audit。

沒有新增表／欄位／索引：沿用0025 cold_proofs及0026 verification_context等欄位。
handoff查找的EXPLAIN是`SEARCH p ... (file_id=?)`及case_files id索引，不掃全部cold歷史。

Worker新隔離協定另須以下設定全部成立（本輪只在本機fixture配置）：

- `STORAGE_ARCHIVE_CANARY_ENABLED=true`
- `STORAGE_ARCHIVE_CANARY_ENVIRONMENT=isolated`
- `STORAGE_ARCHIVE_CANARY_ORIGIN`精確等於目前origin
- host以`voteproof-archive-canary-test-`開頭，僅接受小寫workers.dev origin，無自訂port／path／userinfo／alias
- 真正刪除仍需原`STORAGE_CLEANUP_LIVE_ENABLED=true`及既有可信容量／exclusive writer條件

Production不設新隔離flags；未符合時新payload為403。舊Worker會拒絕新non-empty payload，
新Script遇到該結果保留hold、不盲目改送舊`{}`。新Worker保留舊客戶端，但不得再使用舊Canary執行器冒稱這些新安全保護已存在。

## Script durable journal與操作回復

新增Script Properties：`STORAGE_ARCHIVE_CANARY_ORIGIN`、`STORAGE_ARCHIVE_CANARY_TRIGGER_OWNER`；
run flag為`STORAGE_ARCHIVE_CANARY_ENABLED`，環境必須isolated，既有origin／secret／root仍由Code.gs取得。
所有憑證只能安全配置於測試Script Properties，不放原始碼／對話／Repo。

`runStorageArchiveCanary()`取得ScriptLock後先檢查`STORAGE_ARCHIVE_CANARY_JOURNAL`。
存在任何journal（含malformed／舊資料）即operator_hold，0 HTTP。
送A前保存verify_in_flight；A成功後送B前保存delete_in_flight及file_id。
正常idle／target_reached／no_eligible／dry_run或同proof成功cold才清除journal。
網路失敗、ACK遺失、blocked／busy／unavailable／ambiguous／B找不到原claim均保留hold。
最多2次POST；不呼叫tick／inventory／archive以外的路徑，不讀圖片、不寄信、不自動retry。

**journal只約束此Script執行器，不是全系統刪除開關。** 持有合法relay secret的legacy controller
仍可呼叫舊維護API，所以正式預檢必須排除其他maintenance caller及其他帳號的隱藏Trigger。
Script API只能列出目前帳號可見Trigger，不能據此宣稱其他帳號沒有Trigger。

hold後先保持執行器OFF，唯讀核對目標cold_proofs、R2 HEAD、backup與audit。
不得為了重試清D1 pin／anomaly。只有Operator明確確認前次結果與下一次行為後，才可手動清理
Script journal／安裝pending標記；本版沒有自動resume或一鍵強制解除函式。
deleting未知pin的恢復沿用既有經審查Worker恢復協定，需要另行核准；Canary A不自動接管。

Trigger installer只允許指定單一有效帳號，已存在一個時no-op，發現多個或legacy
runStorageMaintenance則拒絕。建立前先寫pending，create ACK不明後不自動再建。
移除只碰本Canary handler；run flag OFF仍可移除，runBackup及tick-only Trigger保留。
本輪所有Trigger測試是VM mock，沒有真的安裝Google Trigger。

## 本機驗收與資源

- 真正本機Workerd執行目前Worker入口，使用全Migration鏈的新D1及原生R2，合成1／3／5 MiB PNG。
- Worker呼叫原Code.gs的VM；mock Google metadata／permission／media，真SHA/HMAC計算，非真Google E2E。
- 驗證A零DELETE、B同proof單次DELETE、D1 cold、confirmed backup留存、immutable audit、重播／並發、retention／threshold、lost ACK／commit故障／version、auth／RBAC／CSRF／Origin及後續全盤點。
- 不涉及前端UI，不需要瀏覽器回歸或完整CI；測試命令、Exit Code及原始證據隨完整ZIP交付。

小型單proof fixture每階段操作實測：A 9 statements／6 trips，22 Rows Read／10 Rows Written、2 R2 HEAD、1 relay；B 13／7，30／16、3 HEAD＋1 DELETE、0 relay。
Google VM於A執行4 metadata＋4 permissions＋1 media，B為0；沒有Worker收取完整圖片bytes。
原有ContentService redirect若發生，A的Worker HTTP還會增加一次GET，仍是同一A invocation；本機此fixture直接回覆200，不能把1 relay推估為正式永遠1 request。
這是小型本機D1 instrumentation（first使用all收集meta），不是正式計費／Worker CPU。
候選選取及占用guard仍受歷史案件、backup與export資料量影響，不能把小fixture讀列當成正式上限。

真實Cloudflare CPU P50／P95／P99／Max、記憶體上限事件、1102、缺失trace率全部UNKNOWN／未執行。
本機wall包含Node VM、通訊與profiling開銷，不得與10ms比較或判Cloudflare CPU FAIL／PASS。
不用舊archive或inventory traces填補新候選。後續需另授權受保護隔離Worker與有界樣本，分A/B報告
1／3／5 MiB、valid／missing traces、CPU分位、D1及R2操作，缺失不得填0。

## 正式 Migration／部署／回復計畫

1. 本候選不需要新Migration／回填／索引；正式仍須另授權唯讀確認0025／0026／0027及目前基準要求的0028實際存在、quick_check／FK、最新復原點、所有pin／reservation／anomaly、writer／multipart／在途PUT。
2. 先完成受保護隔離雲端CPU與真Google Drive私有root／file／folder／SHA／權限變更／失敗／replay實測。僅VM PASS不能代替。
3. 本基準採手動Drive查看方案：封存圖片私有API回410，ZIP匯出會拒絕cold scope，不是透明冷讀。正式前須Operator接受此既有產品行為，或另行授權安全冷讀／還原；不能本輪偷偷重做舊冷讀。
4. exclusive writer是必要前提，R2 DELETE沒有本版可用的conditional version transaction；最後HEAD→DELETE仍有外部writer風險。Drive owner亦可在A之後修改備份，120秒收據不是永久不可變保證，須保留與權限策略。
5. **此Script隔離-only，不能改ENVIRONMENT=production直接啟用。** 正式controller須另立候選審查，具精確origin、雙重Operator授權、單張／總量上限、持久暫停、單一帳號與其他caller排除。不得直接排程舊runStorageMaintenance。
6. 正式將來仍按來源CI／Production protections部署Worker，live／告警／投稿保持OFF；再更新經核准的正式Script，先dry-run，再限量正式canary，驗證後才另授權排程。每一正式寫入／設定／部署／Trigger均需單獨具體授權。
7. 失敗先停新controller／移除新Trigger，保留runBackup、tick-only、D1 schema／audit／pin、所有Drive備份。結果不明先唯讀核對，不能盲目重送或清除狀態。
8. Worker可提出回退到本基準的方案，既有schema相容；但R2已刪除不能靠程式回退或D1 Time Travel還原。Drive→R2回填需另授權、容量預留、bytes／checksum／身分核對與audit，現有版本沒有已驗收的一鍵還原；整庫回復不自動執行。

最終：本機候選可交GPT審查；**Production自動清理 NO-GO**，CPU／真Drive／正式controller及營運回復條件尚未完成。
