# B4G / B6G dual authentication (local checkpoint)

Production remains paused. No push/deploy/provider change/remote migration is part of this checkpoint. Read [provider assessment](b4g-provider-assessment.md) before changing hosted settings, then follow [separate Live acceptance](b4g-live-acceptance.md).

## Model and schema

Unpublished `0003_member_identity.sql` extends the existing one-row Supabase UUID → unique VoteProof member mapping. It adds `password_enabled` (default 1 for accepted password inserts), nullable unique `google_identity_id`, immutable mapping triggers, session `auth_method` and short `google_authenticated_until`. Google-only inserts explicitly use password_enabled=0 and NO credential/recovery row.

New `auth_google_flows` holds state/browser hashes and encrypted PKCE verifier (purpose-specific AES-GCM AAD), initiating member/session, purpose, expiry and one-time callback claim. `auth_method_setups` holds a unique member reservation, transaction, HMAC of the retry request password and a 30-second writer lease; this HMAC binds an authorized retry, is NOT a password authentication verifier or KDF. It cannot authorize login and no raw password is stored. `auth_identity_events` is append-only with flow/member/action/time and verified provider UUID/identity UUID for reconciliation, no email/tokens. Existing 0001/0002 and 0004–0007 are unchanged. Recreate disposable local DBs made with the older unpublished 0003; do not attempt to rewrite an applied Production migration.

Email is encrypted and HMAC-indexed for ownership-proved lookup/conflict detection, never used as member identity. Profile/cases/points/tier tables are not moved or merged. One confirmed provider UUID cannot receive a second member. A different UUID colliding with the same email, another member selected during connect, or pending B4S password enrollment fails closed. Pending enrollments stay blocked even after expiry until safe operator reconciliation; no timed destructive cleanup of provider users.

## API and lifecycle

All JSON responses use existing envelopes and no-store. Mutations use exact AUTH_ORIGIN, X-VoteProof-Request and member CSRF when a session is involved.

| Endpoint | Contract |
|---|---|
| POST `/api/auth/google/start` | `{purpose: login/connect/security, confirmed?: true}`; connect/security require current member + CSRF + explicit consent. Returns authorize_url and expires_in=300. No client redirect argument. Login refuses signed-in account switching. |
| GET `/api/auth/google/callback?state=...&code=...` | Exact origin/path, single random state/code, initiating HttpOnly browser cookie, persisted expiry and atomic one-time claim; exchange server PKCE, fetch verified `/user`, require confirmed same-email Google identity/valid UUID. Success 303 to exact `/#google`; errors are safe no-store JSON. |
| GET `/api/auth/google/result` | Browser-bound pending proof, verified Google email and PROFILE_REQUIRED/CONFIRM_REQUIRED/LOGIN_READY; shows provider_already_linked honestly. No session yet. |
| POST `/api/auth/google/confirm` | transaction_id, confirmed=true; profile nickname/player_id for new user, optional remember_me. Existing profile remains intact. Atomic identity activation + own session. No ordinary TOTP/recovery for Google. |
| POST `/api/auth/google/cancel` | transaction_id; consumes proof, cancels VoteProof activation, explicitly returns provider_unlinked=false. No provider mutation/session. |
| GET `/api/auth/login-security` | Current member only; own method flags/Google email/TOTP configuration. No provider tokens/UUID/internal fields. |
| POST `/api/auth/password/add/start` | confirmed=true; fresh Google session OR verified-email add-password transaction. Creates encrypted TOTP setup for same member or asks for existing TOTP. No password is written yet. |
| POST `/api/auth/password/add/verify` | transaction_id, new_password, code; validates TOTP FIRST, reserves durable write, writes password to SAME Supabase UUID, then atomic credentials/recovery/method activation/consumption/own session. |
| POST `/api/auth/google/totp/enroll/start`, `/verify` | Fresh Google session + CSRF + consent; TOTP enrollment/recovery for elevated security WITHOUT forcing password. Enrollment grants no admin elevation. Backend only. |
| POST `/api/auth/google/step-up` | Fresh browser/session-bound `purpose=security` Google proof + existing unused TOTP timestep; elevates existing session, consumes proof, appends audit. Existing RBAC remains authoritative. Backend only. |

OAuth flow TTL=300 seconds; pending Google proof is also accepted only within 300 seconds even though the generic transaction row TTL is 600. Independent 256-bit state and browser cookie; PKCE S256 verifier stays encrypted server-side. Two tabs share a cookie slot: the later initiation invalidates the earlier browser binding, which fails closed. Refresh/replay does not re-exchange or create another account. Supabase tokens are discarded, never stored in D1/localStorage or returned to the browser. No provider SDK is shipped.

VoteProof sessions keep existing 7/30-day expiry, HttpOnly/Secure/SameSite=Lax, token hash, rotation/revocation and CSRF. Google sessions have zero elevation; their fresh Google proof lasts 300 seconds for adding security. Password login remains trusted-device-or-TOTP. Admin/reviewer access always checks elevated_until and role; Google-only users can explicitly enroll VoteProof TOTP and then use fresh OAuth+TOTP step-up. No admin frontend.

