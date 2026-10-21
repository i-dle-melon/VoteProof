# Google login optional MFA V1

Base: main b97accb8762a9899bc59ab9be9197fc54db2853c; migration 0027.
Development only. No Production mutations, deployment, provider changes or schedulers.

## Design before implementation

- Reuse the browser-bound, PKCE-verified `google` transaction kind. No transaction CHECK rebuild or Google trusted-device subsystem.
- Bind policy changes to a fresh, session-bound Google security OAuth flow and an explicit enable/disable action. Enrollment does not enable policy.
- Login confirmation reads the indexed per-member policy. Enabled accounts receive a pending challenge, never a member session, until atomic TOTP/recovery verification and transaction consumption.
- Compare policy generation, active identity, transaction, credentials and one-use factor inside the same D1 batch as session creation. Missing schema or database failures fail closed.
- Policy changes revoke existing Google sessions atomically. Password sessions and password trusted-device mechanisms remain separate. A Google session used to change policy rotates with its original expiry and no automatic admin elevation.
- Add a database session-insert gate: a Worker which ignores enabled policy cannot issue a Google session. Keep this gate and policy when rolling back application code.
- Add no policy query to `memberSession`, uploads, submissions, rankings or ordinary member reads. Policy reads happen only in Google authentication/security configuration flows.
- Google login MFA (including recovery) does not confer admin MFA elevation. Existing explicit sensitive-operation step-up remains required.

## Deployment and rollback proposal (not executed)

1. After separate approval, apply additive 0028; preserve existing transactions and sessions. Default policies are off.
2. Publish compatible Worker with `GOOGLE_LOGIN_MFA_ENROLLMENT_ENABLED` absent/false. This flag gates enabling, never enforcement or disabling.
3. Validate compatible Worker/frontend in controlled conditions; only then separately authorize exposing opt-in by setting the enable flag.
4. Roll back opt-in exposure by turning the flag off. Keep migration, policy, audit and database gate. Prefer a compatible Worker; an older Worker fails closed for enabled Google accounts, rather than bypassing MFA. Never drop the policy or restore a whole database to undo this feature.

Threats: OAuth/CSRF/login swapping; cross-browser proof theft; pre-MFA session issuance; TOTP/recovery replay; policy/login/enrollment/reset races; old-Worker downgrade; unintended admin elevation; accidental Google device trust. Tests and measurements are recorded below after implementation.

## API contract

- `GET /api/auth/login-security`: existing DTO plus `google.mfa: {enabled, generation, available}`. `available` gates enabling, not enforcement.
- `POST /api/auth/google/start`: existing body plus optional `mfa_policy_action: enable|disable`, only with `purpose: security`, `confirmed: true`, member session and CSRF. Action is persisted in the OAuth flow, never trusted from a later client-only intention.
- `GET /api/auth/google/result`: existing browser-bound result plus `mfa_policy_action`, `mfa_required`; policy flows also report `authenticator_configured`. No TOTP secret or recovery code is returned here.
- `POST /api/auth/google/confirm`: unchanged login body. Enabled policy returns HTTP 202 `{status: GOOGLE_MFA_REQUIRED, transaction_id, expires_in}` with NO member session cookie. Repeat confirm cannot bypass it. A refreshed browser can resume via result.
- `POST /api/auth/google/mfa/verify`: `{transaction_id, code}`.
- `POST /api/auth/google/mfa/recovery`: `{transaction_id, recovery_code}`. Optional `disable_mfa: true, confirmed: true` permits explicitly recovering from a lost Authenticator using the final remaining code: policy generation advances, Google sessions are revoked, and the code/policy/session commit atomically. Without that explicit opt-in, recovery leaves policy enabled. The recovery code is consumed atomically with session creation; both login endpoints return the existing member-session DTO, without administrative elevation or device trust.
- `POST /api/auth/google/mfa/enroll/start`: `{transaction_id}` on a fresh enable-policy OAuth transaction; returns local QR enrollment URI. Encrypted setup stays in the existing Google transaction payload without rotating its browser cookie.
- `POST /api/auth/google/mfa/enroll/verify`: `{transaction_id, code}`; returns recovery codes once and `google_mfa_enabled: false`. A subsequent unused TOTP and recovery acknowledgement are still required to enable.
- `POST /api/auth/google/mfa/enable`: `{transaction_id, code, recovery_confirmed: true}`.
- `POST /api/auth/google/mfa/disable`: `{transaction_id, code}` OR `{transaction_id, recovery_code}`, never both. Does not delete Authenticator or alter password trust.
- Policy changes require fresh, action-bound OAuth and exact member/session CSRF. Google sessions rotate with their ORIGINAL expiry and no elevation; password sessions are retained unchanged. Errors are sanitized, missing schema returns 503, and uncertain mutations are not automatically retried.

## Evidence for Part A

- Existing auth/Google/admin-session suites: 125 PASS before three additional security cases; the final Google feature suite separately passes all 20 cases, including those three. There are 128 distinct auth regression cases covered overall.
- Actual Wrangler local migration registry, populated 0019 through 0028: PASS; original rows, sessions, pending transactions, gate, integrity and FK checks preserved. New receipt columns default to zero and policy table is empty. Windows test data now uses a short temporary directory, removed afterward.
- Frontend member unit: 15 PASS; Pages build/isolation: 2 PASS.
- Google browser regression: 84 distinct cases across desktop Chrome, Android Chrome and iPhone WebKit. An expiry test initially raced its 100 ms fixture lifetime on WebKit; freezing the test clock before entry fixed the test, and the expiry scenario passed on all three projects. Runtime timeout rules were not changed.
- Race tests execute actual D1 guards and batches. The test fixture resets an initial TOTP time-step between independent operations to avoid real-time waits; replay/concurrency assertions reuse a code without that reset.

## Local measurement (not Cloudflare CPU)

`google-mfa-local-metrics.json` records one bounded synthetic run under local Miniflare/workerd with a mock Google provider and disposable D1/R2. SQL counts include throttling and transaction guards, but not SQLite's internal trigger sub-statements or billable row counts. Wall times include local dispatch/I/O. They are neither CPU duration nor production percentile/headroom evidence.

| Flow | HTTP invocations | D1 SELECT statements | Write statements | DB trips | sampled aggregate wall ms |
|---|---:|---:|---:|---:|---:|
| Google MFA OFF (start/callback/result/confirm) | 4 | 10 | 19 | 20 | 41.56 |
| Google MFA ON (start/callback/result/challenge/verify) | 5 | 12 | 27 | 28 | 57.51 |

The extra writes are auth rate-limit counters, challenge state, factor use and atomic guard/audit/session operations. The session insertion trigger performs an indexed policy check; it does not run on ordinary member reads. No Google device records/cookies are written.

Actual ordinary member, cases, public ranking, submission status, upload prepare, image PUT, Complete and case creation requests all reported **0 Google policy reads**. `src/lib/auth-session.js` is unchanged. These flows successfully created an isolated synthetic submission after Google MFA login. Existing first-time ranking materialization writes in the sample are unrelated to MFA.

`login-security` necessarily returns own MFA settings, including when the existing Member Center calls it. Its policy metadata is joined by member primary key into the pre-existing identity SELECT, rather than adding a new query or round trip. No other ordinary session read performs that join.

**Cloudflare Worker CPU: UNMEASURED / 未測.** No cloud deployment or native CPU trace was authorized/performed. Workers Free CPU readiness is UNKNOWN; do not convert these wall times into CPU or claim PASS. A bounded isolated CPU check and real-provider controlled acceptance remain separate pre-release validation items.
