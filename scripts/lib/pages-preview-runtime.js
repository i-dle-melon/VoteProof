import { previewState, previewControlChange } from "./pages-preview-state.js";
export function previewAllowed(marker, hostname, protocol = "https:") {
  return (
    marker === "isolated" &&
    ["https:", "http:"].includes(protocol) &&
    (/^[a-z0-9-]+\.github\.io$/i.test(hostname) ||
      ["localhost", "127.0.0.1", "[::1]"].includes(hostname))
  );
}
export const PREVIEW = previewAllowed(
  document.querySelector('meta[name="voteproof-preview"]')?.content,
  location.hostname,
  location.protocol,
);
export function assetURL(path) {
  return new URL(".." + path, import.meta.url).href;
}
export async function previewFetch(path, options = {}) {
  const { fixtureResponse } = await import("./preview-fixtures.js");
  return fixtureResponse(path, options);
}
export function setupPreview() {
  if (!PREVIEW) throw Error("Isolated Preview marker/host required");
  document.documentElement.dataset.preview = "isolated";
  // Block every actual form event before the shared render modules can act.
  document.addEventListener(
    "submit",
    (event) => {
      if(event.target.matches("#profile-form,[data-preview-review]"))return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.getElementById("preview-action-status").textContent =
        "UI PREVIEW：這個操作不會送出或保存。";
    },
    true,
  );
  for (const control of document.querySelectorAll("[data-preview-control]")) {
    const key = control.dataset.previewControl;
    control.value = previewState[key];
    control.addEventListener("change", () => previewControlChange(key, control.value));
  }
  try {
    localStorage.setItem("voteproof-theme", previewState.theme);
  } catch {}
  // Credential and provider entry points are visible for layout only.
  const readonlyIds = [
    "login-google",
    "register-google",
    "security-google-step",
    "security-link-confirm",
    "security-add-confirm",
    "security-enroll",
    "security-reset",
    "security-regenerate",
    "copy-key",
    "copy-case",
    "copy-all",
    "batch-copy",
    "batch-download",
    "receipt-download",
    "lookup-created",
    "new-submission",
    "abandon-button",
  ];
  document.addEventListener(
    "click",
    (event) => {
      const button = event.target.closest("button");
      if (button && (readonlyIds.includes(button.id) || button.closest("#batch-items"))) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  document.getElementById("theme-toggle")?.addEventListener("click", () =>
    queueMicrotask(() => {
      const value = document.documentElement.dataset.theme;
      document.getElementById("preview-theme").value = value;
      const url = new URL(location.href);
      url.searchParams.set("preview_theme", value);
      history.replaceState(null, "", url);
    }),
  );
  const disable = () => {
    for (const id of readonlyIds) {
      const button = document.getElementById(id);
      if (button) {
        button.disabled = true;
        button.title = "UI PREVIEW：只有展示，不會登入或產生憑證";
      }
    }
    for (const button of document.querySelectorAll("#batch-items button")) {
      button.disabled = true;
      button.title = "UI PREVIEW：無查詢碼";
    }
  };
  new MutationObserver(disable).observe(document.getElementById("main"), {
    childList: true,
    subtree: true,
  });
  disable();
}
