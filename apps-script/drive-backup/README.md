# Private Apps Script Drive backup relay

The Worker keeps R2 authoritative and exposes a server-only pull API. A private,
standalone Apps Script runs as a dedicated backup Google account every five
minutes, claims at most one proof, reserves Drive identities in D1, streams the
private R2 proof through the authenticated API, uploads it, reads Drive metadata,
and sends a complete/failed receipt. No web-app deployment is required.

## Private project and root

Use a dedicated Google account and a separate Apps Script project. Copy `Code.gs`
and enable **Show appsscript.json manifest file** in project settings; copy the
checked-in manifest. Enable the Drive v3 advanced service, and the Drive API for
the associated standard Cloud project when applicable. Keep the script private.
Only this dedicated account should install its trigger: trigger enumeration is
scoped to the installing user, so a second installer can own separate triggers.

Exact scopes (no full Drive, Gmail, Calendar or unrelated scope):

- `https://www.googleapis.com/auth/drive.file`
- `https://www.googleapis.com/auth/script.external_request`
- `https://www.googleapis.com/auth/script.scriptapp`

Create the root **through this script**, so `drive.file` can access it; a manually
created arbitrary Drive folder might not be accessible. For an isolated test set
`ENVIRONMENT=isolated` and run `createIsolatedTestRoot()`. For separately approved
future Production setup use `ENVIRONMENT=production` and `createBackupRoot()`.
These helpers persist a reserved root ID before creating it and require an
owner-only private root. Production root name is **VoteProof Backup**. Neither
helper runs automatically. Do not call the Production helper during local work.
Inspect `ROOT_FOLDER_ID` in Script Properties; do not put IDs/secrets into source.
Leave Drive sharing **Restricted** and the script unshared. V1 never automatically
renames existing mapped folders or changes their permissions.

## Configuration and scheduling

Script Properties:

| Property | Value |
| --- | --- |
| `ENVIRONMENT` | `isolated` for connection acceptance; `production` only later |
| `VOTEPROOF_ORIGIN` | Exact reachable HTTPS origin, no path or trailing slash |
| `DRIVE_BACKUP_RELAY_SECRET` | Dedicated cryptographically random 32 bytes encoded as 64 lowercase hex characters |
| `ROOT_FOLDER_ID` | Script-created private root ID |
| `CLAIM_REQUEST_ID` | Managed by the script; do not clear while an ACK is uncertain |

Worker server-only configuration: `GOOGLE_DRIVE_BACKUP_ENABLED=true` and the same
`DRIVE_BACKUP_RELAY_SECRET` as a secret. No Google client ID, client secret or
refresh token is required. Absent/invalid relay secret is not configured; absent
or non-exact `true` enable flag disables backup. The transport defaults to
`apps_script_pull`. Never configure `worker_oauth_legacy` for this path.
Do not commit properties or use a real secret as a CLI argument/log value.

After an isolated manual run succeeds, `installTrigger()` removes every
`runBackup` trigger visible to that account and creates one five-minute trigger.
It preserves unrelated handlers. A script lock prevents overlapping runs and
installer races; D1's lease decides which receipt may read or mutate the job.
`removeTriggers()` disables this account's handler. A running invocation might
finish; disabling the Worker flag also rejects all new relay operations.

## Protocol and recovery

All endpoints require `Authorization: Bearer <relay secret>`, no browser Origin,
and exact request fields. Credentials are never redirected. Responses expose no
R2 object key, signed URL or permanent proof URL.

| Endpoint under `/api/internal/drive-backup` | Method | Purpose |
| --- | --- | --- |
| `/claim` | POST | `request_id` UUID and `root_folder_id`; idle or one job |
| `/{backupId}/identity` | POST | Persist generated file/campaign/date IDs before Drive writes |
| `/{backupId}/content` | GET | Lease and attempt headers; private R2 body with MIME/length |
| `/{backupId}/complete` | POST | Lease/attempt, IDs and exact metadata receipt |
| `/{backupId}/failed` | POST | Lease/attempt and allowlisted failure category |

