import assert from "node:assert/strict";
import { localCaseRuntime, guestBody } from "./lib/local-case-runtime.mjs";
import {
  login,
  loginHeaders,
  responseCookie,
} from "./lib/local-auth-runtime.mjs";

const local = await localCaseRuntime();
try {
  const a = await login(local),
    b = await login(local);
  const untrusted = await local.fetch(
    "/api/auth/login",
    "POST",
    { email: a.email, password: a.password, remember_me: true },
    loginHeaders(),
  );
  assert.equal(untrusted.status, 202);
  const challenge = (await untrusted.json()).data;
  assert.equal(challenge.status, "MFA_REQUIRED");
  const mfa = await local.fetch(
    "/api/auth/login/totp",
    "POST",
    {
      transaction_id: challenge.transaction_id,
      code: a.otp.generate({ timestamp: Date.now() + 30000 }),
      trust_this_device: true,
    },
    { ...loginHeaders(), Cookie: responseCookie(untrusted, "__Host-vp-login") },
  );
  assert.equal(mfa.status, 200);
  const verified = (await mfa.json()).data;
  assert.equal(verified.expires_in, 2592000);
  assert.equal(verified.member.member_id, a.member.member_id);
  const trusted = await local.fetch(
    "/api/auth/login",
    "POST",
    { email: a.email, password: a.password },
    {
      ...loginHeaders(),
      Cookie: responseCookie(mfa, "__Host-voteproof_device"),
    },
  );
  assert.equal(trusted.status, 200);
  const security = await local.fetch("/api/auth/me", "GET", undefined, {
    Cookie: responseCookie(trusted, "__Host-vp-session"),
  });
  assert.equal((await security.json()).data.elevated_until, 0);
  assert.equal(
    (
      await local.fetch(
        "/api/auth/login",
        "POST",
        { email: a.email, password: crypto.randomUUID() },
        loginHeaders(),
      )
    ).status,
    401,
  );
  const recovery = await local.fetch(
    "/api/auth/recovery/password/start",
    "POST",
    { email: b.email, recovery_code: b.recovery_codes[0], code:b.otp.generate({timestamp:Date.now()+30000}) },
    loginHeaders(),
  );
  assert.equal(recovery.status, 202);
  const recoveryId = (await recovery.json()).data.transaction_id;
  const reset = await local.fetch(
    "/api/auth/recovery/password/finish",
    "POST",
    { transaction_id: recoveryId, new_password: crypto.randomUUID() },
    { ...loginHeaders(), Cookie: responseCookie(recovery, "__Host-vp-login") },
  );
  assert.equal(reset.status, 200);
  assert.equal(
    (await local.fetch("/api/auth/me", "GET", undefined, b.headers)).status,
    401,
  );
  const ownerB = await login(local),
    body = guestBody(await local.upload());
  const headers = { ...a.headers, "Idempotency-Key": crypto.randomUUID() };
  const response = await local.fetch("/api/cases", "POST", body, headers);
  assert.equal(response.status, 201);
  const created = (await response.json()).data;
  assert.equal(
    (
      await local.fetch(
        `/api/me/cases/${created.case_id}`,
        "GET",
        undefined,
        a.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await local.fetch(
        `/api/me/cases/${created.case_id}`,
        "GET",
        undefined,
        ownerB.headers,
      )
    ).status,
    404,
  );
  const page = (
    await (
      await local.fetch("/api/me/cases?limit=1", "GET", undefined, a.headers)
    ).json()
  ).data;
  assert.equal(page.cases[0].case_id, created.case_id);
  const replay = await local.fetch("/api/cases", "POST", body, headers);
  assert.equal(replay.status, 201);
  assert.deepEqual((await replay.json()).data, created);
  assert.equal(
    (
      await local.fetch(`/api/cases/${created.case_id}`, "GET", undefined, {
        "X-Case-Query-Key": created.query_key,
      })
    ).status,
    200,
  );
  assert.equal(
    (await local.fetch("/api/auth/logout", "POST", undefined, a.headers))
      .status,
    200,
  );
  assert.equal(
    (await local.fetch("/api/auth/me", "GET", undefined, a.headers)).status,
    401,
  );
  assert.equal(
    (await local.fetch("/api/cases", "POST", guestBody(await local.upload())))
      .status,
    201,
  );
  console.log(
    "B4 local workerd/D1/R2: password/TOTP enrollment, owner isolation, member list, persistent replay, Guest query/create, logout/revocation; untrusted MFA, trusted password login, remember TTL, recovery and admin elevation boundary passed.",
  );
  console.log(
    "Only disposable local identities were used; no Production migration or deployment.",
  );
} finally {
  await local.runtime.dispose();
}
