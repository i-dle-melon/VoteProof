# R2 archive Plan A isolated evidence

Only synthetic images and test-only IDs are included. No member data, proof images,
credentials, tokens, relay secrets, request headers or Google API responses are retained.

- `voteproof-archive-e2e-67447ae42d27/results.json`: first instrumented run,
  before the bounded HMAC / HEAD cleanup optimization. 26 scenarios passed;
  the run ended on an unmeasured fixture upload transport error. Partial CPU
  observations and resource cleanup evidence are intentionally retained.
- `voteproof-archive-e2e-1427b4b800e2/results.json`: optimized source, 28 scenarios,
  a separate instrumented operation-count phase, then raw native-binding CPU phase.
  94 of the planned 120 cleanup requests succeeded before another unmeasured seed
  transport failure. Use `cpu` / `cpu_readiness`; missing CPU is UNKNOWN.
- `voteproof-archive-e2e-727786352ed1/results.json`: inventory-only run completes post-delete inventory /
  backup retention / OFF checks without repeating the CPU workload.
- `summary.json`: derived, auditable request / CPU / outcome / trace accounting.

`baseline` is the Git commit from which uncommitted tested changes were based.
`source_sha256` and deployment `bundle_sha256` identify the actual deployed bytes.
The final Git commit is reported separately after these evidence files are committed.

Cloudflare `cpuTime` / `wallTime` are retained separately from client wall time.
SDK counters in pure CPU samples are null by design: operation counts come only
from the explicitly instrumented samples. CPU includes one extra durable harness
budget UPDATE plus trace logging, with no invented subtraction. The benchmark
covers authenticateRelay + cleanupArchive + verifyDriveArchive, not the entire
Production storage/tick orchestration. The mock receipt does not validate real Drive.

Historical `collector.sampling_signals` is a broad substring-match counter over
stdout chunks, including JSON field names; it is NOT a count of dropped traces
or proof of platform sampling. Historical `error_signals` counts matching stderr
chunks, not unique errors or verified reconnects. Their raw diagnostics were not
retained, so exact reconnect/error counts are UNKNOWN. A single collector was
started per run. Use request/sample matching for exact missing-trace accounting.
The reusable runner now distinguishes textual matches, reported sampling rates
and connection/reconnect diagnostics for future runs. No historical data is rewritten.

Account free_tier, isolated binding names/IDs, offline fixture trigger restoration,
submission OFF, resource deletion and independent GET-404 confirmation are in
results.json. Source import is offline before test endpoints exist. No Production
mutation, real Google access, mail, paid upgrade or Production migration occurred.

Reproduction (explicit test account and authorization required):

```powershell
node scripts/validate-archive-cloud.mjs --isolated-synthetic-only --account-id=<authorized-test-account-id> --samples=40
```

The command creates temporary resources and performs actual R2 deletes. It always
attempts resource teardown and records verification; inspect failures before retry.
Do not automatically retry an ambiguous destructive request or clear its D1 pin.

The reusable runner also supports `--inventory-only --samples=1` for bounded
inventory verification without rerunning the CPU workload. Its CPU readiness
is UNKNOWN by design, and must not replace the full CPU run verdict.
