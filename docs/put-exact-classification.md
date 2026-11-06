# PUT settlement and exact classification (local candidate)

## Scope and guarantees

In observe mode, a verified successful immutable PUT commits its exact Reservation receipt and releases its own Intent write token in one existing Reset Fence batch. A zero-write assertion aborts the transaction if either update misses. Pre-PUT admission, the native R2 dispatch/ACK receipt, streaming, epoch checks and ambiguous-write handling remain unchanged. Enforced capacity mode keeps its original settlement order. Unknown native PUT or D1 ACK is not retried or unlocked automatically.

Automatic classification applies to authenticated member Direct Cases (the current website flow). The existing Legacy/V2 upload and legacy Case paths remain compatible; they are not converted to automatic classification. Anonymous Cases are not linked to member history. A new Direct Case uses the R2-verified checksum and immutable Intent/file links; legacy history is eligible only where its existing verified hash metadata is available. No image download, analysis job, processor activation or historical backfill is introduced.

For the same member and Campaign, an approved/completed exact source creates a duplicate Case with zero new points. With the independent pending-policy Trigger upgrade installed, a pending source also creates a duplicate Case linked to the original pending Case; the original alone remains eligible for later approval. Historical pending_match decisions remain immutable, and older Workers may still produce those hints during rollout. Unverified historical coverage gives UNKNOWN. A current file without a valid native R2 checksum fails existing validation, rather than being assigned an invented hash. Every Case and image is retained.

The immutable classification decision is inserted before the Case in the same deferred-FK batch as Case, file and idempotency. Original source state is checked inside that transaction. A database approval guard serializes later competing approvals and rolls back their point/audit batch on conflict. For a current SHA-enabled review, the API first checks for an already-approved/completed trusted exact source and resolves the pending Case as duplicate with its own audit, without issuing points. The transaction rechecks the exact scope and reference version. If a real race still reaches the approval guard, it returns a sanitized conflict, preserves Fence UNKNOWN when applicable, and never retries the write in the same request. If an original is later revoked or otherwise changed, its existing duplicate decision stays immutable and the Admin UI shows the changed-source warning; no historical points or classifications are silently rewritten.

## Independent schema and controlled activation

`migrations-exact-classification/0001_case_sha256.sql` adds the immutable decision receipt, policy control, verified-source view, guards and two partial indexes. Existing migrations are untouched. Schema installation alone defaults to disabled. Activation additionally requires `EXACT_DUPLICATE_CLASSIFICATION_ENABLED=true`, the existing Reset Fence enabled, and an audited policy CAS to enabled=1. A missing/mismatched schema fails closed.

No production schema/configuration has been changed. Installation and activation need separate approval and cloud verification. Enable only after all serving Case writers understand the policy: once enabled, the DB rejects old unclassified Direct member Case inserts. Rollback is not seamless; disable through an explicitly approved audited CAS before reverting Runtime/configuration, and preserve the decision evidence and extension. Do not drop guards to recover. Any future Reset must classify the new immutable decision/control data before execution; this work does not authorize or implement another Reset.

## Pending policy release order (2026-11-06 local patch)

Install `migrations-exact-pending-classification/0001_pending_duplicate.sql` only after the original exact-classification extension, as one atomic D1 batch. Check the current Trigger fingerprint before changing it, and read it back after commit. It replaces only `case_sha_decision_insert`; no classification, points, policy flags, data backfill or indexes are changed. The original published migration remains unchanged.

Install the new Trigger before serving the new Runtime. New Runtime with the old Trigger rejects pending exact copies and rolls back; do not deploy in that order. Old Runtime with the new Trigger remains compatible with its historical pending-match policy, so rolling coexistence is safe without promising all old in-flight requests use the new policy. Keep the new compatible Trigger on Runtime rollback and preserve every new Case, decision, image, audit, Ledger and UNKNOWN. Do not restore a database snapshot or drop protections to roll back.

Batch and single-case review results distinguish actual approval from automatic duplicate classification. A lost review ACK is reconciled through the winning audit/version; a manual duplicate action is not accepted as an approval replay. Historical classification remains a creation-time record even after an audited review resolves the Case as duplicate. Rejection/revocation of an original does not automatically promote existing duplicate Cases or issue points.

This patch does not authorize installation, Git changes, deployment, R2 cleanup or a Google authentication change. Cloud DDL and native Cloud CPU remain unverified for this upgrade.

## Cost and verification limits

Use the attached native local D1 metadata benchmark, not statement counts alone. PUT saves two written rows and one round trip. For a normal member Direct Prepare/PUT/Case flow, the new consumed-intent index entry and immutable decision row offset those two saved writes. Classification adds reads; the exact digest partial index avoids scanning unrelated Direct member history. Older unverified Legacy history may still require a bounded-by-member/Campaign coverage probe and has no fabricated completeness claim.

The full-flow benchmark excludes Batch Authorize and review; it is not a 24-hour production forecast. No added R2 GET/LIST or image buffering is required. Local workerd D1 rollback tests are not real Cloud D1 proof for this new extension. Native production Worker CPU remains UNKNOWN; no local wall time is converted to CPU and no cloud resources are created.
