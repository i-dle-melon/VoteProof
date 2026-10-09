// Browser-only disposable contract fixtures. Never shipped with static assets.
import { randomBytes, randomUUID } from "node:crypto";
import { Secret, TOTP } from "otpauth";
export const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j0ioAAAAASUVORK5CYII=", "base64");
export async function memberFixture(page, options = {}) {
  const member = { member_id: "M-" + randomUUID(), nickname: options.nickname ?? "本機會員", player_id: "local-player", status: "active" };
  const secret = new Secret({ size: 20 }), otp = new TOTP({ issuer: "VoteProof", label: "local@example.com", secret });
  const state = { calls: [], puts: 0, authenticated: Boolean(options.authenticated), authDown: Boolean(options.authDown), invalidCode: 0, invalidTotp: 0,
    failCase: 0, revoked: false, recoveryInvalid: false, delay: false, member,
    query: randomBytes(32).toString("base64url"), csrf: randomBytes(32).toString("hex"), password: randomUUID(),
    recoveryCodes: Array.from({ length: 10 }, () => randomBytes(32).toString("base64url")), manual: secret.base32,
    caseId: "VP-20261009-" + "A".repeat(16), providerRequests: [] };
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async value => { globalThis.__copiedFixture = value; } } });
    const original = globalThis.fetch;
    globalThis.__transportFixture = [];
    globalThis.fetch = (path, options) => {
      globalThis.__transportFixture.push({ path, credentials: options?.credentials });
      return original(path, options);
    };
  });
  await page.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => route.fulfill({ contentType: "text/javascript", body:
    `let next=0;const widgets=new Map();globalThis.turnstile={render(container,opts){const id=String(next++);widgets.set(id,opts);container.textContent='本機隔離驗證';queueMicrotask(()=>opts.callback('local-browser-fixture'));return id;},reset(id){queueMicrotask(()=>widgets.get(id).callback('local-browser-fixture'));}};` }));
  await page.route(/^https:\/\/[a-f0-9]{32}\.r2\.cloudflarestorage\.com\//, async route => {
    state.puts++; await route.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, body: "" });
  });
  const session = () => ({ member: state.member, csrf_token: state.csrf, expires_in: options.shortSession ? .2 : 600 });
  state.googleConnected = Boolean(options.googleOnly || options.dual); state.passwordConfigured = !options.googleOnly;
  // WebKit cannot fulfill mocked 302 responses; the isolated provider fixture
  // performs the same full-page return using a fixed local navigation.
  await page.route("https://google-auth.local.example/auth/v1/authorize?provider=google", route => route.fulfill({ contentType: "text/html", body: '<script>location.replace("http://127.0.0.1:4173/#google")</script>' }));
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, body = request.postData() ? request.postDataJSON() : undefined;
    state.calls.push({ path, method: request.method(), body, serialized: request.postData(), headers: request.headers() });
    const reply = (data, status = 200) => route.fulfill({ status, headers: { "Cache-Control": "no-store" }, contentType: "application/json", body: JSON.stringify({ ok: true, data }) });
    const error = (code, status = 400) => route.fulfill({ status, headers: { "Retry-After": "90" }, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message: "private provider message" } }) });
    if (path.startsWith("/api/auth/") || path.startsWith("/api/me/")) {
      if (state.authDown) return error("AUTH_PROVIDER_UNAVAILABLE", 502);
      if (state.delay && request.method() === "POST") await new Promise(resolve => setTimeout(resolve, 200));
    }
    const tx = () => ({ transaction_id: randomUUID(), expires_in: options.expired ? .1 : 600 });
    if (path === "/api/auth/google/start") {
      if (options.googleDown) return error("AUTH_PROVIDER_UNAVAILABLE", 502);
      return reply({ authorize_url: "https://google-auth.local.example/auth/v1/authorize?provider=google", expires_in: 300 });
    }
    if (path === "/api/auth/google/result") return reply({ ...tx(), status: options.googleResult ?? "GOOGLE_PROFILE_REQUIRED", purpose: "login", email: options.googleEmail ?? "google@local.example", provider_already_linked: options.googleResult === "GOOGLE_CONFIRM_REQUIRED", cancel_unlinks_provider: false });
    if (path === "/api/auth/google/confirm") { state.authenticated = true; state.googleConnected = true; return reply(session()); }
    if (path === "/api/auth/google/cancel") return reply({ cancelled: true, provider_unlinked: false });
    if (path === "/api/auth/login-security") return state.authenticated ? reply({ google: { connected: state.googleConnected, email: "google@local.example" }, password: { configured: state.passwordConfigured }, authenticator: { configured: state.passwordConfigured }, current_method: options.googleOnly ? "google" : "password" }) : error("AUTH_REQUIRED", 401);
    if (path === "/api/auth/password/add/start") return reply({ ...tx(), status: "PASSWORD_MFA_REQUIRED", otpauth_uri: otp.toString() }, 202);
    if (path === "/api/auth/password/add/verify") {
      if (state.invalidTotp-- > 0) return error("AUTH_VERIFICATION_FAILED");
      state.passwordConfigured = true; state.authenticated = true; return reply({ ...session(), recovery_codes: state.recoveryCodes });
    }
    if (path === "/api/auth/step-up") return reply({ reauthenticated_until: Date.now() / 1000 + 300 });
    if (path === "/api/auth/password/change/start") return reply(tx(), 202);
    if (path === "/api/auth/password/change") { state.authenticated = false; return reply({ password_changed: true, logged_out: true }); }
    if (path === "/api/auth/me") return state.authenticated && !state.revoked ? reply(session()) : error("AUTH_REQUIRED", 401);
    if (path === "/api/auth/registration-status") return reply({ registration_available: !options.unavailable });
    if (path === "/api/auth/register/start" || path === "/api/auth/register/resend") {
      if (options.rateLimited) return error("AUTH_RATE_LIMITED", 429);
      return reply({ challenge_id: randomUUID(), expires_in: options.expired ? .1 : 600 }, 202);
    }
    if (path === "/api/auth/register/verify-email") return state.invalidCode-- > 0 ? error("AUTH_VERIFICATION_FAILED") : reply({ ...tx(), status: options.emailMatchesGoogle ? "ADD_PASSWORD_REQUIRED" : "EMAIL_VERIFIED" }, 202);
    if (path === "/api/auth/register/credentials") return reply({ ...tx(), status: "MFA_ENROLLMENT_REQUIRED", otpauth_uri: otp.toString() }, 202);
    if (path === "/api/auth/register/verify-totp") {
      if (state.invalidTotp-- > 0) return error("AUTH_VERIFICATION_FAILED");
      state.authenticated = true; return reply({ ...session(), recovery_codes: state.recoveryCodes });
    }
    if (path === "/api/auth/login") {
      if (options.badLogin) return error("AUTH_LOGIN_FAILED", 401);
      if (options.trusted) { state.authenticated = true; return reply(session()); }
      return reply({ ...tx(), status: "MFA_REQUIRED" }, 202);
    }
    if (path === "/api/auth/login/totp") {
      if (state.invalidTotp-- > 0) return error("AUTH_VERIFICATION_FAILED");
      state.authenticated = true; return reply(session());
    }
    if (path === "/api/auth/logout") { state.authenticated = false; return reply({ logged_out: true }); }
    if (path === "/api/auth/recovery/password/start") return reply(tx(), 202);
    if (path === "/api/auth/recovery/password/finish") {
      if (state.recoveryInvalid) return error("AUTH_VERIFICATION_FAILED");
      state.authenticated = false; return reply({ recovered: true, login_required: true });
    }
    if (path.startsWith("/api/me/")) {
      if (state.revoked) return error("AUTH_REQUIRED", 401);
      if (path === "/api/me/profile") { Object.assign(member, body); return reply({ member }); }
      if (path === "/api/me/points") return reply({ total_points: 123, tier: { tier_id: "bronze", name: "青銅" },
        next_tier: options.unconfigured ? null : { tier_id: "silver", name: "白銀" }, points_to_next_tier: 77,
        tier_progress: 23, tier_configuration_ready: !options.unconfigured });
      if (path === "/api/me/cases") return reply({ cases: url.searchParams.has("cursor") ? [] : [{ case_id: state.caseId, vote_date: "2026-10-09", status: "approved" }], next_cursor: url.searchParams.has("cursor") ? null : "localCursor" });
      if (path.startsWith("/api/me/cases/")) return reply({ case_id: state.caseId, campaign_id: "LOCAL", vote_type: "Solo", vote_date: "2026-10-09", status: "approved", query_key_hash: "private", object_key: "private" });
    }
    if (path === "/api/campaigns") return reply({ campaigns: [{ campaign_id: "LOCAL", name: "本機活動", category: "local", status: "active",
      campaign_timezone: "UTC", vote_start_date: "2000-01-01", vote_end_date: "2099-12-31" }] });
    if (path === "/api/leaderboards") return reply({ leaderboards: [] });
    if (path === "/api/uploads/prepare") {
      const session_id = randomUUID(); return reply({ session_id, expires_in: 300, uploads: body.files.map(file => ({
        key: `proofs/staging/2026/10/09/${session_id}/${randomUUID()}.png`, method: "PUT",
        upload_url: `https://${randomBytes(16).toString("hex")}.r2.cloudflarestorage.com/local/${randomUUID()}`, headers: { "Content-Type": file.type } })) });
    }
    if (path === "/api/uploads/complete") return reply({ session_id: body.session_id, files: [] });
    if (path === "/api/cases") {
      if (state.failCase-- > 0) return route.abort();
      return reply({ case_id: state.caseId, query_key: state.query, status: "pending" }, 201);
    }
    if (path === "/api/cases/" + state.caseId && request.headers()["x-case-query-key"] === state.query) return reply({ case_id: state.caseId, status: "pending", vote_date: "2026-10-09", campaign_id: "LOCAL", vote_type: "Solo" });
    return error("NOT_FOUND", 404);
  });
  page.on("request", request => {
    const host = new URL(request.url()).hostname;
    if (host.endsWith("supabase.co") || host.endsWith("googleapis.com")) state.providerRequests.push(host);
  });
  return state;
}
