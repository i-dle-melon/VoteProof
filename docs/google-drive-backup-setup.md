# Google Drive Backup V1 — operator setup

Implementation is local only. This document does **not** authorize remote migrations,
secret installation, Cron activation, Production uploads or backfill. R2 remains
authoritative; V1 contains no R2 deletion/retention or sharing API.

## Dedicated human account and Google Cloud

1. Create/use a dedicated **human** Google account with recovery and 2-step verification.
   Ensure its My Drive has enough free space. Do not use the permanent VoteProof admin
   identity as a backup credential or a service account owning personal My Drive files.
2. In [Google Cloud Console](https://console.cloud.google.com/), select/create a project
   for VoteProof Backup. Open **APIs & Services → Library → Google Drive API → Enable**.
3. Open **Google Auth Platform → Branding**. Set app name `VoteProof Backup`, support
   and developer-contact details. These identities stay in Google configuration, not
   source or filenames. In **Audience**, use External for a personal account and add
   only the dedicated account as a test user while testing.
4. In **Data Access**, add only `https://www.googleapis.com/auth/drive.file`.
   This permits app-created files; do not request full Drive access or try to reuse an
   arbitrary manually created folder that the app cannot access.
5. In **Clients → Create client**, choose **Web application**. Add the exact authorized
   redirect URI `http://127.0.0.1:53682/oauth/callback`. No Production login callback,
   Supabase, Google login configuration or browser frontend changes are needed.
6. A long-lived automated backup cannot rely on External **Testing** refresh tokens:
   Drive authorization in Testing normally expires after seven days. Follow Google's
   publishing/verification requirements before continuous operation, then authorize
   again if needed. Never weaken the scope to work around this.

Sources: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[web-server OAuth](https://developers.google.com/identity/protocols/oauth2/web-server),
[refresh-token expiration](https://developers.google.com/identity/protocols/oauth2#expiration).

## Local-only offline authorization

From the repository, create `.wrangler/google-drive-oauth/client.json` privately with
the two keys `client_id` and `client_secret` from that OAuth client. Do not put actual
values in tracked files, terminal command arguments, chat, screenshots or CI.
The `.wrangler/` directory is gitignored. Restrict access to your Windows account;
the helper also removes inherited ACLs on its private output directory before use.

```powershell
node scripts/google-drive-oauth.mjs authorize
```

Open the printed authorization URL in the dedicated account's browser. The helper
uses offline access, consent, random state, PKCE/S256, exact loopback callback and a
five-minute timeout. It binds only `127.0.0.1`, validates the Host/state, never prints
the callback/code/tokens, and shuts down after success/failure. It discards the access
token and writes the refresh credential only to the private gitignored
`credentials.json` (exclusive create, no overwrite). Protect this file as a secret.
For reauthorization, preserve/revoke the old credential intentionally and remove
the old private output file yourself; do not automatically overwrite it.

No automated tests require this file or real credentials.

## Private root folder bootstrap

Only after separately approved real Google setup:

```powershell
node scripts/google-drive-oauth.mjs create-root
```

This creates **VoteProof Backup** in the authorized account's My Drive and prints
only `GOOGLE_DRIVE_ROOT_FOLDER_ID`. A reserved ID is first saved in gitignored
`root-id.json`; reruns reuse it instead of creating another root. No permissions API,
public link, reviewer sharing or ownership transfer is called. Manually share the
root with specific human reviewers as Viewer later if authorized. Child permissions
inherit; do not make it public. If a retry cannot reconcile the recorded ID, stop
and inspect it; never generate a replacement root automatically.

## Worker configuration (future approved release only)

Configuration:

| Name | Meaning |
|---|---|
| `GOOGLE_DRIVE_BACKUP_ENABLED` | exact string `true` opts in; absent/other values disable scheduling/processing |
| `GOOGLE_DRIVE_CLIENT_ID` | OAuth client ID; server-only config |
| `GOOGLE_DRIVE_ROOT_FOLDER_ID` | app-created private root; server-only config |

Secrets:

- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REFRESH_TOKEN`

Use Cloudflare's secret input UI, or the explicit **manual**, separately authorized
stdin installer below. It does not put secret values in command arguments or normal
stdout. Never add credentials to `wrangler.jsonc`, GitHub Pages, Actions logs or D1.

```powershell
# ONLY after the exact target Worker/config and secret change are approved:
node scripts/google-drive-oauth.mjs install-secrets --operator-approved
```

The installer uses this repository's default Wrangler target. Check the target
first; do not run it against Production during local development. Prefer a separate
test Worker with isolated D1/R2/account/root for the first real connection test.

## Durable work and verification

Migration `0010_google_drive_backups.sql` adds only backup structures. No seed or
backfill is executed. Apply it locally first; remote rollout needs separate approval.
Case creation commits R2 and D1 first, then best-effort idempotent enqueue. Missing
0010 or queue failure cannot invalidate the committed case. A static error category
is logged and bounded backfill can reconcile the missing work.

Path: root / `Campaign Name [Campaign ID]` / local creation day / `CASE_ID.png|jpg|webp`.
Campaign timezone comes from the existing campaign configuration. Stored folder
identity uses campaign ID and local date; renaming a campaign reuses the original
folder. No member identifiers or original filenames enter this naming convention.

Processor is sequential, **max 5 jobs / execution**, max 240-second budget, renewable
300-second global/job leases; a 35-Google-request ceiling and 15-request headroom
before claiming each additional proof may lower the actual job count on a run.
Every remote request rechecks ownership. No due jobs
means no token refresh, Drive calls or lock creation. Workers Cron plan CPU/subrequest
limits must be checked before activation; there is no paid queue dependency.

Each proof has a unique `(file_id, provider)` record. Drive file/folder IDs are
pre-generated and committed before remote creation. Google documents safe retries
with these IDs: an already successful create conflicts instead of duplicating a file.
The processor reconciles the same ID on retry, verifies ID, byte size, MIME, parent,
app metadata and non-trashed state, and only then marks confirmed. R2 size/MIME/ETag
must match the archived proof. Upload uses a private resumable session, one streaming
PUT of the existing maximum 5 MiB raster object; no full image buffer in production.
Workers uses `FixedLengthStream` for correct Content-Length while streaming.
See [Workers request lengths](https://developers.cloudflare.com/workers/runtime-apis/request/#set-the-content-length-header).
The session URI/access token are memory-only, not persisted or exposed. Interrupted
transfers restart/reconcile the same logical file ID on a later run; V1 does not
persist the resumable URI or resume byte ranges. A partial/ambiguous result is never
marked confirmed without independent `files.get` verification.

[Resumable uploads and pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads).

Network, 429/rate-limit and 5xx errors retry with 60-second exponential backoff plus
0–29 seconds jitter, capped at one day, max eight automatic attempts. OAuth/config,
root-access and full-Drive errors retain R2 and block the provider. No tight loop.
Admin fixes the external condition then explicitly retries a failed proof; its same
reserved Drive ID remains. A crash on the eighth leased attempt becomes a visible
failed record. Revoking access never removes the authoritative proof.

## Connectivity, dry run and backfill

First controlled connection test: use the isolated test Worker/account. Confirm
the private root, enable only that environment, submit a legitimate isolated fixture,
invoke its scheduled handler, and verify a confirmed job and matching private Drive
file. All automated tests instead mock Google and never call real Drive.

Authenticated elevated Admin APIs (ordinary members/reviewers cannot mutate):

- `GET /api/admin/backups`: counts, missing jobs, sanitized blocked category and last
  ten backup audit actions.
- `GET /api/admin/cases/{case_id}/backups`: per-proof status/readback (reviewers may read).
- `POST /api/admin/backups/backfill`: `{ "dry_run": true, "limit": 25 }` first;
  response contains ready/missing/changed proof IDs and a cursor, never R2 URLs.
- Explicit enqueue uses `dry_run: false` with `file_ids` from the dry run (max 25,
  UUIDs only); this rechecks only the operator-reviewed proofs. API-based full
  pagination may instead use the same page parameters; use returned
  `next_cursor` as `after` for later pages. Each page is max 25, no unbounded scan.
- `POST /api/admin/backups/{id}/retry`: `{ "expected_version": ... }` only for failed
  work; no blind repeat after conflict.

Mutations use the normal authenticated session, Origin/CSRF and current admin MFA,
plus in-transaction role/session revalidation and immutable audit. A dry run uses
only D1 reads/R2 HEAD; it schedules/uploads nothing. Rerunning enqueue skips existing
records, including confirmed jobs. The 34 current Production proofs must **not** be
backfilled/uploaded in this implementation task. Existing submission gate stays
independent, with no test submissions or fake points added.

## Schedule approval and recovery

There is a scheduled handler but **no Cron Trigger in tracked config**. Future
operator-approved schedule may be every 5–15 minutes after connection, quota and
plan acceptance. If Cron is stopped, records remain pending; R2 remains intact.

If Drive is full/unavailable: keep R2, inspect the safe Admin category, restore space
or access, then retry the failed job. If the refresh token is revoked: authorize the
dedicated account again, securely replace the Worker secret, then retry. To revoke,
remove app access in the dedicated Google account's third-party connections and
disable the Worker backup flag/schedule. Do not delete R2 or reset case/ledger data.
If D1 is unavailable, queued jobs/leases reconcile later; never repair business data
to compensate for a backup failure. Changing root does not move an in-progress job;
its original root is pinned for consistent retry.

## Zero fixed cost and quotas

No paid OCR, queue, storage plan or SaaS is required by this code. Google account
storage and Cloudflare free-plan ceilings still apply. Do not claim API usage is
free forever. Google's October 2026 documentation describes a revised quota-unit
model for new projects (1,000,000/project/minute, 325,000/user/project/minute and
400,000,000/day billing threshold); older projects may retain previous quotas.
Confirm the project's Console quotas and current pricing before enabling. At five
sequential jobs per 5–15 minutes this implementation deliberately bounds requests;
429/403 rate limits back off and storage exhaustion blocks. No billing/quota increase
is automatically requested. [Current limits/pricing](https://developers.google.com/workspace/drive/api/guides/limits).

GitHub Pages builds exclude admin modules and operational UI and use `connect-src
'none'`. They contain no Drive/OAuth runtime, credentials or functional backup actions.
