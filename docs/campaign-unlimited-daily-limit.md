# Unlimited Campaign daily scoring

Migration `0009_campaign_unlimited_daily_limit.sql` rebuilds only `campaigns`,
copies every existing column without transforming values, and restores its two
indexes and four policy triggers. Child ledger/leaderboard foreign keys continue
to reference `campaigns`. A transactional CHECK guard validates the complete
`pragma_foreign_key_check` graph before resetting deferred DROP bookkeeping;
any violation aborts the migration. No guard table remains after success.
Migrations 0001–0008 are unchanged. No Campaigns, points or thresholds are seeded.

`daily_limit` is a nullable INTEGER with a CHECK constraint:

| Storage / API | Meaning |
| --- | --- |
| `null` | Unlimited scored approvals per member/Campaign/vote date |
| `0` | No proof awards; approval may still succeed with zero points |
| `1`–`1000` | At most this many net scored approvals per day |

Admin create/update must explicitly supply null or an integer. Omitted values,
strings, fractions, negatives and values above 1000 remain invalid. Public/admin
readback and audit/ledger metadata preserve JSON null. Existing finite values,
revocation capacity release and zero-point policies retain their meanings.

The private input to `scripts/prepare-release-plan.mjs --kind campaign` may use
`"daily_limit": "unlimited"` or JSON null. Only the offline builder interprets
that exact shorthand; it emits SQL NULL and still requires existing admin RBAC,
recent MFA/reauthentication, an explicit Campaign ID/category and atomic audit.
Never substitute 0, 999999 or another numeric sentinel.

The approval transaction applies `daily_limit IS NULL OR net_daily_usage <
daily_limit`. Award amounts still require a member and positive points_per_proof.
Ledger remains the sole points source; manual adjustments, completion, ranking,
and proof-count semantics are unchanged. Unlimited Campaigns do not enable the
independent global submission switch.

## Future Production rollout (not executed by this change)

Keep submissions OFF. Back up Production, apply only approved 0009 atomically
with the existing migration tooling, verify preserved data/FK/quick_check, then
deploy the approved new Worker. Create the unlimited Campaign only after that
Worker is verified. The old Worker remains compatible with finite Campaigns but
its old SQL does not award points for NULL caps; do not create/use an unlimited
Campaign during the migration-before-deploy window or roll back to that Worker
while permitting unlimited Campaign approvals. Do not enable submissions as
part of this migration or Campaign bootstrap. D1 supports temporary FK deferral
for schema changes: [Cloudflare foreign-key documentation](https://developers.cloudflare.com/d1/sql-api/foreign-keys/).

Local tests cover a populated 0008 upgrade with finite caps 0/1/1000, ledger,
published snapshot, audit and gate preservation; real approval/revoke/rebuild;
and cap boundaries. The >1000 usage test replaces only the aggregate count with
1001 in disposable D1, exercising the actual approval transaction without
creating 1001 proof rows. No Production state or auth setting is used.
