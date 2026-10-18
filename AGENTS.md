# VoteProof iteration and publishing

- Preserve existing work. Never reset, restore or clean without an explicit request.
- Use the smallest relevant checks. CSS/copy/layout changes do not require backend, auth, migration or export regressions. Auth/business changes require related security and ownership tests.
- `scripts/ci/plan.mjs` selects checks relative to a successful ancestor CI run. Unknown/shared-core changes fall back to full coverage. Never use a failed previous push as the sole change baseline.
- Pages is a public-safe fixture UI preview. Its own build, isolation tests and quick browser smoke gate publication; full backend CI must not block Pages.
- Production deployment requires the user's explicit authorization, exact approved main SHA, and successful exact-SHA branch validation. Reuse that CI result; do not rerun it locally or add another full test gate.
- CI uses Node 24. Full browser coverage runs as three independent project jobs. Do not increase local browser workers or change test isolation merely for speed.
- Full regression is available through `branch-validation.yml` → `full_regression=true`. Use it for broad core/CI/dependency changes, not routine iterations.
- Use one status monitor per workflow. Read concise state changes; fetch only a failed job's relevant log. Avoid repeated repository scans, unchanged progress narration, and unnecessary model work while CI is running.
- Never deploy Production, apply remote migrations, mutate D1/R2, activate submissions or Async rollout merely to verify a workflow change.
- See `docs/ci-and-publishing.md` for the workflow contract. Report the final SHA, relevant checks and publication result concisely.
