import assert from "node:assert/strict";
import { localCaseRuntime, guestBody } from "./lib/local-case-runtime.mjs";
import { login } from "./lib/local-auth-runtime.mjs";

const local = await localCaseRuntime();
try {
  const a = await login(local), b = await login(local), body = guestBody(await local.upload());
  const headers = { ...a.headers, "Idempotency-Key": crypto.randomUUID() };
  const response = await local.fetch("/api/cases", "POST", body, headers);
  assert.equal(response.status, 201); const created = (await response.json()).data;
  assert.equal((await local.fetch(`/api/me/cases/${created.case_id}`, "GET", undefined, a.headers)).status, 200);
  assert.equal((await local.fetch(`/api/me/cases/${created.case_id}`, "GET", undefined, b.headers)).status, 404);
  const page = (await (await local.fetch("/api/me/cases?limit=1", "GET", undefined, a.headers)).json()).data;
  assert.equal(page.cases[0].case_id, created.case_id);
  const replay = await local.fetch("/api/cases", "POST", body, headers);
  assert.equal(replay.status, 201); assert.deepEqual((await replay.json()).data, created);
  assert.equal((await local.fetch(`/api/cases/${created.case_id}`, "GET", undefined, { "X-Case-Query-Key": created.query_key })).status, 200);
  assert.equal((await local.fetch("/api/auth/logout", "POST", undefined, a.headers)).status, 200);
  assert.equal((await local.fetch("/api/auth/me", "GET", undefined, a.headers)).status, 401);
  assert.equal((await local.fetch("/api/cases", "POST", guestBody(await local.upload()))).status, 201);
  console.log("B4 local workerd/D1/R2: OTP login, owner isolation, member list, persistent replay, Guest query/create, logout/revocation passed.");
  console.log("Only local mock email delivery was used; no Production email, migration or deployment.");
} finally { await local.runtime.dispose(); }
