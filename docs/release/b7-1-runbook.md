# B7.1 Release blocker closure

Global gate amendment: the next candidate adds [submission gate](../submission-gate.md)
and migration 0008 (default OFF). Historical 0001–0007 remain unchanged. Extend
the staged migration sequence with migrate-0008 and verify the setting is OFF,
audit empty and all six gate/audit triggers present. New submissions must remain
closed through new Worker deployment, real admin/Campaign bootstrap and live
acceptance; an authorized MFA admin enables them explicitly afterward. During
0008-before-deploy, old B1–B3 new case/complete inserts intentionally fail closed;
lookup/auth-independent reads remain intact. The previous frozen RC is superseded
only after the separately reported local commit and freeze. No rollout is authorized.

Mail transport amendment: the current local candidate uses [MailApp relay](../mail-relay.md), not the historical Gmail OAuth send path described below. Active mail gates require MAIL_RELAY_URL / MAIL_RELAY_SECRET (Worker-only Secrets), 60/80 limits, safe hosted redirects and real registration acceptance. Retain all historical Gmail settings/release artifacts for rollback; sender-client/lifetime sections below apply to that rollback only. Do not rotate/delete credentials or run any Production command as part of the relay integration. The previously frozen B7.2 candidate must be re-frozen after this change.

Baseline: `4bf8e2c0df2f5763e8a3970839fb7a2b7c136625`. Production remains B1–B3 / migrations 0001–0002. **Planning only: none of the operational commands below has been run.** B7.1 adds offline operator artifacts/tests, not Worker/UI/schema changes. No commit, push, deploy, remote migration, Production cleanup, provider changes or Secret rotation is authorized by this document.

B7.2 authorizes one LOCAL release-preparation commit after file classification and safety review. It does not authorize any Production command. The exact resulting commit and post-commit regression results are reported separately; do not confuse the historical baseline above with the frozen candidate.

## Decision sheet — operator must approve, not inferred by tooling

|Item|Recommendation / required operator entry|STOP condition|
|---|---|---|
|Legacy acceptance case|Approve future exact D1 + R2 cleanup after backup, or explicitly preserve it as read-only legacy|No cleanup approval; inventory changed; preservation without review policy|
|Real first campaign|Supply real campaign metadata and appoint active MFA admin; create before declaring submissions open|Missing data, invalid/future/expired window, or no currently active campaign|
|Leaderboard continuity|No import of unproven aggregates; announce D1 ledger starts independently and publish real definitions/snapshots|No approval of cutover/notice; pretending old history equals zero|
|Provider / sender evidence|Read hosted exact-state checklist, match OAuth clients, confirm prior exposed credentials rotation, and Gmail grant lifetime|Unverified hook/callback, client collision, unresolved compromised credential or sender grant|
|Release operator|Choose first admin member/role/ticket, backup location, maintenance window, restore result and deployment gate evidence|No authorized human owner / recent VoteProof MFA / actual gate evidence|

These are operator facts/decisions. The runtime code does not need a new auth architecture or a legacy Campaign fabricated to launch. The admin bootstrap and local rehearsal tooling below close the earlier missing-tool gap; their real operator execution remains pending.

## A. Proven legacy artifact and controlled cleanup

B7.1 read-only D1 comparison matched the exact public case_id in gitignored `.wrangler/b3-production-result.json`, whose release is `de6e15f25cf94c66df92d7d179bda589f2f848af` and which records a successful B3 Production acceptance flow and deliberate retention of one acceptance case / one private proof. Current D1 has the same single Guest pending case, Campaign label `B3-PRODUCTION-ACCEPTANCE`, zero points, one case_file and one completed_upload_file. This is stronger evidence than merely guessing from its Campaign name. A private, exact inventory was prepared at `.wrangler/b7.1/legacy-inventory.json`; its keys/ETags are not in Git or this report.

Recommendation: remove this demonstrable acceptance artifact only after explicit approval and backup. **It has not been deleted.** Current R2 physical existence is not inferred solely from D1; confirm each exact object before cleanup. The old acceptance report says its consumed staging object was already removed, so a missing staging object is expected and not a reason to sweep a prefix.

An exact offline plan for this private inventory is now prepared at gitignored `.wrangler/b7.1/prepared-legacy-cleanup.sql` with its private `.sql.r2.json` companion. No SQL/R2 operation was executed. B3's final proof prefix uses the **internal case UUID**, not the public case_id; the builder checks that UUID and the exact case_file UUID/extension. Re-inventory/review/backup/approval are still mandatory before using any prepared plan; the future command below deliberately writes a separate new file and refuses overwrites.

Future controlled procedure:

1. Freeze/drain case writes for the cleanup window; take full D1 export and private R2 proof backup. Re-read the case inventory and compare public case ID to the original acceptance report, internal ID/session, status, zero points, Guest ownership, counts, exact keys/size/ETag. STOP on any change. Keep the original inventory and backup privately.
2. Prepare SQL only, with explicit Production identity. The generator never calls Wrangler, D1 or R2:

```powershell
node scripts/prepare-release-plan.mjs --kind legacy --input .wrangler/b7.1/legacy-inventory.json --output .wrangler/b7.1/legacy-cleanup.sql --target production --database voteproof-cases --confirm-database-id 9e2b885d-66e2-4e4d-b768-4bded261296a --confirm-cleanup-plan PREPARE_ONLY_NO_EXECUTION
```

3. Review the private SQL and companion `.sql.r2.json`, recheck database binding, and obtain cleanup approval. The SQL has a CHECK guard for exactly the acceptance case/count/ownership/state/object metadata. In one SQL-file transaction it deletes case_files and case_idempotency, clears completed_uploads' case FK, deletes the case, deletes only its upload_files/upload session, and drops the guard. No schema/migration or unrelated row is deleted. Guard/write failure rolls back the file. This cleanup is for the B3 acceptance artifact **before** new reviews/ledger writes, not generic production case removal.
4. Only after approval:

```powershell
$cleanupApproval = Read-Host 'Approved exact acceptance cleanup: type DELETE_VERIFIED_ACCEPTANCE_ONLY'
if ($cleanupApproval -cne 'DELETE_VERIFIED_ACCEPTANCE_ONLY') { throw 'STOP_CLEANUP_NOT_ACKNOWLEDGED' }
npx wrangler d1 execute voteproof-cases --remote --file .wrangler/b7.1/legacy-cleanup.sql
npx wrangler d1 execute voteproof-cases --remote --command "SELECT COUNT(*) AS cases FROM cases; PRAGMA foreign_key_check; PRAGMA quick_check;" --json
```

