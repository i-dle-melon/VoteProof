# MailApp relay transport (local release candidate)

Replaces the active Gmail OAuth transport. This changes the accepted release
candidate: repeat the mail/operator gates before any separately approved rollout.
No Production configuration, credentials, migrations or deployment are changed.

## Configuration and rollback

Required Worker-only settings: `MAIL_RELAY_URL`, `MAIL_RELAY_SECRET`. Keep both
as Secrets for the future Production rollout so the deployed URL is not exposed
by variable listings/build logs. Do not put either value in Git, assets, client
responses, logs, CLI arguments or shell history. The URL must be an HTTPS Apps
Script `/macros/s/<deployment>/exec` URL on `script.google.com`, without query,
fragment, credentials or a nonstandard port. Do not use the `/dev` URL.

The secret is dedicated to this relay, 32–1024 UTF-8 bytes. Use the exact stored
string, not hex decoding, trimming or normalization. Auth/TOTP/Case/R2/Turnstile,
Supabase and legacy Gmail credentials cannot be reused as the relay secret.

`GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` are now legacy,
decommission-pending; retain existing Production secrets until relay Production
acceptance and a separately approved decommission. `GMAIL_SENDER_EMAIL` and
`GMAIL_SENDER_NAME` are also unused by the active Worker. Sender/template/name
are owned by the accepted relay, executing as the dedicated sender Gmail account.
Do not make the relay accept arbitrary From, subject or HTML from clients.

`src/lib/gmail.js` remains a tested legacy rollback adapter, excluded from the
active Worker bundle. A rollback uses the recorded prior release and its matching
configuration, under a separate approval; no automatic OAuth fallback exists.
Retain the old release artifact/reference and operator-held credentials.

## Protocol

Worker generates a crypto-random UUID `send_id` (36 allowed characters), current
integer Unix seconds, normalized lowercase recipient, exactly six-digit code,
and `purpose: "verify_email"`. HMAC-SHA256 input is exactly:

```text
v1
<timestamp>
<send_id>
verify_email
<lowercase email>
<code>
```

No trailing newline. Signature is unpadded base64url. Only these six JSON fields
are sent over HTTPS. The secret itself is never sent. No code/signature enters a
query parameter. Relay is a delivery service, never an email verifier or member
provisioner; it has no Supabase/DB/session authority.

## Redirects, delivery and failure

All fetches use `redirect: manual`, one 10-second timeout for the entire chain,
maximum two redirects and a 4 KiB JSON response limit. A 301/302/303 may lead only
to HTTPS `script.googleusercontent.com/macros/echo`, no userinfo, fragment or
nonstandard port. Follow as GET with no POST body or application headers.
Reject other hosts/paths/schemes and 307/308 rather than forwarding/replaying the
signed POST. Hosted ContentService behavior must be confirmed during acceptance.

Only JSON `ok: true` without contradictory error/code marks delivery sent. All
rejects, malformed data, HTTP/network/timeout errors map to safe existing
`AUTH_EMAIL_UNAVAILABLE`; capacity/BUSY/config upstream failures use 503, other
relay failures 502. Missing/invalid Worker settings use 503 `AUTH_NOT_CONFIGURED`.
Provider details and exception causes are discarded. Never log full requests,
responses, signatures, codes, URLs or credentials.

No retry occurs in the transport. A timeout may have delivered a message; its
reservation still counts. Users retry via normal cooldown/resend, with a new code
and send ID. Latest send status (explicit append rowid order in the existing
send ledger) must be `sent` before verification and within the final claim CAS.
Rejected/ambiguous latest delivery cannot advance email verification. Resend
still uses the existing browser-bound challenge/cooldown/attempt/expiry checks.
Expired challenges are not extended/revived. Receipt does not prove inbox delivery.

## Launch quota and unchanged identity security

Worker defaults: soft 60 / hard 80 reservations in rolling 24 hours; optional
AUTH_EMAIL_SOFT_LIMIT / AUTH_EMAIL_HARD_LIMIT may only lower these ceilings.
Zero/unlimited sentinels are invalid. Reserved/sent/failed all count; D1 guarded
reservation protects concurrent requests. Keep existing 60-second cooldown,
five sends/email/30 minutes and sixty/source/30 minutes. Google auth performs no
verification email reservation/send and remains independent of relay config.

Operator-accepted relay independently uses soft 60, hard 80, provider reserve 20,
durable replay prevention and locking. Worker does not modify those settings.
MailApp consumer quota is 100 recipients/day, shared with the sender's other
scripts; resends count. Quotas/anti-abuse can reduce availability. Never bypass
verification at quota/outage. Gmail account recovery and owner Script
reauthorization remain operational responsibilities; there is no Worker-managed
Testing OAuth refresh token in this path.

Six-digit CSPRNG, ten-minute expiry, maximum five verification attempts, browser
binding, encrypted email, HMAC verifier, single-use CAS, Turnstile, Supabase
trusted Admin-create marker, TOTP, recovery/session/device/RBAC rules are retained.
No schema/migration or frontend change is needed.

## Local and future live acceptance

Gitignored B4S/B4G launcher uses the two relay settings from the existing private
config, emits variable names only, keeps local DB/R2 and paired local Turnstile
test values separate from Production. Check git-ignore before every private write.

Acceptance must cover invalid HMAC without delivery, real HTTPS Worker
registration → actual email code → Supabase verified user → TOTP → recovery
codes → password/TOTP login, direct public signup denial, Google same-member
login without mail, hosted redirect method/host observations, no duplicate mail,
safe logs and owned disposable identity cleanup. Never paste tokens/codes/URLs
into chat. Preserve the core local identity; remove only owned disposable users
after matching the provider enrollment marker and checking no baseline collision.

Run unit/browser regression, empty local migrations 0001–0007, foreign_key_check,
quick_check, dry-run and tracked known-value scan. Source integration does not
authorize push/deploy/remote migration or dashboard changes.

## Local acceptance results (2026-10-10)

- Unit suite: 710 passed; browser suite: 234 passed.
- Empty local migrations 0001–0007, foreign_key_check, quick_check and schema
  verification passed. Wrangler dry-run passed with DB, PROOFS_BUCKET and ASSETS
  preserved. No migration or public frontend changes were required.
- Hosted invalid HMAC returned AUTH_FAILED without sending mail. Observed
  ContentService POST on script.google.com returned 302; receipt GET on
  script.googleusercontent.com returned 200. No signed POST was forwarded.
- All eight live runner checks passed: isolated HTTPS/test Turnstile, real email
  registration through password/TOTP/recovery enrollment, password/TOTP login,
  forged public signup rejection, Google same-core-member login without mail,
  safe logs/local integrity, disposable provider-user removal and isolated
  D1/R2-copy removal. Registration sent one email; Google sent zero. No second
  core member or duplicate send was observed.
- Owned disposable Supabase users remaining: zero. Core local identity retained;
  temporary verification-code file and isolated data copy removed.
- Gitignored live configuration and known-value sensitive scan passed without
  storing actual URLs, credentials, signatures, codes or session tokens in Git.

The local Worker supplied the correct localhost callback, but the hosted redirect
allowlist initially did not match, so Google returned to the configured Site URL.
The operator authorized and added only the temporary exact local rule
`https://localhost:8787/api/auth/google/callback?state=*`; Google regression then
passed. The operator confirmed logout and removal of that newly added rule,
preserving the Site URL and all pre-existing rules. This local acceptance does not authorize a Production
rollout; refreeze the release candidate and repeat the separately approved mail
and operator gates before deployment.
