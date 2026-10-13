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
