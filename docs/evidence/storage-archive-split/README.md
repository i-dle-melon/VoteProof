# Two-request archive validation evidence

Baseline: 6b70f294. The tested formal source hashes match this commit's source.
Only isolated, synthetic data are present. No headers, tokens, credentials, actual
Google responses, member data, proof images or Production resources are included.

- 31b0bdac950f: 34 functional scenarios PASS; controller failed when the expected
  non-JSON lost-response value was dereferenced. Raw failure evidence is retained.
- c89afe834e03: only response-lost and upload-stop were repeated/completed, then
  nine instrumented A/B pairs and 45 pure native-binding A/B pairs were measured.
- summary.json: union of 36 scenarios, measured CPU, missing-trace accounting,
  inventory, source-hash checks and isolated resource removal evidence.

CPU is Cloudflare tail cpuTime, not Node process CPU or wall time. Each A and B
is a separate authenticated HTTP invocation including readReviewJson and empty
input validation. Budget SQL and trace-log overhead are included, not subtracted.
Counter proxies are used only in a separate operation-count phase. All six groups
have 15 requests; missing CPU is UNKNOWN, never zero. The preselected <=10 percent
missing criterion failed for 1 MiB A and B, so overall readiness remains UNKNOWN,
although every received trace was <=10 ms. No repeated optimization was attempted.

Each run created one reader, one mock relay, one D1 and one private R2. All eight
resource-removal GET checks returned 404. Actual inventory matched 1 MiB remaining,
all backup records were preserved and submissions stayed OFF. No actual Drive API,
Google login, Apps Script deploy, Production deploy, email or paid upgrade occurred.
The receipt mock proves Worker processing only. Real Drive E2E is still pending.

Reproduce only with an authorized isolated account:

```powershell
node scripts/validate-archive-cloud.mjs --isolated-synthetic-only --account-id=<test-account> --samples=15
```

The second run used --e2e-only=response-lost,upload-stop to avoid repeating the
already passed scenarios. Do not use that selective run alone as evidence for all
36 scenarios: use the explicit union of both reports. Baseline Git SHA identifies
the ancestor; source_sha256 and deployment bundle_sha256 identify tested changes.
