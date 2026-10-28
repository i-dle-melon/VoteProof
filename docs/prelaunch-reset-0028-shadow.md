# B0 / 0028 local shadow preparation

Base: b3d00e7b2cda988d0c91a166515ce6ebacb0a322. Offline synthetic data only.
The original nine Reset V1 source files remain byte-identical in the original
checkout and reference/original-v1-source delivery folder. Five original library
files are reused unchanged here. The old 68-table fixture is not installed in
this checkout's test directory: it requires 0029/0030. No Migration is
added, edited or run against Cloudflare by this extension.

The 64 application tables exclude d1_migrations and platform-internal tables.
The fixture separately models and preserves 28 registry rows. Real D1 registry,
system-table export/import and binding switching are not implemented or proven.

## Permitted executable scope

    node --test test/prelaunch-reset-0028.test.js
    node scripts/run-prelaunch-reset-0028-local.mjs --synthetic-demo ../new-output

Reviewed schema reference fixtures are included in test/fixtures. Reuse the
existing Node 24 dependencies; there is no cloud adapter, credential input,
network deployment, activation command or source-object deletion command.
All fixture databases/object stores are created under a checked temporary path
and removed on close. Output contains metadata/hashes, not keys or identity rows.

## Safety boundary

The original assertReady remains unchanged and rejects a 64-table snapshot.
This is not a weakened destructive reset: the separate assertShadow permits
only an UNBOUND new database and isolated local object store preparation.
productionActivation always throws. UNKNOWN and Dispatch9 HOLD remain explicit.

Only known website assets enter the clean bucket; proof images remain in the
old store. Unknown scope or an asset/proof collision stops preparation. Drive
recovery copies require exact ownership/root/file/case/content correspondence;
unrelated Drive files remain untouched. The protected recovery store retains
old bytes; local restoration does not prove real Drive File ID restoration.

Each copy has a manifest-bound journal with a hash chain and exclusive local
lock. UNKNOWN does not expire into retry. A separate explicit local copy-only
inspection may verify an already present, matching copy with no PUT. It cannot
authorize DELETE or reconcile Dispatch9. Existing target files/objects are never
silently overwritten. Do not apply these local reconciliation helpers to cloud.

Mixed admin audit keeps exact, recognized configuration/role rows only. Case,
point and ranking-derived entries remain archived in the unchanged source.
Leaderboard rebuild or non-null run/statistic payloads do not enter the clean
database. Unknown audit domains or invalid JSON stop classification for review;
no immutable source row is updated, deleted or silently rewritten.

## Production remains NO-GO

Before an actual generation switch, independently prove identity/config freeze,
protected recovery, new writer admission, no replayed old grants/admin actions,
external account-principal controls, old/new bindings, coordinated backup and
inventory consumers, and a reversible D1 import/binding procedure. New bucket
identity alone does not constrain account-wide OAuth/S3/control-plane powers.

The real readUploadGrant helper accepts an old grant under a reused upload key.
That test covers cryptographic parsing only, not complete HTTP Handler success.
An independently reviewed upload-secret generation change may reject old grants
without changing AUTH_SECRET/TOTP encryption keys; it does not fence old admin
requests, external writers or control-plane retargeting. No key is rotated here.

Old sources are archived, not purged. Later physical D1/R2/Drive cleanup requires
separate scope, recovery-retention policy, terminal evidence and authorization.
Do not rewrite legacy_status, remove guards, enable Cleanup or touch Dispatch9.
