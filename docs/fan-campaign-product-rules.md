# Fan ID, campaign types and system rankings

Source/local implementation only. Do not apply migration 0014 or deploy the
Worker as part of GitHub Pages publication. Production submissions remain OFF.

`members.player_id` is the existing public fan ID; API `fan_id` is its descriptive
alias, not another identity. Existing `idle_voteproof` is preserved. Display IDs
retain their original form. Uniqueness folds ASCII case and outer spaces using
SQLite `lower(trim(player_id))`; input retains existing trim behavior. No Unicode
compatibility conversion is introduced. The partial unique index permits NULL
profiles. Immutable/no-replace triggers prevent overwrites; the profile UPDATE
also guards a concurrent first claim. Google/password linking retains the same
member. Nicknames remain nonunique; the rate-limited, same-origin advisory
returns only `{duplicate:boolean}`. Its failure never blocks profile saving.

Migration 0014 fails on historical normalized collisions without deleting,
renaming or merging members. For a future authorized rollout, preflight on an
authorized database copy:

```sql
SELECT lower(trim(player_id)) AS normalized_fan_id, COUNT(*) AS collisions
FROM members WHERE player_id IS NOT NULL
GROUP BY lower(trim(player_id)) HAVING COUNT(*) > 1;
SELECT campaign_id, category FROM campaigns WHERE category NOT IN ('Solo','團體');
SELECT campaign_id FROM campaigns WHERE category='Solo' AND solo_target IS NULL;
```

Campaign `category` is the sole Solo/group classification. `solo_target` is a
stable explicit key shared across campaigns, frozen once assigned; no names are
used to infer it. Approval records that key in immutable ledger metadata. Old
Solo ledger entries without metadata use an explicitly assigned campaign key;
unresolved entries are reported and excluded from Solo target totals, while
history totals still include all valid points. No backfill runs here.

History/group/Solo use direct ledger reads including compensating reversals.
History also includes formal unscoped adjustments. Group uses `vote_type='團體'`;
Solo groups independently by stable target. Existing all_time snapshots remain
for audit but are never served, edited or rebuilt. Campaign/custom snapshots,
version guards, publication and rebuild controls remain supported. Fixed board
metadata is outside the mutable Admin pagination in `system_boards`.

Anonymous submissions use `匿名投稿`; legacy identity fields are validated only
for compatibility/idempotent replay, never stored as identity. Members use the
authenticated profile snapshot. Query credentials remain RAM-only and explicitly
copied/downloaded through secondary disclosures. Member dialogs only use the
owner-scoped metadata endpoint. Admin proof rendering keeps authenticated/MFA
transport and revokes transient object URLs on collapse, switch or logout.

Pages injects only build-time session/fixture transports. Review/profile demos
mutate synthetic in-memory state; all other writes remain denied. CSP forbids
network API connections. Reload discards mutations. Production cannot enable
the adapter through a URL, storage key or DOM marker.


Admin Review Workflow V2 adds only `review_stage` and a generic
`review_risk_reason`, plus the existing audit enum extension in migration 0015.
It does not add color/ROI/pixel/pHash/OCR/ML/image-risk scoring, workers or tables.
The four current manual reason codes are `manual_flag`, `exact_duplicate`,
`auto_check_failed`, `other`. Flagging leaves the case pending and writes no points.

Album previews use the existing authenticated private blob endpoint and lazy
loading; their object URLs are transient. Fast approval accepts exact case IDs
and expected versions, four per request. The browser sequences up to 20 selected
cases and retains only failures for retry. Each case is independently atomic;
audit-confirmed retries recover lost acknowledgements without another award.
Detailed cases require explicit individual review. Compare-and-swap, live
session/MFA/RBAC SQL guards, original ledger uniqueness and compensating reversals
remain authoritative. The query bound is covered by a structural D1 test, not
CPU profiling or a Production readiness claim.

D1 limit reference: https://developers.cloudflare.com/d1/platform/limits/
Async remains optional same-member/same-Campaign/R2-verified exact SHA evidence.
It never automatically rejects, approves or changes points. Production Async
rollout remains NO-GO. Neither new migration is applied to Production here.
