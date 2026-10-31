# Storage observation policy (local candidate)

This change is opt-in. No production changes, resource operations or CI runs
are performed by installing the source in a local worktree.

## Policy and safety

- `STORAGE_CAPACITY_ENFORCEMENT=disabled` selects the new admission SQL. It
  additionally requires `storage_capacity.upload_policy='observe'`; absent
  extension or mismatched settings fail closed. Default remains `enforced`.
- Observation mode ignores the website's 9.5GB admission limit, `blocked`, stale
  snapshots and an inventory pin. It retains size/integer integrity, anomalies,
  ownership, Epoch, Grant/issuance, atomic Reservation/Write Pin admission,
  immutable PUT/checksum receipts, UNKNOWN retention and idempotency.
- This does not remove Cloudflare product limits or D1 daily limits. Retained
  incremental accounting is not presented as a fresh R2 inventory.
- Reservation creation/commit/cancel during a scan sets `inventory_dirty=1`,
  increments its CAS version and invalidates trust. The original inventory ID,
  cursor and all operation pins remain. Both the Runtime and a database trigger
  reject publication, including from an old Runtime that ignores the new field.
- A clean manual inventory still works. An invalidated scan requires a separate
  explicitly approved, audited recovery; this patch never clears its pin. Resume
  is not a promise that an invalidated/in-flight scan is safe to finalize.
- `VOTEPROOF_INVENTORY_PAUSED=true` soft-pauses GAS inventory. Code, API, trigger,
  credentials, runBackup and properties are preserved. No quota/tick/finalize is
  requested while paused. An already dispatched page is allowed to return and
  progress is retained; the loop checks pause before the next page/finalize.
- `pauseStorageInventory()` and `resumeStorageInventory()` only change that one
  property. They do not create, remove or run triggers and do not change Gate.
- Cleanup and Dispatch9 are unchanged. No R2 object cleanup is added.

## Write reductions

- Empty Backup claim performs a single indexed application SELECT and returns
  idle without a mutation. Existing leases, terminal/replay IDs and exhausted
  lease processing retain the original checks and mutation path. Work arriving
  just after an idle read is picked up on the next existing poll.
- UNKNOWN persistence is attempted once per Operation/request, including a
  synchronous exception or lost ACK. A failed attempt keeps durable active /
  pending evidence; it cannot lead to a completed terminal or automatic resend.
- Prepare puts issuance + Intent in the same permit/batch. Batch recovery is
  constrained to the exact persistent epoch, kind and key; no foreign or retired
  issuance may create an Intent.
- Case and its optional backup enqueue remain separate: a backup enqueue error
  currently must not roll back an otherwise valid submission. Combining them
  would change this availability contract and is deliberately deferred.
- The previous inventory-page CAS optimization is not included.

## Later production transition (not authorized or executed here)

1. Review the source, exact SQL/hash and diff; approve Commit/Push/CI separately.
2. Approve installation of the revised GAS source and the one pause property.
   Confirm the already running invocation's actual terminal state. Preserve
   runBackup, trigger IDs and all unrelated properties; do not infer drain from
   a timer or silently discard a ready scan.
3. Separately approve and atomically install
   `migrations-storage-policy/0001_observe_capacity.sql`. It adds two columns and
   replaces only the capacity/accounting triggers, preserving archive/reset
   guards. It defaults to enforced. Record its exact version/hash in the release
   journal / independent migration source; do not alter the 0028 or Reset registry.
   Provider/cloud behavior of this new extension has not been measured here;
   local native workerd installation and failed-DDL rollback were verified.
4. Before activation require no active inventory, no dirty scan and no integrity
   anomaly. Existing R01/Pin/UNKNOWN are retained; they do not have to be settled
   or deleted. If a scan or ACK is ambiguous, stop the transition and preserve it.
5. Separately approve the exact bounded policy/config changes and Worker release.
   Set `upload_policy='observe'` using existing Operation/Permit + control CAS,
   immutable storage audit and receipt in one controlled transaction. Change no
   usage totals, reservations, pins or Gate. A missing/unknown ACK is not resent.
   Stage the non-secret Worker Var `STORAGE_CAPACITY_ENFORCEMENT=disabled` while
   the old Runtime still ignores it, then deploy the approved exact new SHA.
   The existing production workflow uses `--keep-vars`; verify this Var is
   actually retained. Do not change Bindings/Secrets/Workflow to bypass a mismatch.
6. Read-only verify policy, Gate unchanged, Cleanup OFF, retained R01/pins,
   no new anomalies and correct health semantics. Any controlled submission test
   or native CPU observation requires its own authorization. No automatic reopen,
   retry, rollback or inventory restart is part of this patch.

## Restoring inventory and enforcement later

The code, manual APIs, default enforcement policy and GAS resume function remain.
Before resuming automatic inventory, separately approve its coordination and
verify existing scan state. Resolve a dirty scan only through an audited explicit
recovery, never by deleting R01/UNKNOWN. Capacity enforcement can be restored only
after a complete trustworthy snapshot and a safe setting transition. Changing
the two flags alone does not prove capacity or old IO drained. Keep the extension
installed for rollback; do not DROP it or rewrite historical migrations.

Normal new uploads have no added R2 calls or D1 round trips; Prepare removes one
trip. Native Worker CPU has not been measured for this candidate, so a 10ms PASS
is not claimed. Local/cloud and real billing measurements must stay distinct.
