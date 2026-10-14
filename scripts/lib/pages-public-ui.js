// Pages build-only adapter. Production keeps its real authenticated modules.
import { PublicError } from "./api.js";
const blocked = () => { throw new PublicError("UI_PREVIEW_ONLY"); };
export class MemberSession {
  get member() { return null; }
  async refresh() { return blocked(); }
  async request() { return blocked(); }
  async adminRequest() { return blocked(); }
  async adminProof() { return blocked(); }
  caseSender() { return blocked(); }
}
export const authMessage = () => "UI 預覽不會登入或保存資料。";
export const adminUI = () => ({ enter() {}, identity() {} });
export function memberUI({ changed = () => {} } = {}) {
  const session = new MemberSession();
  const ready = Promise.resolve().then(() => {
    document.getElementById("login-content").hidden = false;
    document.getElementById("login-session-status").textContent = authMessage();
    const options = document.getElementById("login-password-options");
    options.addEventListener("toggle", () => document.getElementById("login-password-summary").setAttribute("aria-expanded", String(options.open)));
    changed(null);
  });
  return { session, ready, enter() {}, loadRecentCases() {} };
}

export const tierArtwork=()=>null;
export const renderTierArtwork=host=>host.replaceChildren();
