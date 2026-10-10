import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { mailConfig, canonicalVerificationMail, signedVerificationMail, sendVerificationEmail, MAIL_RELAY_LIMITS } from "../src/lib/mail-relay.js";
import { EMAIL_LIMITS, quotaConfig, emailBudget } from "../src/lib/registration-quota.js";
import { authProviderFixture } from "../scripts/lib/local-auth-provider.mjs";
import { localCaseRuntime } from "../scripts/lib/local-case-runtime.mjs";
import { loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { LOGIN_COOKIE } from "../src/lib/auth-session.js";
import { googleMember } from "../scripts/lib/local-google-runtime.mjs";
const code = () => String(Math.floor(Math.random() * 1000000)).padStart(6, "0");
const echo = () => "https://script.googleusercontent.com/macros/echo?user_content_key=" + randomBytes(24).toString("base64url");
const reject = (promise, status = 502) => assert.rejects(promise, { status, code: "AUTH_EMAIL_UNAVAILABLE", message: "Verification email service is unavailable" });

test("relay canonical bytes have fixed purpose, normalized email and no final newline", () => {
  const data = { timestamp: 1700000000, send_id: "abcdefghijklmnop", to: " Member@Local.Example ", code: "001234" };
  assert.equal(canonicalVerificationMail(data), "v1\n1700000000\nabcdefghijklmnop\nverify_email\nmember@local.example\n001234");
  for (const change of [{ timestamp: 1.5 }, { send_id: "short" }, { send_id: "x".repeat(81) }, { send_id: "x\n".repeat(16) }, { code: "12345" }, { code: 123456 }]) assert.throws(() => canonicalVerificationMail({ ...data, ...change }));
});

test("relay uses exact UTF-8 secret, SHA256 HMAC and unpadded base64url", async () => {
  for (const secret of [randomBytes(32).toString("hex"), "é " + randomBytes(32).toString("base64url") + " "]) {
    const body = await signedVerificationMail(secret, " Member@Local.Example ", code());
    assert.equal(body.signature, createHmac("sha256", Buffer.from(secret, "utf8")).update(canonicalVerificationMail(body)).digest("base64url"));
    assert.match(body.signature, /^[A-Za-z0-9_-]{43}$/); assert.equal(body.to, "member@local.example");
    assert.equal(body.purpose, "verify_email"); assert.ok(Math.abs(body.timestamp - Math.floor(Date.now()/1000)) <= 1);
  }
});

test("relay send ids are independently crypto-random and fit the hosted protocol", async () => {
  const secret = randomBytes(32).toString("hex"), bodies = await Promise.all(Array.from({ length: 50 }, () => signedVerificationMail(secret, "member@local.example", code())));
  assert.equal(new Set(bodies.map(b => b.send_id)).size, 50);
  assert.ok(bodies.every(b => /^[A-Za-z0-9_-]{16,80}$/.test(b.send_id)));
});

test("relay config is strict HTTPS exec URL, dedicated key and no OAuth dependency", () => {
  const { config } = authProviderFixture();
  for (const name of Object.keys(config).filter(n => n.startsWith("GMAIL_"))) delete config[name];
  assert.doesNotThrow(() => mailConfig(config));
  for (const url of ["http://script.google.com/macros/s/test/exec", "https://attacker.example/exec", config.MAIL_RELAY_URL + "?signature=test", config.MAIL_RELAY_URL + "#fragment", config.MAIL_RELAY_URL.replace("/exec", "/dev"), config.MAIL_RELAY_URL.replace("script.google.com", "user@script.google.com")]) assert.throws(() => mailConfig({ ...config, MAIL_RELAY_URL: url }), { code: "AUTH_NOT_CONFIGURED" });
  for (const secret of [undefined, "", "x".repeat(31), "x".repeat(1025)]) assert.throws(() => mailConfig({ ...config, MAIL_RELAY_SECRET: secret }), { code: "AUTH_NOT_CONFIGURED" });
  for (const name of ["AUTH_SECRET", "AUTH_TOTP_ENCRYPTION_KEY", "CASE_QUERY_KEY_SECRET", "SUPABASE_SECRET_KEY", "SUPABASE_PUBLISHABLE_KEY", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"]) assert.throws(() => mailConfig({ ...config, [name]: config.MAIL_RELAY_SECRET }), { code: "AUTH_NOT_CONFIGURED" });
});

test("relay success sends one minimal POST, without OAuth or retry", async t => {
  const f = authProviderFixture(), calls = [];
  t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({url,init}); return f.fetch(new Request(url,init)); });
  await sendVerificationEmail(f.config, " Member@Local.Example ", code());
  assert.equal(calls.length, 1); assert.equal(f.mails.length, 1);
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.redirect, "manual"); assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(Object.keys(body).sort(), ["code", "purpose", "send_id", "signature", "timestamp", "to"]);
  assert.equal(body.to, "member@local.example"); assert.equal(calls[0].init.body.includes(f.config.MAIL_RELAY_SECRET), false);
});

