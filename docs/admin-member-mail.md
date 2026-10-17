# Admin member lookup / mail V1 (source and Preview only)

No Production deployment, migration, secret configuration, or real mail sending
is authorized by this implementation. Submissions stays OFF. Existing verification
relay and migrations 0020–0023 are unchanged.

## Identity and privacy

POST `/api/admin/member-lookup` accepts only `fan_id`, normalized with existing
`normalizeFanId()` and matched exactly. Both contact endpoints require active
admin/super_admin, an elevated server session, Origin and CSRF. Reviewer, member
and guest get 403. All responses are no-store. Activated `auth_identities` is the
existing verified identity authority (current schema has UNIQUE(member_id)); no
pending email challenge/enrollment is used. All matching verified rows are folded
by normalized decrypted email and provider labels. Distinct emails get separate
compose actions; neither ordering nor activity guesses which address to use.

Email is decrypted only in Worker with `decryptEmail` and its existing AAD.
Browser sees safe display values and an opaque, server-HMAC `recipient_ref`.
Send reloads identities from D1 and matches that ref. It never accepts arbitrary
From/To, HTML, URL, provider headers, credentials, attachment, CC or BCC. A recent
(10 minute) successful explicit lookup audit for this admin/target is required;
knowing a member ID alone does not grant mail access. Lookup failures reveal no
email and create no successful access audit. Each successful explicit result
reveal is appended before returning private fields.

## Durable sends and limits

0024 adds only `admin_member_mail_requests` (reservation) and
`admin_member_contact_audit` (lookup/result), their indexes and immutable triggers.
All reservations count: max 3/admin/rolling 10 minutes, 10/site/rolling 24 hours.
`ADMIN_MAIL_ADMIN_LIMIT` and `ADMIN_MAIL_SITE_LIMIT` can only lower ceilings;
invalid/zero/raised limits fail closed. One conditional INSERT both reserves a
globally unique mutation/send ID and revalidates elevated authority/lookup/quota.
Audit/reservation store only IDs, timestamps, roles, outcomes, hashes/opaque
recipient ref; never email, ciphertext, subject, body, relay URL or secrets.
Subject SHA-256 is not confidential against guessing; audit access is privileged.

Network starts only after committed reservation. The same mutation can never
send twice, including concurrent calls or a crash between delivery and audit.
Success means authenticated relay accepted/sent, not guaranteed inbox delivery.
Timeout, malformed receipt, disallowed redirect, network error and missing result
audit are `ambiguous`; reserved requests with no final audit also read ambiguous.
These are never retried. A confirmed relay rejection preserves the draft and
allows a deliberate new send ID, still subject to all quota checks. UI transport
errors keep the original ID so manual recheck cannot duplicate the message.

## Separate relay (not deployed)

Worker-only Secrets: `ADMIN_MAIL_RELAY_URL`, `ADMIN_MAIL_RELAY_SECRET` (32–1024
UTF-8 bytes, exact string; different from verification and other credentials).
URL must be HTTPS `script.google.com/macros/s/<deployment>/exec`, no query/hash,
credentials or nonstandard port. Must differ from verification relay URL.
No automatic fallback exists. Neither settings nor values are installed by this
task. `relay/admin-member-mail/Code.gs` is for a **new dedicated Apps Script
project/deployment**, executing as owner `idle.voteproof.verify@gmail.com`.
It checks the effective user and uses MailApp with no From parameter. Do not
reuse/widen `docs/mail-relay.md`'s verification-only protocol or project.

JSON fields: `version=1`, integer Unix `timestamp`, UUID `send_id`,
`purpose=admin_member_message`, `recipient`, `subject`, `body`, `signature`.
HMAC-SHA256 over exact UTF-8 JSON.stringify array (no trailing newline):

```
["VoteProof/admin-member-mail",1,timestamp,send_id,"admin_member_message",recipient,subject,body]
```

Signature is unpadded base64url. Plain text subject max150 Unicode characters,
body max10000; header/control injection and malformed email fail closed.
Timestamp tolerance ±300 seconds. Script lock plus ScriptProperties reservations
prevent duplicate sends; replays return prior receipt, changed payload rejects.
No CacheService-only replay protection. Old reservations clean after48h, after
signed timestamp replay expiration. Script enforces max10/rolling24h (downward-only
property `ADMIN_MAIL_SITE_LIMIT`) and refuses if MailApp remaining quota <=80,
reserving authentication capacity. Verification traffic and support use separate
projects/locks: provider quota is shared and other account activity may still
reduce availability. Never retry quota errors or lower the verification reserve.

Receipt JSON: `{version:1,send_id,outcome,code,signature}` with HMAC over
`["VoteProof/admin-member-mail-receipt",1,send_id,outcome,code]`. Worker accepts
only bounded4KiB authenticated receipts. One10s deadline, max2 redirects;
301/302/303 may only become a body-free GET to HTTPS
`script.googleusercontent.com/macros/echo`; 307/308 and other hosts/paths reject.
Never log request/response bodies, full recipients, signatures, secrets or URLs.

Protocol tests execute Code.gs with fake MailApp/Properties/Lock and verify the
real Worker signer/receipt parser. Actual hosted sender/account/quota/redirect
acceptance remains a separate future authorization; no real mail is sent here.

Google API references:
[MailApp](https://developers.google.com/apps-script/reference/mail/mail-app),
[PropertiesService](https://developers.google.com/apps-script/reference/properties/properties-service),
[Utilities HMAC](https://developers.google.com/apps-script/reference/utilities/utilities).
