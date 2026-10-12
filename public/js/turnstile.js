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
  constructor(container, changed) { this.container = container; this.changed = changed; }
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
      "response-field": false, callback: (token) => { if (!this.#active) return; this.#token = token; this.changed("已完成人機驗證"); this.#waiting?.resolve(); },
      "expired-callback": () => { this.#token = ""; this.changed("驗證已到期，請重新驗證。"); },
      "error-callback": () => { this.#token = ""; this.changed("人機驗證暫時無法完成，請重試驗證。"); this.#waiting?.reject(new PublicError("TURNSTILE_UPSTREAM_ERROR")); } });
  }
  waitForToken(timeout = 120000) {
    if (this.#token) return Promise.resolve(this.take());
    if (!this.#active || this.#waiting) return Promise.reject(new PublicError("TURNSTILE_REQUIRED"));
    this.changed("請完成人機驗證，批次投稿會接著繼續。");
    return new Promise((resolve, reject) => {
      const finish = callback => value => { clearTimeout(timer); this.#waiting = null; callback(value); };
      const timer = setTimeout(() => this.#waiting?.reject(new PublicError("TURNSTILE_REQUIRED")), timeout);
      this.#waiting = { resolve: finish(() => resolve(this.take())), reject: finish(reject) };
    });
  }
  take() {
    const token = this.#token;
    this.#token = "";
    // Tokens are single-use. Reset only after reading one into this request.
    if (token && this.#id !== undefined) globalThis.turnstile.reset(this.#id);
    return token;
  }
  reset() {
    this.#token = "";
    if (this.#id !== undefined) globalThis.turnstile.reset(this.#id);
  }
  clear() {
    // Clear a registration response without requesting another challenge.
    this.#token = "";
    this.#active = false;
    this.#waiting?.reject(new PublicError("TURNSTILE_REQUIRED"));
  }
}