for (const [failure, status] of [["AUTH_FAILED",502],["REQUEST_EXPIRED",502],["REPLAY_REJECTED",502],["DAILY_LIMIT_REACHED",503],["PROVIDER_QUOTA_LOW",503],["RELAY_NOT_CONFIGURED",503],["BUSY",503],["INVALID_REQUEST",502],["RELAY_ERROR",502]]) test("relay " + failure + " is a safe unavailable error", async t => {
  const f = authProviderFixture(); let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;return Response.json({ok:false,error:{code:failure,message:f.config.MAIL_RELAY_SECRET}});});
  await reject(sendVerificationEmail(f.config,"member@local.example",code()),status); assert.equal(calls,1);
});

for (const data of [null, [], {}, { ok: "true" }, { ok: true, error: "AUTH_FAILED" }, { ok: false, error: "UNKNOWN" }]) test("malformed relay contract rejected: " + JSON.stringify(data),async t=>{
  t.mock.method(globalThis,"fetch",async()=>Response.json(data)); await reject(sendVerificationEmail(authProviderFixture().config,"member@local.example",code()));
});

test("relay rejects invalid JSON, oversized response, and HTTP error",async t=>{
  const f=authProviderFixture();
  for(const response of [new Response("not-json"),new Response("x".repeat(MAIL_RELAY_LIMITS.responseBytes+1)),Response.json({ok:true},{status:500})]){
    t.mock.method(globalThis,"fetch",async()=>response);await reject(sendVerificationEmail(f.config,"member@local.example",code()));t.mock.restoreAll();
  }
});

test("network failure has no upstream URL, credentials or retry",async t=>{
  const f=authProviderFixture();let calls=0;
  t.mock.method(globalThis,"fetch",async()=>{calls++;throw Error(f.config.MAIL_RELAY_URL+f.config.MAIL_RELAY_SECRET);});
  await reject(sendVerificationEmail(f.config,"member@local.example",code()));assert.equal(calls,1);
});

test("relay timeout aborts the submission once without automatic retry",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});let start;
  const started=new Promise(resolve=>{start=resolve;});let calls=0;
  t.mock.method(globalThis,"fetch",async(_url,init)=>{calls++;start();return new Promise((_resolve,reject)=>init.signal.addEventListener("abort",()=>reject(Error("private timeout detail")),{once:true}));});
  const pending=reject(sendVerificationEmail(authProviderFixture().config,"member@local.example",code()));
  await started;t.mock.timers.tick(MAIL_RELAY_LIMITS.timeoutMs);await pending;assert.equal(calls,1);
});

for(const status of [301,302,303]) test("ContentService " + status + " follows only response GET without signed body",async t=>{
  const f=authProviderFixture(), target=echo(),calls=[];
  t.mock.method(globalThis,"fetch",async(url,init)=>{calls.push({url,init});return calls.length===1?new Response(null,{status,headers:{Location:target}}):Response.json({ok:true});});
  await sendVerificationEmail(f.config,"member@local.example",code());
  assert.equal(calls[1].url,target);assert.equal(calls[1].init.method,"GET");assert.equal(calls[1].init.body,undefined);assert.equal(calls[1].init.headers,undefined);
  assert.equal(calls[0].init.signal,calls[1].init.signal);
});

