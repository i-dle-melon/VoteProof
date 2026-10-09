// Executes the exact operator SQL in isolated in-memory PostgreSQL, not D1
// or a JS copy of the policy. Provider calls use disposable mocks only.
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { authProviderFixture } from "../scripts/lib/local-auth-provider.mjs";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { begin, finish, loginHeaders, responseCookie } from "../scripts/lib/local-auth-runtime.mjs";
import { googleMember } from "../scripts/lib/local-google-runtime.mjs";
import { adminCreateVerifiedUser } from "../src/lib/supabase-auth.js";
import { LOGIN_COOKIE } from "../src/lib/auth-session.js";

let pg;
before(async () => {
  pg = new PGlite();
  await pg.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE supabase_auth_admin;");
  await pg.exec(await readFile(new URL("../docs/voteproof-signup-policy.sql", import.meta.url), "utf8"));
});
after(async () => { await pg?.close(); });
const policy = async event => (await pg.query("SELECT public.voteproof_signup_policy($1::jsonb) AS result", [JSON.stringify(event)])).rows[0].result;
const event = (provider, marker, anonymous = false) => ({ user: { is_anonymous: anonymous,
  app_metadata: { provider, ...(marker === undefined ? {} : { voteproof_verified_signup: marker }) } } });
const allowed = async input => assert.deepEqual(await policy(input), {});
const denied = async input => assert.equal((await policy(input)).error.http_code, 403);
const disposableEmail = () => randomUUID() + "@local.example";
const password = () => randomBytes(24).toString("base64url");
const publicSignup = (fixture, body) => fixture.fetch(new Request(fixture.config.SUPABASE_URL + "/auth/v1/signup", {
  method: "POST", headers: { apikey: fixture.config.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" }, body: JSON.stringify(body),
}));

test("SQL allows new non-anonymous Google user without the email marker", async () => allowed(event("google")));
test("SQL allows verified server email only with JSON boolean true marker", async () => allowed(event("email", true)));
test("SQL rejects direct email signup without trusted app metadata marker", async () => denied(event("email")));
test("SQL rejects marker false/null/string/number and unsupported providers", async () => {
  for (const marker of [false, null, "true", 1, {}]) await denied(event("email", marker));
  for (const provider of ["phone", "github", "anonymous", null]) await denied(event(provider, true));
});
test("SQL ignores forged user_metadata marker/provider", async () => {
  const input = event("email"); input.user.user_metadata = { provider: "google", voteproof_verified_signup: true, app_metadata: { voteproof_verified_signup: true } };
  await denied(input);
});
test("SQL rejects anonymous even with Google or the trusted email marker", async () => {
  await denied(event("google", undefined, true)); await denied(event("email", true, true));
});
test("SQL missing/malformed anonymous flag and malformed event fail closed", async () => {
  for (const flag of [null, "false", 0]) await denied(event("google", undefined, flag));
  for (const input of [{}, { user: {} }, { user: { app_metadata: { provider: "google" } } }, null]) await denied(input);
});
test("SQL privileges allow only auth admin; hook remains invoker with pinned search path", async () => {
  const r = await pg.query("SELECT has_function_privilege('anon','public.voteproof_signup_policy(jsonb)','EXECUTE') anon, has_function_privilege('authenticated','public.voteproof_signup_policy(jsonb)','EXECUTE') member, has_function_privilege('supabase_auth_admin','public.voteproof_signup_policy(jsonb)','EXECUTE') admin");
  assert.deepEqual(r.rows[0], { anon: false, member: false, admin: true });
  const fn = (await pg.query("SELECT prosecdef,proconfig FROM pg_proc WHERE oid='public.voteproof_signup_policy(jsonb)'::regprocedure")).rows[0];
  assert.equal(fn.prosecdef, false); assert.ok(fn.proconfig.some(c => c.startsWith("search_path=") && !c.includes("public")));
  await pg.exec("SET ROLE supabase_auth_admin");
  try { await allowed(event("email", true)); } finally { await pg.exec("RESET ROLE"); }
});
test("public signUp cannot forge app_metadata through root or nested data", async () => {
  const f = authProviderFixture({ beforeUserCreated: policy });
  for (const body of [
    {}, { app_metadata: { provider: "google", voteproof_verified_signup: true } },
    { data: { voteproof_verified_signup: true, app_metadata: { provider: "google", voteproof_verified_signup: true } } },
    { user_metadata: { voteproof_verified_signup: true } },
  ]) assert.equal((await publicSignup(f, { email: disposableEmail(), password: password(), ...body })).status, 403);
  assert.equal(f.users.size, 0);
});
test("public credentials cannot call Admin create even with a forged marker", async () => {
  const f = authProviderFixture({ beforeUserCreated: policy, adminCreateHook: true });
  const r = await f.fetch(new Request(f.config.SUPABASE_URL + "/auth/v1/admin/users", { method: "POST",
    headers: { apikey: f.config.SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ email: disposableEmail(), password: password(), email_confirm: true, app_metadata: { voteproof_verified_signup: true } }),
  }));
  assert.equal(r.status, 401); assert.equal(f.users.size, 0);
});
test("adapter sets server-only trusted marker and hook accepts Admin creation if invoked", async t => {
  let invocations = 0;
  const f = authProviderFixture({ adminCreateHook: true, beforeUserCreated: async e => { invocations++; return policy(e); } });
  t.mock.method(globalThis, "fetch", (url, init) => f.fetch(new Request(url, init)));
  const enrollment = randomUUID(), id = await adminCreateVerifiedUser(f.config, disposableEmail(), password(), enrollment);
  assert.equal(invocations, 1); assert.equal(f.users.get(id).confirmed, true);
  assert.deepEqual(f.calls[0].body.app_metadata, { voteproof_enrollment_id: enrollment, voteproof_verified_signup: true });
  assert.equal(f.calls[0].body.user_metadata, undefined); assert.equal(f.calls[0].headers.apikey, f.config.SUPABASE_SECRET_KEY);
});
test("upstream-style Admin bypass remains compatible but is not used as policy authorization", async t => {
  const f = authProviderFixture({ beforeUserCreated: () => { throw new Error("Admin hook should not run in upstream mode"); } });
  t.mock.method(globalThis, "fetch", (url, init) => f.fetch(new Request(url, init)));
  const id = await adminCreateVerifiedUser(f.config, disposableEmail(), password(), randomUUID());
  assert.equal(f.users.get(id).app_metadata.voteproof_verified_signup, true);
});
test("B4S Gmail verified registration completes with the actual SQL enforced for Admin", async () => {
  const h = await localCaseRuntime({ providerOptions: { beforeUserCreated: policy, adminCreateHook: true } });
  try {
    const setup = await begin(h), response = await finish(h, setup); assert.equal(response.status, 200);
    const data = (await response.json()).data; assert.equal(data.recovery_codes.length, 10);
    const user = [...h.provider.users.values()][0]; assert.equal(user.app_metadata.voteproof_verified_signup, true);
    assert.equal((await h.db.prepare("SELECT member_id FROM auth_identities WHERE provider_subject=?").bind(user.id).first()).member_id, data.member.member_id);
    assert.equal(h.provider.mails.length, 1); assert.equal(JSON.stringify(data).includes("voteproof_verified_signup"), false);
    assert.equal((await publicSignup(h.provider, { email: disposableEmail(), password: password() })).status, 403);
  } finally { await h.runtime.dispose(); }
});
test("Worker rejects client-supplied trusted marker before provider create", async () => {
  const h = await localCaseRuntime({ providerOptions: { beforeUserCreated: policy, adminCreateHook: true } });
  try {
    const headers = loginHeaders(), email = disposableEmail();
    const start = await h.fetch("/api/auth/register/start", "POST", { email, turnstile_token: password() }, headers);
    const challenge = (await start.json()).data;
    const proof = await h.fetch("/api/auth/register/verify-email", "POST", { challenge_id: challenge.challenge_id, code: h.provider.codeFor(email) }, { ...headers, Cookie: responseCookie(start, LOGIN_COOKIE) });
    const registration = (await proof.json()).data;
    const r = await h.fetch("/api/auth/register/credentials", "POST", { transaction_id: registration.transaction_id, password: password(), app_metadata: { voteproof_verified_signup: true } }, { ...headers, Cookie: responseCookie(proof, LOGIN_COOKIE) });
    assert.equal(r.status, 400); assert.equal(h.provider.users.size, 0);
  } finally { await h.runtime.dispose(); }
});
test("new Google profile still completes when the actual SQL guards provider creation", async () => {
  let invocations = 0;
  const h = await localCaseRuntime({ providerOptions: { beforeUserCreated: async e => { invocations++; return policy(e); }, adminCreateHook: true } });
  try {
    const m = await googleMember(h); assert.equal(invocations, 1);
    assert.equal(m.provider.app_metadata.provider, "google"); assert.equal(m.provider.app_metadata.voteproof_verified_signup, undefined);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM member_credentials").first()).n, 0);
    assert.equal(h.provider.mails.length, 0); assert.equal(h.unexpectedUpstreams.length, 0);
  } finally { await h.runtime.dispose(); }
});
