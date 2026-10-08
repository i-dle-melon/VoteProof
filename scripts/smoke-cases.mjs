import assert from "node:assert/strict";
import { localCaseRuntime, guestBody } from "./lib/local-case-runtime.mjs";
const local = await localCaseRuntime();
try {
  const reference = await local.upload({ count: 2 });
  const created = await local.fetch("/api/cases", "POST", guestBody(reference));
  assert.equal(created.status, 201);
  const data = (await created.json()).data;
  const found = await local.fetch(`/api/cases/${data.case_id}`, "GET", undefined, { "X-Case-Query-Key": data.query_key });
  assert.equal(found.status, 200);
  const body = await found.json(); assert.equal(body.data.files.length, 2); assert.equal(body.data.status, "pending");
  assert.equal(JSON.stringify(body).includes("object_key"), false);
  assert.equal((await local.fetch(`/api/cases/${data.case_id}?key=wrong`)).status, 404);
  assert.equal((await local.fetch("/api/cases", "POST", guestBody(reference))).status, 409);
  assert.equal((await local.fetch("/api/health")).status, 200);
  console.log("Local workerd/D1/R2: complete persistence, case 201, Guest 200, wrong key 404, replay 409, health 200 passed.");
  console.log("No Production database, migration, token or object was used.");
} finally { await local.runtime.dispose(); }