for(const [index,target] of ["https://attacker.example/macros/echo","http://script.googleusercontent.com/macros/echo","https://script.googleusercontent.com.attacker.example/macros/echo","https://script.googleusercontent.com:444/macros/echo","https://user@script.googleusercontent.com/macros/echo",authProviderFixture().config.MAIL_RELAY_URL,"https://script.googleusercontent.com/other",""].entries()) test("reject unexpected response redirect " + index,async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(null,{status:302,headers:{Location:target}});});
  await reject(sendVerificationEmail(authProviderFixture().config,"member@local.example",code()));assert.equal(calls,1);
});

for(const status of [307,308]) test("never forward signed POST on " + status,async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(null,{status,headers:{Location:echo()}});});
  await reject(sendVerificationEmail(authProviderFixture().config,"member@local.example",code()));assert.equal(calls,1);
});

test("response redirect chain is bounded",async t=>{
  let calls=0;t.mock.method(globalThis,"fetch",async()=>{calls++;return new Response(null,{status:302,headers:{Location:echo()}});});
  await reject(sendVerificationEmail(authProviderFixture().config,"member@local.example",code()));assert.equal(calls,MAIL_RELAY_LIMITS.redirects+1);
});

test("launch budget is 60/80, allows lower limits only and rejects unlimited sentinels",()=>{
  assert.deepEqual(quotaConfig({}),{soft:60,hard:80});assert.equal(EMAIL_LIMITS.dailyWindow,86400);
  for(const env of [{AUTH_EMAIL_HARD_LIMIT:0},{AUTH_EMAIL_HARD_LIMIT:81},{AUTH_EMAIL_HARD_LIMIT:999999},{AUTH_EMAIL_SOFT_LIMIT:61},{AUTH_EMAIL_SOFT_LIMIT:0},{AUTH_EMAIL_HARD_LIMIT:10,AUTH_EMAIL_SOFT_LIMIT:11}])assert.throws(()=>quotaConfig(env),{code:"AUTH_NOT_CONFIGURED"});
  assert.deepEqual(quotaConfig({AUTH_EMAIL_HARD_LIMIT:10}),{soft:10,hard:10});
});

test("actual D1 budget warns at 60 and blocks the 81st reserved send",async()=>{
  const h=await localCaseRuntime();try{
    const now=Math.floor(Date.now()/1000);
    const insert=()=>h.db.prepare("INSERT INTO auth_email_sends(id,challenge_id,email_lookup_hash,source_hash,created_at) VALUES(?,?,?,?,?)").bind(randomUUID(),randomUUID(),randomBytes(32).toString("hex"),randomBytes(32).toString("hex"),now);
    await h.db.batch(Array.from({length:59},insert));assert.equal((await emailBudget(h.db,h.authConfig)).warning,false);
    await h.db.batch([insert()]);assert.equal((await emailBudget(h.db,h.authConfig)).warning,true);
    await h.db.batch(Array.from({length:20},insert));assert.equal((await emailBudget(h.db,h.authConfig)).available,false);
    await expectError(await h.fetch("/api/auth/register/start","POST",{email:"member@local.example",turnstile_token:randomUUID()},loginHeaders()),429,"AUTH_REGISTRATION_UNAVAILABLE");assert.equal(h.provider.mails.length,0);
  }finally{await h.runtime.dispose();}
});

