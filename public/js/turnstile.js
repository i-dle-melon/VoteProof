import { PublicError } from "./api.js";
import { PREVIEW } from "./preview.js";
// Lazy official script: homepage/lookup/leaderboards need no challenge request.
let loading;
function load() {
  if (typeof globalThis.turnstile?.render === "function") return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    const timer = setTimeout(() => { script.remove(); reject(new PublicError("TURNSTILE_UPSTREAM_ERROR")); }, 15000);
    script.onload = () => { clearTimeout(timer); resolve(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); reject(new PublicError("TURNSTILE_UPSTREAM_ERROR")); };
    document.head.append(script);
  }).catch((e) => { loading = null; throw e; });
  return loading;
}
export class Challenge {
  #id;
  #token = "";
  #mounting;
  #active = false;
  #waiting;
  #needsReset = false;
  #receivedAt = 0;
  #lastConsumed = '';
  constructor(container, changed, {now=Date.now}={}) { this.container = container; this.changed = changed; this.now=now; }
  mount() {
    if (PREVIEW) return Promise.reject(new PublicError("UI_PREVIEW_ONLY", 403));
    if (this.#id !== undefined) {
      if (!this.#active) { this.#active = true; globalThis.turnstile.reset(this.#id); }
      return Promise.resolve();
    }
    this.#active = true;
    if (this.#mounting) return this.#mounting;
    this.#mounting = this.#mount().finally(() => { this.#mounting = null; });
    return this.#mounting;
  }
  async #mount() {
    await load();
    if (!this.#active) return;
    if (typeof globalThis.turnstile?.render !== "function") throw new PublicError("TURNSTILE_UPSTREAM_ERROR");
    const sitekey = document.querySelector('meta[name="turnstile-site-key"]')?.content;
    if (!sitekey) throw new PublicError("TURNSTILE_NOT_CONFIGURED");
    this.#id = globalThis.turnstile.render(this.container, { sitekey, theme: document.documentElement.dataset.theme,
      size: this.container.clientWidth < 300 ? "compact" : "flexible",
      "response-field": false, callback: (token) => {
        if (!this.#active||typeof token!=='string'||!token||token===this.#lastConsumed) return;
        this.#token = token;this.#receivedAt=this.now();this.#needsReset=false;
        this.changed("已完成人機驗證"); this.#waiting?.resolve();
      },
      "expired-callback": () => { this.#token = "";this.#needsReset=true; this.changed("驗證已到期，請重新驗證。"); },
      "error-callback": () => { this.#token = "";this.#needsReset=true; this.changed("人機驗證暫時無法完成，請重試驗證。"); this.#waiting?.reject(new PublicError("TURNSTILE_UPSTREAM_ERROR")); } });
  }
  waitForToken(timeout = 120000) {
    // A backgrounded mobile page can miss an expiry callback. Local age is a
    // conservative UX check only; backend Siteverify remains authoritative.
    if(this.#token&&this.now()-this.#receivedAt>=295000){this.#token='';this.#needsReset=true;}
    if (this.#token) return Promise.resolve(this.take({ reset: false }));
    if (!this.#active) return Promise.reject(new PublicError("TURNSTILE_REQUIRED"));
    if(this.#waiting)return this.#waiting.promise;
    this.changed("請完成人機驗證，批次投稿會接著繼續。");
    const promise=new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); this.#waiting = null; callback(value); };
      const timer = setTimeout(() => this.#waiting?.reject(new PublicError("TURNSTILE_REQUIRED")), timeout);
      this.#waiting = { resolve: finish(() => resolve(this.take({ reset: false }))), reject: finish(reject) };
    });
    this.#waiting.promise=promise;
    // Register the waiter BEFORE reset: an immediate/cached callback must not
    // be lost and require another click. A valid existing token never resets.
    if(this.#needsReset&&this.#id!==undefined){this.#needsReset=false;globalThis.turnstile.reset(this.#id);}
    return promise;
  }
  take({ reset = true } = {}) {
    const token = this.#token;
    this.#token = "";
    if(token)this.#lastConsumed=token;
    // Batch upload consumes this token once. Ask for the next challenge only
    // when a later authorization needs one, not while its images are uploading.
    // Registration's synchronous take() retains its existing reset behavior.
    if (token && this.#id !== undefined) {
      this.#needsReset=!reset;
      if(reset)globalThis.turnstile.reset(this.#id);
    }
    return token;
  }
  reset() {
    this.#needsReset = false;
    this.#token = "";
    if (this.#id !== undefined) globalThis.turnstile.reset(this.#id);
  }
  clear() {
    this.#needsReset = false;
    // Clear a registration response without requesting another challenge.
    this.#token = "";
    this.#active = false;
    this.#waiting?.reject(new PublicError("TURNSTILE_REQUIRED"));
  }
}
