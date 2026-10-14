// Build-only transport: no cookie, CSRF, provider URL or network fallback.
import { PublicError } from "./api.js";
import { PREVIEW, previewFetch } from "./preview.js";
import { previewState } from "./pages-preview-state.js";
import { previewPicture } from "./preview-fixtures.js";
export { emailValue, passwordValue, codeValue, authMessage, adminPath } from "./member-rules.js";
export class MemberSession {
  #member = null;
  constructor({ changed = () => {} } = {}) {
    this.changed = changed;
  }
  get member() {
    return this.#member;
  }
  clear() {
    this.#member = null;
    this.changed(null);
  }
  accept() {
    throw new PublicError("UI_PREVIEW_ONLY", 403);
  }
  updateProfile() {
    throw new PublicError("UI_PREVIEW_ONLY", 403);
  }
  async request(path, options = {}) {
    if (!PREVIEW || (options.method ?? "GET") !== "GET")
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    const response = await previewFetch(path, options),
      json = await response.json();
    if (!response.ok) {
      if (json.error.code === "AUTH_REQUIRED") this.clear();
      throw new PublicError(json.error.code, response.status);
    }
    return json.data;
  }
  async refresh() {
    const data = await this.request("/api/auth/me");
    if (this.#member?.member_id !== data.member.member_id) {
      this.#member = Object.freeze(data.member);
      this.changed(this.#member);
    }
    return data;
  }
  async adminRequest(path, options = {}) {
    return this.request(path, options);
  }
  async adminProof(path) {
    if (
      !PREVIEW ||
      previewState.identity !== "admin" ||
      previewState.data !== "normal" ||
      !/^\/api\/admin\/cases\/VP-PREVIEW-\d+\/files\/PREVIEW-IMAGE-\d+$/.test(path)
    )
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    return previewPicture();
  }
  caseSender() {
    const blocked = async () => {
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    };
    blocked.verify = blocked;
    return blocked;
  }
}
