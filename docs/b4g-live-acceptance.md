# B4G-Live acceptance — preparation only

Do not execute these operator steps until a separately authorized Live phase. B7 remains paused. Use a separate non-Production Supabase project, disposable test identities and local HTTPS Worker/D1/R2 first. Do not paste credentials, auth codes or passwords into chat, Git or logs.

## Future Google Cloud operator setup

1. Create a separate OAuth **Web application** client named `VoteProof Google Login`. Do not reuse the Gmail sender client.
2. Configure consent branding/support/privacy URLs and test users if the app is in Testing.
3. Request only `openid`, `email`, `profile` (Cloud console equivalents may display userinfo.email/userinfo.profile). No Gmail/Drive/Contacts/Calendar scopes.
4. Authorized JavaScript origins: `https://voteproof.i-dle-melon.workers.dev` for the future rollout; for isolated Live add only the exact chosen local HTTPS application origin. Origins have no path/trailing slash. Do not add wildcards.
5. Authorized redirect URI: copy the exact **Supabase Google provider callback** shown in its dashboard, normally `https://<project-ref>.supabase.co/auth/v1/callback`. This is Google's callback, NOT the VoteProof callback. A custom Supabase auth domain requires its displayed callback instead.
6. Keep client ID/secret in provider settings. No Google client secret or Gmail sender secret belongs in frontend or repo.

## Future Supabase operator setup

1. Google provider: enable, configure that separate client ID/secret, retain nonce verification; do not enable unrelated scopes/provider options.
2. Auth URL Configuration: Site URL = exact VoteProof application origin. Redirect allowlist = `https://voteproof.i-dle-melon.workers.dev/api/auth/google/callback?state=*` for future Production (the star matches only the app-generated 256-bit state). Add only the corresponding EXACT local HTTPS host/path rule for isolated Live. Never add a whole-domain `/**` or third-party redirect wildcard. Verify the hosted matcher includes query strings and accepts the generated URL; do not silently fall back to Site URL.
3. Allow new users signup = ON for new Google accounts. Email provider = ON for password grant. Confirm Email = ON; anonymous = OFF. Manual identity linking need not be enabled: v1 intentionally uses same-email automatic linking and exact UUID reconciliation, not `linkIdentity` or different-email linking.
4. Before User Created hook: reject public non-Google signup using trusted `user.app_metadata.provider`, not editable user_metadata. This hook is listed as available on Free/Pro in [Supabase Auth Hooks](https://supabase.com/docs/guides/auth/auth-hooks). Install the following **operator-reviewed Postgres hook** using SQL Editor and select it under Authentication → Hooks → Before User Created. It is not a D1 migration and Codex has not executed it:

```sql
create or replace function public.voteproof_signup_policy(event jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
begin
  if event #>> '{user,app_metadata,provider}' = 'google'
     and coalesce((event #>> '{user,is_anonymous}')::boolean, false) = false then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'Use the application registration flow'));
end;
$$;
revoke execute on function public.voteproof_signup_policy(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.voteproof_signup_policy(jsonb) to supabase_auth_admin;
```

5. Before enabling signup, verify on the disposable project that direct public email signup is rejected, new Google signup succeeds, existing password grant succeeds, and VoteProof verified-email Admin API create still succeeds. Upstream Admin create bypasses the public signup hook; hosted behavior must be proven. If this combination is unavailable, FAIL CLOSED and leave rollout paused. Do not turn off Confirm Email to make it work.
6. No new VoteProof Worker secrets; existing SUPABASE/AUTH/GMAIL settings remain server-only. Set local AUTH_ORIGIN to the chosen exact HTTPS origin. Use local trusted TLS so Secure __Host cookies survive the cross-site redirect; do not remove Secure for development. Dashboard values must be entered privately, not committed.

## Live test matrix after separate authorization

Record status/check names and opaque member/case references only, without tokens/passwords/emails/screenshots of secret setup.

- New Google user: start/browser state/PKCE → provider → exact callback → profile → own session; zero password credential/recovery/mail rows; /me/cases, points/tier and Guest remain usable.
- Existing password same verified Google email: inspect provider identities privately to confirm automatic linking occurred before VoteProof prompt. Confirm retains UUID/member/profile/cases/ledger/tier. Cancel retains provider identity, issues no session/local activation; original password login still works. Repeat Google login continues same member.
- Authenticated same-email connect: explicit initial consent, provider email shown, final confirmation. Different email or identity belonging to another member returns conflict; no member/history merge. Two tabs/callback refresh/replay fail closed. Log out or switch account in another tab before callback/confirm and verify it refuses activation.
- Google→password: explicit same-account consent, new password through server Admin API, TOTP verify/recovery, one same UUID/member. Before completion or after forced local failure, Google remains usable; password method stays disabled. Verify same-transaction retry; do not test destructive provider failures on real members.
- Email registration matching Google: generic send before ownership proof; after proof add-password offer and no createUser/no second member. Concurrent Google/profile/password registration must yield one member or safe conflict.
- Password route remains password + trusted device/TOTP; Google route normal members requires neither. Google-only promoted reviewer/admin cannot access elevated APIs; enroll VoteProof TOTP, then fresh Google proof + TOTP step-up works with existing RBAC. No password is forced for this backend admin path.
- Unlink remains absent; Google-assisted password reset remains absent; Google-only password recovery refuses. Password recovery still requires original TOTP + unused code.
- Inspect own security screen states and safe public API response fields. Verify no Supabase refresh/access token in browser localStorage/cookies/URLs/JSON; only VoteProof HttpOnly cookies and random state/auth code during transient callback. Review infrastructure log redaction separately.
- Simulate Google outage while Supabase password grant works; verify Guest/public unaffected. Supabase outage makes both provider methods fail gracefully but Guest stays available.

Do not delete arbitrary provider users, migrations or member history to clean up. Use only tracked disposable identities/isolated local databases. If any actual hosted behavior differs from the assessment, stop rollout and revise implementation/UX first.