5. DB deletion first, then R2: verify no case_files/completed_upload_files row refers to either exact manifest key; privately back up/check any present R2 object. Delete **only** companion-file keys from `voteproof-proofs`, never a prefix or all objects. Use a trusted terminal, keep keys out of shared logs. The following captures CLI output rather than echoing private keys:

```powershell
$objects = Get-Content .wrangler/b7.1/legacy-cleanup.sql.r2.json -Raw | ConvertFrom-Json
if ($objects.bucket -cne 'voteproof-proofs' -or $objects.keys.Count -ne 2) { throw 'STOP_INVALID_INVENTORY' }
if ((Read-Host 'After backup and DB no-reference checks, type DELETE_EXACT_REVIEWED_R2_KEYS') -cne 'DELETE_EXACT_REVIEWED_R2_KEYS') { throw 'STOP_R2_CLEANUP_NOT_ACKNOWLEDGED' }
# First independently verify the companion file's keys, DB no-reference query,
# object metadata and backups. Then obtain the separate cleanup approval.
foreach ($key in $objects.keys) {
  $objectPath = $objects.bucket + '/' + $key
  $privateOutput = & node node_modules/wrangler/bin/wrangler.js r2 object delete $objectPath --remote 2>&1
  if ($LASTEXITCODE -ne 0) { $privateOutput=$null; throw 'STOP_R2_CLEANUP_REQUIRES_RETRY' }
  $privateOutput=$null
}
```

The loop is not an authorization check: manifest review/no-reference checks/backup are mandatory preceding STOP gates. If R2 deletion fails, leave the precise orphan-key record privately and retry only those keys; do not re-delete unrelated D1 data. Verify absence and final counts/FK/quick; preserve audit/approval evidence outside business immutable tables. R2/D1 cannot be one cross-service transaction; D1-first avoids destroying proof for a case whose DB deletion failed.

