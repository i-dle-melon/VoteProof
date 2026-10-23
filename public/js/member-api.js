import { PublicError } from "./api.js";
import { PREVIEW, previewFetch } from "./preview.js";

// Only Worker-relative endpoints. Cookie credentials and CSRF never reach R2
// or a provider. The secure session cookie remains inaccessible to JavaScript.
export class MemberSession {
  #member = null;
  #blocked = false;
  #csrf = "";
  #revision = 0;
  #expiry;
  constructor({ fetcher = (...args) => fetch(...args), changed = () => {} } = {}) {
    this.fetcher = fetcher; this.changed = changed;
  }
  get member() { return this.#member; }
  get blocked() { return this.#blocked; }
  clear(code) {
    this.#blocked=code==='MEMBER_SUSPENDED';
    clearTimeout(this.#expiry); this.#member = null; this.#csrf = "";
    this.#revision++; this.changed(null);
  }
  accept(data) {
    if (!data?.member || typeof data.member.member_id !== "string" || data.member.status !== "active" ||
        !/^[a-f0-9]{64}$/.test(data.csrf_token ?? "")) throw new PublicError("SERVICE_UNAVAILABLE");
    this.#blocked=false;clearTimeout(this.#expiry);
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
    if (path.includes("..") || !/^\/api\/(?:auth\/(?:[a-z/-]+|trusted-devices\/[a-f0-9-]{36}\/revoke)|me\/(?:profile|points|point-transactions|cases(?:\/[A-Z0-9-]+)?)(?:\?[^#]*)?|uploads\/(?:prepare|complete)|cases(?:\/direct)?)$/.test(path))
      throw new PublicError("INVALID_AUTH_REQUEST");
    return this.#send(path, { method, body, headers, signal });
  }
  async adminRequest(path, options = {}) {
    if (!adminPath(path) || /\/files\//.test(path)) throw new PublicError("INVALID_AUTH_REQUEST");
    if (!this.member) throw new PublicError("AUTH_REQUIRED");
    return this.#send(path, options);
  }
  async adminProof(path, signal) {
    if (!adminPath(path) || !/\/files\/[a-f0-9-]{36}$/.test(path)) throw new PublicError("INVALID_AUTH_REQUEST");
    if (!this.member) throw new PublicError("AUTH_REQUIRED");
    return this.#send(path, { signal, image: true });
  }
  async adminAsset(path, signal) {
    if(!/^\/api\/admin\/campaign-assets\/[a-f0-9-]{36}$/.test(path)||!this.member)throw new PublicError('INVALID_AUTH_REQUEST');
    return this.#send(path,{signal,image:true});
  }
  async adminAssetUpload(campaignId,file,signal) {
    if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(campaignId)||!this.member||!['image/png','image/jpeg','image/webp'].includes(file?.type)||file.size<=0||file.size>5242880)throw new PublicError('INVALID_IMAGE_TYPE');
    return this.#send('/api/admin/campaign-assets/'+campaignId,{method:'POST',body:file,headers:{'Content-Type':file.type},signal,upload:true});
  }
  async #send(path, { method = "GET", body, headers = {}, signal, image = false, upload = false } = {}) {
    const revision = this.#revision;
    let response;
    const timeout = method === 'POST' && /^\/api\/admin\/backups\/[a-f0-9-]{36}\/process$/.test(path) ? 270000 : 30000;
    try {
      response = await (PREVIEW ? previewFetch : this.fetcher)(path, { method, credentials: "same-origin", cache: "no-store", referrerPolicy: "no-referrer",
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
        headers: { ...headers, ...(method === "GET" ? {} : { "X-VoteProof-Request": "1", ...(this.#csrf ? { "X-CSRF-Token": this.#csrf } : {}) }),
          ...(body === undefined || upload ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: upload || typeof body === "string" ? body : JSON.stringify(body) }) });
    } catch { throw new PublicError(signal?.aborted ? "REQUEST_CANCELLED" : "NETWORK_ERROR"); }
    if (image && response.ok) {
      if (!["image/png", "image/jpeg", "image/webp"].includes(response.headers.get("Content-Type"))) throw new PublicError("PROOF_INTEGRITY_ERROR");
      const blob = await response.blob();
      if (blob.size <= 0 || blob.size > 5 * 1024 * 1024) throw new PublicError("PROOF_INTEGRITY_ERROR");
      return blob;
    }
    let result;
    try { result = await response.json(); } catch { throw new PublicError("SERVICE_UNAVAILABLE", response.status); }
    if (!response.ok || result?.ok !== true) {
      const code = result?.error?.code ?? "SERVICE_UNAVAILABLE";
      if (["AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(code) && revision === this.#revision) this.clear(this.#blocked?'MEMBER_SUSPENDED':code);
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
    const verify = async () => {
      if (this.#member?.member_id !== owner) throw new PublicError("AUTH_IDENTITY_CHANGED");
      const data = await this.refresh();
      if (data.member.member_id !== owner || this.#member?.member_id !== owner) throw new PublicError("AUTH_IDENTITY_CHANGED");
    };
    const send = async (path, options) => {
      await verify();
      return this.request(path, options);
    };
    send.verify = verify;
    return send;
  }
}

// Explicit admin surface: no arbitrary endpoint, external URL, dot segment,
// fragment or proof path carrying credentials in query parameters.
export function adminPath(path) {
  if (/^\/api\/admin\/storage(?:\/(?:inventory|dry-run))?$/.test(path)) return true;
  if (typeof path !== "string" || /[#\\]/.test(path)) return false;
  const [pathname, query, extra] = path.split("?");
  if(pathname.includes('.'))return false;
  if (extra !== undefined || query && [...new URLSearchParams(query)].some(([key, val]) => !/^[a-z_]+$/.test(key) || val.length > 1024 || /[\u0000-\u001f\u007f]/.test(val))) return false;
  if(['/api/admin/solo-targets','/api/admin/overview'].includes(pathname) && query===undefined)return true;
  if(pathname==='/api/admin/staff' && query===undefined)return true;
  if(pathname==='/api/admin/member-blocks')return true;
  if(['/api/admin/member-lookup','/api/admin/member-mail/send'].includes(pathname)&&query===undefined)return true;
  if(query===undefined&&/^\/api\/admin\/(?:announcements(?:\/[a-f0-9-]{36}\/update)?|campaign-assets\/[A-Za-z0-9_-]{1,100}|campaigns\/[A-Za-z0-9_-]{1,100}\/guidance)$/.test(pathname))return true;
  if(['/api/admin/cases/initial-review','/api/admin/cases/batch-status','/api/admin/backups/jobs'].includes(pathname)){
    const allowed=pathname.endsWith('initial-review')?['cutoff','cursor']:pathname.endsWith('batch-status')?['items']:['status','page'];
    const params=new URLSearchParams(query??'');return [...params.keys()].every(k=>allowed.includes(k)&&params.getAll(k).length===1);
  }
  if(pathname==="/api/admin/cases/batch-approve" && query===undefined)return true;
  if(pathname==='/api/admin/image-exports'&&query!==undefined){const p=new URLSearchParams(query);return p.getAll('page').length===1&&[...p.keys()].every(k=>k==='page')&&/^[1-9]\d*$/.test(p.get('page'))&&Number.isSafeInteger(Number(p.get('page'))*10);}
  if (pathname.includes("/files/") && query !== undefined) return false;
  if (pathname === '/api/admin/backups/missing' || pathname === '/api/admin/storage/history') {
    const params = new URLSearchParams(query ?? '');
    return [...params.keys()].every(key => key === 'page') && params.getAll('page').length <= 1 &&
      (!params.has('page') || /^[1-9]\d*$/.test(params.get('page')) && Number.isSafeInteger(Number(params.get('page')) * 10));
  }
  if(query===undefined && /^\/api\/admin\/image-exports(?:\/(?:query|jobs)|\/jobs\/[a-f0-9-]{36}(?:\/packages\/[1-9]\d{0,4}(?:\/(?:start|state)|\/attempts\/[a-f0-9-]{36}\/files\/[a-f0-9-]{36}))?)?$/.test(pathname)) return true;
  if (/^\/api\/admin\/(?:backups(?:\/backfill|\/[a-f0-9-]{36}\/(?:retry|process))?|cases\/VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}\/backups)$/.test(pathname)) return true;
  return /^\/api\/admin\/(?:me|audit-logs|cases(?:\/VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}(?:\/review|\/files\/[a-f0-9-]{36})?)?|campaigns(?:\/[A-Za-z0-9_-]{1,100}(?:\/update)?)?|leaderboards(?:\/[A-Za-z0-9_-]{1,100}(?:\/(?:update|rebuild|results))?)?|member-tiers(?:\/[a-z]+\/update)?|submissions(?:\/update)?)$/.test(pathname);
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
  FAN_ID_REQUIRED: "請填寫粉絲 ID，才能完成註冊。",
  FAN_ID_TAKEN: "此粉絲 ID 已被使用，請確認後重新輸入。",
  FAN_ID_IMMUTABLE: "粉絲 ID 建立後無法修改。",
  AUTH_IDENTITY_CONFLICT: "這個登入身份無法連結。請使用原登入方式，或聯絡支援；不會自動合併會員。",
  AUTH_METHOD_CONFLICT: "登入方式設定未完成。請使用 Google 登入，並重試原本的設定；若已過期請聯絡支援。",
  AUTH_GOOGLE_REAUTH_REQUIRED: "請先重新驗證 Google，再為同一會員新增密碼登入。",
  AUTH_PROVIDER_UNAVAILABLE: "會員服務暫時無法使用（Google 或身份服務）。請稍後重試；免登入功能仍可使用。",
  AUTH_STEP_UP_REQUIRED: "此操作需要重新驗證登入身份及 Authenticator。",
  AUTH_MFA_ENROLLMENT_REQUIRED: "請先在登入與安全設定 Authenticator，再重新驗證身份。",
  EMAIL_FORMAT: "請輸入有效的電子信箱。",
  PASSWORD_FORMAT: "密碼需為 12～128 個字元，不可包含空字元。",
  PASSWORD_MISMATCH: "兩次輸入的密碼不相同。",
  CODE_FORMAT: "請輸入六位數驗證碼。",
  RECOVERY_FORMAT: "請輸入完整的未使用復原碼。",
  AUTH_LOGIN_FAILED: "登入未完成，請確認登入資料後重試。",
  AUTH_VERIFICATION_FAILED: "驗證未完成，資料可能有誤、已過期或超過嘗試次數。請重試或重新開始。",
  AUTH_REQUIRED: "登入已失效，請重新登入。未完成的投稿資料仍在此分頁。",
  MEMBER_SUSPENDED: "此會員已被封鎖，目前無法使用功能。請聯絡管理員。",
  AUTH_IDENTITY_CHANGED: "登入身份已改變。請重新登入原會員後重試，或明確放棄本次投稿。",
  AUTH_RATE_LIMITED: "操作過於頻繁，請等待後再試。",
  AUTH_REGISTRATION_UNAVAILABLE: "會員註冊暫時無法使用，請稍後再試。案件查詢與排行榜仍可使用。",
  CSRF_REJECTED: "登入驗證已更新，請重新登入後再試。",
  NETWORK_ERROR: "連線中斷或等待逾時，請稍後再試。",
  TURNSTILE_REQUIRED: "請先完成人機驗證。",
  TURNSTILE_INVALID: "人機驗證已失效，請重新驗證。",
  INVALID_AUTH_REQUEST: "資料未通過檢查，請確認欄位內容。",
}[error?.code] ?? "會員服務暫時無法使用，請稍後再試。案件查詢與排行榜仍可使用。");