Leases last 600 seconds. Active leases cannot be independently claimed. Lost claim
ACKs replay the stored request ID without consuming another attempt. Expired
leases below the existing maximum of eight attempts reclaim the same logical
proof and reserved Drive identities. Every claim also terminalizes at most one
expired processing lease at/above eight: failed, no retry, cleared lease fields,
existing sanitized error or INTERNAL. Repeated sweeps do not change terminal rows.
Callback failures use the existing exponential backoff with jitter and eight
attempt policy. Permanent provider/root/config failures can block the queue until
an administrator fixes configuration and explicitly retries. Retry resets the
receipt but preserves Drive IDs. Confirmed/failed callbacks retain the receipt
token for ACK replay, with no active lease expiration; terminal sweeps clear it.

Campaign identity is the campaign ID, mapped Drive ID, expected parent and hashed
folder-key appProperty. Display names are informational. A renamed campaign
reuses its existing folder. Reserved file IDs and folder mappings survive retries
and Worker/script restarts. Missing remote objects are created with those IDs;
existing objects are verified rather than recreated.

The script reads actual Drive metadata before completion. The Worker validates
its trusted authenticated receipt against pinned file/folder IDs, name, size,
MIME, parent and source/case/proof appProperties. It does not independently call
Google. Changed R2 size/MIME/ETag or mismatched case-file metadata is rejected.
No R2 delete, image transformation, hashing or full-buffer proof copy is added
to the Worker. Apps Script buffers the bounded maximum 5 MiB proof.

## Isolated real acceptance: manual gate

Automated tests use disposable local D1/R2 and mocks. They do not prove real
Google Drive preview/download, account authorization or quota headroom.

1. Run `node scripts/drive-relay-isolated.mjs`. It persists exactly one synthetic
   PNG/case/backup under gitignored `.wrangler/drive-relay-isolated/manual`, binds
   only `127.0.0.1:65011`, and denies all routes except authenticated relay and
   isolated controls. No Cloudflare API, Production D1/R2 or Google OAuth is used.
2. An operator must provide a temporary HTTPS tunnel to this **local** listener;
   Apps Script cannot reach localhost. Set only that HTTPS origin in the private
   test script. Keep Production URLs/config completely separate. No tunnel tool
   is automatically installed or started by this task.
3. Privately read `private-config.json` in that directory and copy its generated
   relay secret into Script Properties. Never send the secret to chat. Create the
   isolated script-owned test root; set the four configuration properties above.
4. Run `runBackup()` manually. Require `confirmed`, exactly one PNG, one campaign
   folder and one date folder in the root. Open the PNG preview and download it;
   compare bytes with the retained `synthetic.png`. Verify root Restricted.
5. Run again: no extra upload/file/folder. Restart the local Node listener with the
   same command and rerun: persisted D1/R2 identities remain, no duplicate.
6. To test callback ACK loss on a *fresh isolated fixture*, start with
   `--fixture=ack-test --port=65012`, use that fixture's secret and a new private
   test script/root. An authenticated POST to local `/__lose-complete-ack` arms
   one 503 after the server has confirmed. Run the script twice; the persisted
   request receipt must reconcile to confirmed without another Drive file.
   Authenticated `/__restart` restarts workerd; `/__status` reads sanitized local
   status/integrity. Use the secret privately as a header, never in the URL.
7. Only after these checks, optionally install the isolated five-minute trigger,
   observe two runs, then remove it. Keep test artifacts for review. Do not delete
   R2 data or test Drive files automatically.

Stop at this gate when operator installation/tunneling is unavailable. Report
real acceptance as **PENDING**, never replace it with mocked PASS evidence.

## Future one-proof Production canary (separate approval)

Require real isolated acceptance, reviewed local commit, backup/integrity baseline,
and explicit operator approval first. Future rollout must apply additive 0011
after 0010 and deploy the exact approved source with backups disabled. Production
setup creates the private dedicated-account root and private script, configures a
dedicated relay secret, and verifies the installer/scopes/account. No Worker Cron.
Use existing Admin MFA/CSRF-protected dry-run and enqueue with exactly one selected
proof ID; never bulk backfill. Enable briefly for one manual script run, read back
confirmed metadata/preview/download, replay and real CPU/D1/Apps Script timing,
then disable again. Do not enable submissions or mutate cases/points.

Disable/rollback: remove the script trigger, set Worker backup enable flag false,
and preserve D1 receipts, Drive IDs/files and R2 proofs. No schema rollback or data
deletion. Reverting Worker source after acceptance requires a separately approved
exact version; enabling old OAuth is explicit, never an automatic fallback.

