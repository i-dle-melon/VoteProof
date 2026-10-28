# REST selective reset: release and maintenance sequence

Production changes require separate Operator approval. This candidate does not
activate its fence, install Schema, close submissions, clear data or touch R2.
The only Production reset execution path is the Operator's REST CLI. Do not
deploy or CPU-test the abandoned Reset HTTP Worker.

1. **Source and CPU gate.** Validate this exact candidate SHA. The normal
   website Worker with `PRELAUNCH_RESET_FENCE_ENABLED=true` has no matching
   Cloudflare native CPU evidence yet: UNKNOWN, not the old B0 measurement and
   not the abandoned Reset Worker's22.557ms. Obtain a separately authorized,
   bounded normal-handler CPU check before Production release. Do not infer
   CPU from D1 duration, wall time or this REST transport's zero invocations.
2. **Protected publication ref.** After separate approval, fast-forward the
   existing `codex/p1-0028-independent-release-20261027` from its B0 ancestor to
   this approved SHA; wait for same-ref/same-SHA Branch Validation again. The
   candidate ref itself is not on the Production Workflow allowlist. No main,
   workflow whitelist, secret, Ruleset or Environment changes are part of this
   candidate. Recheck any external Cloudflare Builds automation before release.
3. **Maintenance and recovery.** Explicitly coordinate Admin image/auth/review/
   points/export operations, runBackup and runStorageInventory. Record the
   current Gate/Bindings/settings, fresh private D1 TimeTravel bookmark and
   verifiable export/restore artifact. Only with approval, stop new writes and
   close submissions. Unknown operations are retained, never retried/cleared.
   No fixed wait, zero reservations or verbal pause proves historical drain.
4. **Independent Schema, then safe activation.** Install only
   `migrations-reset-v1/0001_reset_fence.sql` with its own version/hash record,
   in one authorized REST batch. Main `d1_migrations` remains at0028; do not
   apply0029–0031. The independent Schema defaults to maintenance and rejects
   old unfenced D1 writes. Verify all original0028 objects plus every installed
   Reset Guard and FK state. Deploy the approved normal Worker/public assets
   through the protected manual Workflow; activate its fence with separately
   authorized configuration. Do not call the new Maintenance API before both
   Schema and matching Worker exist. Keep maintenance and Gate closed.
5. **Fresh frozen Manifest.** Collect private exact-PK scope and original
   identity/config hashes from the frozen source. Collect current active
   deployment, same-ref CI, bindings/flags and public-R2-access evidence.
   `scripts/prelaunch-selective-reset.mjs --database <private captured.sqlite>
   --out <new private Manifest.json> --evidence <private evidence.json>
   --approved-cutover-sha256 <explicitly reviewed evidence hash>` is offline.
   Evidence must identify the current source/epoch/version/run, one100% active
   safety deployment, fence ON, Cleanup OFF, old objects RETAINED and historical
   DELETE terminal UNKNOWN. Its raw artifact hashes must be retained. The
   verifier checks evidence consistency, all actual Reset Guards and original
   0028 Schema; it does not authenticate remote artifacts on its own. Operator
   provenance approval is mandatory. Status is PRODUCTION_REVIEW_REQUIRED,
   never permission to execute. Mixed data, unknown operations, pending leases,
   changed source/Schema or public image bypass: STOP. Do not fake a legacy
   attestation or reuse the synthetic-only evidence marker in Production.
6. **One-shot reset approval.** Review the new exact Manifest and Prepared
   hashes; verify a fresh private restore artifact/receipt and bookmark. Supply
   a separate `production-selective-reset-once` approval document tied to the
   exact SHA/CI/deployment, Manifest, Prepared, account/DB and reviewed cutover
   evidence hash. Run `scripts/prelaunch-reset-rest.mjs --package <private.json>`
   first (dry-run). Only after explicit reset approval add `--execute`. It
   fsyncs an exclusive Journal, submits the original48 parameterized statements
   in one REST request and checks the complete postcondition plus unique
   immutable Receipt. No R2, Drive, Supabase or Gate operations are included.
7. **Unknown/failure.** No rerun, rollback, reopening or old-Worker restoration
   is automatic. Preserve Journal, source, logs and all data. Obtain separate
   read-only approval for `--reconcile`; retain the original UNKNOWN Journal.
   No Receipt or changed postcondition means HOLD. A D1 TimeTravel restore is
   another separately approved operation and never restores R2 or external Auth.
8. **Acceptance and reopening.** Privately compare every member/Auth mapping,
   MFA/role/config hash; points and business/ranking rows must match approved
   zero targets, board definitions remain, old key references are blocked and
   new keys use the trusted epoch generation. Capacity continues to count old
   retained R2 objects. Keep Cleanup OFF and Dispatch9 HOLD. With separate
   approval, verify login/MFA and a controlled new submission, update the
   Apps Script relay epoch property, resume backup/inventory, then reopen Gate
   and normal admissions in an explicitly approved order. A partial resume must
   not clear UNKNOWN or silently rewrite work. No old R2 objects are deleted.
