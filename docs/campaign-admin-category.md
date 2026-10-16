# Campaign category and Solo target registry

Local source change only. No Production deployment, migration, Campaign creation,
submission gate change, R2 access, Apps Script operation or Drive relay change.

## Submission contract

Before this change the public form displayed a locked type and the browser still
had to send `vote_type`. Now the form selects only Campaign (with the existing
date, note and proof fields). New frontend payloads omit `vote_type`, `category`
and `solo_target`. Public Campaign responses retain `category` for compatibility,
but omit `solo_target`; invalid legacy classification is not offered for new
submissions. Historical/Admin reads are unchanged.

Both legacy and Direct Case handlers resolve Campaign from `campaign_id` and
derive the stored Case `vote_type` from Campaign.category. Legacy clients may
still assert `vote_type`; a mismatch is rejected. Extra classification fields
are rejected. Idempotency hashes/replay run before derivation, preserving old
request hashes and successful retries after gate closure. Existing atomic
Campaign version/type, ownership, Origin/CSRF and upload guards remain in force.
The Direct path is Prepare → Worker streaming PUT → Case, without Complete.

## Registry and Admin

Migration `0019_solo_target_registry.sql` adds only `solo_targets` and its stable
ID trigger. It seeds miyeon/MIYEON, minnie/MINNIE, soyeon/SOYEON, yuqi/YUQI and
shuhua/SHUHUA, active with sort order 1–5. `target_id` is immutable;
`display_name`, `active` and `sort_order` are metadata. There is no Campaign FK or
backfill, so unknown historical keys remain intact and readable.

Admin fetches `GET /api/admin/solo-targets` through the existing authenticated,
MFA-protected transport. The dropdown uses active API entries; frontend source
contains no authoritative artist list. Unknown/inactive existing selections are
displayed read-only with a historical label. Solo Campaign create/update requires
an active registry target. The server checks membership and rechecks it in the
atomic INSERT/UPDATE guard, preventing a deactivation race from accepting a new
configuration. Unknown/inactive legacy configurations cannot be resaved through
this editor; no ID is silently changed. Existing category/target immutability
rules remain in place. Group hides/disables the target and sends `null`; a forged
non-null Group target is rejected.

Registry entries are backend-managed. There is deliberately no new public or
Admin registry mutation endpoint. Future additions can be reviewed as registry
data changes, without modifying Campaign, Case, ledger or ranking models. Prefer
deactivation over deleting identities with historical use.

## Rankings

- History: all formal ledger points, including adjustments and exact reversals.
- Group: all historical Group points across Campaigns.
- Solo total: one member ranking across all historical Solo points, including
  exact reversals. Campaign `solo_target` never groups or filters this total.
- Campaign/custom boards: existing publication and rebuild mechanisms retained.
- Registry is Campaign metadata only, not a public leaderboard dimension.
  The former `GET /api/leaderboards/solo-targets` route is removed (404).
  Public leaderboard requests with `solo_target` are rejected (400), so an old
  client cannot accidentally treat the member total as an artist-specific rank.

Approvals already record `solo_target` in ledger metadata; reversals copy the
original metadata. Historical unknown targets remain readable in Campaign/Case
records. All Solo ledger rows contribute to the member Solo total, including
unknown or absent target metadata. No artist identity is guessed from names.
Unknown keys are not automatically added to the registry, renamed or deleted.

The Solo tab shows only member ranks, names and accumulated Solo points. There
are no artist cards or drilldown buttons. For example, one member's miyeon +10,
minnie +20 and yuqi +30 produce one row with 60 points. Revoking the 20-point
proof leaves 40. Group/history scope and campaign/custom publication are retained.
Preview uses the same renderer; its registry fixture is used only by Admin.

## Future Campaign preparation (not executed)

`2026_MAMA_FANS_CHOICE` / `2026 MAMA Fan's Choice`:
Asia/Taipei start 2026-10-16 23:01 (`2026-10-16T15:01:00.000Z`),
end 2026-10-25 22:59 (`2026-10-25T14:59:00.000Z`, existing exclusive-end contract),
10 points, `daily_limit=null`, draft. Admin must decide category; Solo additionally
requires an active target. No Campaign or activation request has been sent.

## Local validation

The normal workerd/Miniflare harness was attempted but could not connect to its
local service (`EACCES 127.0.0.1`). This is an environment restriction, not a
Production failure. No elevated permissions or Production retry was attempted.

Additional tests execute real Worker handlers and the complete SQLite schema in
process with synthetic R2/Turnstile. They cover Campaign validation and the active
target race, derived guest/member Direct Cases, idempotency, Gate OFF, batch
review, points/reversal, ranking, legacy V1/V2 readers, private image/export and
Drive backup references. The additive migration test preserves populated
Campaign/Case/file/ledger/backup rows, including an unknown historical target.
These component tests do not claim provider/workerd execution coverage.

Browser component tests fulfill local static source files and mock API contracts
without opening a local listener. They use the real public/Admin renderers and
the built Pages artifact. They cover dropdown loading/validation, future and
inactive entries, Direct payload omission, Preview mutations and member Solo totals
at 320/390/430/1024/1440 in both themes across Chrome and WebKit projects.

Commands:

```text
node --test test/campaign-category-registry.test.js
npx playwright test --config=playwright.component.config.js
npm run check:frontend-hooks
npm run check:public-assets
npm run check:frontend-sensitive
npm run build:pages-preview
git diff --check
```

Migration 0019 must be tested/applied under a separately authorized future
deployment before serving this new code. No migration or deployment command
is part of this local implementation task.