## Query budget and current quota review

Measured application D1 statements, including every batch guard/cleanup statement:

| Request | Statements |
| --- | ---: |
| Idle / successful claim | 4 / 4 |
| Active / confirmed claim replay | 3 / 2 |
| Identity reservation | 6 |
| Content authorization | 1 (+ one private R2 get) |
| Complete / duplicate complete | 2 / 1 |
| Retryable failed / blocking permanent failed | 4 / 5 |
| Failed callback replay | 1 |
| Expired reclaim / exhausted terminalization | 4 / 4 |

Maximum measured is six, below the currently documented 50 D1 queries on Free
per Worker invocation. Statement counts are not row-read/write billing, CPU or
live Production measurements. Monitor those during any approved canary.
[Cloudflare D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

Reviewed 2026-10-13: nominal schedule 12/hour, 288/day, 8,640/30 days; completed
proofs can be lower because idle, retry, overlap and quota stops consume ticks.
Current consumer/Workspace Apps Script quotas respectively: URL Fetch 20,000 /
100,000 per day; trigger runtime 90 minutes / 6 hours per day; six minutes per
execution; 20 triggers per user/script; 50 MB URL Fetch response. A normal success
uses four relay fetches (1,152/day at 288 successes); cold Drive creation uses
about 11 API calls. Consumer daily trigger runtime would require an average below
18.75 seconds/tick to sustain every tick. Measure real duration; no throughput
guarantee. These limits may change without notice and are shared per account.
[Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas),
[installable triggers](https://developers.google.com/apps-script/guides/triggers/installable).

Drive's current model varies by project history: the May 2026 changes use quota
units and per-minute project/user limits; older active projects can retain prior
quotas. Consult the actual project console for read/create operations, storage,
rate limits and upcoming billing; never assume the former request-count limits
or automatically increase quota/billing. Retries happen on later ticks.
[Drive usage limits](https://developers.google.com/workspace/drive/api/guides/limits).

## Legacy decommission candidates

Legacy remains deprecated and disabled by default. Only the explicit
`DRIVE_BACKUP_TRANSPORT=worker_oauth_legacy` path can schedule/process directly.
After Apps Script Production acceptance and a separately approved rollback
decision, candidates include `scripts/google-drive-oauth.mjs`, the direct
executor/client portions of `src/lib/proof-backup-processor.js` and
`src/lib/google-drive.js`, legacy comparison tests, and Worker-held
`GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`,
`GOOGLE_DRIVE_REFRESH_TOKEN`, `GOOGLE_DRIVE_ROOT_FOLDER_ID`. Shared constants,
error types and routing helpers still used by the relay need extracting first.
Do not delete or rotate existing Production credentials in this task.

## 獨立 R2 分段盤點（2026-10-19，本機候選，尚未啟用）

新增 `StorageInventory.gs`，放在既有備份 Apps Script 專案，沿用
`Code.gs` 的 HTTPS relay helper、`VOTEPROOF_ORIGIN` 與
`DRIVE_BACKUP_RELAY_SECRET`。沿用已配置的 Drive v3 與 `drive.file` scope，
只讀 `About.get({fields:'storageQuota'})` 的帳號配額 metadata；不需要
ROOT_FOLDER_ID、圖片 bytes、新 Secret 或新增 OAuth scope。
本輪新增 additive migration `0027_storage_inventory_phases.sql`，只增加 nullable
`storage_capacity.inventory_phase`，須先由本機／隔離驗證，正式套用另需批准。
既有 manifest 與 `runBackup` 完全不變。

- `runStorageInventory()` 每輪先讀一次配額，POST 既有 `/storage/quota`，再
  POST `/api/internal/drive-backup/storage/tick` 保存 R2 分頁進度；tick body
  固定 `{ "inventory_only": true }`。新 Worker 模式保留原有 relay
  authentication、容量檢查、D1 CAS／scan pin／history／audit；此模式每頁 50
  物件，完整沿 cursor 掃描，Admin／舊模式仍每頁 200。
  第一段只更新累計與 scan／ready 狀態，永遠 `complete:false`；最後一頁也
  不發布 used_bytes、信任期限或解除封鎖。到 ready 後，再以**獨立 HTTP**
  POST `/api/internal/drive-backup/storage/inventory/finalize`，只傳 server 回覆的
  `inventory_id`／`inventory_version`。第二段不 LIST R2，以同一 guarded D1
  transaction 提交容量、history、immutable audit、95%／90%／85% 規則與去重 outbox，
  才回 `complete:true`；
  但明確跳過 alert delivery，回傳 `inventory_only:true`、`cleanup:null` 與
  `alerts:{state:"skipped_inventory_only",sent:0}`。即使告警 flag 意外 ON，
  此模式也不寄信；容量門檻仍可能建立去重的 alert outbox，並非寄送。
- 不呼叫 archive、Drive.Files、Drive.Permissions 或 MailApp；不呼叫既有
  `runStorageMaintenance`。不能把後者安裝成這次的盤點排程。
- `inventory_phase` 為 NULL（legacy）、scan 或 ready，ready 必須有 pin 且
  cursor=NULL。新 API 不接手尚未完成的 legacy scan；先用舊流程完成。
  phased scan 不能由 legacy API 完成；schema CHECK 也會拒絕舊程式直接清除 pin
  卻留下 phase。不能手動清 pin／偽造 ready。
- scan ACK 遺失後依 D1 cursor／version 續跑；ready 的 tick 重複讀取不再 LIST。
  finalize 的 ID／version／phase 必須吻合，且 reserved=0。history 與 audit 是
  同一 commit 的持久收據；重複 finalize 回傳 replay，不重計、不重複 audit／outbox，
  **不延長 trusted_until**。若 finalize 已提交但 Apps Script 未收到 ACK，下一輪
  也可能開始新的完整掃描，仍不會重複加總。任何未完成 scan／ready 均保留 pin、
  trusted_until=0，現有 PUT guard 與管理摘要仍視為封鎖，並非靠暫時變更 blocked
  產生假的 recovered 告警。
- 配額只傳 id、observed_at、state、total_bytes、used_bytes，不傳 Google
  identity／OAuth token。沒有上限回 `unlimited`；缺少數據回 `unknown`；
  API／權限／服務停用或不合目前接收 contract 的數字回 `error`，不偽造 0。
  error／unknown 也送快照，後台可顯示資料時間與異常。配額 POST 未成功或
  數據不可用時仍繼續 R2；R2 完成但配額不可用回 `partial`，不虛報整體成功。
  配額只讀一次，不隨每個 R2 page 重讀。Google metadata 延遲不消耗 R2 的
  60 秒軟預算；Apps Script 平台的整體執行時間上限仍適用。
- 使用 `LockService.getUserLock()`，避免同一執行帳號重疊；不占用
  `runBackup` 的 ScriptLock。**只允許同一個安裝帳號維護此 trigger**。
  不同使用者的 UserLock 不互斥；跨帳號／Admin 併發仍由 Worker 的 D1 CAS
  防重複累計，不能因此宣稱全專案鎖定。不要由多個帳號重複安裝。
- 每次依序呼叫 tick，直到 `inventory.complete === true`。不保存或自行
  傳 cursor；D1 決定續跑位置。最多 50 頁（2,500 物件），60 秒是兩次
  scan request 之間的軟預算，不是 UrlFetch 的硬 timeout。最多另加一次 finalize
  request；若最後一頁已達時間預算，保留 ready 到下一輪。達預算回 `incomplete`，
  下一輪繼續；不把部分成功當完整盤點。
- R2 tick 網路、權限、舊 Worker、不合格式回覆均停止本輪；不做即時重送或 `{}`
  fallback。只輸出 sanitized state/pages/code，不寫備份的 CLAIM_REQUEST_ID。
  已開始但未完成的掃描保持 pin 與 `trusted_until=0`；若請求根本沒到 Worker，
  原可信期限仍照既有 600 秒到期封鎖。若最終 ACK 遺失但 Worker 已完成，
  下一輪可能啟動新掃描，並不重複加總。anomaly 保持鎖定，不強制修正 D1。

### 必須另行批准的最小啟用順序

1. 另獲正式 migration 授權後套用 0027；核准新 Worker SHA，依既有 Production
   workflow 發布兩段 API，保留所有現有 Vars／Secrets／Bindings。
   **目前正式舊 SHA 不支援這個 body／finalize；不可先安裝 trigger。**
2. 專案編輯者只新增 `StorageInventory.gs`，保留 Code.gs、manifest、Script
   Properties、既有 backup trigger 與 Web App deployment。這個排程函式不需
   重新發布既有 cold-read Web App。安裝帳號使用既有 external_request 與
   script.scriptapp scopes；不增加 Drive／Email 權限。
   Worker 沿用 `authenticateRelay`／`requireBackupReady`：既有備份服務若停用，
   tick 也會拒絕，可信期限失效後封鎖；安裝函式不會自行開啟任何 Worker flag。
3. 由唯一安裝帳號手動跑一次 `runStorageInventory()`，確認 `complete`、
   history/audit、fresh trusted_until、Drive 配額快照已接收與剩餘比例，
   無 archive／mail／Drive 圖片操作。
4. 另獲正式 Trigger 授權後，執行 `installStorageInventoryTrigger()`。
   它先建立一個每 5 分鐘 trigger，再刪除此帳號可見的同名舊 trigger；
   不刪 runBackup 或其他 handler。先檢查沒有未批准的 legacy maintenance
   trigger；不要自行變更其他帳號的排程。
5. 觀察至少兩次真實執行及實際耗時、CPU、quota。Apps Script 為時間驅動
   排程，延遲、停用、配額耗盡都可能使 freshness 失效；5 分鐘不是硬 SLA。

停用：只執行 `removeStorageInventoryTriggers()`；不改 runBackup、資料、
secret、Google Drive 或清理設定。停用後容量會依原有期限失效而封鎖 PUT。
若仍有 phased pin，應保留新 Worker 安全續跑完成後再評估回退；不以刪 schema、
清 pin、重設 anomaly 或偽造容量回復。

### 操作量、Free CPU 與剩餘啟用條件

隔離測試涵蓋真實 storage handler + relay auth + 本機 D1：正常低於 90%、
沒有 reservation／anomaly／恢復事件時，P 頁完整掃描共 `2P+7` statements、
`2P+3` trips、P+1 次 Worker request、P 次 R2 LIST。實測 P=1 為 9/5/2；P=3 為
13/9/4，initial／warm 一致。scan 首頁 3 statements／3 trips，後續頁各 2／2；
finalize 6／2、0 R2。容量預檢共用同一次 server-read row，沒有跳過。
每輪另加一次 quota request：1 INSERT／1 trip。
合計 `2P+8` statements、`2P+4` trips、P+2 次 Worker request；
P=1 合計 10/6/3。這不是 D1 計費 rows read/write。

目前 34 個物件為一頁。每 5 分鐘名目上 288 次／日：URL Fetch、Worker
request 各 864／日；R2 LIST、Drive About.get 各 288／日（8,640／30 日），
D1 statements 2,880／日、trips 1,728／日。沒有 Drive 圖片傳輸或 Email。
R2 完整快照、audit、Drive quota 快照各增加 288 筆／日。
若 Bucket 增長，按頁數線性增加，不是永遠一個
request。異常／重試／既有服務用量另計。

官方額度（2026-10-19 查閱）：Workers Free 100,000 requests／日、10 ms CPU
／request；R2 Standard Class A 1,000,000／月；Apps Script consumer URL Fetch
20,000／日、trigger runtime 90 分鐘／日、每次最長 6 分鐘。這些額度由帳號
共用，包含 runBackup；不可只看盤點函式就保證整個帳號不超額。以 consumer
全部 trigger runtime 計算，288 次盤點若獨占額度平均也須低於 18.75 秒，
實際還必須為備份等工作保留餘裕。D1 quota 按 rows，不按上述 statements。

**2026-10-20 最新A page-CAS優化：功能／安全90 PASS，隔離Workers Free CPU PASS。**
只改A單列累計為具完整ID/version/phase/reservation條件的原子UPDATE RETURNING，
省去通用交易guard的INSERT/DELETE；B未修改。沒有採用額外pending-page第三段。
一輪160請求：A120/120有效，CPU P50/P95/Max=5/7/8ms；B40/40，3/5/5ms，
兩路收集器各自完整，0缺失、0超限、0 HTTP1102，40輪容量對照全相同。
測試Worker／D1／R2均已清理。達標後依授權Commit/Push開發分支，Production未動；
不表示未來零CPU尾端，也未授權正式Script／Trigger發布。
詳見[最新量測與發布界線](../../docs/storage-cold-v1.md)。

**2026-10-20 前輪分段請求：功能／安全 PASS，Workers Free CPU FAIL，當時未 Commit／Push。**
一輪隔離 160 個 HTTP：A scan 119 有效／1 缺失，CPU P50/P95/Max=5/7/13 ms，
1 筆超過 10 ms；B finalize 39 有效／1 缺失，3/5/6 ms。HTTP 200、0 1102，
40 輪結果全部與 legacy 容量相符。CPU 為兩路原生 tail 按 sample ID 合併；
WS 斷線，CLI 補回 8 筆（含 13 ms），其餘 2 筆 UNKNOWN，未補測。
只使用 WS 的初版 summary 已保留並更正，不能引用其 Max=8 作為 PASS。
超限發生中間 scan 頁，拆 claim 不能直接解決該觀測；本輪停止調校。
臨時 Worker／D1／R2 已清理，Production／正式 Script／Trigger 未動。
新 Apps Script finalize 編排本輪僅本機測試，前輪真實 Google 結果不等於新編排已驗收。
詳見 [分段量測報告](../../docs/storage-cold-v1.md)。

**2026-10-19 前輪單次請求基線：Workers Free CPU readiness 為 FAIL。**
每頁改為 50 並省一個容量 SELECT／trip；34 物件 30 次與 201 物件 30 次完整盤點，
共 180 個 invocation：83 筆有效 CPU / 97 缺失，合併 P50/P95/Max=7/10/16 ms，
4 筆 >10 ms。沒有 1102，不能因此判 CPU PASS。原始 WebSocket／Wrangler CLI
收到相同 sample 集合，無解析錯誤；設定 head sampling=1 仍缺失，平台內部
交付／抽樣根因未證實。持久日誌 API 現有 OAuth 回403，沒有自行擴權。
小型測試 budget SQL／log 負擔包含在內，未扣除；wall time 不代替 CPU。
本輪與歷史原始證據見
[量測報告](../../docs/storage-cold-v1.md)。臨時 Worker／D1／R2 已清理。

獨立 Script 已實際執行 About.get、寫入隔離 D1 3 筆 known 快照、3 頁盤點、
1 頁預算停止及剩餘 2 頁續跑，整組約 11.766 秒；runBackup idle 正常。
一次性真實 Trigger 持鎖時回 overlap_skipped，沒有呼叫 archive 或讀寫 Drive
圖片。測試 helper 的已停用一次性 trigger 清理例外另記於報告；UI 清除後
0 triggers。沒有正式 Script／Trigger 變更，沒有長期測試排程。
本機與 Google 功能 PASS 不代表可直接裝正式 trigger；目前仍受 CPU 阻擋。

本輪 A 階段 CAS 優化相關測試 90 項 PASS：Apps Script inventory 33、tick 21、既有 backup 9、
容量／安全回歸 22、trace framing／配對及雙端統計 4、populated 0027 migration 1。
測試使用本機 D1／R2 fixture
及 VM Google service mocks，不是 Google 真實端對端或 Cloudflare CPU 實測。
`git diff --check` 與 Worker JS syntax check PASS。

正式唯讀查核（2026-10-19）：`drive_quota_snapshots` 0 筆；未授權 quota
POST 回 401/RELAY_AUTH_REQUIRED，未寫入正式 D1。服務帳號的正式
`VoteProof Production Backup` 主程式沒有 `Drive.About.get` 或
`/storage/quota` 呼叫；manifest 已配置 Drive v3 及上述 scopes。
本輪未執行正式 storageQuota 讀取或合法快照 POST，實際端對端仍未驗證。
正式 Script 原始碼、Trigger、Worker 及資料均未變更。

參考：[Apps Script quotas](https://developers.google.com/apps-script/guides/services/quotas)、
[UserLock 語意](https://developers.google.com/apps-script/reference/lock/lock-service)、
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)、
[R2 pricing](https://developers.cloudflare.com/r2/pricing/)、
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)。
`about.get` 支援既有 `drive.file` scope：
[Drive API v3 about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get)。