## Truthful UX / recovery

Login/registration offer Google OR email/password. New Google members supply profile only. Logged-out same-email Google and authenticated same-email connect use actual verified Google email, explain that Supabase may already have linked the identity, and gate local method activation behind confirmation. Cancel does not claim rollback. v1 neither unlinks providers nor connects different emails. There is no last-method removal endpoint.

Verified Gmail registration discovering a Google-only mapping offers explicit add-password confirmation; before ownership proof the existing generic send responses remain identical. It never calls createUser for that existing account. Google requires no verification mail. Add-password failures keep the password flag disabled and Google usable. If the provider write succeeded but D1 failed, retry the SAME transaction/password after the lease expires (TOTP must still be valid); local flag/credential guards prevent competing setups. If the transaction expires or the outcome cannot be reconciled, use Google and contact the operator; v1 intentionally does not automatically replace the uncertain reservation or delete an identity. Backend tokens cannot bypass the local disabled flag.

Google account recovery belongs to Google. Password recovery remains email + VoteProof TOTP + unused Recovery Code. Google-only accounts (including TOTP-enrolled admins) cannot use that flow to silently create/reset a password. Google-assisted password reset and unlink are deferred. Password change UI uses the existing password+TOTP step-up, even when signed in through Google. Existing TOTP reset/device management APIs remain; their expanded management UI is deferred.

## Boundaries / local verification

No new Worker Secret is needed: existing auth HMAC/encryption keys use purpose separation; Supabase keys remain server-only. Google client secret is configured solely in Supabase. Gmail sender OAuth credentials are independent. CSP, public assets boundary and Worker bindings remain unchanged. No logs include request bodies, query strings, provider responses, tokens, passwords or codes. Callback does not run frontend analytics; redirects immediately to a clean URL. Future infrastructure/access-log integrations must redact callback query strings, Cookie/Authorization and auth bodies; application code cannot guarantee external vendor log retention policies.

Tests use disposable workerd/D1/R2, mock Supabase PKCE with pre-return automatic linking, ephemeral credentials and local browser fixtures. `npm run test:google-frontend-smoke` runs real frontend/Worker/D1/Secure cookies and PKCE exchange against the mock, then proves Google and password/TOTP enter the same member. These prove local behavior, not the actual hosted provider deployment version or settings. B4G-Live remains mandatory before rollout. Existing B1–B6 regression and schema checks remain required.

## Checkpoint verification and changed files (2026-10-09)

- Starting Git state: clean main, 11 commits ahead of origin/main; accepted HEAD `f6f929742afe4ac13292f423f3a6ff527ef73932`.
- Node: **626/626** passing, including 43 Google/dual-method tests and all existing 583 tests.
- Browser: **228/228** passing across desktop Chrome, Android Chrome and iPhone WebKit; 54 Google/security checks plus 174 existing checks. Includes 320px layout, private setup erasure, session expiration, truthful cancellation and recovery acknowledgement.
- B1/B2/B3/B4S/B5A/B5B/B5C/B5D smoke and Guest/member/Google frontend smoke all pass using isolated local fixtures.
- Fresh local D1: 0001–0007 apply; foreign_key_check passes; quick_check=ok; no member/case fixtures retained in that schema-verification database (eight fixed tier definitions are intentional migration seed rows).
- Wrangler dry-run passes: 279.58 KiB, gzip 64.10 KiB; bindings/CSP unchanged. No deployment.
- Git diff whitespace checks and changed-file/static-asset sensitive scans pass. No ignored live credentials were read; no environment files, local databases, node_modules or generated logs belong in this commit.
- No real Google provider tests or Production calls/settings/migrations/data changes. Signup-hook behavior, hosted identity shapes and redirect matching remain gated by separate B4G-Live acceptance.

| Change | Files |
|---|---|
| Google/provider/method backend | `src/api/auth-google.js`, `src/api/auth-methods.js`, `src/lib/supabase-auth.js`, `src/api/router.js` |
| Existing password/session integration | `src/api/auth-login.js`, `src/api/auth-recovery.js`, `src/api/auth-registration.js`, `src/api/auth.js`, `src/lib/auth-identity.js`, `src/lib/auth-session.js` |
| Unpublished schema only | `migrations/0003_member_identity.sql` |
| Existing frontend extension | `public/index.html`, `public/css/app.css`, `public/js/app.js`, `public/js/member.js`, `public/js/member-api.js` |
| Local provider/runtime fixtures | `scripts/lib/local-auth-provider.mjs`, `scripts/lib/local-case-runtime.mjs`, `scripts/lib/local-google-runtime.mjs`, `frontend-tests/member-fixture.mjs` |
| Tests and checks | `test/auth-google.test.js`, `frontend-tests/google.spec.js`, `scripts/smoke-google-frontend.mjs`, `scripts/check-admin-schema.mjs`, `scripts/check-frontend-sensitive.mjs`, `package.json` |
| Documentation | `README.md`, `docs/b4g-dual-auth.md`, `docs/b4g-provider-assessment.md`, `docs/b4g-live-acceptance.md` |
