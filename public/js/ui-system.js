// Shared presentation only. Native modal supplies inert background and Escape;
// explicit Tab wrapping keeps focus within a single-control dialog on all engines.
export function setupUI() {
  const dialog = document.getElementById("workflow-dialog"),
    opener = document.getElementById("workflow-help");
  let returnFocus = null;
  opener?.addEventListener("click", () => {
    returnFocus = opener;
    dialog.showModal();
    document.getElementById("workflow-close").focus();
  });
  document.getElementById("workflow-close")?.addEventListener("click", () => dialog.close());
  dialog?.addEventListener("close", () => {
    if (returnFocus?.isConnected) returnFocus.focus();
  });
  dialog?.addEventListener("keydown", (event) => {
    if (event.key !== "Tab") return;
    const controls = [
      ...dialog.querySelectorAll(
        'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
      ),
    ].filter((control) => control.getClientRects().length);
    const first = controls[0],
      last = controls.at(-1);
    if (!first) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  dialog?.addEventListener("click", (event) => {
    const bounds = dialog.getBoundingClientRect();
    if (
      event.target === dialog &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    )
      dialog.close();
  });
  document.addEventListener(
    "invalid",
    (event) => {
      event.target.setAttribute("aria-invalid", "true");
    },
    true,
  );
  document.addEventListener("input", (event) => {
    if (event.target.hasAttribute("aria-invalid")) event.target.removeAttribute("aria-invalid");
  });
  // Static explanation on phones remains reachable from the About page.
}
