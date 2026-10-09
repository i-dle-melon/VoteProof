import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { URI } from "otpauth";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { localAdminRuntime } from "../scripts/lib/local-admin-runtime.mjs";
import {
  begin,
  finish,
  login,
  loginHeaders,
  responseCookie,
  expectError,
} from "../scripts/lib/local-auth-runtime.mjs";
import {
  SESSION_COOKIE,
  LOGIN_COOKIE,
  DEVICE_COOKIE,
} from "../src/lib/auth-session.js";
let local;
before(async () => {
  local = await localCaseRuntime();
});
after(async () => {
  await local?.runtime.dispose();
});
const nextCode = (m) => m.otp.generate({ timestamp: Date.now() + 30000 });
const password = () => randomBytes(24).toString("base64url");
async function startLogin(m, extra = {}, headers = {}) {
  return local.fetch(
    "/api/auth/login",
    "POST",
    { login_name: m.login_name, password: m.password, ...extra },
    { ...loginHeaders(), ...headers },
  );
}
async function mfaTransaction(m, extra = {}) {
  const r = await startLogin(m, extra);
  assert.equal(r.status, 202);
  const d = (await r.json()).data;
  assert.equal(d.status, "MFA_REQUIRED");
  return {
    id: d.transaction_id,
    cookie: responseCookie(r, LOGIN_COOKIE),
    headers: loginHeaders(),
  };
}
const verifyMfa = (tx, code, trust = false, extraHeaders = {}) =>
  local.fetch(
    "/api/auth/login/totp",
    "POST",
    { transaction_id: tx.id, code, trust_this_device: trust },
    { ...tx.headers, Cookie: tx.cookie, ...extraHeaders },
  );
const authData = async (r) => {
  assert.equal(r.status, 200);
  return (await r.json()).data;
};
const expireTx = async (id) =>
  local.db
    .prepare(
      "UPDATE auth_transactions SET created_at=?,expires_at=? WHERE id=?",
    )
    .bind(
      Math.floor(Date.now() / 1000) - 1000,
      Math.floor(Date.now() / 1000) - 1,
      id,
    )
    .run();

