# Global submission gate

Storage: migration `0008_submission_gate.sql` adds singleton
`submission_settings` (`id=1`) and append-only `submission_settings_audit`.
SQLite stores BOOLEAN as INTEGER constrained to 0/1. Public message is nullable,
at most 500 Unicode characters and cannot contain control characters. The API
returns it as plain text; frontend uses textContent, never HTML.

Default: **OFF** with `投稿暫停開放，請稍後再試。`. A missing singleton row is
OFF. Missing DB/schema or storage failure returns a safe 503; it never enables
submissions. No environment variable, local bypass or default-ON fallback exists.
The isolated developer fixtures explicitly opt in after migrations.

## API and enforcement

- `GET /api/submissions/status`: only `submissions_enabled` (boolean) and
  `submissions_message` (string/null). No version, actor or internal settings.
- `GET /api/admin/submissions`: the two fields plus current version, admin only.
- `POST /api/admin/submissions/update`: requires JSON
  `{ "submissions_enabled": false, "submissions_message": "投稿暫停開放，請稍後再試。", "expected_version": 0 }`.
  All three fields are required; unknown fields rejected. No public mutation API.

All responses use the standard envelope and `Cache-Control: no-store`.
Admin/super_admin only, recent verified VoteProof MFA, active session/membership,
exact AUTH_ORIGIN and member CSRF token required. Authorization is revalidated
inside the D1 batch. CAS version conflict returns 409
`SUBMISSION_SETTINGS_CONFLICT`. Mutation and minimal before/after audit are one
atomic batch; audit failure rolls back the setting. Audit records cannot be
updated, deleted or replaced. Reviewers and ordinary members cannot toggle.

OFF rejects prepare (no new signed URLs), complete (no new completed-upload
records) and new Guest/Member cases with 503 `SUBMISSIONS_DISABLED`. Storage
failure is 503 `SUBMISSIONS_UNAVAILABLE`. Request validation/security errors may
be returned first, but no rejected request creates an upload/case. D1 insert
triggers revalidate OFF for cases, completed uploads and completed files,
closing the check/write race. Existing R2-copy compensation remains effective.

An already committed idempotency replay returns its original 201/query
credential, even while OFF: it creates nothing and preserves recovery after a
lost response. Existing lookup, auth, profiles, member center, leaderboards and
admin/review routes remain available. Turning OFF does not update existing cases.

ON is only a global prerequisite. New cases still require the selected Campaign
to exist, be active within its current window, and accept the vote date; Campaign
version/window/session are still checked atomically. Upload metadata has no
Campaign field in B2, so prepare/complete check the global gate; case creation
checks both global gate and the selected Campaign.

## Operator toggle (no admin UI required)

After separately approved deployment/bootstrap, sign in on the actual VoteProof
origin as the authorized admin and complete the existing Authenticator step-up.
In that same browser Console, run this explicit OFF operation. It reads the
version first and sends the CSRF token only to the same origin; do not print or
copy the session response. To intentionally open submissions, edit ONLY
`submissions_enabled` to `true` and choose the public message/null.

```js
(async () => {
  const get = async path => {
    const response = await fetch(path, { credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer" });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.error?.code || "REQUEST_FAILED");
    return result.data;
  };
  const session = await get("/api/auth/me");
  const current = await get("/api/admin/submissions");
  const response = await fetch("/api/admin/submissions/update", {
    method: "POST", credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrf_token },
    body: JSON.stringify({ submissions_enabled: false,
      submissions_message: "投稿暫停開放，請稍後再試。", expected_version: current.version })
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.error?.code || "REQUEST_FAILED");
  console.log({ submissions_enabled: result.data.submissions_enabled, version: result.data.version });
})();
```

Do not bypass authorization with ad hoc unaudited Production SQL. No toggle is
executed automatically by migration, bootstrap, dev launcher, push or deployment.

## Frontend

Initial state is disabled until the no-store public status request succeeds.
OFF hides submission links and disables the form/submit action, showing the
public message on home and submission views. Active Campaigns still display.
Status is refreshed on navigation to submission, window focus, Campaign refresh,
and a gate-related rejection. Fetch failure leaves submission disabled. A stale
browser view cannot bypass backend checks. Other public/member views keep working.

## R2 capability limitation and rollout

A PUT URL issued before OFF is a capability with up to 300 seconds remaining.
The Worker cannot revoke that individual URL. Such PUTs can still create private
staging objects, but OFF prevents completion/new cases; orphan lifecycle policy
still applies. OFF is not an instantaneous R2 transport kill switch. Requests
already in progress can finish signing around the toggle boundary; no DB
creation may commit after OFF. Do not weaken private R2/Turnstile for this gate.

The next release candidate must be re-frozen after this source change. Apply
0008 only in a separately approved rollout, after 0001–0007; historical files
are unchanged. The old B1–B3 Worker still reads existing cases, but 0008 OFF
intentionally blocks its new case/complete inserts during migration-before-deploy
(old error codes may be generic). Do not deploy intermediate checkpoints or
assume the old Worker's prepare endpoint knows the new gate: it can still issue
PUT URLs until replaced. Use the existing approved writer-drain/maintenance
procedure for migration-before-deploy; the complete gate is provided by the new Worker.
Do not enable submissions before new Worker, real admin/Campaign bootstrap and live
acceptance have passed. Old Worker rollback leaves OFF enforced by DB triggers.

This feature changes no Production data/settings and requires no new Secret.
