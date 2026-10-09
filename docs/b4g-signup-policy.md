# B4G.1 signup-policy compatibility (local only)

## Official behavior and what has not been tested

On 2026-10-09 the official Supabase Auth revision inspected was [`ce9a8eee0cc042be8c7a42981a7ddae631e41d91`](https://github.com/supabase/auth/tree/ce9a8eee0cc042be8c7a42981a7ddae631e41d91).

[`admin.go` / `adminUserCreate`](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/api/admin.go) creates the user in its own transaction without invoking BeforeUserCreated. Its trusted AdminUserParams accepts app_metadata. It initializes provider=email for email accounts and merges custom app_metadata later in that transaction. The current upstream Admin create-user path therefore bypasses the hook.

[`signup.go` / `SignupParams` / `Signup` / `signupNewUser`](https://github.com/supabase/auth/blob/ce9a8eee0cc042be8c7a42981a7ddae631e41d91/internal/api/signup.go) exposes public email/password and user-editable `data`, but no app_metadata parameter. Public provider metadata is assigned server-side; Signup invokes BeforeUserCreated before insertion. Root app_metadata is not an accepted signup field; app_metadata nested in data remains user_metadata. Both fail our policy. Public credentials cannot authorize the Admin endpoint.

The [hosted hook documentation](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook) describes pre-creation execution without promising an Admin-endpoint exception. The [createUser contract](https://supabase.com/docs/reference/javascript/auth-admin-createuser) is server-only; neither page guarantees the inspected upstream control flow for every hosted version. No hosted hook was enabled or invoked, no actual provider creation was attempted, and the deployed Auth version was not inspected in this task. Local fixtures test upstream-style bypass AND compatibility if a hook receives Admin custom app_metadata. They do not claim to verify hosted behavior. A future implementation invoking the hook before custom metadata is merged could still require provider-side adjustment; verify the actual disposable hosted project before rollout.

Supabase documents that users can edit user_metadata but cannot edit [app_metadata](https://supabase.com/docs/guides/database/postgres/row-level-security#authjwt). The marker is an authorization attribute, not a secret. Never place it in user_metadata, accept it from a VoteProof request, or use it as a VoteProof session/member authorization claim. Any trusted Admin credential holder can set it, so those credentials and privileged hooks must remain server-only.

## Approved creation policy

Canonical deployable operator SQL is [voteproof-signup-policy.sql](voteproof-signup-policy.sql); tests execute this exact file in isolated in-memory PostgreSQL via development-only PGlite. It is outside migrations and never imported by the Worker. Install only with separate operator authorization.

| Payload | Decision |
|---|---|
| is_anonymous JSON false + trusted provider google | Allow |
| is_anonymous JSON false + trusted provider email + app_metadata.voteproof_verified_signup JSON true | Allow |
| Public email without that app_metadata boolean | Deny 403 |
| Marker in data/user_metadata, or attempted root public signup app_metadata | Deny 403 |
| Marker false/null/string/number, missing provider/anonymous flag, unsupported provider | Deny 403 |
| Anonymous, even with Google or the email marker | Deny 403 |

`adminCreateVerifiedUser()` hardcodes `voteproof_verified_signup: true` alongside the existing enrollment UUID. Its only production call site remains `registrationCredentials()` after a browser-bound, unexpired, verified-email transaction and durable enrollment guard. Client app_metadata is rejected by onlyFields; no provider create happens on a forged request or before email verification. Google OAuth creation does not need this email marker. The Google→add-password path updates an existing UUID, so does not create a user or require the marker.

The function uses SECURITY INVOKER and empty search_path; only supabase_auth_admin receives execute permission. It reads no database tables and trusts only server-generated app_metadata plus the anonymous flag. Email/password registration remains Gmail ownership proof → server Admin create → VoteProof TOTP/recovery → activation, with one UUID/member.

## Operator acceptance gate (not executed)

Authentication → Auth Hooks → Before User Created → Postgres function → public.voteproof_signup_policy → Enabled. Install its grants using SQL Editor, enable it before global signup, and keep the rest of [B4G-Live settings](b4g-live-acceptance.md).

On a disposable hosted project, verify Google signup and Worker verified-email Admin create both succeed, public email signup with forged root/nested metadata fails, anonymous fails, and existing password login still works. Determine whether that hosted Admin request invokes the hook using safe operator instrumentation; do not infer this from the upstream source or mocks. Do not log payloads/passwords/tokens/email while diagnosing. Production Google Cloud/Supabase settings, D1/R2, migrations and traffic remain untouched.

## Local checkpoint verification

Starting Git state: clean main at `e6454bcb0b2795adc3650a0870dfea04e406ac5c`, ahead of origin/main by 12 commits. This checkpoint adds no D1 migration or frontend change.

- Node: 641/641 pass (626 retained + 15 new SQL/policy/adapter/registration tests).
- Browser: 228/228 pass across desktop Chrome, Android Chrome and iPhone WebKit.
- Auth smoke and real Member/Google frontend smoke with isolated provider fixtures pass.
- Fresh local D1 0001–0007 apply; foreign_key_check passes, quick_check=ok.
- Wrangler dry-run passes (279.61 KiB, gzip 64.11 KiB). PGlite 0.5.8 is an exact-pinned development dependency only; it is absent from the Worker/frontend bundles.
- Changed-file/static asset sensitive scans and git diff whitespace checks pass. No credentials/local paths/signed URLs/tokens/env files were added. Ignored live config was not read; no real hosted provider calls or settings changes.

Changed files:

| Group | Files |
|---|---|
| Worker adapter | `src/lib/supabase-auth.js` |
| Exact hook / assessment | `docs/voteproof-signup-policy.sql`, `docs/b4g-signup-policy.md` |
| Updated B4G docs | `docs/b4g-live-acceptance.md`, `docs/b4g-provider-assessment.md`, `docs/b4g-dual-auth.md` |
| Local fixtures | `scripts/lib/local-auth-provider.mjs`, `scripts/lib/local-case-runtime.mjs`, `scripts/lib/local-google-runtime.mjs` |
| Tests / development dependency | `test/auth-signup-policy.test.js`, `package.json`, `package-lock.json` |
