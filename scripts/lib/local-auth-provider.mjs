// Developer-only upstream fixture. All credentials/passwords are ephemeral.
import { randomBytes, randomUUID, createHash } from "node:crypto";
export function authProviderFixture() {
  const users = new Map(), mails = [], calls = [], tokens = [], failures = new Map(), oauthCodes = new Map(), accessUsers = new Map();
  const config = { SUPABASE_URL: "https://local-auth.supabase.example", SUPABASE_PUBLISHABLE_KEY: randomBytes(32).toString("hex"), SUPABASE_SECRET_KEY: randomBytes(32).toString("hex"),
    GMAIL_CLIENT_ID: randomBytes(32).toString("hex"), GMAIL_CLIENT_SECRET: randomBytes(32).toString("hex"), GMAIL_REFRESH_TOKEN: randomBytes(32).toString("hex"), GMAIL_SENDER_EMAIL: "sender@local.example", GMAIL_SENDER_NAME: "VoteProof" };
  return { config, users, mails, calls, tokens, failures,
    oauth(authorizeUrl, email, options = {}) {
      const url = new URL(authorizeUrl); email = email.trim().toLowerCase();
      let user = [...users.values()].find(u => u.email === email);
      if (options.newSubject) user = null;
      if (!user) { user = { id: randomUUID(), email, confirmed: true, identities: [] }; users.set(user.id, user); }
      user.identities ??= [];
      if (!user.identities.some(i => i.provider === "google")) user.identities.push({ provider: "google", id: randomUUID(), user_id: user.id, identity_data: { sub: randomUUID(), email, email_verified: !options.unverified } });
      const code = randomBytes(32).toString("base64url");
      oauthCodes.set(code, { user, challenge: url.searchParams.get("code_challenge") });
      const callback = new URL(url.searchParams.get("redirect_to")); callback.searchParams.set("code", code);
      return { user, code, path: callback.pathname + callback.search };
    },
    codeFor(email) { return mails.filter(m => m.email === email.trim().toLowerCase()).at(-1)?.code; },
    async fetch(request) {
      const url = new URL(request.url), path = url.pathname;
      if (![new URL(config.SUPABASE_URL).origin, "https://oauth2.googleapis.com", "https://gmail.googleapis.com"].includes(url.origin)) return null;
      const text = await request.text(), body = request.headers.get("Content-Type")?.includes("application/x-www-form-urlencoded") ? Object.fromEntries(new URLSearchParams(text)) : JSON.parse(text || "{}");
      calls.push({ path, method: request.method, headers: Object.fromEntries(request.headers), body });
      const failure = failures.get(path); if (failure) { if (failure.once) failures.delete(path); return Response.json({ message: "unsafe provider information" }, { status: failure.status }); }
      if (url.origin === "https://oauth2.googleapis.com") {
        if (body.client_id !== config.GMAIL_CLIENT_ID || body.client_secret !== config.GMAIL_CLIENT_SECRET || body.refresh_token !== config.GMAIL_REFRESH_TOKEN || body.grant_type !== "refresh_token") return Response.json({}, { status: 401 });
        const token = randomBytes(32).toString("base64url"); tokens.push(token); return Response.json({ access_token: token, expires_in: 3600, token_type: "Bearer" });
      }
      if (url.origin === "https://gmail.googleapis.com") {
        if (!tokens.includes(request.headers.get("Authorization")?.slice(7))) return Response.json({}, { status: 401 });
        const raw = Buffer.from(body.raw, "base64url").toString("utf8"), [headers, encoded] = raw.split("\r\n\r\n"), message = Buffer.from(encoded, "base64").toString("utf8");
        mails.push({ email: headers.match(/To: ([^\r\n]+)/)[1], code: message.match(/\d{6}/)[0], raw }); return Response.json({ id: randomUUID() });
      }
      const admin = path.startsWith("/auth/v1/admin/"), key = request.headers.get("apikey");
      if (key !== (admin ? config.SUPABASE_SECRET_KEY : config.SUPABASE_PUBLISHABLE_KEY)) return Response.json({}, { status: 401 });
      const publicUser = user => ({ id: user.id, email: user.email, email_confirmed_at: user.confirmed ? new Date().toISOString() : null, app_metadata: user.app_metadata, identities: user.identities ?? [] });
      if (path === "/auth/v1/user") { const user = accessUsers.get(request.headers.get("Authorization")?.slice(7)); return Response.json(user ? publicUser(user) : {}, { status: user ? 200 : 401 }); }
      if (path === "/auth/v1/token") {
        if (url.searchParams.get("grant_type") === "pkce") {
          const flow = oauthCodes.get(body.auth_code);
          if (!flow || createHash("sha256").update(body.code_verifier ?? "").digest("base64url") !== flow.challenge) return Response.json({}, { status: 400 });
          oauthCodes.delete(body.auth_code);
          const access = randomBytes(32).toString("base64url"), refresh = randomBytes(32).toString("base64url"); tokens.push(access, refresh); accessUsers.set(access, flow.user);
          return Response.json({ user: publicUser(flow.user), access_token: access, refresh_token: refresh, provider_token: randomBytes(32).toString("base64url") });
        }
        const user = [...users.values()].find(u => u.email === body.email && u.password === body.password);
        if (!user) return Response.json({}, { status: 400 });
        const access = randomBytes(32).toString("base64url"), refresh = randomBytes(32).toString("base64url"); tokens.push(access, refresh);
        return Response.json({ user: publicUser(user), access_token: access, refresh_token: refresh });
      }
      if (path === "/auth/v1/admin/users" && request.method === "POST") {
        if ([...users.values()].some(u => u.email === body.email)) return Response.json({}, { status: 422 });
        const user = { id: randomUUID(), email: body.email, password: body.password, confirmed: body.email_confirm === true, app_metadata: body.app_metadata };
        users.set(user.id, user); return Response.json(publicUser(user));
      }
      const id = path.split("/").at(-1), user = users.get(id);
      if (!user) return Response.json({}, { status: 404 });
      if (request.method === "DELETE") { users.delete(id); return Response.json({}); }
      if (request.method === "PUT") { user.password = body.password; return Response.json(publicUser(user)); }
      return Response.json({}, { status: 404 });
    } };
}