test("failed resend cannot advance verification; retry keeps cooldown and rotates the code",async()=>{
  const h=await localCaseRuntime();try{
    const headers=loginHeaders(),email=randomUUID()+"@local.example";
    const start=await h.fetch("/api/auth/register/start","POST",{email,turnstile_token:randomUUID()},headers), data=(await start.json()).data;
    const bound={...headers,Cookie:responseCookie(start,LOGIN_COOKIE)},before=await h.db.prepare("SELECT * FROM auth_email_challenges WHERE id=?").bind(data.challenge_id).first();
    await h.db.prepare("UPDATE auth_email_sends SET created_at=created_at-61").run();
    h.provider.failures.set(new URL(h.provider.config.MAIL_RELAY_URL).pathname,{status:429});
    await expectError(await h.fetch("/api/auth/register/resend","POST",{challenge_id:data.challenge_id},bound),503,"AUTH_EMAIL_UNAVAILABLE");
    const failure=await h.fetch("/api/auth/register/verify-email","POST",{challenge_id:data.challenge_id,code:h.provider.codeFor(email)},bound);
    await expectError(failure,400,"AUTH_VERIFICATION_FAILED");
    assert.equal((await h.db.prepare("SELECT state FROM auth_email_challenges WHERE id=?").bind(data.challenge_id).first()).state,"pending");
    assert.equal(h.provider.users.size,0);assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM auth_transactions").first()).n,0);
    await expectError(await h.fetch("/api/auth/register/resend","POST",{challenge_id:data.challenge_id},bound),429,"AUTH_RATE_LIMITED");
    h.provider.failures.clear();await h.db.prepare("UPDATE auth_email_sends SET created_at=created_at-61").run();
    assert.equal((await h.fetch("/api/auth/register/resend","POST",{challenge_id:data.challenge_id},bound)).status,202);
    const after=await h.db.prepare("SELECT * FROM auth_email_challenges WHERE id=?").bind(data.challenge_id).first();assert.notEqual(before.code_hash,after.code_hash);
    assert.equal((await h.fetch("/api/auth/register/verify-email","POST",{challenge_id:data.challenge_id,code:h.provider.codeFor(email)},bound)).status,202);
    assert.equal(h.provider.mails.length,2);
  }finally{await h.runtime.dispose();}
});

test("Worker graph excludes legacy Gmail OAuth transport",async()=>{
  const bundle=await build({entryPoints:["src/index.js"],bundle:true,write:false,metafile:true,format:"esm",platform:"browser"});
  assert.equal(Object.keys(bundle.metafile.inputs).some(p=>p.endsWith("/gmail.js")),false);assert.equal(bundle.outputFiles[0].text.includes("oauth2.googleapis.com/token"),false);
});

test("Google registration works without any relay/OAuth sender config and consumes no mail quota",async()=>{
  const h=await localCaseRuntime();try{
    const removals=Object.fromEntries(Object.keys(h.authConfig).filter(n=>n.startsWith("GMAIL_")||n.startsWith("MAIL_RELAY_")).map(n=>[n,undefined]));await h.setAuthConfig(removals);
    const member=await googleMember(h);assert.ok(member.member.member_id);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM auth_email_sends").first()).n,0);assert.equal(h.provider.mails.length,0);
  }finally{await h.runtime.dispose();}
});

test("relay rejection never leaks provider details, logs secrets or advances a challenge",async t=>{
  const h=await localCaseRuntime();try{
    const original=h.provider.fetch.bind(h.provider),messages=[];t.mock.method(console,"warn",(...args)=>messages.push(args.join(" ")));t.mock.method(console,"error",(...args)=>messages.push(args.join(" ")));
    h.provider.fetch=async request=>request.url===h.provider.config.MAIL_RELAY_URL?Response.json({ok:false,error:{code:"AUTH_FAILED",message:h.provider.config.MAIL_RELAY_SECRET+request.url}}):original(request);
    const r=await h.fetch("/api/auth/register/start","POST",{email:randomUUID()+"@local.example",turnstile_token:randomUUID()},loginHeaders()),text=await r.clone().text();
    await expectError(r,502,"AUTH_EMAIL_UNAVAILABLE");assert.equal(text.includes(h.provider.config.MAIL_RELAY_SECRET),false);assert.equal(text.includes(h.provider.config.MAIL_RELAY_URL),false);assert.equal(text.includes("AUTH_FAILED"),false);
    assert.deepEqual((await h.db.prepare("SELECT status FROM auth_email_sends").all()).results,[{status:"failed"}]);assert.deepEqual((await h.db.prepare("SELECT state FROM auth_email_challenges").all()).results,[{state:"pending"}]);assert.equal(h.provider.users.size,0);
    assert.equal(messages.join(" ").includes(h.provider.config.MAIL_RELAY_SECRET),false);
  }finally{await h.runtime.dispose();}
});