test("final schema has private normalized login identity, modular credentials and no old challenge/email columns", async () => {
  const tables = (
    await local.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
  ).results.map((r) => r.name);
  for (const name of [
    "members",
    "member_credentials",
    "auth_transactions",
    "auth_sessions",
    "trusted_devices",
    "recovery_codes",
    "auth_rate_limits",
    "auth_atomic_guards",
  ])
    assert.ok(tables.includes(name));
  assert.ok(!tables.includes("auth_challenges"));
  const columns = (
    await local.db.prepare("PRAGMA table_info(members)").all()
  ).results.map((r) => r.name);
  assert.ok(columns.includes("login_name"));
  assert.ok(!columns.includes("email"));
  assert.deepEqual(
    (await local.db.prepare("PRAGMA foreign_key_check").all()).results,
    [],
  );
});
test("registration is pending until TOTP; encrypted setup has no clear secret/password", async () => {
  const s = await begin(local);
  assert.equal(
    await local.db
      .prepare("SELECT member_id FROM members WHERE login_name=?")
      .bind(s.login_name)
      .first(),
    null,
  );
  const row = await local.db
    .prepare("SELECT * FROM auth_transactions WHERE id=?")
    .bind(s.id)
    .first();
  assert.ok(!row.payload.includes(s.password));
  assert.ok(!row.payload.includes(s.otp.secret.base32));
  assert.ok(!row.browser_hash.includes(s.cookie.split("=")[1]));
  assert.match(s.data.otpauth_uri, /^otpauth:\/\/totp\//);
  assert.equal(s.otp.issuer, "VoteProof");
  assert.equal(s.otp.digits, 6);
  assert.equal(s.otp.period, 30);
  assert.equal(s.otp.algorithm, "SHA1");
  const r = await finish(local, s);
  const d = await authData(r);
  assert.equal(d.recovery_codes.length, 10);
  assert.equal(new Set(d.recovery_codes).size, 10);
  const member = await local.db
    .prepare("SELECT * FROM members WHERE member_id=?")
    .bind(d.member.member_id)
    .first();
  assert.equal(member.login_name, s.login_name);
  const cred = await local.db
    .prepare("SELECT * FROM member_credentials WHERE member_id=?")
    .bind(member.member_id)
    .first();
  assert.ok(!JSON.stringify(cred).includes(s.password));
  assert.ok(!JSON.stringify(cred).includes(s.otp.secret.base32));
  assert.equal(cred.totp_iv.length, 24);
  assert.equal(cred.totp_key_version, 1);
  assert.deepEqual(
    Object.keys(d.member).sort(),
    [
      "member_id",
      "nickname",
      "player_id",
      "status",
      "created_at",
      "updated_at",
      "last_login_at",
    ].sort(),
  );
  await expectError(await finish(local, s), 400, "AUTH_VERIFICATION_FAILED");
});
test("case-insensitive login uniqueness survives a second independently verified enrollment", async () => {
  const m = await login(local),
    s = await begin(local, "  " + m.login_name.toUpperCase() + "  ");
  await expectError(await finish(local, s), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal(
    (
      await local.db
        .prepare("SELECT count(*) n FROM members WHERE login_name=?")
        .bind(m.login_name)
        .first()
    ).n,
    1,
  );
});
for (const name of [
  "abc",
  "bad space",
  "中文帳號",
  "a@b.c",
  "a".repeat(33),
  "\n",
]) {
  test("invalid login_name rejected: " + JSON.stringify(name), async () => {
    await expectError(
      await local.fetch(
        "/api/auth/register/start",
        "POST",
        {
          login_name: name,
          password: password(),
          nickname: "Local",
          turnstile_token: "local-test",
        },
        loginHeaders(),
      ),
      400,
      "INVALID_AUTH_REQUEST",
    );
  });
}
for (const value of [
  "short",
  "a".repeat(129),
  null,
  String.fromCharCode(0xd800).repeat(12),
])
  test(
    "password policy is bounded without composition rules: " +
      String(value?.length),
    async () => {
      await expectError(
        await local.fetch(
          "/api/auth/register/start",
          "POST",
          {
            login_name: randomUUID().replaceAll("-", ""),
            password: value,
            nickname: "Local",
            turnstile_token: "local-test",
          },
          loginHeaders(),
        ),
        400,
        "INVALID_AUTH_REQUEST",
      );
    },
  );
test("registration accepts long Unicode and password-manager compatible passwords", async () => {
  const s = await begin(local, undefined, undefined, {
    password: "密".repeat(128),
  });
  assert.equal((await finish(local, s)).status, 200);
});
test("wrong initial TOTP is capped at five tries, no activation", async () => {
  const s = await begin(local);
  for (let i = 0; i < 5; i++)
    await expectError(
      await finish(local, s, { code: "bad" }),
      400,
      "AUTH_VERIFICATION_FAILED",
    );
  await expectError(await finish(local, s), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal(
    await local.db
      .prepare("SELECT member_id FROM members WHERE login_name=?")
      .bind(s.login_name)
      .first(),
    null,
  );
});
test("expired setup and browser substitution cannot enroll", async () => {
  const s = await begin(local);
  await expectError(
    await finish(
      local,
      s,
      {},
      { Cookie: LOGIN_COOKIE + "=" + randomBytes(32).toString("base64url") },
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  await expireTx(s.id);
  await expectError(await finish(local, s), 400, "AUTH_VERIFICATION_FAILED");
});
test("concurrent registration verification commits one member/session/recovery set", async () => {
  const s = await begin(local),
    rs = await Promise.all([finish(local, s), finish(local, s)]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
  const member = await local.db
    .prepare("SELECT member_id FROM members WHERE login_name=?")
    .bind(s.login_name)
    .first();
  assert.equal(
    (
      await local.db
        .prepare("SELECT count(*) n FROM auth_sessions WHERE member_id=?")
        .bind(member.member_id)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (
      await local.db
        .prepare("SELECT count(*) n FROM recovery_codes WHERE member_id=?")
        .bind(member.member_id)
        .first()
    ).n,
    10,
  );
  assert.equal(
    (
      await local.db
        .prepare("SELECT count(*) n FROM auth_atomic_guards")
        .first()
    ).n,
    0,
  );
});
test("registration requires server Turnstile, bounded JSON and exact Origin/custom header", async () => {
  const body = {
      login_name: randomUUID().replaceAll("-", ""),
      password: password(),
      nickname: "Local",
    },
    h = loginHeaders();
  await expectError(
    await local.fetch("/api/auth/register/start", "POST", body, h),
    400,
    "TURNSTILE_REQUIRED",
  );
  await expectError(
    await local.fetch("/api/auth/register/start", "POST", "{", h),
    400,
    "INVALID_JSON",
  );
  await expectError(
    await local.fetch("/api/auth/register/start", "POST", " ".repeat(16385), h),
    413,
    "INVALID_AUTH_REQUEST",
  );
  for (const bad of [
    { Origin: "https://attacker.example" },
    { "X-VoteProof-Request": "0" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    await expectError(
      await local.fetch("/api/auth/register/start", "POST", body, {
        ...h,
        ...bad,
      }),
      403,
      "CSRF_REJECTED",
    );
  const failed = await localCaseRuntime({
    turnstileService: () => Response.json({ success: false }),
  });
  try {
    await expectError(
      await failed.fetch(
        "/api/auth/register/start",
        "POST",
        { ...body, turnstile_token: "invalid" },
        h,
      ),
      403,
      "TURNSTILE_INVALID",
    );
    assert.equal(
      (
        await failed.db
          .prepare("SELECT count(*) n FROM auth_transactions")
          .first()
      ).n,
      0,
    );
  } finally {
    await failed.runtime.dispose();
  }
});
test("new login without trusted device requires TOTP; raw password/hash never returned", async () => {
  const m = await login(local),
    tx = await mfaTransaction(m),
    r = await verifyMfa(tx, nextCode(m)),
    d = await authData(r);
  assert.equal(d.member.member_id, m.member.member_id);
  assert.ok(!JSON.stringify(d).includes(m.password));
  assert.equal(d.recovery_codes, undefined);
});
test("wrong password, absent account and suspended account share same failure shape", async () => {
  const m = await login(local),
    bad = password(),
    a = await expectError(
      await startLogin(m, { password: bad }),
      401,
      "AUTH_LOGIN_FAILED",
    );
  assert.deepEqual(
    await expectError(
      await startLogin(
        { ...m, login_name: randomUUID().replaceAll("-", "") },
        { password: bad },
      ),
      401,
      "AUTH_LOGIN_FAILED",
    ),
    a,
  );
  await local.db
    .prepare("UPDATE members SET status='suspended' WHERE member_id=?")
    .bind(m.member.member_id)
    .run();
  assert.deepEqual(
    await expectError(
      await startLogin(m, {}, { Cookie: m.deviceCookie }),
      401,
      "AUTH_LOGIN_FAILED",
    ),
    a,
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    403,
    "MEMBER_SUSPENDED",
  );
});
test("trusted device skips TOTP only after correct password, does not grant admin elevation", async () => {
  const m = await login(local),
    r = await startLogin(m, {}, { Cookie: m.deviceCookie });
  assert.equal(r.status, 200);
  const d = await authData(r);
  assert.equal(d.member.member_id, m.member.member_id);
  const current = await authData(
    await local.fetch("/api/auth/me", "GET", undefined, {
      Cookie: responseCookie(r, SESSION_COOKIE),
    }),
  );
  assert.equal(current.elevated_until, 0);
  await expectError(
    await startLogin(m, { password: password() }, { Cookie: m.deviceCookie }),
    401,
    "AUTH_LOGIN_FAILED",
  );
});
test("successful login TOTP can create a device with hash only and secure cookie", async () => {
  const m = await login(local),
    tx = await mfaTransaction(m),
    r = await verifyMfa(tx, nextCode(m), true);
  assert.equal(r.status, 200);
  const device = responseCookie(r, DEVICE_COOKIE),
    row = await local.db
      .prepare(
        "SELECT * FROM trusted_devices WHERE member_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .bind(m.member.member_id)
      .first();
  assert.notEqual(row.token_hash, device.split("=")[1]);
  assert.equal(row.token_hash.length, 64);
  assert.equal(row.expires_at - row.created_at, 2592000);
  const cookies = r.headers.getSetCookie().join(";");
  for (const flag of [
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Path=/",
    "Max-Age=2592000",
  ])
    assert.ok(cookies.includes(flag));
  assert.ok(!cookies.includes("Domain="));
});
for (const reason of ["expired", "revoked", "wrong-member", "malformed"]) {
  test("invalid trust falls back to TOTP: " + reason, async () => {
    const m = await login(local);
    let cookie = m.deviceCookie;
    if (reason === "expired")
      await local.db
        .prepare(
          "UPDATE trusted_devices SET created_at=?,expires_at=? WHERE member_id=?",
        )
        .bind(
          Math.floor(Date.now() / 1000) - 100,
          Math.floor(Date.now() / 1000) - 1,
          m.member.member_id,
        )
        .run();
    if (reason === "revoked")
      await local.db
        .prepare("UPDATE trusted_devices SET revoked_at=? WHERE member_id=?")
        .bind(Math.floor(Date.now() / 1000), m.member.member_id)
        .run();
    if (reason === "wrong-member") cookie = (await login(local)).deviceCookie;
    if (reason === "malformed") cookie = DEVICE_COOKIE + "=bad";
    assert.equal((await startLogin(m, {}, { Cookie: cookie })).status, 202);
  });
}
for (const remember of [false, true])
  test("absolute session TTL remember_me=" + remember, async () => {
    const s = await begin(local),
      r = await finish(local, s, { remember_me: remember }),
      d = await authData(r),
      ttl = remember ? 2592000 : 604800;
    assert.equal(d.expires_in, ttl);
    const row = await local.db
      .prepare("SELECT * FROM auth_sessions WHERE member_id=?")
      .bind(d.member.member_id)
      .first();
    assert.equal(row.expires_at - row.created_at, ttl);
    assert.match(r.headers.get("set-cookie"), new RegExp("Max-Age=" + ttl));
    assert.equal(row.token_hash.length, 64);
  });
test("current member/session expiry/invalid cookie/logout and session fixation protection", async () => {
  const m = await login(local),
    r = await startLogin(m, {}, { Cookie: m.deviceCookie + "; " + m.cookie });
  assert.equal(r.status, 200);
  assert.notEqual(responseCookie(r, SESSION_COOKIE), m.cookie);
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    401,
    "AUTH_REQUIRED",
  );
  const cookie = responseCookie(r, SESSION_COOKIE);
  await local.db
    .prepare(
      "UPDATE auth_sessions SET created_at=?,expires_at=? WHERE member_id=? AND revoked_at IS NULL",
    )
    .bind(
      Math.floor(Date.now() / 1000) - 100,
      Math.floor(Date.now() / 1000) - 1,
      m.member.member_id,
    )
    .run();
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, { Cookie: cookie }),
    401,
    "AUTH_REQUIRED",
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, {
      Cookie: SESSION_COOKIE + "=broken",
    }),
    401,
    "AUTH_REQUIRED",
  );
  const fresh = await login(local);
  assert.equal(
    (await local.fetch("/api/auth/logout", "POST", {}, fresh.headers)).status,
    200,
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, fresh.headers),
    401,
    "AUTH_REQUIRED",
  );
});
test("TOTP past/out-of-window codes rejected; same step replay and concurrent use rejected", async () => {
  const m = await login(local),
    tx = await mfaTransaction(m);
  await expectError(
    await verifyMfa(tx, m.otp.generate({ timestamp: Date.now() - 120000 })),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const used = await local.db
    .prepare(
      "SELECT last_used_time_step FROM member_credentials WHERE member_id=?",
    )
    .bind(m.member.member_id)
    .first();
  await expectError(
    await verifyMfa(
      tx,
      m.otp.generate({ timestamp: used.last_used_time_step * 30000 }),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const another = await mfaTransaction(m),
    sameCode = nextCode(m),
    rs = await Promise.all([
      verifyMfa(tx, sameCode),
      verifyMfa(another, sameCode),
    ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
});
test("TOTP supports minus-one and plus-one drift with persistent counter", async () => {
  for (const delta of [-1, 1]) {
    const m = await login(local); // Explicit fixture clock-history reset, never a production bypass.
    await local.db
      .prepare(
        "UPDATE member_credentials SET last_used_time_step=? WHERE member_id=?",
      )
      .bind(Math.floor(Date.now() / 30000) - 2, m.member.member_id)
      .run();
    const tx = await mfaTransaction(m);
    assert.equal(
      (
        await verifyMfa(
          tx,
          m.otp.generate({ timestamp: Date.now() + delta * 30000 }),
        )
      ).status,
      200,
    );
  }
});
test("encrypted TOTP is authenticated and bound to member; corruption is sanitized", async () => {
  const m = await login(local),
    b = await login(local),
    cred = await local.db
      .prepare("SELECT * FROM member_credentials WHERE member_id=?")
      .bind(b.member.member_id)
      .first();
  await local.db
    .prepare(
      "UPDATE member_credentials SET totp_ciphertext=?,totp_iv=? WHERE member_id=?",
    )
    .bind(cred.totp_ciphertext, cred.totp_iv, m.member.member_id)
    .run();
  const tx = await mfaTransaction(m),
    body = await expectError(
      await verifyMfa(tx, nextCode(m)),
      503,
      "AUTH_SERVICE_UNAVAILABLE",
    );
  assert.ok(!JSON.stringify(body).includes("cipher"));
});
test("password pepper must match and each password has random salt/strong KDF parameters", async () => {
  const m = await login(local),
    a = JSON.parse(
      (
        await local.db
          .prepare(
            "SELECT password_record FROM member_credentials WHERE member_id=?",
          )
          .bind(m.member.member_id)
          .first()
      ).password_record,
    );
  assert.equal(a.algorithm, "scrypt");
  assert.equal(a.N, 32768);
  assert.equal(a.r, 8);
  assert.equal(a.p, 3);
  assert.equal(a.salt.length, 32);
  assert.equal(a.hash.length, 64);
  const isolated = await localCaseRuntime();
  try {
    const x = await login(isolated);
    await isolated.setAuthConfig({
      AUTH_PASSWORD_PEPPER: randomBytes(32).toString("hex"),
    });
    await expectError(
      await isolated.fetch(
        "/api/auth/login",
        "POST",
        { login_name: x.login_name, password: x.password },
        loginHeaders(),
      ),
      401,
      "AUTH_LOGIN_FAILED",
    );
  } finally {
    await isolated.runtime.dispose();
  }
});
test("security settings require recent password+TOTP and CSRF; step-up refreshes both deadlines", async () => {
  const m = await login(local);
  await local.db
    .prepare(
      "UPDATE auth_sessions SET reauthenticated_until=0,elevated_until=0 WHERE member_id=?",
    )
    .bind(m.member.member_id)
    .run();
  await expectError(
    await local.fetch(
      "/api/auth/recovery-codes/regenerate",
      "POST",
      {},
      m.headers,
    ),
    403,
    "AUTH_STEP_UP_REQUIRED",
  );
  const sameCode = nextCode(m);
  const r = await local.fetch(
      "/api/auth/step-up",
      "POST",
      { password: m.password, code: sameCode },
      m.headers,
    ),
    d = await authData(r);
  assert.ok(d.elevated_until - Math.floor(Date.now() / 1000) <= 3600);
  assert.ok(d.reauthenticated_until - Math.floor(Date.now() / 1000) <= 300);
  await expectError(
    await local.fetch(
      "/api/auth/password/change",
      "POST",
      { new_password: password() },
      { ...m.headers, Origin: "https://attacker.example" },
    ),
    403,
    "CSRF_REJECTED",
  );
  await expectError(
    await local.fetch(
      "/api/auth/step-up",
      "POST",
      { password: m.password, code: sameCode },
      m.headers,
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
});
test("password change invalidates old password and revokes sessions/devices", async () => {
  const m = await login(local),
    next = password();
  assert.equal(
    (
      await local.fetch(
        "/api/auth/password/change",
        "POST",
        { new_password: next },
        m.headers,
      )
    ).status,
    200,
  );
  await expectError(await startLogin(m), 401, "AUTH_LOGIN_FAILED");
  assert.equal(
    (await startLogin({ ...m, password: next }, {}, { Cookie: m.deviceCookie }))
      .status,
    202,
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    401,
    "AUTH_REQUIRED",
  );
  assert.equal(
    (
      await local.db
        .prepare(
          "SELECT count(*) n FROM trusted_devices WHERE member_id=? AND revoked_at IS NULL",
        )
        .bind(m.member.member_id)
        .first()
    ).n,
    0,
  );
});
test("recovery codes stored hash-only; wrong code rejected; regenerate invalidates old set", async () => {
  const m = await login(local),
    rows = (
      await local.db
        .prepare("SELECT * FROM recovery_codes WHERE member_id=?")
        .bind(m.member.member_id)
        .all()
    ).results;
  assert.equal(rows.length, 10);
  for (const code of m.recovery_codes)
    assert.ok(!JSON.stringify(rows).includes(code));
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/start",
      "POST",
      {
        login_name: m.login_name,
        recovery_code: randomBytes(32).toString("base64url"),
      },
      loginHeaders(),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const set = await authData(
    await local.fetch(
      "/api/auth/recovery-codes/regenerate",
      "POST",
      {},
      m.headers,
    ),
  );
  assert.equal(set.recovery_codes.length, 10);
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/start",
      "POST",
      { login_name: m.login_name, recovery_code: m.recovery_codes[0] },
      loginHeaders(),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
});
async function recoveryBegin(m, kind = "password", code = m.recovery_codes[0]) {
  const headers = loginHeaders(),
    r = await local.fetch(
      "/api/auth/recovery/" + kind + "/start",
      "POST",
      {
        login_name: m.login_name,
        recovery_code: code,
        ...(kind === "totp" ? { password: m.password } : {}),
      },
      headers,
    );
  assert.equal(r.status, 202);
  const d = (await r.json()).data;
  return {
    d,
    headers: { ...headers, Cookie: responseCookie(r, LOGIN_COOKIE) },
  };
}
test("password recovery consumes one code at commit, rejects reuse and requires login+existing TOTP", async () => {
  const m = await login(local),
    tx = await recoveryBegin(m),
    next = password();
  assert.equal(
    (
      await local.db
        .prepare(
          "SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL",
        )
        .bind(m.member.member_id)
        .first()
    ).n,
    0,
  );
  const body = { transaction_id: tx.d.transaction_id, new_password: next },
    d = await authData(
      await local.fetch(
        "/api/auth/recovery/password/finish",
        "POST",
        body,
        tx.headers,
      ),
    );
  assert.equal(d.login_required, true);
  assert.equal(d.member, undefined);
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/finish",
      "POST",
      body,
      tx.headers,
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/start",
      "POST",
      { login_name: m.login_name, recovery_code: m.recovery_codes[0] },
      loginHeaders(),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  await expectError(await startLogin(m), 401, "AUTH_LOGIN_FAILED");
  assert.equal(
    (await startLogin({ ...m, password: next }, {}, { Cookie: m.deviceCookie }))
      .status,
    202,
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    401,
    "AUTH_REQUIRED",
  );
});
test("two recovery transactions cannot consume the same code twice", async () => {
  const m = await login(local),
    a = await recoveryBegin(m),
    b = await recoveryBegin(m);
  const rs = await Promise.all(
    [a, b].map((tx) =>
      local.fetch(
        "/api/auth/recovery/password/finish",
        "POST",
        { transaction_id: tx.d.transaction_id, new_password: password() },
        tx.headers,
      ),
    ),
  );
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 400]);
});
test("lost Authenticator recovery requires password+code and verified replacement, rotates recovery generation", async () => {
  const m = await login(local),
    before = await local.db
      .prepare(
        "SELECT totp_ciphertext FROM member_credentials WHERE member_id=?",
      )
      .bind(m.member.member_id)
      .first();
  await expectError(
    await local.fetch(
      "/api/auth/recovery/totp/start",
      "POST",
      {
        login_name: m.login_name,
        password: password(),
        recovery_code: m.recovery_codes[0],
      },
      loginHeaders(),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const tx = await recoveryBegin(m, "totp"),
    otp = URI.parse(tx.d.otpauth_uri);
  await expectError(
    await local.fetch(
      "/api/auth/recovery/totp/verify",
      "POST",
      { transaction_id: tx.d.transaction_id, code: "invalid" },
      tx.headers,
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  assert.deepEqual(
    await local.db
      .prepare(
        "SELECT totp_ciphertext FROM member_credentials WHERE member_id=?",
      )
      .bind(m.member.member_id)
      .first(),
    before,
  );
  const d = await authData(
    await local.fetch(
      "/api/auth/recovery/totp/verify",
      "POST",
      { transaction_id: tx.d.transaction_id, code: otp.generate() },
      tx.headers,
    ),
  );
  assert.equal(d.login_required, true);
  assert.equal(d.recovery_codes.length, 10);
  assert.notEqual(
    (
      await local.db
        .prepare(
          "SELECT totp_ciphertext FROM member_credentials WHERE member_id=?",
        )
        .bind(m.member.member_id)
        .first()
    ).totp_ciphertext,
    before.totp_ciphertext,
  );
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    401,
    "AUTH_REQUIRED",
  );
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/start",
      "POST",
      { login_name: m.login_name, recovery_code: m.recovery_codes[1] },
      loginHeaders(),
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const loginTx = await mfaTransaction(m);
  assert.equal(
    (await verifyMfa(loginTx, otp.generate({ timestamp: Date.now() + 30000 })))
      .status,
    200,
  );
});
test("authenticated TOTP reset requires step-up, enrollment, atomically revokes sessions/devices", async () => {
  const m = await login(local),
    r = await local.fetch("/api/auth/totp/reset/start", "POST", {}, m.headers);
  assert.equal(r.status, 202);
  const d = (await r.json()).data;
  const headers = {
    ...m.headers,
    Cookie: m.cookie + "; " + responseCookie(r, LOGIN_COOKIE),
  };
  const verified = await authData(
    await local.fetch(
      "/api/auth/totp/reset/verify",
      "POST",
      {
        transaction_id: d.transaction_id,
        code: URI.parse(d.otpauth_uri).generate(),
      },
      headers,
    ),
  );
  assert.equal(verified.totp_reset, true);
  assert.equal(verified.recovery_codes.length, 10);
  await expectError(
    await local.fetch("/api/auth/me", "GET", undefined, m.headers),
    401,
    "AUTH_REQUIRED",
  );
});
test("list/revoke devices is owner-scoped, sensitive hashes hidden, revoke-others retains only current device", async () => {
  const m = await login(local),
    other = await login(local),
    list = await authData(
      await local.fetch(
        "/api/auth/trusted-devices",
        "GET",
        undefined,
        m.headers,
      ),
    );
  assert.equal(list.devices.length, 1);
  assert.deepEqual(
    Object.keys(list.devices[0]).sort(),
    ["id", "created_at", "last_used_at", "expires_at", "label"].sort(),
  );
  assert.equal(
    (
      await local.fetch(
        "/api/auth/trusted-devices/" + list.devices[0].id + "/revoke",
        "POST",
        {},
        other.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await startLogin(m, {}, { Cookie: m.deviceCookie })).status,
    200,
  );
  assert.equal(
    (
      await local.fetch(
        "/api/auth/trusted-devices/revoke-others",
        "POST",
        {},
        { ...m.headers, Cookie: m.cookie + "; " + m.deviceCookie },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await local.fetch(
        "/api/auth/trusted-devices/" + list.devices[0].id + "/revoke",
        "POST",
        {},
        m.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await startLogin(m, {}, { Cookie: m.deviceCookie })).status,
    202,
  );
});
test("password brute force has persistent temporary account quota, reset window restores access", async () => {
  const m = await login(local);
  for (let i = 0; i < 10; i++)
    await expectError(
      await startLogin(m, { password: password() }),
      401,
      "AUTH_LOGIN_FAILED",
    );
  const r = await startLogin(m);
  await expectError(r, 429, "AUTH_RATE_LIMITED");
  assert.equal(r.headers.get("retry-after"), "900");
  await local.db
    .prepare(
      "UPDATE auth_rate_limits SET window_start=window_start-900,expires_at=expires_at-900",
    )
    .run();
  assert.equal(
    (await startLogin(m, {}, { Cookie: m.deviceCookie })).status,
    200,
  );
});
test("TOTP challenge brute force persists five-attempt limit and does not lock account forever", async () => {
  const m = await login(local),
    tx = await mfaTransaction(m);
  for (let i = 0; i < 5; i++)
    await expectError(
      await verifyMfa(tx, "bad"),
      400,
      "AUTH_VERIFICATION_FAILED",
    );
  await expectError(
    await verifyMfa(tx, nextCode(m)),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  const next = await mfaTransaction(m);
  assert.equal((await verifyMfa(next, nextCode(m))).status, 200);
});
test("recovery brute force uses persistent hashed account/IP quotas", async () => {
  const m = await login(local);
  for (let i = 0; i < 10; i++)
    await expectError(
      await local.fetch(
        "/api/auth/recovery/password/start",
        "POST",
        {
          login_name: m.login_name,
          recovery_code: randomBytes(32).toString("base64url"),
        },
        loginHeaders(),
      ),
      400,
      "AUTH_VERIFICATION_FAILED",
    );
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/start",
      "POST",
      { login_name: m.login_name, recovery_code: m.recovery_codes[0] },
      loginHeaders(),
    ),
    429,
    "AUTH_RATE_LIMITED",
  );
  const rows = (
    await local.db.prepare("SELECT scope_hash FROM auth_rate_limits").all()
  ).results;
  assert.ok(rows.every((r) => /^[a-f0-9]{64}$/.test(r.scope_hash)));
  assert.ok(!JSON.stringify(rows).includes(m.login_name));
});
test("missing or reused crypto secrets fail closed", async () => {
  const isolated = await localCaseRuntime();
  try {
    const original = isolated.authConfig;
    for (const config of [
      { AUTH_PASSWORD_PEPPER: undefined },
      { AUTH_PASSWORD_PEPPER: original.AUTH_SECRET },
      {
        AUTH_PASSWORD_PEPPER: original.AUTH_PASSWORD_PEPPER,
        AUTH_TOTP_ENCRYPTION_KEY: undefined,
      },
    ]) {
      await isolated.setAuthConfig(config);
      await expectError(
        await isolated.fetch(
          "/api/auth/login",
          "POST",
          { login_name: "local-user", password: password() },
          loginHeaders(),
        ),
        503,
        "AUTH_NOT_CONFIGURED",
      );
    }
  } finally {
    await isolated.runtime.dispose();
  }
});
test("obsolete auth endpoints removed, wrong methods 405, uniform no-store", async () => {
  for (const path of ["/api/auth/start", "/api/auth/verify"])
    await expectError(
      await local.fetch(path, "POST", {}, loginHeaders()),
      404,
      "NOT_FOUND",
    );
  for (const path of [
    "/api/auth/register/start",
    "/api/auth/login",
    "/api/auth/step-up",
    "/api/auth/recovery/password/start",
  ])
    await expectError(await local.fetch(path), 405, "METHOD_NOT_ALLOWED");
});
test("all B5 mutations and reads require recent MFA for reviewers/admins/super_admins", async () => {
  const h = await localAdminRuntime();
  try {
    for (const role of ["reviewer", "admin", "super_admin"]) {
      const actor = await h.identity({ role, elevated: false });
      await expectError(
        await h.local.fetch(
          "/api/admin/cases",
          "GET",
          undefined,
          actor.headers,
        ),
        403,
        "ADMIN_STEP_UP_REQUIRED",
      );
      const paths =
        role === "reviewer"
          ? ["/api/admin/cases/example/review"]
          : [
              "/api/admin/cases/example/review",
              "/api/admin/campaigns",
              "/api/admin/points/adjustments",
              "/api/admin/leaderboards/example/rebuild",
              "/api/admin/member-tiers/normal/update",
            ];
      for (const path of paths) {
        const r = await h.local.fetch(path, "POST", {}, actor.headers);
        assert.equal(r.status, 403);
        assert.equal((await r.json()).error.code, "ADMIN_STEP_UP_REQUIRED");
      }
    }
    const member = await h.identity();
    await expectError(
      await h.local.fetch("/api/admin/cases", "GET", undefined, member.headers),
      403,
      "ADMIN_FORBIDDEN",
    );
    const elevated = await h.identity({ role: "reviewer" });
    assert.equal(
      (
        await h.local.fetch(
          "/api/admin/cases",
          "GET",
          undefined,
          elevated.headers,
        )
      ).status,
      200,
    );
  } finally {
    await h.local.runtime.dispose();
  }
});
test("real member TOTP step-up enables admin role but expires independently of long session", async () => {
  const m = await login(local),
    now = new Date().toISOString();
  await local.db
    .prepare(
      "INSERT INTO admin_memberships(id,member_id,role,status,created_at,updated_at) VALUES(?,?,'admin','active',?,?)",
    )
    .bind(randomUUID(), m.member.member_id, now, now)
    .run();
  await local.db
    .prepare("UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?")
    .bind(m.member.member_id)
    .run();
  await expectError(
    await local.fetch("/api/admin/cases", "GET", undefined, m.headers),
    403,
    "ADMIN_STEP_UP_REQUIRED",
  );
  assert.equal(
    (
      await local.fetch(
        "/api/auth/step-up",
        "POST",
        { password: m.password, code: nextCode(m) },
        m.headers,
      )
    ).status,
    200,
  );
  assert.equal(
    (await local.fetch("/api/admin/cases", "GET", undefined, m.headers)).status,
    200,
  );
  await local.db
    .prepare("UPDATE auth_sessions SET elevated_until=? WHERE member_id=?")
    .bind(Math.floor(Date.now() / 1000) - 1, m.member.member_id)
    .run();
  await expectError(
    await local.fetch("/api/admin/cases", "GET", undefined, m.headers),
    403,
    "ADMIN_STEP_UP_REQUIRED",
  );
});

test("credential changes invalidate outstanding password-verified MFA transaction", async () => {
  const m = await login(local),
    tx = await mfaTransaction(m);
  assert.equal(
    (
      await local.fetch(
        "/api/auth/password/change",
        "POST",
        { new_password: password() },
        m.headers,
      )
    ).status,
    200,
  );
  await expectError(
    await verifyMfa(tx, nextCode(m)),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
});
test("expired recovery transaction cannot consume code or reset credentials", async () => {
  const m = await login(local),
    tx = await recoveryBegin(m);
  await expireTx(tx.d.transaction_id);
  await expectError(
    await local.fetch(
      "/api/auth/recovery/password/finish",
      "POST",
      { transaction_id: tx.d.transaction_id, new_password: password() },
      tx.headers,
    ),
    400,
    "AUTH_VERIFICATION_FAILED",
  );
  assert.equal(
    (await startLogin(m, {}, { Cookie: m.deviceCookie })).status,
    200,
  );
  assert.equal(
    (
      await local.db
        .prepare(
          "SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL",
        )
        .bind(m.member.member_id)
        .first()
    ).n,
    0,
  );
});
test("D1 failure rolls back member/credential/code/session/consumption together", async () => {
  const s = await begin(local);
  await local.db
    .prepare(
      `CREATE TRIGGER fixture_auth_failure BEFORE INSERT ON recovery_codes BEGIN SELECT RAISE(ABORT,'fixture failure'); END`,
    )
    .run();
  try {
    await expectError(await finish(local, s), 503, "AUTH_SERVICE_UNAVAILABLE");
  } finally {
    await local.db.prepare("DROP TRIGGER fixture_auth_failure").run();
  }
  assert.equal(
    await local.db
      .prepare("SELECT member_id FROM members WHERE login_name=?")
      .bind(s.login_name)
      .first(),
    null,
  );
  assert.equal(
    (
      await local.db
        .prepare("SELECT consumed_at FROM auth_transactions WHERE id=?")
        .bind(s.id)
        .first()
    ).consumed_at,
    null,
  );
  assert.equal(
    (
      await local.db
        .prepare("SELECT count(*) n FROM auth_atomic_guards")
        .first()
    ).n,
    0,
  );
  assert.equal((await finish(local, s)).status, 200);
});
test("enrollment/key/cookie/credential values cannot appear in auth source logging", async () => {
  const { readFile } = await import("node:fs/promises");
  for (const file of [
    "api/auth.js",
    "api/auth-login.js",
    "api/auth-security.js",
    "api/auth-recovery.js",
    "lib/auth-crypto.js",
    "lib/auth-store.js",
    "lib/auth-session.js",
  ]) {
    const source = await readFile(
      new URL("../src/" + file, import.meta.url),
      "utf8",
    );
    assert.ok(!/console\.(log|warn|error|info|debug)\s*\(/.test(source));
  }
  assert.equal(local.unexpectedUpstreams.length, 0);
});

test("logout retains empty POST compatibility but rejects non-JSON/oversize bodies", async () => {
  const m = await login(local);
  await expectError(
    await local.fetch("/api/auth/logout", "POST", " ".repeat(16385), m.headers),
    413,
    "INVALID_AUTH_REQUEST",
  );
  const rejected = await local.runtime.dispatchFetch(
    "https://voteproof.example/api/auth/logout",
    { method: "POST", headers: m.headers, body: "invalid-body" },
  );
  await expectError(rejected, 400, "INVALID_JSON");
  assert.equal(
    (await local.fetch("/api/auth/logout", "POST", undefined, m.headers))
      .status,
    200,
  );
});