If operator chooses preservation: keep its query/private proof unchanged, no points, no fake Campaign, no silent approve/reject. New approval still returns `CAMPAIGN_NOT_REVIEWABLE`. Current accepted frontend contains **no admin UI** (the deployed old page's “Super Admin demo” is not real authorization). Smallest treatment is an explicit private operator legacy-exclusion list, keeping this case out of actionable approvals; a future admin UI must label it “legacy: read-only / not eligible for approval” and disable approve. No runtime patch is required if cleanup is selected; a general legacy-approval policy is a separate source change, not silently done in B7.1.

## B. First campaign — blank real-data template

Copy `docs/release/campaign-input.template.json` to a gitignored/private operator input. It contains null placeholders only; none is runnable until filled.

|Field|Requirement / exact validation|
|---|---|
|actor_member_id|Existing active `M-<UUID>` administrator with VoteProof TOTP and recent MFA; not email|
|reason|Nonempty operator ticket/reason, <=500 Unicode characters, no controls/Secret/URL|
|campaign_id|required immutable ASCII `[A-Za-z0-9][A-Za-z0-9_-]{0,99}`; new unique ID|
|name|required trimmed 1–100 Unicode characters; no controls; real activity title|
|category|required trimmed 1–50 chars, no controls; real business classification|
|start_at/end_at|required exact UTC `YYYY-MM-DDTHH:mm:ss.sssZ`; valid year 2000–9998; start < end|
|campaign_timezone|optional in API (default UTC); prefer explicitly approved valid IANA timezone; <=100 chars|
|points_per_proof|required integer 0–1000000; do not choose it for the operator|
|daily_limit|required integer 0–1000; **0 means no proof awards, not unlimited**|
|status|required `draft` or `active` at create; operator chooses; `active` also needs start<=now<end to accept submissions|
|note|optional null or nonempty trimmed text <=1000 chars, no controls|

Server derives vote_start_date and vote_end_date in the approved timezone; end is exclusive, so vote_end_date uses end_at minus 1ms. Do not enter derived dates, version, actors/timestamps or mutation IDs manually. Voting target / eligibility are **not dedicated machine-enforced fields in this schema**; category/note cannot be falsely presented as an eligibility engine. If launch needs rules beyond current Campaign/time/MIME/review limits, STOP for product/source review.

There is no accepted Admin UI to create Campaigns. Preferred normal mechanism after deployment is secured `POST /api/admin/campaigns`, using VoteProof session + exact Origin + X-CSRF-Token + active admin/super_admin + recent MFA; the backend executes guarded D1 batch and audit. A controlled private API client is appropriate, not the old demo UI.

The offline D1 alternative reuses `campaignInput()` and generates fixed, escaped SQL with the same actor/MFA gate and atomic Campaign + campaign_create audit:

```powershell
node scripts/prepare-release-plan.mjs --kind campaign --input .wrangler/b7.1/campaign-input.json --output .wrangler/b7.1/campaign-bootstrap.sql --target production --database voteproof-cases --confirm-database-id 9e2b885d-66e2-4e4d-b768-4bded261296a
# STOP: review input, SQL, exact DB identity, recent MFA and operator approval.
npx wrangler d1 execute voteproof-cases --remote --file .wrangler/b7.1/campaign-bootstrap.sql
```

Duplicate IDs fail without update/replace. After approved create, GET campaigns must show at least one genuinely open activity before release. Draft/future/closed data does not satisfy that gate. Points arise only from future approved lifecycle transactions; bootstrap never invents awards.

## C. Leaderboard continuity, based on current live read-only inspection

Today the Production homepage is the old inline **demo** frontend: no fetch(), no `/api/leaderboards` call, with demoBoards/示範資料. Its visible rankings are static UI examples. The separate public API is a B1 adapter using the secret Apps Script URL with `action=leaderboards`, public-field normalization and 30-second cache.

B7.1 GET API returned five boards, timestamp `2026-10-08T00:41:03+08:00`:

|ID|Name|Rows|
|---|---|---|
|LB-HISTORY|歷史累計排行|3|
|LB-CB2026|本次回歸排行|3|
|LB-GROUP|團體排行|1|
|LB-SOLO|Solo排行|3|
|LB-CUSTOM-001|10月第一週 Solo 排行|3|

Rows have rank/member_id/nickname/points/proof_count/reached_at. Repository does not contain the authoritative Apps Script ledger/award history or a verified mapping from these external member IDs to Supabase UUID / new VoteProof member_id. “points” as a field name and a board labelled “歷史累計” are **not proof of compatible lifecycle semantics**. We cannot establish whether the underlying API figures are real historical awards or fixtures merely by this response. The homepage demonstrably uses examples independently.

Recommendation: no aggregate import into D1 points, no direct results insertion, no historical zero claim. Announce a fresh D1 ledger cutover and publish only results rebuilt from point_transactions. Preserve old Apps Script/service/config for rollback; do not delete it. Suggested operator-approved launch notice:

> 排行榜改由 VoteProof 點數帳本產生。舊頁面示範排名與舊來源榜單尚未匯入，新榜將在正式發布成績快照後顯示。這不代表歷史成績為零。

The existing empty UI already renders no fabricated rows, but cannot communicate all cutover context; publish this notice via an approved launch communication, or approve a minimal copy-only UI patch separately. This phase does not silently choose a new season title/date or alter the homepage. If future evidence proves import compatibility, require source transaction history, member UUID mapping, net revoke/proof counts, timestamps/scope and independent reconciliation before designing a separate ledger import. Never turn unrelated rank totals into manual awards just to populate a chart.

After real data decisions: create approved definitions through `/api/admin/leaderboards`, rebuild via `/:id/rebuild`, and verify active/public/successful snapshot. Only unfiltered all-time includes current scopeless manual adjustments; no results mutation API. Empty/new ledger cannot be sold as migration of old history.

## D. Hosted Supabase exact-state checklist (read, do not change)

Project: `https://bcezasxxirznpojfrmol.supabase.co`, already shared with B4G-Live and the future Production Worker. Do not recreate users/providers or repeat setup blindly.

- Authentication → settings / User Signups: Allow new users to sign up **ON**.
- Authentication → Sign In / Providers → Email: provider **ON**, Confirm Email **ON**.
- Same provider list → Google **ON**; Anonymous **OFF**.
- Authentication → settings / identity linking: manual identity linking **OFF** (only automatic verified-email reconciliation used by this code).
- Authentication → Auth Hooks → Before User Created: **enabled**, Postgres function `public.voteproof_signup_policy`.
- Authentication → URL Configuration → Site URL: `https://voteproof.i-dle-melon.workers.dev`.
- Redirect URLs must include exactly `https://voteproof.i-dle-melon.workers.dev/api/auth/google/callback?state=*`; no broad Production /** wildcard. Inventory existing valid entries before choosing dev-entry removal. B7.1 does not remove localhost entries.

Public settings GET confirms the first five ON/OFF states except manual linking/hook/URL configuration, which require operator inspection. In SQL Editor **read-only** compare:

```sql
SELECT pg_get_functiondef('public.voteproof_signup_policy(jsonb)'::regprocedure);
SELECT has_function_privilege('supabase_auth_admin','public.voteproof_signup_policy(jsonb)','EXECUTE') AS auth_can_execute,
       has_function_privilege('anon','public.voteproof_signup_policy(jsonb)','EXECUTE') AS anon_can_execute,
       has_function_privilege('authenticated','public.voteproof_signup_policy(jsonb)','EXECUTE') AS authenticated_can_execute;
```

Canonical `docs/voteproof-signup-policy.sql` remains unchanged and matches accepted live policy: actual JSON is_anonymous=false AND (provider google OR provider email + **app_metadata** boolean voteproof_verified_signup=true). Reject public Email, user_metadata forgery, string "true", anonymous/malformed input. auth_admin execute true, anon/authenticated false; no PUBLIC execute; empty search_path/security invoker. Admin create may bypass Before User Created in inspected official behavior; successful Admin registration alone does not prove the hosted marker branch exists. Do not copy user_metadata into this trust decision. [Supabase hook contract](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook).

## E. Google Login exact-client identification and production policy

The repository intentionally contains **no Google Login client ID/secret**; these live in Supabase provider settings. Name “VoteProof Google Login” is the intended label, not independently verified as the currently configured actual client. Exact matching procedure:

1. Supabase Authentication → Sign In / Providers → Google: privately record the enabled provider's **Client IDs** value.
2. Google Cloud → correct project → Google Auth Platform → Clients: open the Web OAuth client whose **Client ID exactly matches**. Record project/client label and matching=true, not credentials in shared evidence.
3. Separately compare sender GMAIL_CLIENT_ID from the operator vault with the sender's client. Require different client IDs; record if their projects/audience are shared. Do not assume client separation proves project separation.

Expected Google Login settings: JavaScript origin `https://voteproof.i-dle-melon.workers.dev`; Google authorized redirect `https://bcezasxxirznpojfrmol.supabase.co/auth/v1/callback`; actual Worker requested scopes **openid email profile**. No Gmail permissions or Google password handling. Public audience expected External; Internal cannot serve arbitrary personal Google accounts.

**Correction to over-broad Testing assumptions:** official Google Audience docs exempt requests using only basic profile/email/openid from Testing's trusted-user-list/warning/seven-day-authorization behavior. Ordinary Testing scopes otherwise allow at most 100 listed test users. Therefore In production is recommended public-release policy, but **Testing alone is not proof that this pure OIDC login is blocked**, nor a mandatory sensitive-scope verification requirement. Confirm actual requested scopes/provider configuration first. Basic non-sensitive-only login does not require sensitive-scope review; branding name/logo or other project configurations can require separate review. [Google Audience exact exceptions](https://support.google.com/cloud/answer/15549945?hl=en), [Google non-sensitive verification guidance](https://support.google.com/cloud/answer/13463073?hl=en).

Future operator action: choose documented public audience/publishing policy, accurate Branding/support/privacy, exact production URLs, and ensure no unexpected additional scopes. Do not change them here. Post-change smoke: controlled allowed Google user completes chooser→Supabase→exact Worker callback, VoteProof session, no normal-member TOTP; logout/repeat same UUID/member; dual password/TOTP resolves same profile/cases/points/tier; admin remains MFA-gated. If choosing Testing under the documented OIDC exception, include a controlled non-test-listed allowed account to verify actual behavior, without bypassing Google protections.

## F. Gmail sender productionization — zero-secret procedure

Sender `idle.voteproof.verify@gmail.com` is the only account intended to grant Gmail access; recipients do not OAuth-authorize their mailboxes. Sender uses its own client/grant, separate from Google member sign-in. Source requests/sends using gmail.send only; that scope is **Sensitive**, not Restricted. [Gmail scope classification](https://developers.google.com/workspace/gmail/api/auth/scopes).

External + Testing Gmail grants get seven-day refresh tokens; pure OIDC exception does not apply. In production removes the Testing issuance rule but does not make tokens immortal: revocation, Gmail password changes, unused grants and token limits can invalidate them. Google does not promise that flipping Publishing Status retroactively upgrades a token minted in Testing. Fresh reauthorization is the safe release procedure when grant provenance/lifetime is unproven; not a reason to rotate the client secret unnecessarily. [OAuth lifetime rules](https://developers.google.com/identity/protocols/oauth2).

Verification for this specific use cannot be conclusively selected from repository data. A sole sender operator granting access may fit Google's personal/small-known-user exception; public VoteProof membership does not itself mean every member requests Gmail scope. Conversely, we cannot claim exemption is guaranteed just because only one mailbox sends. Operator must confirm the actual grant audience, Google project use and applicable verification/exemption. If all users may grant Gmail in some other use of the same app/project, sensitive-scope review applies unless an official exception covers it. No restricted Gmail read/modify scope or security-assessment requirement is introduced by this send-only implementation. [Official sensitive-scope exceptions](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification).

Future procedure, no values in chat/Git/CLI arguments:

1. Record sender client/project, Gmail API enabled, requested scope gmail.send, Audience/Publishing and verification or documented exemption. Choose appropriate In production policy before unattended release; existing Client ID/Secret can remain if uncompromised and matching.
2. **Previously exposed development OAuth credentials: rotation is not proved by repository/history/current metadata.** Obtain operator confirmation of which credentials were exposed, affected client, revocation/rotation date and that current stored versions supersede them. Client ID alone is public; leaked client secret/refresh token needs remediation. Never assume a new Cloudflare Secret timestamp proves compromised old credentials were revoked. If actual compromised credentials remain active, STOP; separately authorize targeted rotation, not AUTH/CASE keys.
3. Sender signs into Google's official OAuth authorization page using its own client and registered mint-tool redirect; offline access, prompt=consent when needed, gmail.send. Google Login's Supabase redirect is not the sender redirect. If using OAuth Playground, use its private “own OAuth credentials” settings and the sender client registered redirect `https://developers.google.com/oauthplayground`; do not put those credentials in URL/query or shared console.
4. Save the returned refresh token directly to the operator vault; do not assume the page will always issue one without offline/consent. Record only client match, scope and issuance date.
5. Separately approved update: `npx wrangler secret put GMAIL_REFRESH_TOKEN --name voteproof` and use Wrangler's hidden prompt from the vault. Do not append the value to command text; disable session transcript/shared logs. Confirm the prompt is hidden; otherwise STOP and use the protected Dashboard Secret field. Update only the required secret, not AUTH keys. Do not run this in B7.1.
6. One controlled verification send after rollout: actual delivered mail/code/registration success and safe logs, then record durable monitoring after the seven-day Testing window. A metadata existence check is not a refresh/send test.

## G. Production secret format preflight

`scripts/release-secret-preflight.ps1` defaults to LOCAL copy-format checks with no Cloudflare request. Production metadata requires explicit target, exact database name/ID, version UUID and matching DB binding. It reads current Secret names and the operator-selected Worker version's bindings, suppresses raw CLI errors/logging, prints only names/presence/format booleans, and optionally asks for two operator-vault copies via hidden SecureString prompts. No files containing Secret values are written and no setting is changed. Its local default and Production refusal guards are tested; no real Secret copy has been entered.

```powershell
# First record the actual current version using deployments list; don't blindly
# reuse an old version if another Secret update has created a new one.
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/release-secret-preflight.ps1 -Target production -Database voteproof-cases -ConfirmDatabaseId 9e2b885d-66e2-4e4d-b768-4bded261296a -VersionId <current-worker-version-uuid> -CheckCryptoFormats
```

AUTH_SECRET and AUTH_TOTP_ENCRYPTION_KEY must each be **exactly64 hex /32bytes**, distinct and stable. **DO NOT ROTATE.** The procedure checks operator-held copies, not a retrieval of Cloudflare values: API cannot read existing Secrets, so output explicitly says cloudflare_value_match_verified=false. Operator must privately attest copies are the currently installed versions; otherwise STOP, do not “test” by overwriting keys. Key separation against CASE/R2/Turnstile/Supabase/Gmail must be privately attested too.

Presence-only: SUPABASE_SECRET_KEY, GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN, TURNSTILE_SECRET_KEY, CASE_QUERY_KEY_SECRET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY. CASE_QUERY_KEY_SECRET separately remains exact64hex by existing B3 contract; do not rotate it. Keep GOOGLE_PUBLIC_API_URL for old-version rollback.

Variables checked without displaying values: AUTH_ORIGIN=production origin; SUPABASE_URL=selected project; nonempty publishable key; sender email format/name; R2 account32hex and bucket voteproof-proofs. Operator separately confirms the publishable key belongs to the selected project and sender address matches the approved mailbox; the tool does not embed an email or prove provider validity. DB/PROOFS_BUCKET/ASSETS bindings and keep_vars must remain. Optional TOTP key version defaults1; email safety limits defaultsoft300/hard400.

## H. Initial admin artifact, not a public endpoint

Copy `admin-input.template.json` to private input. Explicit member_id, role admin/super_admin and reason/ticket are mandatory. No default role/email/member. Tool is **first admin only**, refuses any existing admin_memberships row; it is not a general reviewer/role-management mechanism.

```powershell
node scripts/prepare-release-plan.mjs --kind admin --input .wrangler/b7.1/admin-input.json --output .wrangler/b7.1/admin-bootstrap.sql
# Default target is local. No database is executed.
# To prepare a Production-labelled plan, require all explicit identity flags:
node scripts/prepare-release-plan.mjs --kind admin --input .wrangler/b7.1/admin-input.json --output .wrangler/b7.1/admin-production.sql --target production --database voteproof-cases --confirm-database-id 9e2b885d-66e2-4e4d-b768-4bded261296a
```

Production target flags only label/check the artifact; they are not execution approval and do not query a DB. Before separately executing SQL, recheck current wrangler DB binding/Cloudflare account and approved member/ticket. Generator accepts only gitignored/private inputs, writes a **new** ignored .wrangler SQL file, refuses overwrite, and never outputs query/session/OTP credentials.

SQL guard: active existing member + identity mapping + completed member_credentials/TOTP timestep>0 + unrevoked unexpired VoteProof session with elevated_until and reauthenticated_until still current + no pending password operation + no existing membership. In the same file transaction: grant role, append bootstrap_membership audit, remove temporary atomic guard. Guard/audit failure rolls back all; concurrent/duplicate grants fail safely. No role via Google-only login/enrollment without step-up. The generated reason is escaped as a literal; SQL shape is fixed, not a generic mutation utility.

After approved Worker deployment the operator completes real TOTP login/step-up, reviews artifact, then (within 300s freshness, regenerate/re-auth if expired):

```powershell
# STOP: approved target/member/role, current MFA, SQL checksum, DB identity.
npx wrangler d1 execute voteproof-cases --remote --file .wrangler/b7.1/admin-production.sql
npx wrangler d1 execute voteproof-cases --remote --command "SELECT member_id,role,status FROM admin_memberships; SELECT action,target_type,admin_role FROM admin_audit_logs WHERE action='bootstrap_membership'; PRAGMA foreign_key_check;" --json
```

Use normal TOTP password-enabled operator or secure Google TOTP enrollment/fresh Google+TOTP step-up backend. No temporary MFA bypass. Then verify GET admin/me/queue; refresh login without MFA must still be denied. Future reviewer additions require an independently audited operator action, not rerunning this first-admin tool.

## I. Cloudflare Git deployment gate

Repository has no tracked GitHub workflow. Actual Cloudflare Builds settings are not proved by repository config; available CLI OAuth did not permit reading build-trigger configuration in B7. **Gate status: UNKNOWN / STOP until operator evidence.**

Exact future operator state, choose one after approval:

- Recommended for this release: **Workers & Pages → voteproof → Settings → Builds → Disconnect** the repository; record current repo/branch/root/build settings first. This stops automatic builds/deployments without deleting the currently active Worker. Then explicit manual deploy once after migration.
- Alternative preserving build integration: replace production deploy command with **`npx wrangler versions upload`**, with no extra deploy/migrate command in build/install scripts. Push only uploads an inactive version; promote a verified version explicitly via versions deploy. Version URLs still use configured resources; do not browse/test them against Production DB before approval.

These are Workers controls, not a Pages “automatic production branch deployments” checkbox. Disable preview builds too if they could touch Production bindings, cancel queued/running deploy builds, inventory deploy hooks/external CI, and verify no second integration can still deploy. “No push yet” is not proof of a gate. [Cloudflare exact disconnect/inactive-version instructions](https://developers.cloudflare.com/workers/ci-cd/builds/).

## J. Backup and NON-PRODUCTION restore rehearsal

Future approved operator commands in a trusted terminal; protected backup directory must be outside public/ and ideally outside repository, encrypted/access-controlled. No console transcripts containing export data.

```powershell
$backupDir = Read-Host 'Approved private backup directory'
if (-not (Test-Path -LiteralPath $backupDir -PathType Container)) { throw 'STOP_BACKUP_DIRECTORY' }
if (Test-Path -LiteralPath (Join-Path $backupDir 'pre-b7.sql')) { throw 'STOP_DO_NOT_OVERWRITE_BACKUP' }
# Read the count SQL into one query: --command is read-only and returns only names/counts.
$countSql = Get-Content docs/release/backup-counts.sql -Raw
$countRaw = & node node_modules/wrangler/bin/wrangler.js d1 execute voteproof-cases --remote --command $countSql --json
if ($LASTEXITCODE -ne 0) { throw 'STOP_BACKUP_COUNTS' }
$countData = ($countRaw -join "`n") | ConvertFrom-Json
$manifest = $countData[1].results[0].manifest_json
[IO.File]::WriteAllText((Join-Path $backupDir 'counts.json'),$manifest,[Text.UTF8Encoding]::new($false))
npx wrangler d1 export voteproof-cases --remote --output (Join-Path $backupDir 'pre-b7.sql')
if ($LASTEXITCODE -ne 0) { throw 'STOP_EXPORT_FAILED' }
npx wrangler d1 time-travel info voteproof-cases --json
npx wrangler deployments list --name voteproof --json
npx wrangler secret list --name voteproof
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $backupDir 'pre-b7.sql')
```

Freeze/drain writers while count manifest/export are captured, otherwise they may describe different snapshots. Compare the table-name result with manifest keys; no schema table omitted. If legacy cleanup is authorized, keep both the original pre-cleanup backup and a fresh post-cleanup/pre-migration backup, each with its own counts/bookmark. Do not reuse a counts.json from before deletion.

Record current rollback **version UUID**, not just Git SHA. B7 observed 9efd993e-2e35-420a-ac53-c8e0469c20ca, but re-read before release. Record binding IDs, variable names/formats, secret names only; secret backup comes from operator vault. Record Supabase exact-state/hook/grants, each Google client/project/Audience/Branding/scope/redirect, sender grant issuance/rotation attestation, Turnstile production hostname and R2 private/CORS. Screenshots must crop/obscure codes/client secrets/tokens; do not open provider Secrets for evidence screenshots. Time Travel Free7days/Paid30days is not a permanent export. [D1 backup/restore](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/).

Prepared rehearsal (not run against real backup in B7.1):

```powershell
node scripts/rehearse-d1-backup.mjs --backup (Join-Path $backupDir 'pre-b7.sql') --manifest (Join-Path $backupDir 'counts.json')
```

The tool only supports LOCAL: fresh random database_id/name/config in an ignored `.wrangler/b7-restore-*` directory, `--local --persist-to`, no remote option/token. It restores privately, compares exact noninternal table names and every count, runs FK/quick checks, reports safe counts only. CLI errors/backup rows are suppressed. It does not restore over existing local/core or Production data. It retains the private local restore for operator inspection; delete only that exact resolved directory after approved inspection, never all .wrangler. Actual backup restore PASS is still an operator release gate, not fabricated from generic migration tests.

## K. Migration window — exact each-file application

0001/0002 unchanged. 0003 adds identity tables; 0004 expands cases/RBAC; 0005 adds Campaign/ledger and preserves/rebuilds audit; 0006 adds snapshots/preserves audit; 0007 seeds fixed tiers/preserves audit. No historical Campaign/points backfill. Old B3 explicit columns/default zero-Guest inserts/query still work with expanded schema; offline compatibility tests cover this. Auth/Member/B5 traffic must wait for new Worker and all seven migrations.

Wrangler tracking table is **d1_migrations**, not schema_migrations. Plain `d1 execute --file migrations/0003...` must not replace migration runner/tracking. Installed 4.149.0 apply has no “one migration only” option. Therefore offline `prepare-migration-stages.mjs` copies unchanged/hash-recorded prefixes 0001..N into five private configs so each invocation sees exactly one new file (given verified preceding tracking state).

Default staging is LOCAL, with a random isolated DB ID and `.wrangler/b7-local` outputs. The explicit Production flags below are required to prepare the approved DB identity. Neither mode applies migrations or deploys; generated files must remain private and be reviewed before any separate CLI execution.

```powershell
# Prepare offline copies; no remote action. Refuses existing output dirs.
node scripts/prepare-migration-stages.mjs --target production --database voteproof-cases --confirm-database-id 9e2b885d-66e2-4e4d-b768-4bded261296a
# STOP: check each file-hashes.json against checked-in unchanged migration bytes.
npx wrangler d1 migrations list voteproof-cases --remote
npx wrangler d1 execute voteproof-cases --remote --command "SELECT name FROM d1_migrations ORDER BY id; PRAGMA foreign_key_check; PRAGMA quick_check;" --json
# STOP: expect only0001/0002, no FK defects, quick_check ok, verified backup/drill,
# correct account/DB ID, approved maintenance/gate and legacy decision.
npx wrangler d1 migrations apply voteproof-cases --remote --config .wrangler/b7.1/migrate-0003/wrangler.json
```

STOP after 0003: exit0 and tracking exactly0001..0003, new identity tables present, original B3 counts/fields unchanged. Then repeat, **separately**, not a shell command chain:

```powershell
npx wrangler d1 migrations apply voteproof-cases --remote --config .wrangler/b7.1/migrate-0004/wrangler.json
# STOP: tracking0001..0004, cases version default0/RBAC/audit indexes and original rows intact.
npx wrangler d1 migrations apply voteproof-cases --remote --config .wrangler/b7.1/migrate-0005/wrangler.json
# STOP: tracking0001..0005, Campaign/ledger schema, audit preserved, no retroactive awards.
npx wrangler d1 migrations apply voteproof-cases --remote --config .wrangler/b7.1/migrate-0006/wrangler.json
# STOP: tracking0001..0006, snapshots/current-run constraints, audit/ledger unchanged.
npx wrangler d1 migrations apply voteproof-cases --remote --config .wrangler/b7.1/migrate-0007/wrangler.json
# STOP: tracking0001..0007, normal active0 + seven disabledNULL; no invented thresholds.
```

Between every command rerun tracking/FK/quick and expected original-row checks; do not paste all lines as an unattended batch. At completion use the read-only verification SQL via **--command**, avoiding --file's import path:

```powershell
$verifySql = Get-Content docs/release/verify-expanded-schema.sql -Raw
npx wrangler d1 execute voteproof-cases --remote --command $verifySql --json
```

Expect all29 business tables, required indexes/triggers/FKs, no “missing” defect rows, quick_check ok, 0001..0007, normal-only defaults and ledger_count0 before approved real reviews. Cross-check full schema against local check:admin-schema output, not just absence of SQL errors. Files are individually transactional; failure rolls back that file, not previously applied ones. Stop and retain old Worker/expanded schema; no DROP to “undo”. Migration may briefly make D1 unavailable, so schema compatibility is not a zero-downtime promise. If unexpected old B3 INSERT/query failure appears, NO-GO until reviewed. [D1 migration semantics](https://developers.cloudflare.com/d1/reference/migrations/).

## L. Rollout runbook — STOP before every external mutation

1. **Policy STOP:** signed decision sheet, actual Campaign/admin data, cutover announcement, legacy cleanup/preservation choice, credential-exposure attestation. No fake activity or history.
2. **Git gate STOP:** verify disconnect or inactive versions-upload command, no running deploy/hooks/external CI; record state. Do not push yet.
3. **Provider STOP:** exact Supabase checklist/hook, mapped Google client, approved public audience and exact URLs. Do not reinitialize shared project/users. Resolve only approved differences.
4. **Gmail STOP:** publisher/verification-or-exemption/grant provenance ready; separately authorized token replacement if needed, no unrelated Secret rotation. Validate stable auth key copies privately.
5. **Backup STOP:** protected export + count snapshot + bookmark + current rollback version + provider inventories. Run real LOCAL restore rehearsal and require PASS. If cleanup approved, follow A, back up again and rehearse the new pre-migration snapshot.
6. **Window STOP:** approved low-traffic/maintenance window, controlled operator-only launch policy and writer drain. There is no existing runtime maintenance switch; do not pretend one exists. If product requires technical restriction of public writes during bootstrap, review the edge/access arrangement separately before release.
7. **Migrations STOP:** run K's five file-gated apply invocations in order; no deployment yet.
8. **Integrity STOP:** all schema/tracking/FK/quick/original-row checks pass; no unexpected awards/identity mappings. Old Worker still serves against expanded schema.
9. **Release commit / upload / deploy STOP:** source changes from this phase first require review/local commit at later authorization. Final tested release HEAD, not today's old baseline, must be clean and recorded. With disconnected Builds:

```powershell
git status --short --branch
git rev-parse HEAD
git push origin main
# STOP: confirmed push SHA, no automatic deployment, migrations/provider gates passed.
npx wrangler deploy --name voteproof
```

   With the alternative versions-upload gate: push triggers upload only; record the actual new version tied to final commit/build, then approved `npx wrangler versions deploy <verified-version-uuid>@100 --name voteproof`. Choose **one** release mechanism, not both. No mixed old/new traffic rollout unless separately designed for schema/identity/API consistency.
10. **Health STOP:** site/health/unknown404, expected new public data contract, exact callback/origin, no sensitive platform logs, correct DB/R2/private bindings. Source console summaries cannot alone prove platform log redaction.
11. **Admin STOP:** own real signup/login/TOTP/recent step-up, H's reviewed atomic bootstrap, role/audit/MFA-denial checks. Old demo admin controls are never used.
12. **Campaign STOP:** B's approved API/SQL creation, public open Campaign confirmed before enabling/announcing submission. No active Campaign => **no submission release**.
13. **Leaderboard STOP:** approved continuity notice + real D1 definition/rebuild if needed. No import aggregates, no fake top-N, no historical-zero claim. Only normal tier until real thresholds approved.
14. **Production smoke STOP:** Guest prepare/PUT/complete/case/replay/query with real Campaign; Email delivery/verification/Password/TOTP/recovery; Google/new-repeat/logout/dual same-member; normal-role denied admin; MFA reviewer/admin review + audit; owner profile/cases/points/tier; public Campaign/boards; private R2/no-store/no sensitive logs. Controls must use disposable identities and genuine approved test activity/policy; immutable ledger/audit are not arbitrarily deleted.
15. **Release decision STOP:** publish only after all applicable tests pass and bootstrap is complete; otherwise incident/runbook rollback. Worker rollback to recorded pre-release UUID leaves D1/R2/providers intact. Preserve new rows, crypto keys and original Apps Script binding; do not erase migrated schema. Full D1 Time Travel restore is separate explicit data-loss approval with write freeze, final backup and Supabase/R2 reconciliation.

## M. Status / evidence boundary

Prepared artifacts are reviewable locally; no external mutation step above was performed. Source/UI/migrations remain accepted baseline. There is no new runtime code blocker identified under the recommended artifact-cleanup/new-ledger policy. Preservation requiring general legacy approval, launch eligibility beyond existing schema, or a mandatory on-site cutover notice would require separately approved source work; not silently implemented.

Actual operator gates remain: approve legacy/data/launch policy; enter real Campaign/admin facts; exact dashboard/client/hook/audience checks; attest compromised dev credential rotation; verify Git gate; protected backup and actual restore rehearsal; future migration/bootstrap/deployment/smoke approval. Generic local builder tests do not stand in for those actual operations. **Recommendation: NO-GO for Production execution until these gates close; implementation/tooling can proceed to operator review.**

Local validation: 661/661 unit tests (645 existing +16 release-plan tests), 234/234 browser tests; fresh local Wrangler migrations0001–0007/schema/FK/quick, dry-run and public-asset checks passed. The release tests exercise pure SQL builders in disposable local D1, including role/audit atomicity, concurrency, MFA guards, Campaign validation and precise legacy cleanup. They do **not** invoke the operator bootstrap/secret-preflight/restore CLI or modify a live database. PowerShell syntax parsing and Node syntax checks passed. Sensitive-value scan includes the reviewable new files; no real provider credentials/object keys are in these artifacts. Actual private export/restore rehearsal and Production secret-format attestation remain unexecuted release gates.

## N. B7.2 candidate freeze, classifications and operator gate

The 11 new files were presented to the operator before commit. All are **TRACKED RELEASE ARTIFACT**; none is a private report, backup, credential, acceptance output or obsolete generated file. Generated SQL, filled inputs, local databases, exports, screenshots, keys and environment-specific evidence remain gitignored/private. There is no Worker/UI/schema/dependency change in this release-preparation commit.

|Path|Purpose / rollout dependency|Environment identifiers|Secret handling / disposition|
|---|---|---|---|
|docs/release/b7-1-runbook.md|Required rollout/STOP reference|Public origin, project/DB identifiers, sender and historical acceptance label|No Secret values; track|
|docs/release/admin-input.template.json|Required input shape if SQL admin bootstrap chosen|None; null placeholders|Filled copy is private; track blank template|
|docs/release/campaign-input.template.json|Required real-data input shape if SQL Campaign bootstrap chosen|None; null placeholders|Filled copy is private; track blank template|
|docs/release/backup-counts.sql|Required backup count manifest|Schema names only|No rows/PII/credentials; track|
|docs/release/verify-expanded-schema.sql|Required post-migration read-only checks|Schema and fixed tier names only|No sensitive data; track|
|scripts/lib/release-plans.mjs|Required SQL builder for bootstrap/cleanup alternatives|Explicit nonsecret DB identity and original acceptance commit|No actual member/email/Campaign/R2 key values embedded; private inputs/outputs; track|
|scripts/prepare-release-plan.mjs|Offline preparation only; required for SQL alternatives|Explicit target supplied by operator|No DB execution; default local; Production flags and cleanup-plan acknowledgment; track|
|scripts/prepare-migration-stages.mjs|Required one-file migration staging approach|Nonsecret DB identity; default local random ID|No apply/deploy; Production explicit; track|
|scripts/release-secret-preflight.ps1|Required presence/format-check option|Expected nonsecret Production origin/project/DB/bucket|Default local/no Cloudflare request; optional hidden copies never logged/saved; track|
|scripts/rehearse-d1-backup.mjs|Required isolated backup-restore rehearsal option|Random local-only DB|Reads private backup, suppresses row/error output, retains ignored local restore; track|
|test/release-plans.test.js|Required regression/security evidence|Disposable fixtures only|Runtime random credentials; refusal/default tests make no provider calls; track|

Tool review: SQL shape is fixed and strings are escaped; actual transactions are executed only by separately approved Wrangler commands. Builder output is the practical dry-run. Metadata preflight is read-only; restore is always LOCAL and has no remote flag. Schema SQL is read-only and has no connection/target of its own. Destructive cleanup preparation requires `--confirm-cleanup-plan PREPARE_ONLY_NO_EXECUTION`; actual D1/R2 deletion has independent approval/acknowledgment and backup/no-reference gates in A. First admin bootstrap is not a generic elevation endpoint. No tool prints provider/Guest/session credentials or actual R2 keys. Fixed synthetic test fixtures are not Production bootstrap data.

### Read-only deployment-path evidence

Status: **OPERATOR VERIFICATION REQUIRED**, not SAFE.

- Local HEAD and origin/main have no repository `.github/workflows`; package/config have no publish/install lifecycle deployment and no remote migration automation.
- GitHub API currently reports one active **dynamic GitHub Pages** workflow, `pages-build-deployment`, absent from repository source. This is an additional deployment integration to inventory, not proof that Cloudflare Worker deployments are disabled. Remote main matches the known origin/main baseline. No push was performed.
- GitHub webhook inventory is not readable anonymously (HTTP401); operator must inspect authenticated Settings. Absence of repository YAML does not establish absence of hooks/apps/external CI.
- Cloudflare Builds trigger GET was rejected HTTP403/code10000 with the existing CLI authorization. Do not infer disconnected from access denial and do not expand OAuth permissions automatically.
- Actual external service evidence/results stay under ignored `.wrangler/b7.2`, not tracked snapshots that might become stale or expose private settings.

Operator reads ONLY; do not click save/disconnect/delete yet:

1. Cloudflare → Workers & Pages → voteproof → Settings → Builds: record connected repository/branch/root, build/install/deploy commands and queued/running builds. Require disconnected OR inactive-only `npx wrangler versions upload` with no hidden deploy/migration side effect before future push. Inventory nonproduction commands and bindings too.
2. Same Builds screen → Deploy hooks, if configured: inventory every enabled push/API/manual trigger; do not copy hook URLs into shared evidence.
3. GitHub → i-dle-melon/VoteProof → Actions: inspect dynamic Pages job and any other active workflows; Settings → Pages: record deployment source and whether its destination relates to VoteProof. Settings → Webhooks / GitHub Apps: inventory Cloudflare and other deployment integrations; external CI must be explicitly accounted for.
4. Record gate owner/time, evidence reference, and SAFE / UNSAFE / OPERATOR VERIFICATION REQUIRED. Only SAFE satisfies the future push gate. No integration was altered here. [Cloudflare deployment controls](https://developers.cloudflare.com/workers/ci-cd/builds/), [read-only trigger API](https://developers.cloudflare.com/api/resources/workers_builds/subresources/triggers/methods/list/).

### Operator Secret evidence — YES / NO only, never values

Read-only metadata confirms required Secret and variable names exist. This does not prove format, ownership, preservation, key separation or valid grants.

|Item|YES / NO confirmation needed|
|---|---|
|AUTH_SECRET|Exists; vault source exactly64hex/32bytes; matches installed version; preserved unchanged|
|AUTH_TOTP_ENCRYPTION_KEY|Exists; vault source exactly64hex/32bytes; distinct from AUTH_SECRET; matches installed version; preserved unchanged|
|SUPABASE_SECRET_KEY|Exists; correct project/server-only credential|
|GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN|All exist; correct separate sender client/grant; exposure/lifetime resolved|
|TURNSTILE_SECRET_KEY|Exists; matches formal Production widget, never test credential|
|CASE_QUERY_KEY_SECRET|Exists; preserved unchanged and separate from auth/provider keys|
|AUTH_ORIGIN / SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY|Exist; exact approved Production/project configuration and matching publishable key|
|GMAIL_SENDER_EMAIL / GMAIL_SENDER_NAME|Exist; approved sender mailbox/name|

No existing Secret value was retrieved, displayed, written or rotated. The optional preflight hidden-copy check remains operator-controlled; cannot prove matching Cloudflare Secret values by metadata. Keep values out of reports, chat and screenshots.

### Hosted provider YES / NO checklist

- Supabase → Authentication: signupON, EmailON, GoogleON, AnonymousOFF, ConfirmEmailON, manual linkingOFF. Auth Hooks → Before User Created ENABLED → `public.voteproof_signup_policy`; canonical SQL, boolean app_metadata marker, auth_admin grants and revoked anon/authenticated/PUBLIC execute verified. URL Configuration → Site URL equals Production origin and exact Production callback allowlisted. Inventory dev entries; do not remove them without a separate policy decision.
- Google Login: Supabase provider Client ID exactly matches recorded Web OAuth client; differs from Gmail sender; approved Production JS origin and Supabase auth callback present; Audience/publishing recorded; requests only openid/email/profile. See E for current Testing exception, not a blanket assumption.
- Gmail sender: exact client privately recorded and separate; publishing/verification-or-exemption recorded; prior credential exposure explicitly rotated/revoked or unresolved; grant issuance/refresh-token lifetime risk resolved. Do not assume a timestamp or successful earlier send proves remediation.
- Turnstile: formal Production widget/secret only, no test key, exact approved Production hostname. No localhost/LAN widget change.

These operator confirmations are pending; B7.2 does not change any provider or Dashboard setting. Production Secret/variable names are not provider-configuration proof.

### Actual backup gate — OPERATOR ACTION REQUIRED

No authorization to export Production data or run the operational backup steps has been established in this phase. Therefore no Production export/Time Travel bookmark or actual-backup restore rehearsal was performed. J provides exact private export/bookmark/count and LOCAL restore commands for separate approval. Successful clean-migration tests are not a substitute. Required evidence: private export hash/schema/count manifest from one drained-write snapshot, current recovery bookmark, isolated restore with exact table/count equality, FK empty and quick_check ok. Never commit the backup, screenshots or private restore.

### Single operator decision sheet — leave unanswered until explicit reply

1. **Legacy:** [ ] DELETE verified acceptance case + exact reviewed R2 proof after backup/key checks; [ ] KEEP AS LEGACY NON-REVIEWABLE. Neither selected. No fabricated campaign/points/status.
2. **Campaign:** real campaign_id, title/name, category, UTC start/end, timezone, points_per_proof, daily_limit, create status, optional note/actual rules. Fill private template, do not fabricate or assume defaults are approved. No launch submissions until genuinely open Campaign exists.
3. **Initial admin:** existing exact member_id, completed VoteProof TOTP YES/NO, desired admin/super_admin role, approved reason/ticket. Recent verified MFA still required at execution; email is not DB identity.
4. **Leaderboard:** [ ] fresh ledger/season with approved explicit launch message; [ ] delay exposure until genuine point data. Neither selected. Never import unproven Apps Script aggregates into points. Delay exposure/on-site messaging may require a separately reviewed small source change depending on chosen UX; it is not silently implemented here.
5. **Maintenance:** approved date/start/end/timezone, owner and write-drain/traffic plan. Blank; no maintenance switch is invented.
6. **Auto-deploy:** owner/evidence/time + SAFE result required before push. Currently OPERATOR VERIFICATION REQUIRED.
7. **Gmail exposure:** [ ] rotated/revoked with private evidence; [ ] not yet resolved. Neither selected. Unresolved remains NO-GO.

### Candidate invariants and final gate

After the one authorized LOCAL commit, record `git rev-parse HEAD`, clean status and ahead count. Run full unit/browser checks, fresh local migrations0001–0007/FK/quick, dry-run and tracked-file sensitive scan **after commit**. Check no credential/CA/certificate/test-Turnstile material tracked; no localhost/LAN/sslip callback URL in Production runtime/public/config; accepted mobile/B4G runtime tree unchanged. Local live/acceptance helpers and data are not deployment dependencies: normal wrangler configuration uses only src/public/bindings, not ignored outputs.

Any failed runtime-tree comparison, incomplete regression, sensitive finding or unsafe tooling is a technical STOP. Once these pass, remaining gates are actual operator decisions/evidence and independently approved external operations. Clean Git and a known commit do not establish Production GO. Keep **NO-GO** until policy/settings/deployment gate/actual backup rehearsal are resolved and Production actions explicitly approved.
