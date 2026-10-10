# B4S — Supabase password identity + Gmail verification

Local checkpoint only. Production remains B1–B3 / migrations 0001–0002; no push, deploy, remote migration, real email or Supabase mutation. B6A public assets remain unchanged; no final Member/Admin UI.

## Ownership and security boundary

Supabase owns password verification/storage. VoteProof Worker forwards a password only transiently over HTTPS; no password/hash/pepper is written to D1, transactions, audit, logs or assets. `legacy-password-kdf.js` preserves the prior strong scrypt implementation for benchmarks/tests. Active Worker imports contain no password KDF and require no AUTH_PASSWORD_PEPPER.

Password grant uses the publishable key; admin create/update/delete use the secret key. New Supabase keys are sent only as `apikey`, never misrepresented as Bearer JWTs. Adapters return the validated UUID only and discard provider access/refresh tokens. Supabase JWTs cannot authorize VoteProof APIs. Each adapter request has a five-second timeout including JSON parsing; redirects are not followed, and upstream errors/tokens never reach responses/logs. See [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys), [createUser](https://supabase.com/docs/reference/javascript/auth-admin-createuser), [password grant](https://supabase.com/docs/reference/javascript/auth-signinwithpassword).

D1 owns Member, TOTP, recovery, sessions, trust, RBAC, cases, points and tiers. `member_id` is server-generated. `members.login_name` remains an opaque random legacy internal label for downstream schema compatibility; it is no longer the login identifier. Email is normalized by trim + lowercase (no provider-specific dot/alias rewriting); ASCII mailbox/punycode domain forms supported, quoted/internationalized local parts unsupported. Lookup is domain-separated HMAC-SHA256 with AUTH_SECRET, not enumerable raw SHA-256(email). Reversible email needed for Gmail/reauth is AES-GCM encrypted with distinct email AAD, bound to challenge/subject. No plaintext email is a D1 authorization key or public profile field.

## Schema / empty local migration

Only unpublished `0003_member_identity.sql` is rewritten. Published 0001/0002 and 0004–0007 are unchanged. Recreate old local auth DBs in a new ignored persist directory; do not apply this rewritten file over old checkpoint state.

Existing members, credentials, transactions, sessions, trust, recovery, rate limits and atomic guards remain; member_credentials has no password_record. New tables:

| Table | Purpose / constraints |
| --- | --- |
| auth_identities | provider=`supabase`; unique provider_subject UUID, member_id FK/unique, keyed email_lookup_hash unique; encrypted email |
| auth_email_challenges | opaque UUID, browser hash, keyed code verifier, encrypted email, 600s expiry, 0–5 attempts, pending/verified/transferred |
| auth_email_sends | durable reservation/status and pseudonymous email/source keys, timestamps; indexed rolling accounting |
| auth_enrollments | unique non-deleted email claim, unique provider subject/member ID/transactions; creating/pending/active/cleanup_failed/deleted; 600s deadline |
| auth_password_operations | pending/complete/superseded operations; one pending operation per member; credential version, transaction binding, durable lease |

Unique partial indexes serialize duplicate enrollment and password changes. Timestamp indexes support bounded challenge/send cleanup and budget queries. D1 batch atomic guards retain all-or-nothing Member/TOTP/recovery/session activation and B5 consistency. Empty DB 0001→0007, foreign_key_check and quick_check are required by `check:admin-schema`.

## HTTP contract

All auth responses use the existing ok/data or ok/error envelope and `Cache-Control: no-store`. UUIDs/tokens/codes go in JSON, never query strings. POST requires exact AUTH_ORIGIN, `X-VoteProof-Request: 1`, JSON body (≤16 KiB), and rejects cross-site fetch. Browser must include cookies. Login transaction cookie binds every verification to the same browser; HttpOnly, Secure, SameSite=Lax, Path=/, __Host prefix. Authenticated security start also requires session CSRF and recent password+TOTP proof.

| Endpoint | Request / response data |
| --- | --- |
| GET /api/auth/registration-status | `registration_available`; only when budget unavailable, `retry_after`. No usage/count/threshold. Configuration/quota status, not a network delivery health probe |
| POST /api/auth/register/start | `{email,turnstile_token}` → 202 `{challenge_id,expires_in:600,message}` + browser cookie. Official Siteverify required; generic account-independent shape |
| POST /api/auth/register/resend | `{challenge_id}` + same cookie → 202 same challenge, 600s expiry. New verifier, existing attempts retained; same quotas/cooldown |
| POST /api/auth/register/verify-email | `{challenge_id,code}` → 202 `{transaction_id,expires_in:600,status:"EMAIL_VERIFIED"}` + rotated transaction cookie |
| POST /api/auth/register/credentials | `{transaction_id,password,nickname?,player_id?}` → 202 `{transaction_id,expires_in:600,status:"MFA_ENROLLMENT_REQUIRED",otpauth_uri}` + rotated cookie. Default nickname=會員, player_id=null; creates confirmed Supabase user and pending enrollment only |
| POST /api/auth/register/verify-totp | `{transaction_id,code,trust_this_device?,remember_me?}` → 200 VoteProof member/session/CSRF/expiry + ten one-time recovery codes |
| POST /api/auth/login | `{email,password,remember_me?}` → trusted-device 200 session, otherwise 202 `{status:"MFA_REQUIRED",transaction_id,expires_in:600}` |
| POST /api/auth/login/totp | `{transaction_id,code,trust_this_device?}` → 200 VoteProof session |
| GET /api/auth/me | Own safe Member fields, CSRF/session deadlines; provider identity/email/tokens not exposed |
| POST /api/auth/logout | Existing logout/revocation; empty POST compatibility retained |
| POST /api/auth/recovery/password/start | `{email,code,recovery_code}`: code is TOTP; unused recovery code also mandatory. Always generic 202 transaction for syntactically valid input, including wrong/absent account or proof |
| POST /api/auth/recovery/password/finish | `{transaction_id,new_password}` → 200 `{recovered:true,login_required:true}`; fresh login required |
| POST /api/auth/password/change/start | `{}` + valid session/CSRF/recent step-up → 202 `{transaction_id,expires_in:300}` + cookie; no password retained |
| POST /api/auth/password/change | `{transaction_id,new_password}` + transaction cookie → 200 `{password_changed:true,logged_out:true}`; same transaction can retry an upstream/commit failure |
| POST /api/auth/step-up | Existing `{password,code}` + session/CSRF; password now verified through Supabase; TOTP advances once |
| POST /api/auth/recovery/totp/start | Existing lost-Authenticator concept now `{email,password,recovery_code}`; generic 202 replacement enrollment. Never bypasses password/recovery proof |
| POST /api/auth/recovery/totp/verify | `{transaction_id,code}` verifies replacement TOTP, consumes recovery code, rotates generation and revokes sessions/trust |

Trusted-device list/revoke/revoke-others, recovery-code regeneration and authenticated TOTP reset endpoints retain existing contracts and CSRF/recent-step-up checks. Member profile may only update nickname/player_id; email/provider/member ID cannot be changed there. B3 Guest query/idempotency and B5 authorization/points/snapshots/tier semantics remain intact.

Successful login/activation `data` is `{member,csrf_token,expires_in}`; activation additionally returns `recovery_codes` once. `member` contains only `member_id,nickname,player_id,status,created_at,updated_at,last_login_at`. Session/trusted-device raw tokens are Set-Cookie only. `/auth/me` returns `{member,csrf_token,expires_at,elevated_until,reauthenticated_until}`. Optional boolean flags default false. TOTP/code inputs are six-digit strings, preserving leading zeroes; transaction/challenge IDs are opaque UUIDs. Frontend must keep setup URI/recovery codes private and never put them in storage, URLs or analytics.

Retained security routes: `GET /api/auth/trusted-devices` returns `{devices:[{id,created_at,last_used_at,expires_at,label}]}`; `POST /api/auth/trusted-devices/:id/revoke`, `POST /api/auth/trusted-devices/revoke-others`, and `POST /api/auth/recovery-codes/regenerate` accept `{}` with session/CSRF/recent step-up. `POST /api/auth/totp/reset/start` accepts `{}` and returns a replacement setup transaction/URI; `POST /api/auth/totp/reset/verify` accepts `{transaction_id,code}`. No provider/session credentials appear in these results.

Passwords keep the existing 12–128 Unicode-character bounds without trimming/composition rules; Supabase's actual password policy is additionally authoritative. Provider policy errors are safe structured failures; no local KDF workaround. Provider UUID, confirmed email and requested normalized email must match before any D1 identity/trust check. Known/absent/suspended/wrong-password login share `401 AUTH_LOGIN_FAILED`. Valid provider credentials for an incomplete/unmapped user still return 401.

## Email verification / abuse limits

Six digits are generated with cryptographic randomness and rejection sampling, not Math.random. Only a challenge-bound, domain-separated HMAC verifier is stored. Browser binding, expiry and a persistent CAS attempt counter apply even to malformed codes. Successful verify is one-time. Email ownership is verified before admin user creation.

Active verification sending now uses the MailApp HTTPS relay; protocol/config/redirect/rollback are defined in [mail-relay.md](mail-relay.md). The historical Gmail OAuth adapter remains for rollback and is excluded from the active bundle. No Supabase email confirmations/reset links are sent.

Server-side defaults:

- Per normalized email: 60s cooldown; ≤5 reserved sends in rolling 30 minutes.
- Per pseudonymous CF-Connecting-IP source: ≤60 in rolling 30 minutes; no raw IP stored. Absent IP shares the conservative unknown bucket.
- Global: soft 60 / hard 80 reserved sends in rolling 24h, not midnight reset.
- Optional AUTH_EMAIL_SOFT_LIMIT / AUTH_EMAIL_HARD_LIMIT may lower these defaults; hard ≤80 and soft ≤min(60,hard). Invalid values fail closed.

Reservation and challenge mutation occur in one D1 guarded batch before relay delivery. Concurrent calls cannot overspend. Reserved, sent and failed attempts all count because a timeout might still deliver. The latest send must be sent before email verification can advance. Soft warning is a fixed non-sensitive log; at hard limit only sends/resends stop (429 AUTH_REGISTRATION_UNAVAILABLE + retry-after). Guest/public/login/admin functions do not depend on this budget. No count/remaining budget/threshold is returned by registration-status.

Auth account/IP brute-force limits remain persistent and hashed. Old KDF-global quota is removed from active runtime. Expired send records older than 24h+10m and email challenges expired over 24h are cleaned in bounded batches of 100 on a later send; quota enforcement itself does not depend on cleanup. No scheduler is introduced.

## Enrollment compensation / stale cleanup

Credential registration first reserves a durable unique email enrollment claim before calling Supabase. Admin create marks email confirmed and attaches `voteproof_enrollment_id` in server-only app_metadata. Known new UUID is immediately persisted. Any subsequent local enrollment failure attempts deletion of **only that newly-created UUID**; existing/duplicate users are never deleted. Compensation failure retains cleanup_failed/creating state and emits a fixed summary with no UUID/email/secret. Activation is atomic and requires pending enrollment, unexpired deadline and exact transaction/provider binding.

Abandoned setup remains non-active: no Member, no identity mapping/session. Pending enrollment deadline is ten minutes. It cannot be activated after expiry, and password grant alone never grants VoteProof access.

Operator cleanup strategy for a future approved rollout (not executed now): identify expired creating/pending/cleanup_failed records; atomically claim them against activation; verify there is no active auth_identities mapping and match the exact Supabase app_metadata enrollment marker; delete the owned UUID, then mark the enrollment deleted in D1. For an unknown create timeout or complete D1 outage, inspect Supabase users by that exact marker before deleting anything. Never infer ownership from email alone or delete an active user. Retry deletion failures, retain durable evidence until confirmed. This phase documents this controlled procedure; it does not add a public cleanup API, cron or remote script execution.

## Password reset cross-service consistency

Supabase and D1 cannot share a transaction. Before provider mutation, a D1 guarded batch reserves the operation, bumps credential version, consumes the proved recovery code once (for recovery), and revokes **all** VoteProof sessions/trust. A pending operation also blocks Member sessions and new password logins. Provider mutation runs under a 30s durable lease with a 5s request timeout. Final guarded batch marks complete, consumes transaction and confirms revocations. Concurrent finishes cannot unlock/commit each other's operation.

On provider/commit failure the reservation and revocations stay: no restoration of a spent recovery code or old trust. Same browser-bound transaction can retry within its expiry/attempt budget without consuming another code. If lost/expired, **fresh valid TOTP plus another unused recovery code** may supersede an unleased pending operation; old transaction cannot unlock the replacement. There is no password/TOTP/recovery bypass or hidden admin override.

Network timeouts are an uncertain remote outcome: password may already have changed even when response is unavailable. Passwords are not retained for background retries. The next authorized retry sets the requested password again; D1 remains locked until acknowledged provider success plus commit. Lost password + TOTP + all recovery codes has no automated recovery. Provider password/email changes performed outside VoteProof are unsupported coordination paths; no provider JWT becomes a VoteProof session. Any future external account-management rollout must explicitly handle local revocation/identity synchronization.

## Server configuration (names only)

Required for new registration: MAIL_RELAY_URL / MAIL_RELAY_SECRET Worker-only settings (both recommended Secrets); SUPABASE_SECRET_KEY Secret; SUPABASE_URL (HTTPS project origin without trailing slash) / SUPABASE_PUBLISHABLE_KEY Variables; TURNSTILE_SECRET_KEY; retained AUTH_SECRET / AUTH_TOTP_ENCRYPTION_KEY / AUTH_ORIGIN; DB. Login/recovery/step-up need Supabase/local security config, not relay send config. GMAIL_* settings are legacy/decommission-pending; preserve Production values for separately approved rollback, do not delete them now.

No new redundant secret is required: AUTH_SECRET performs HMAC with distinct identity/code/source/CSRF purposes. AUTH_TOTP_ENCRYPTION_KEY remains an independent 32-byte key, also encrypting email with distinct AAD/context. AUTH_PASSWORD_PEPPER is unnecessary; do not copy its value into another setting. AUTH_TOTP_KEY_VERSION remains optional. Changing AUTH_SECRET requires controlled email-hash regeneration and re-auth; encryption key rotation requires re-encrypting both TOTP/email records. No automatic live key rotation is implemented.

Public Supabase signup and anonymous sign-in remain disabled, email confirmation enabled; only verified server-side admin create activates the provider account. No Dashboard configuration/value was inspected, printed, committed or changed.

## Zero fixed cost / remaining external acceptance

No SDK dependency, Worker KDF or paid plan is required by this design. Actual providers have quotas/outages: [Supabase Free includes 50,000 MAU and quota restrictions](https://supabase.com/docs/guides/platform/manage-your-usage/monthly-active-users); [low-activity Free projects may pause over seven days](https://supabase.com/docs/guides/platform/free-project-pausing). No artificial keep-alive jobs are added.

[Google's OAuth documentation](https://developers.google.com/identity/protocols/oauth2) states external Testing refresh tokens with Gmail scopes expire after seven days and can otherwise be revoked. Publishing status/token longevity require manual verification before rollout; this session did not inspect them.

400 sends is a VoteProof safety budget, not a guarantee of mailbox delivery or Gmail quota availability. [Current Gmail quota/pricing documentation](https://developers.google.com/workspace/gmail/api/reference/quota) describes API units, account/rate limits and 2026 quota/billing changes; quotas may depend on project age. Other tools using the same sender/project are outside D1 accounting. Verify real account quotas, OAuth status, Supabase key gateway compatibility and Free Worker CPU/request limits in a separately authorized live acceptance. Do not upgrade automatically or promise unlimited free service.

## Local validation / changed files

Core: unpublished 0003; auth-login/recovery/security/validation/auth/router; auth-crypto/session/store; new auth-registration, auth-identity, gmail, supabase-auth, registration-quota, password-operation, historical legacy-password-kdf. Development: local provider/case/auth fixtures, auth smoke, schema/public-asset checks, benchmark imports, existing auth tests and new b4s/provider tests. Documentation: this file, README and historical b4-members notice. No public pages, package dependencies, bindings, 0001/0002 or 0004–0007 changed.

Tests use disposable workerd/D1/R2 and an isolated external-provider fixture with ephemeral randomized credentials; it models Supabase storage only in test process memory. There is no production bypass and no real external email/user mutation. Required checks: full npm test, eight B1–B5D smokes, frontend smoke/browser regression, clean local 0001–0007 schema checks, Wrangler dry-run, active module graph KDF exclusion, asset/sensitive scans and diff review.

Final local results: npm test 567/567 (528 existing/adapted + 39 B4S/adapter tests); eight backend smokes and frontend smoke PASS; browser regression 75/75 across desktop Chrome, Android Chrome and iPhone WebKit. Clean local 0001–0007 apply, foreign_key_check PASS, quick_check ok; no auth/case/admin fixture rows. Wrangler dry-run PASS, bundle 254.25 KiB / gzip 58.88 KiB. Public asset scan: zero sensitive findings; public assets/bindings/dependencies/protected migrations unchanged. These are fixture/local results, not Supabase/Gmail Production acceptance.
