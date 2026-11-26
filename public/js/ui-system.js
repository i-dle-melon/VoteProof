// Shared presentation only. Native modal supplies inert background and Escape;
// explicit Tab wrapping keeps focus within a single-control dialog on all engines.
export function setupUI() {
  setupLoadingNotice();
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

function setupLoadingNotice() {
  const statusSelector = '[role="status"]:not(#progress-label),[data-site-loading-status]';
  const sourceSelector = statusSelector + ',[aria-busy="true"]';
  const pendingText = /^(?:正在(?:載入|處理|讀取|查詢|確認|準備下載|儲存|寄送|送出|上傳)[^。！\n]{0,48}|(?:載入|處理)中)…$/;
  const notice = document.createElement('div');
  notice.id = 'site-loading-notice';
  notice.className = 'site-loading-notice';
  notice.setAttribute('role', 'status');
  notice.hidden = true;
  const spinner = document.createElement('span');
  spinner.className = 'site-loading-spinner';
  spinner.setAttribute('aria-hidden', 'true');
  const label = document.createElement('span');
  notice.append(spinner, label);
  document.body.append(notice);

  let previous = new Set(), scheduled = false;
  function sync() {
    scheduled = false;
    const modal = document.activeElement?.closest('dialog:modal') ?? [...document.querySelectorAll('dialog:modal')].at(-1);
    const active = [], inline = new Set();
    for (const node of document.querySelectorAll(sourceSelector)) {
      if (notice.contains(node) || node.closest('[hidden], dialog:not([open])')) continue;
      const text = node.matches(statusSelector) ? node.textContent.trim() : '';
      if (pendingText.test(text) && node.parentElement?.getClientRects().length) {
        inline.add(node);
        active.push({ node, text });
      }
      if (node.getAttribute('aria-busy') === 'true' && node.getClientRects().length)
        active.push({ node, text: node.dataset.siteBusyMessage || '', priority: Boolean(node.dataset.siteBusyMessage) });
    }
    for (const node of previous) if (!inline.has(node)) node.classList.remove('site-loading-inline');
    for (const node of inline) if (!previous.has(node)) node.classList.add('site-loading-inline');
    previous = inline;
    const local = modal ? active.filter(entry => modal.contains(entry.node)) : [];
    const candidates = local.length ? local : active;
    const text = candidates.find(entry => entry.priority)?.text || candidates.find(entry => entry.text)?.text || '正在載入或處理資料…';
    const mount = modal ?? document.body;
    if (notice.parentElement !== mount) mount.append(notice);
    if (candidates.length && label.textContent !== text) label.textContent = text;
    notice.hidden = !candidates.length;
  }
  const hasSource = node => node instanceof Element && (node.matches(sourceSelector) || node.querySelector(sourceSelector));
  new MutationObserver(records => {
    if (scheduled || !records.some(record => {
      if (notice.contains(record.target)) return false;
      if (record.type === 'attributes') return true;
      const target = record.target instanceof Element ? record.target : record.target.parentElement;
      return target?.closest(statusSelector) || [...record.addedNodes, ...record.removedNodes].some(hasSource);
    })) return;
    scheduled = true;
    requestAnimationFrame(sync);
  }).observe(document.body, {
    subtree: true, childList: true, characterData: true, attributes: true,
    attributeFilter: ['hidden', 'open', 'aria-busy', 'data-site-busy-message'],
  });
  sync();
}
