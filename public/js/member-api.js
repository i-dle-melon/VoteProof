import { PublicError } from "./api.js";

// Only Worker-relative endpoints. Cookie credentials and CSRF never reach R2
// or a provider. The secure session cookie remains inaccessible to JavaScript.
export class MemberSession {
  #member = null;
  #csrf = "";
  #revision = 0;
  #expiry;
  constructor({ fetcher = (...args) => fetch(...args), changed = () => {} } = {}) {
    this.fetcher = fetcher; this.changed = changed;
  }
  get member() { return this.#member; }
  clear() {
    clearTimeout(this.#expiry); this.#member = null; this.#csrf = "";
    this.#revision++; this.changed(null);
  }
  accept(data) {
    if (!data?.member || typeof data.member.member_id !== "string" || data.member.status !== "active" ||
        !/^[a-f0-9]{64}$/.test(data.csrf_token ?? "")) throw new PublicError("SERVICE_UNAVAILABLE");
    clearTimeout(this.#expiry);
    // Explicit allowlist: ignore identity/provider/storage internals even if
    // an upstream response accidentally includes additional fields.
    const { member_id, nickname, player_id } = data.member;
    this.#member = Object.freeze({ member_id, nickname, player_id });
    this.#csrf = data.csrf_token; this.#revision++;
    const seconds = data.expires_in ?? data.expires_at - Date.now() / 1000;
    if (Number.isFinite(seconds) && seconds > 0) {
      // Browser timers cannot exceed a signed 32-bit millisecond interval.
      const expire = () => {
        const remaining = deadline - Date.now();
        if (remaining <= 0) this.clear(); else this.#expiry = setTimeout(expire, Math.min(remaining, 2147483647));
      };
      const deadline = Date.now() + seconds * 1000;
      this.#expiry = setTimeout(expire, Math.min(seconds * 1000, 2147483647));
      this.#expiry?.unref?.();
    }
    this.changed(this.#member);
  }
  updateProfile(member) {
    if (member?.member_id !== this.#member?.member_id) throw new PublicError("AUTH_IDENTITY_CHANGED");
    this.#member = Object.freeze({ member_id: member.member_id, nickname: member.nickname, player_id: member.player_id });
    this.changed(this.#member);
  }
  async request(path, { method = "GET", body, headers = {}, signal } = {}) {
    if (!/^\/api\/(?:auth\/[a-z/-]+|me\/(?:profile|points|cases(?:\/[A-Z0-9-]+)?)(?:\?[^#]*)?|cases)$/.test(path))
      throw new PublicError("INVALID_AUTH_REQUEST");
    const revision = this.#revision;
    let response;
    try {
      response = await this.fetcher(path, { method, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
        headers: { ...headers, ...(method === "GET" ? {} : { "X-VoteProof-Request": "1", ...(this.#csrf ? { "X-CSRF-Token": this.#csrf } : {}) }),
          ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
    } catch { throw new PublicError(signal?.aborted ? "REQUEST_CANCELLED" : "NETWORK_ERROR"); }
    let result;
    try { result = await response.json(); } catch { throw new PublicError("SERVICE_UNAVAILABLE", response.status); }
    if (!response.ok || result?.ok !== true) {
      const code = result?.error?.code ?? "SERVICE_UNAVAILABLE";
      if (["AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(code) && revision === this.#revision) this.clear();
      const error = new PublicError(code, response.status);
      const retry = Number(response.headers.get("Retry-After"));
      error.retryAfter = Number.isFinite(retry) && retry > 0 ? Math.min(retry, 86400) : 0;
      throw error;
    }
    return result.data;
  }
  async refresh() {
    const revision = this.#revision, data = await this.request("/api/auth/me");
    if (revision === this.#revision) this.accept(data);
    return data;
  }
  // Capture the owner at logical submission start. Recheck the actual cookie
  // owner before EVERY case attempt (including cross-tab login/logout). A
  // failed member submission can never silently become Guest or another user.
  caseSender() {
    const owner = this.#member?.member_id;
    if (!owner) throw new PublicError("AUTH_REQUIRED");
    return async (path, options) => {
      if (this.#member?.member_id !== owner) throw new PublicError("AUTH_IDENTITY_CHANGED");
      const data = await this.refresh();
      if (data.member.member_id !== owner || this.#member?.member_id !== owner) throw new PublicError("AUTH_IDENTITY_CHANGED");
      return this.request(path, options);
    };
  }
}

export function emailValue(value) {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]{1,64}@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(email) ||
      email.split("@")[0].startsWith(".") || email.split("@")[0].endsWith(".") || email.includes("..")) throw new PublicError("EMAIL_FORMAT");
  return email;
}
export function passwordValue(value, confirmation) {
  if (!value.isWellFormed() || [...value].length < 12 || [...value].length > 128 || /\u0000/.test(value)) throw new PublicError("PASSWORD_FORMAT");
  if (confirmation !== undefined && value !== confirmation) throw new PublicError("PASSWORD_MISMATCH");
  return value; // No trim, normalization, complexity rules or client hashing.
}
export function codeValue(value) {
  const code = value.trim();
  if (!/^\d{6}$/.test(code)) throw new PublicError("CODE_FORMAT");
  return code;
}
export const authMessage = (error) => ({
  EMAIL_FORMAT: "請輸入有效的電子信箱。",
  PASSWORD_FORMAT: "密碼需為 12～128 個字元，不可包含空字元。",
  PASSWORD_MISMATCH: "兩次輸入的密碼不相同。",
  CODE_FORMAT: "請輸入六位數驗證碼。",
  RECOVERY_FORMAT: "請輸入完整的未使用復原碼。",
  AUTH_LOGIN_FAILED: "登入未完成，請確認登入資料後重試。",
  AUTH_VERIFICATION_FAILED: "驗證未完成，資料可能有誤、已過期或超過嘗試次數。請重試或重新開始。",
  AUTH_REQUIRED: "登入已失效，請重新登入。未完成的投稿資料仍在此分頁。",
  MEMBER_SUSPENDED: "登入已失效，請重新登入。未完成的投稿資料仍在此分頁。",
  AUTH_IDENTITY_CHANGED: "登入身份已改變。請重新登入原會員後重試，或明確放棄本次投稿。",
  AUTH_RATE_LIMITED: "操作過於頻繁，請等待後再試。",
  AUTH_REGISTRATION_UNAVAILABLE: "會員註冊暫時無法使用，請稍後再試。你仍可免登入投稿。",
  CSRF_REJECTED: "登入驗證已更新，請重新登入後再試。",
  NETWORK_ERROR: "連線中斷或等待逾時，請稍後再試。",
  TURNSTILE_REQUIRED: "請先完成人機驗證。",
  TURNSTILE_INVALID: "人機驗證已失效，請重新驗證。",
  INVALID_AUTH_REQUEST: "資料未通過檢查，請確認欄位內容。",
}[error?.code] ?? "會員服務暫時無法使用，請稍後再試。免登入投稿與案件查詢仍可使用。");
