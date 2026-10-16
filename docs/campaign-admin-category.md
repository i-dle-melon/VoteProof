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
- Solo default: the existing member total across all historical Solo points.
- Campaign/custom boards: existing publication and rebuild mechanisms retained.
- All-artists Solo ranking: `GET /api/leaderboards/solo-targets` uses the registry
  as its mother set and LEFT JOINs ledger totals by recorded stable target key.
  Artists without Campaigns, Cases or points appear with zero. Inactive registry
  artists remain readable, including their historical totals.
- Individual artist member ranking:
  `GET /api/leaderboards?id=system-solo&solo_target=yuqi`. This filters the same
  ledger, with the existing member ranking/tie/tier policies. No second snapshot
  or rebuild control is added. Display-name changes never change identity.

Approvals already record `solo_target` in ledger metadata; reversals copy the
original metadata. Historical unknown targets can still be read explicitly.
Rows without a recorded target still contribute to aggregate Solo/history, but
are never guessed into an artist from Campaign names or current metadata.
Unknown keys are not automatically added to the registry, renamed or deleted.

The normal Solo tab retains the member total board and adds the registry-based
artist list, with links to artist-specific member ranks. Four fixed navigation
buttons and enabled custom buttons remain unchanged. Preview uses the shared
renderer with synthetic registry/API data and local-only Campaign mutations.

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
inactive entries, Direct payload omission, Preview mutations and artist rankings
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
