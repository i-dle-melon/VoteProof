// Build-only transport: no cookie, CSRF, provider URL or network fallback.
import { PublicError } from "./api.js";
import { PREVIEW, previewFetch } from "./preview.js";
import { previewState } from "./pages-preview-state.js";
import { previewPicture } from "./preview-fixtures.js";
export { emailValue, passwordValue, codeValue, authMessage, adminPath } from "./member-rules.js";
export class MemberSession {
  #member = null;
  #blocked = false;
  constructor({ changed = () => {} } = {}) {
    this.changed = changed;
  }
  get member() {
    return this.#member;
  }
  get blocked() { return this.#blocked; }
  clear(code) {
    this.#blocked=code==='MEMBER_SUSPENDED';
    this.#member = null;
    this.changed(null);
  }
  accept() {
    throw new PublicError("UI_PREVIEW_ONLY", 403);
  }
  updateProfile(member) {
    if(member.member_id!==this.#member?.member_id)throw new PublicError("UI_PREVIEW_ONLY",403);this.#member=Object.freeze({...member});this.changed(this.#member);
  }
  async request(path, options = {}) {
    if (!PREVIEW)
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    const response = await previewFetch(path, options),
      json = await response.json();
    if (!response.ok) {
      if (['AUTH_REQUIRED','MEMBER_SUSPENDED'].includes(json.error.code)) this.clear(this.#blocked?'MEMBER_SUSPENDED':json.error.code);
      throw new PublicError(json.error.code, response.status);
    }
    return json.data;
  }
  async refresh() {
    const data = await this.request("/api/auth/me");
    this.#blocked=false;
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
      !["admin","super_admin","reviewer"].includes(previewState.identity) ||
      previewState.data !== "normal" ||
      !/^\/api\/admin\/cases\/VP-PREVIEW-\d+\/files\/PREVIEW-IMAGE-\d+$/.test(path)
    )
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    return previewPicture();
  }
  async exportSample() {
    if(!PREVIEW || !['admin','super_admin','reviewer'].includes(previewState.identity))throw new PublicError('UI_PREVIEW_ONLY',403);
    return new Uint8Array(await (await previewPicture()).arrayBuffer());
  }
  async adminAsset(path,signal){const response=await previewFetch(path,{signal});if(!response.ok)throw new PublicError('CONTENT_NOT_FOUND',response.status);return response.blob();}
  async adminAssetUpload(campaignId,file,signal){return this.request('/api/admin/campaign-assets/'+encodeURIComponent(campaignId),{method:'POST',body:file,signal});}
  caseSender() {
    const blocked = async () => {
      throw new PublicError("UI_PREVIEW_ONLY", 403);
    };
    blocked.verify = blocked;
    return blocked;
  }
}
