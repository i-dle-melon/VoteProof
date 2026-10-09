# B4G provider assessment (local development)

Reviewed Supabase hosted documentation and upstream Auth source on 2026-10-09. No Production project settings or provider login were inspected. Hosted Auth version/settings still require the separate live acceptance procedure.

## Actual provider behavior

Google is an `auth.identities` row with provider `google`, its own identity UUID/provider subject and verified identity data. It belongs to an `auth.users` UUID; the user UUID, not the email or Google subject, is VoteProof's durable mapping.

Supabase automatically attaches a same-email verified OAuth identity to an existing user during its provider callback transaction, BEFORE redirecting the authorization code to VoteProof. A returning app cannot offer true pre-link approval at that point. Unconfirmed identities are removed to prevent pre-account takeover. See [linking documentation](https://supabase.com/docs/guides/auth/auth-identity-linking) and [provider callback source](https://github.com/supabase/auth/blob/master/internal/api/external.go).

The hosted manual-linking toggle controls the authenticated `linkIdentity` feature, not automatic linking. Upstream has experimental provider linking domains; these are not an assumed hosted/dashboard control and isolating Google would defeat the chosen shared UUID model. Manual linking requires a provider session, permits different emails, and completes inside the provider callback. VoteProof v1 instead uses same-email OAuth reconciliation and exact UUID comparison; manual linking need not be enabled.

Supabase unlink requires a signed-in user with multiple identities. That count does not prove the remaining method is usable in VoteProof, nor prove an identity was newly created by this request. Concurrent callbacks also prevent safe attribution. Cancel therefore cancels VoteProof activation/session only; it does NOT undo provider linking, delete users, or claim nothing was linked. Provider unlinking is deferred. See [identity source](https://github.com/supabase/auth/blob/master/internal/api/identity.go).

Adding a password to an OAuth user is supported by updating that same user. Presence of an email identity is not a reliable password-enabled flag: upstream creation of an email identity on password set is experimental/version dependent. VoteProof keeps its own password-method activation flag and requires TOTP verification/recovery generation before setting it. Provider password writes can succeed while the local transaction fails; the flag remains disabled and Google remains usable until a verified retry completes.

Global signup disabled also blocks creation of new OAuth users. Email provider disabled blocks both email signup AND password grant; it cannot meet dual authentication requirements. See [configuration](https://supabase.com/docs/guides/auth/general-configuration), [signup source](https://github.com/supabase/auth/blob/master/internal/api/signup.go), and [password grant source](https://github.com/supabase/auth/blob/master/internal/api/token.go).

Future setup must enable global signup, Google and Email login, retain Confirm Email, disable anonymous signup, and install a Before User Created hook allowing non-anonymous Google OR trusted server-verified email creation. Email requires `app_metadata.voteproof_verified_signup` to be the JSON boolean true, which the Worker sets after its email ownership proof. Public user_metadata cannot authorize it. Official upstream Admin create bypasses the hook; this is an implementation observation, not a guaranteed hosted API exception. The policy explicitly supports both approved paths regardless of that observation. Hosted hook behavior and direct signup rejection MUST be checked before rollout. A public provider user is never a VoteProof member merely by existing in Supabase. See [B4G.1 assessment](b4g-signup-policy.md), [exact SQL](voteproof-signup-policy.sql) and [Before User Created hook](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook).

## Local architecture decision

Server PKCE with S256, random browser-bound state, five-minute one-time callback claim; exact callback URL with no user redirect destination. Provider access/refresh/Google tokens exist only in the server exchange, never in D1, browser JSON/storage or logs. VoteProof verifies `/user`, a confirmed Google identity and exact Supabase UUID, then uses its own sessions.

Existing password accounts require truthful post-provider confirmation before local Google activation. Authenticated same-email linking checks initiating session and UUID again at confirmation. New users provide VoteProof profile only. Unique UUID/member/email constraints and D1 batch guards fail closed on collisions, incomplete password enrollment or races. No history transfer.

Adding password requires explicit same-account consent plus fresh Google proof (or a VoteProof verified email transaction), TOTP and recovery codes; no password plaintext persists. Google-only admin TOTP enrollment and Google proof + TOTP step-up preserve the existing elevated-session guard. Ordinary Google login has zero elevation.
