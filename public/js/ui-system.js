// Shared presentation only. Native modal supplies inert background and Escape;
// explicit Tab wrapping keeps focus within a single-control dialog on all engines.
export function setupUI() {
  const help = document.getElementById("authenticator-help-dialog"), helpClose = document.getElementById("authenticator-help-close");
  let helpOpener = null;
  for (const button of document.querySelectorAll("[data-authenticator-help]")) button.addEventListener("click", () => {
    if (help.open || document.querySelector("dialog[open]")) return;
    helpOpener = button; help.showModal(); helpClose.focus();
  });
  helpClose.addEventListener("click", () => help.close());
  help.addEventListener("close", () => { if (helpOpener?.isConnected) helpOpener.focus(); });
  help.addEventListener("keydown", event => {
    if (event.key !== "Tab") return;
    const controls = [...help.querySelectorAll("button,a[href]")], first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
  help.addEventListener("click", event => {
    const b = help.getBoundingClientRect();
    if (event.target === help && (event.clientX < b.left || event.clientX > b.right || event.clientY < b.top || event.clientY > b.bottom)) help.close();
  });
  window.addEventListener("hashchange", () => { if (help.open) help.close(); });
  window.addEventListener("pagehide", () => { if (help.open) help.close(); });
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
  const about=document.getElementById('about-dialog'),aboutClose=document.getElementById('about-close');let aboutOpener=null;
  const showAbout=source=>{if(about.open||document.querySelector('dialog[open]'))return;aboutOpener=source??document.activeElement;document.getElementById('view-about').hidden=false;about.showModal();aboutClose.focus();};
  document.addEventListener('click',event=>{const link=event.target.closest('a[href="#about"]');if(!link)return;event.preventDefault();event.stopImmediatePropagation();showAbout(link);},true);
  document.addEventListener('voteproof-about-open',()=>showAbout());
  aboutClose.addEventListener('click',()=>about.close());
  about.addEventListener('click',e=>{const b=about.getBoundingClientRect();if(e.target===about&&(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom))about.close();});
  about.addEventListener('close',()=>{if(aboutOpener?.isConnected)aboutOpener.focus();});
  about.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...about.querySelectorAll('button:not([disabled]),a[href]')].filter(n=>n.getClientRects().length),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
  about.addEventListener('click',e=>{if(e.target.closest('[data-submission-action]'))about.close();});
}
