import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { build } from "esbuild";
import { localCaseRuntime, guestBody } from "../scripts/lib/local-case-runtime.mjs";
import { begin, finish, login, loginHeaders, responseCookie, expectError } from "../scripts/lib/local-auth-runtime.mjs";
import { LOGIN_COOKIE } from "../src/lib/auth-session.js";
import { sourceHash } from "../src/lib/auth-identity.js";
import { emailBudget } from "../src/lib/registration-quota.js";
let local; before(async () => { local = await localCaseRuntime(); }); after(async () => { await local?.runtime.dispose(); });
const secret = () => randomBytes(24).toString("base64url"), email = () => randomUUID() + "@local.example";
async function start(h = local, address = email(), headers = loginHeaders()) {
  const r = await h.fetch("/api/auth/register/start", "POST", { email: address, turnstile_token: secret() }, headers);
  assert.equal(r.status, 202); const data = (await r.json()).data;
  return { ...data, email: address.trim().toLowerCase(), response: r, headers: { ...headers, Cookie: responseCookie(r, LOGIN_COOKIE) } };
}
async function verified(h = local, address = email()) {
  const c = await start(h, address), r = await h.fetch("/api/auth/register/verify-email", "POST", { challenge_id: c.challenge_id, code: h.provider.codeFor(address) }, c.headers);
  assert.equal(r.status, 202); return { ...c, ...(await r.json()).data, headers: { ...c.headers, Cookie: responseCookie(r, LOGIN_COOKIE) } };
}
const credentials = (h, v, pw = secret()) => h.fetch("/api/auth/register/credentials", "POST", { transaction_id: v.transaction_id, password: pw }, v.headers);
async function seedBudget(h, count, age = 100, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  await h.db.batch(Array.from({ length: count }, () => h.db.prepare("INSERT INTO auth_email_sends(id,challenge_id,email_lookup_hash,source_hash,created_at,status) VALUES(?,?,?,?,?,'reserved')")
    .bind(randomUUID(), randomUUID(), extra.emailHash ?? randomBytes(32).toString("hex"), extra.sourceHash ?? randomBytes(32).toString("hex"), now - age)));
}
test("registration normalizes email and stores only HMAC verifier and encrypted email", async () => {
  const c = await start(local, "  " + email().toUpperCase() + "  "), code = local.provider.codeFor(c.email);
  const row = await local.db.prepare("SELECT * FROM auth_email_challenges WHERE id=?").bind(c.challenge_id).first();
  assert.equal(row.expires_at - row.created_at, 600); assert.equal(row.email_lookup_hash, await local.emailHash(c.email));
  assert.equal(row.code_hash.length, 64); assert.equal(JSON.stringify(row).includes(code), false); assert.equal(JSON.stringify(row).includes(c.email), false);
  assert.equal(row.attempts, 0); assert.equal(c.response.headers.get("cache-control"), "no-store");
});
test("invalid Turnstile prevents Gmail and registration persistence", async () => {
  const h = await localCaseRuntime({ turnstileService: () => Response.json({ success: false }) });
  try { await expectError(await h.fetch("/api/auth/register/start", "POST", { email: email(), turnstile_token: secret() }, loginHeaders()), 403, "TURNSTILE_INVALID"); assert.equal(h.provider.mails.length, 0); }
  finally { await h.runtime.dispose(); }
});
test("verification requires the same browser and consumes challenge once", async () => {
  const c = await start(), body = { challenge_id: c.challenge_id, code: local.provider.codeFor(c.email) };
  await expectError(await local.fetch("/api/auth/register/verify-email", "POST", body, { ...c.headers, Cookie: LOGIN_COOKIE + "=" + randomBytes(32).toString("base64url") }), 400, "AUTH_VERIFICATION_FAILED");
  assert.equal((await local.fetch("/api/auth/register/verify-email", "POST", body, c.headers)).status, 202);
  await expectError(await local.fetch("/api/auth/register/verify-email", "POST", body, c.headers), 400, "AUTH_VERIFICATION_FAILED");
});
test("email code expires after ten minutes", async () => {
  const c = await start(); await local.db.prepare("UPDATE auth_email_challenges SET created_at=?,expires_at=? WHERE id=?").bind(Math.floor(Date.now()/1000)-601, Math.floor(Date.now()/1000)-1, c.challenge_id).run();
  await expectError(await local.fetch("/api/auth/register/verify-email", "POST", { challenge_id: c.challenge_id, code: local.provider.codeFor(c.email) }, c.headers), 400, "AUTH_VERIFICATION_FAILED");
});
test("five bad code attempts permanently close that challenge", async () => {
  const c = await start(), wrong = String((Number(local.provider.codeFor(c.email)) + 1) % 1000000).padStart(6,"0");
  for (let i=0;i<5;i++) await expectError(await local.fetch("/api/auth/register/verify-email", "POST", { challenge_id:c.challenge_id,code:wrong },c.headers),400,"AUTH_VERIFICATION_FAILED");
  await expectError(await local.fetch("/api/auth/register/verify-email", "POST", { challenge_id:c.challenge_id,code:local.provider.codeFor(c.email) },c.headers),400,"AUTH_VERIFICATION_FAILED");
  assert.equal((await local.db.prepare("SELECT attempts FROM auth_email_challenges WHERE id=?").bind(c.challenge_id).first()).attempts,5);
});
test("resend cooldown applies to start and explicit resend", async () => {
  const c = await start();
  await expectError(await local.fetch("/api/auth/register/start","POST",{email:c.email,turnstile_token:secret()},loginHeaders()),429,"AUTH_RATE_LIMITED");
  await expectError(await local.fetch("/api/auth/register/resend","POST",{challenge_id:c.challenge_id},c.headers),429,"AUTH_RATE_LIMITED");
  await local.db.prepare("UPDATE auth_email_sends SET created_at=created_at-61 WHERE challenge_id=?").bind(c.challenge_id).run();
  assert.equal((await local.fetch("/api/auth/register/resend","POST",{challenge_id:c.challenge_id},c.headers)).status,202);
});
test("per-email rolling thirty-minute maximum is five despite cooldown passage", async () => {
  const address=email();
  for(let i=0;i<5;i++){await start(local,address);await local.db.prepare("UPDATE auth_email_sends SET created_at=? WHERE email_lookup_hash=?").bind(Math.floor(Date.now()/1000)-61,await local.emailHash(address)).run();}
  await expectError(await local.fetch("/api/auth/register/start","POST",{email:address,turnstile_token:secret()},loginHeaders()),429,"AUTH_RATE_LIMITED");
});
test("source quota is persistent/pseudonymous and allows sixty sends per thirty minutes", async () => {
  const h=await localCaseRuntime(),headers=loginHeaders();try{
    const hash=await sourceHash(h.authConfig,new Request("https://voteproof.example",{headers}));await seedBudget(h,60,100,{sourceHash:hash});
    await expectError(await h.fetch("/api/auth/register/start","POST",{email:email(),turnstile_token:secret()},headers),429,"AUTH_RATE_LIMITED");
    assert.equal(JSON.stringify((await h.db.prepare("SELECT source_hash FROM auth_email_sends").all()).results).includes(headers["CF-Connecting-IP"]),false);
  }finally{await h.runtime.dispose()}
});
test("rolling 24h soft/hard limits hide usage and do not block Guest or existing login", async () => {
  const h=await localCaseRuntime();try{
    const m=await login(h);await h.setAuthConfig({AUTH_EMAIL_SOFT_LIMIT:"2",AUTH_EMAIL_HARD_LIMIT:"3"});await start(h);await start(h);
    assert.equal((await emailBudget(h.db,h.authConfig)).warning,true);
    const r=await h.fetch("/api/auth/registration-status"),data=(await r.json()).data;assert.deepEqual(Object.keys(data).sort(),["registration_available","retry_after"]);assert.equal(data.registration_available,false);
    await expectError(await h.fetch("/api/auth/register/start","POST",{email:email(),turnstile_token:secret()},loginHeaders()),429,"AUTH_REGISTRATION_UNAVAILABLE");
    assert.equal((await login(h,m)).response.status,200);for(const path of ["/api/health","/api/campaigns","/api/leaderboards"])assert.equal((await h.fetch(path)).status,200);
    assert.equal((await h.fetch("/api/cases","POST",guestBody(await h.upload()))).status,201);
  }finally{await h.runtime.dispose()}
});
test("exactly-24h-old reservations do not count; recent ones survive a midnight boundary", async()=>{
  const h=await localCaseRuntime();try{await h.setAuthConfig({AUTH_EMAIL_HARD_LIMIT:"2",AUTH_EMAIL_SOFT_LIMIT:"1"});await seedBudget(h,2,86401);assert.equal((await emailBudget(h.db,h.authConfig)).available,true);
  await seedBudget(h,2,100);assert.equal((await emailBudget(h.db,h.authConfig)).available,false);}finally{await h.runtime.dispose()}
});
test("failed relay delivery still consumes safety reservation",async()=>{
  const h=await localCaseRuntime();try{h.provider.failures.set(new URL(h.provider.config.MAIL_RELAY_URL).pathname,{status:429});await expectError(await h.fetch("/api/auth/register/start","POST",{email:email(),turnstile_token:secret()},loginHeaders()),503,"AUTH_EMAIL_UNAVAILABLE");
  assert.equal((await h.db.prepare("SELECT status FROM auth_email_sends").first()).status,"failed");}finally{await h.runtime.dispose()}
});
test("email verification precedes confirmed Supabase create and no passwords enter D1",async()=>{
  const v=await verified(),pw=secret();assert.equal(local.provider.calls.filter(c=>c.path==="/auth/v1/admin/users"&&c.body.email===v.email).length,0);
  assert.equal((await credentials(local,v,pw)).status,202);
  const call=local.provider.calls.find(c=>c.path==="/auth/v1/admin/users"&&c.body.email===v.email);assert.equal(call.body.email_confirm,true);
  const rows=(await local.db.prepare("SELECT payload FROM auth_transactions").all()).results;assert.equal(JSON.stringify(rows).includes(pw),false);
});
test("unverified transaction cannot call Supabase create",async()=>{
  const c=await start(),before=local.provider.users.size;
  await expectError(await credentials(local,{transaction_id:c.challenge_id,headers:c.headers}),400,"AUTH_VERIFICATION_FAILED");assert.equal(local.provider.users.size,before);
});
test("incomplete enrollment and direct Supabase tokens cannot authorize Member APIs",async()=>{
  const setup=await begin(local);await expectError(await local.fetch("/api/auth/login","POST",{email:setup.email,password:setup.password},loginHeaders()),401,"AUTH_LOGIN_FAILED");
  await expectError(await local.fetch("/api/auth/me","GET",undefined,{Authorization:"Bearer "+secret(),Cookie:setup.cookie}),401,"AUTH_REQUIRED");
  assert.equal((await local.db.prepare("SELECT member_id FROM auth_identities WHERE email_lookup_hash=?").bind(setup.email_hash).first()),null);
});
test("local enrollment failure compensates only newly-created Supabase user",async()=>{
  const h=await localCaseRuntime();try{const v=await verified(h);await h.db.prepare("CREATE TRIGGER fixture_enrollment_failure BEFORE INSERT ON auth_transactions WHEN NEW.kind='register' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    await expectError(await credentials(h,v),503,"AUTH_SERVICE_UNAVAILABLE");assert.equal(h.provider.users.size,0);assert.equal((await h.db.prepare("SELECT state FROM auth_enrollments").first()).state,"deleted");
    assert.equal(h.provider.calls.filter(c=>c.method==="DELETE").length,1);
  }finally{await h.runtime.dispose()}
});
test("compensation failure preserves durable cleanup claim and safe API error",async()=>{
  const h=await localCaseRuntime();try{const v=await verified(h);await h.db.prepare("CREATE TRIGGER fixture_enrollment_failure BEFORE INSERT ON auth_transactions WHEN NEW.kind='register' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    const original=h.provider.fetch;h.provider.fetch=async request=>request.method==="DELETE"?Response.json({message:secret()},{status:503}):original(request);
    const body=await expectError(await credentials(h,v),503,"AUTH_SERVICE_UNAVAILABLE");assert.equal(Object.keys(body.error).length,2);assert.equal((await h.db.prepare("SELECT state FROM auth_enrollments").first()).state,"cleanup_failed");
  }finally{await h.runtime.dispose()}
});
test("explicit Supabase create failure cannot delete somebody else's account",async()=>{
  const h=await localCaseRuntime();try{const v=await verified(h);h.provider.failures.set("/auth/v1/admin/users",{status:422});await expectError(await credentials(h,v),400,"AUTH_VERIFICATION_FAILED");assert.equal(h.provider.calls.some(c=>c.method==="DELETE"),false);assert.equal((await h.db.prepare("SELECT state FROM auth_enrollments").first()).state,"deleted");}finally{await h.runtime.dispose()}
});
test("concurrent credential completion creates one provider user and one enrollment",async()=>{
  const h=await localCaseRuntime();try{const v=await verified(h),results=await Promise.all([credentials(h,v),credentials(h,v)]);assert.deepEqual(results.map(r=>r.status).sort(),[202,400]);assert.equal(h.provider.users.size,1);assert.equal((await h.db.prepare("SELECT count(*) n FROM auth_enrollments").first()).n,1);}finally{await h.runtime.dispose()}
});
test("same normalized email in independent verified transactions cannot create duplicate users",async()=>{
  const h=await localCaseRuntime();try{const address=email(),a=await verified(h,address);await h.db.prepare("UPDATE auth_email_sends SET created_at=created_at-61").run();const b=await verified(h,"  "+address.toUpperCase()+"  ");
    const rs=await Promise.all([credentials(h,a),credentials(h,b)]);assert.deepEqual(rs.map(r=>r.status).sort(),[202,400]);assert.equal(h.provider.users.size,1);
  }finally{await h.runtime.dispose()}
});
test("Supabase tokens/credentials never escape the VoteProof auth response",async()=>{
  const m=await login(local),r=await local.fetch("/api/auth/login","POST",{email:m.email,password:m.password},{...loginHeaders(),Cookie:m.deviceCookie}),returned=await r.text();
  assert.equal(r.status,200);for(const value of [...local.provider.tokens,...Object.values(local.provider.config).filter(v=>v.length>40)])assert.equal(returned.includes(value),false);
});
test("active Worker module graph contains no password KDF or historical implementation",async()=>{
  const result=await build({entryPoints:["src/index.js"],bundle:true,write:false,metafile:true,format:"esm",platform:"browser"});
  assert.equal(Object.keys(result.metafile.inputs).some(p=>/legacy-password-kdf|\/(?:scrypt|pbkdf2|bcrypt)\./i.test(p)),false);
});
test("missing Supabase/relay settings fail closed while Guest and public remain available",async()=>{
  const h=await localCaseRuntime();try{const original=h.authConfig;
    for(const name of ["SUPABASE_URL","SUPABASE_PUBLISHABLE_KEY","SUPABASE_SECRET_KEY","MAIL_RELAY_URL","MAIL_RELAY_SECRET"]){await h.setAuthConfig({...original,[name]:undefined});assert.equal((await h.fetch("/api/auth/registration-status")).status,200);assert.equal((await h.fetch("/api/health")).status,200);await expectError(await h.fetch("/api/auth/register/start","POST",{email:email(),turnstile_token:secret()},loginHeaders()),503,"AUTH_NOT_CONFIGURED");}
  }finally{await h.runtime.dispose()}
});
test("password recovery requires TOTP plus unused recovery code and hides invalid proof at start",async()=>{
  const m=await login(local);for(const body of [{email:m.email,recovery_code:m.recovery_codes[0]}, {email:email(),code:"000000",recovery_code:secret()}]){
    const r=await local.fetch("/api/auth/recovery/password/start","POST",body,loginHeaders());assert.equal(r.status,202);const d=(await r.json()).data;
    await expectError(await local.fetch("/api/auth/recovery/password/finish","POST",{transaction_id:d.transaction_id,new_password:secret()},{...loginHeaders(),Cookie:responseCookie(r,LOGIN_COOKIE)}),400,"AUTH_VERIFICATION_FAILED");
  }
});
test("provider failure during reset leaves sessions/devices revoked and retry is durable",async()=>{
  const h=await localCaseRuntime();try{
    const m=await login(h),r=await h.fetch("/api/auth/recovery/password/start","POST",{email:m.email,code:m.otp.generate({timestamp:Date.now()+30000}),recovery_code:m.recovery_codes[0]},loginHeaders());assert.equal(r.status,202);const tx=(await r.json()).data;
    const identity=await h.db.prepare("SELECT provider_subject FROM auth_identities WHERE member_id=?").bind(m.member.member_id).first(),path="/auth/v1/admin/users/"+identity.provider_subject;
    h.provider.failures.set(path,{status:503,once:true});const body={transaction_id:tx.transaction_id,new_password:secret()},headers={...loginHeaders(),Cookie:responseCookie(r,LOGIN_COOKIE)};
    await expectError(await h.fetch("/api/auth/recovery/password/finish","POST",body,headers),502,"AUTH_PROVIDER_UNAVAILABLE");
    await expectError(await h.fetch("/api/auth/me","GET",undefined,m.headers),401,"AUTH_REQUIRED");assert.equal((await h.db.prepare("SELECT count(*) n FROM trusted_devices WHERE member_id=? AND revoked_at IS NULL").bind(m.member.member_id).first()).n,0);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM recovery_codes WHERE member_id=? AND used_at IS NOT NULL").bind(m.member.member_id).first()).n,1);
    assert.equal((await h.fetch("/api/auth/recovery/password/finish","POST",body,headers)).status,200);assert.equal((await h.db.prepare("SELECT status FROM auth_password_operations").first()).status,"complete");
  }finally{await h.runtime.dispose()}
});
test("auth routes enforce POST/Origin and registration-status is no-store",async()=>{
  for(const path of ["register/resend","register/verify-email","register/credentials"]){await expectError(await local.fetch("/api/auth/"+path),405,"METHOD_NOT_ALLOWED");await expectError(await local.fetch("/api/auth/"+path,"POST",{}, {...loginHeaders(),Origin:"https://attacker.example"}),403,"CSRF_REJECTED");}
  assert.equal((await local.fetch("/api/auth/registration-status")).headers.get("cache-control"),"no-store");
});
test("concurrent email sends at hard boundary cannot exceed durable budget",async()=>{
  const h=await localCaseRuntime();try{await h.setAuthConfig({AUTH_EMAIL_HARD_LIMIT:"3",AUTH_EMAIL_SOFT_LIMIT:"2"});await seedBudget(h,2);
    const rs=await Promise.all([email(),email()].map(address=>h.fetch("/api/auth/register/start","POST",{email:address,turnstile_token:secret()},loginHeaders())));
    assert.deepEqual(rs.map(r=>r.status).sort(),[202,429]);assert.equal(h.provider.mails.length,1);assert.equal((await h.db.prepare("SELECT count(*) n FROM auth_email_sends").first()).n,3);
  }finally{await h.runtime.dispose()}
});
test("expired pending enrollment cannot activate despite a valid TOTP transaction",async()=>{
  const h=await localCaseRuntime();try{const s=await begin(h),now=Math.floor(Date.now()/1000);
    await h.db.prepare("UPDATE auth_enrollments SET created_at=?,expires_at=? WHERE totp_transaction_id=?").bind(now-1000,now-1,s.id).run();
    await expectError(await finish(h,s),400,"AUTH_VERIFICATION_FAILED");assert.equal((await h.db.prepare("SELECT count(*) n FROM members").first()).n,0);
  }finally{await h.runtime.dispose()}
});
test("D1 failure after provider password update retains fail-closed lock until authorized retry",async()=>{
  const h=await localCaseRuntime();try{const m=await login(h),r=await h.fetch("/api/auth/recovery/password/start","POST",{email:m.email,code:m.otp.generate({timestamp:Date.now()+30000}),recovery_code:m.recovery_codes[0]},loginHeaders());
    const tx=(await r.json()).data,body={transaction_id:tx.transaction_id,new_password:secret()},headers={...loginHeaders(),Cookie:responseCookie(r,LOGIN_COOKIE)};
    await h.db.prepare("CREATE TRIGGER fixture_password_commit BEFORE UPDATE ON auth_password_operations WHEN NEW.status='complete' BEGIN SELECT RAISE(ABORT,'fixture'); END").run();
    await expectError(await h.fetch("/api/auth/recovery/password/finish","POST",body,headers),503,"AUTH_SERVICE_UNAVAILABLE");
    await expectError(await h.fetch("/api/auth/login","POST",{email:m.email,password:body.new_password},{...loginHeaders(),Cookie:m.deviceCookie}),401,"AUTH_LOGIN_FAILED");
    await h.db.prepare("DROP TRIGGER fixture_password_commit").run();assert.equal((await h.fetch("/api/auth/recovery/password/finish","POST",body,headers)).status,200);
  }finally{await h.runtime.dispose()}
});
test("stale failed password operation can be superseded only by new TOTP plus another unused code",async()=>{
  const h=await localCaseRuntime();try{const m=await login(h),r=await h.fetch("/api/auth/recovery/password/start","POST",{email:m.email,code:m.otp.generate({timestamp:Date.now()+30000}),recovery_code:m.recovery_codes[0]},loginHeaders());
    const tx=(await r.json()).data,subject=(await h.db.prepare("SELECT provider_subject FROM auth_identities").first()).provider_subject;h.provider.failures.set("/auth/v1/admin/users/"+subject,{status:503,once:true});
    await expectError(await h.fetch("/api/auth/recovery/password/finish","POST",{transaction_id:tx.transaction_id,new_password:secret()},{...loginHeaders(),Cookie:responseCookie(r,LOGIN_COOKIE)}),502,"AUTH_PROVIDER_UNAVAILABLE");
    // Disposable fixture models the stored state after ten minutes passed.
    const now=Math.floor(Date.now()/1000);await h.db.batch([h.db.prepare("UPDATE auth_transactions SET created_at=?,expires_at=? WHERE id=?").bind(now-1000,now-1,tx.transaction_id),h.db.prepare("UPDATE member_credentials SET last_used_time_step=? WHERE member_id=?").bind(Math.floor(Date.now()/30000)-2,m.member.member_id)]);
    const fresh=await h.fetch("/api/auth/recovery/password/start","POST",{email:m.email,code:m.otp.generate(),recovery_code:m.recovery_codes[1]},loginHeaders()),next=(await fresh.json()).data;
    assert.equal((await h.fetch("/api/auth/recovery/password/finish","POST",{transaction_id:next.transaction_id,new_password:secret()},{...loginHeaders(),Cookie:responseCookie(fresh,LOGIN_COOKIE)})).status,200);
    assert.deepEqual((await h.db.prepare("SELECT status FROM auth_password_operations ORDER BY rowid").all()).results.map(row=>row.status),["superseded","complete"]);
    assert.equal((await h.db.prepare("SELECT count(*) n FROM recovery_codes WHERE used_at IS NOT NULL").first()).n,2);
  }finally{await h.runtime.dispose()}
});
