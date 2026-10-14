import { PublicError } from "./api.js";
export class Challenge {
  constructor(container, changed = () => {}) {
    this.container = container;
    this.changed = changed;
  }
  async mount() {
    this.changed("UI PREVIEW：展示驗證區，不執行人機驗證。");
  }
  waitForToken() {
    return Promise.reject(new PublicError("UI_PREVIEW_ONLY", 403));
  }
  take() {
    return "";
  }
  reset() {}
  clear() {}
}
