import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { verifyPassword, adminCreateVerifiedUser, adminUpdatePassword, adminDeleteUser } from "../src/lib/supabase-auth.js";
import { sendVerificationEmail } from "../src/lib/gmail.js";
import { authProviderFixture } from "../scripts/lib/local-auth-provider.mjs";
const password = () => randomBytes(24).toString("base64url");
test("Supabase password grant uses publishable apikey and returns identity only", async t => {
  const f = authProviderFixture(), id = randomUUID(), token = password();
  t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.ok(url.endsWith("/auth/v1/token?grant_type=password")); assert.equal(init.headers.apikey, f.config.SUPABASE_PUBLISHABLE_KEY); assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.redirect, "manual"); assert.ok(init.signal instanceof AbortSignal);
    return Response.json({ user: { id, email: "member@local.example", email_confirmed_at: new Date().toISOString() }, access_token: token, refresh_token: token });
  });
  assert.deepEqual(await verifyPassword(f.config, "member@local.example", password()), { id });
});
test("Supabase wrong password is generic, upstream failures do not leak", async t => {
  const f = authProviderFixture(); t.mock.method(globalThis, "fetch", async () => Response.json({ message: password() }, { status: 400 }));
  assert.equal(await verifyPassword(f.config, "member@local.example", password()), null);
  globalThis.fetch = async () => { throw new Error("unsafe provider detail"); };
  await assert.rejects(verifyPassword(f.config, "member@local.example", password()), { code: "AUTH_PROVIDER_UNAVAILABLE" });
});
test("Supabase rejects malformed/unconfirmed/mismatched identity", async t => {
  const f = authProviderFixture();
  t.mock.method(globalThis, "fetch", async () => Response.json({ user: { id: randomUUID(), email: "other@local.example", email_confirmed_at: null } }));
  await assert.rejects(verifyPassword(f.config, "member@local.example", password()), { code: "AUTH_PROVIDER_UNAVAILABLE" });
});
test("Supabase admin create/update/delete use secret apikey, confirmed email, exact methods", async t => {
  const f = authProviderFixture(), id = randomUUID(), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init }); assert.equal(init.headers.apikey, f.config.SUPABASE_SECRET_KEY); assert.equal(init.headers.Authorization, undefined);
    return Response.json(init.method === "DELETE" ? {} : { id, email: "member@local.example", email_confirmed_at: new Date().toISOString() });
  });
  assert.equal(await adminCreateVerifiedUser(f.config, "member@local.example", password(), randomUUID()), id);
  assert.equal(JSON.parse(calls[0].init.body).email_confirm, true);
  await adminUpdatePassword(f.config, id, password()); await adminDeleteUser(f.config, id);
  assert.deepEqual(calls.map(c => c.init.method), ["POST", "PUT", "DELETE"]);
});
test("Supabase missing config fails closed before network", async t => {
  const f = authProviderFixture(); let calls = 0;
  t.mock.method(globalThis, "fetch", async () => { calls++; });
  for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"]) await assert.rejects(verifyPassword({ ...f.config, [name]: undefined }, "member@local.example", password()), { code: "AUTH_NOT_CONFIGURED" });
  assert.equal(calls, 0);
});
test("Gmail refresh grant and RFC822 base64url message succeed without OAuth data in message", async t => {
  const f = authProviderFixture(), code = String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
  t.mock.method(globalThis, "fetch", async (url, init) => f.fetch(new Request(url, init)));
  await sendVerificationEmail(f.config, "member@local.example", code);
  assert.equal(f.mails.length, 1); assert.equal(f.codeFor("member@local.example") === code, true);
  assert.equal(f.calls[0].body.grant_type, "refresh_token"); assert.ok(f.mails[0].raw.includes("Content-Transfer-Encoding: base64"));
  for (const value of [...Object.values(f.config).filter(v => v.length > 40), ...f.tokens]) assert.equal(f.mails[0].raw.includes(value), false);
});
test("Gmail OAuth auth failure stops before send and has safe error", async t => {
  const f = authProviderFixture(); f.failures.set("/token", { status: 401 });
  t.mock.method(globalThis, "fetch", async (url, init) => f.fetch(new Request(url, init)));
  await assert.rejects(sendVerificationEmail(f.config, "member@local.example", "123456"), { code: "AUTH_EMAIL_UNAVAILABLE", status: 502 });
  assert.equal(f.mails.length, 0);
});
for (const status of [403, 429]) test("Gmail quota/rate failure " + status + " maps to safe unavailable", async t => {
  const f = authProviderFixture(); f.failures.set("/gmail/v1/users/me/messages/send", { status });
  t.mock.method(globalThis, "fetch", async (url, init) => f.fetch(new Request(url, init)));
  await assert.rejects(sendVerificationEmail(f.config, "member@local.example", "123456"), { code: "AUTH_EMAIL_UNAVAILABLE", status: 503 });
});
test("Gmail prevents header injection and missing configuration", async () => {
  const f = authProviderFixture();
  await assert.rejects(sendVerificationEmail({ ...f.config, GMAIL_SENDER_NAME: "VoteProof\r\nBcc: attacker@local.example" }, "member@local.example", "123456"), { code: "AUTH_NOT_CONFIGURED" });
  await assert.rejects(sendVerificationEmail({ ...f.config, GMAIL_REFRESH_TOKEN: undefined }, "member@local.example", "123456"), { code: "AUTH_NOT_CONFIGURED" });
  await assert.rejects(sendVerificationEmail(f.config, "member@local.example\r\nBcc: attacker@local.example", "123456"), { code: "INVALID_AUTH_REQUEST" });
});
test("Gmail internal test subject is labeled, bounded and does not change the default API", async t => {
  const f = authProviderFixture(), subject = "VoteProof B4S Live Verification Test";
  t.mock.method(globalThis, "fetch", async (url, init) => f.fetch(new Request(url, init)));
  await sendVerificationEmail(f.config, "member@local.example", "123456", { subject });
  const encoded = f.mails[0].raw.match(/Subject: =\?UTF-8\?B\?([^?]+)\?=/)[1];
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), subject);
  for (const subject of ["", "x".repeat(121), "test\r\nBcc: attacker@local.example"]) {
    await assert.rejects(sendVerificationEmail(f.config, "member@local.example", "123456", { subject }), { code: "AUTH_EMAIL_UNAVAILABLE" });
  }
  assert.equal(f.mails.length, 1);
});
