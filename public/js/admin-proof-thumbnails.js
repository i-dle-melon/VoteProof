// Private authenticated proof bytes only; viewport-triggered and capped at two requests.
export function proofThumbnails({ session, signal, isCurrent, onAuthError }) {
  const ownAbort = new AbortController(),
    requestSignal = AbortSignal.any([signal, ownAbort.signal]);
  const observers = new Set(),
    urls = new Map(),
    cleanup = new Set(),
    queue = [];
  let running = 0,
    stopped = false,
    owner = null;
  const dialog = document.createElement("dialog");
  dialog.className = "proof-preview-dialog";
  dialog.setAttribute("aria-label", "證明圖片放大預覽");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-white";
  close.textContent = "關閉圖片預覽";
  const picture = document.createElement("img");
  dialog.append(close, picture);
  document.body.append(dialog);
  function hide() {
    const focus = dialog.classList.contains("is-modal") ? owner : null;
    if (dialog.open) dialog.close();
    picture.removeAttribute("src");
    owner = null;
    if (focus?.isConnected) focus.focus();
  }
  close.addEventListener("click", hide);
  dialog.addEventListener("close", () => {
    if (dialog.open) return;
    picture.removeAttribute("src");
    if (dialog.classList.contains("is-modal") && owner?.isConnected) owner.focus();
    owner = null;
  });
  dialog.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      close.focus();
    }
  });
  function zoom(button, modal = false) {
    const img = button.querySelector("img");
    if (!img || stopped) return;
    if (dialog.open) dialog.close();
    owner = button;
    picture.src = img.src;
    picture.alt = img.alt;
    dialog.classList.toggle("is-modal", modal);
    modal ? dialog.showModal() : dialog.show();
    if (modal) close.focus();
  }
  function pump() {
    while (!stopped && running < 2 && queue.length) {
      const task = queue.shift();
      if (!task.button.isConnected || !isCurrent()) continue;
      running++;
      void load(task).finally(() => {
        running--;
        pump();
      });
    }
  }
  async function load({ button, row, primary }) {
    try {
      const blob = await session.adminProof(
        "/api/admin/cases/" + row.case_id + "/files/" + primary,
        requestSignal,
      );
      if (stopped || !isCurrent() || !button.isConnected) return;
      const url = URL.createObjectURL(blob);
      urls.set(row.case_id, url);
      const img = document.createElement("img");
      img.src = url;
      img.alt = "投票證明 " + row.case_id;
      img.decoding = "async";
      img.draggable = false;
      button.replaceChildren(img);
      if (button.matches(":hover") && matchMedia("(hover:hover)").matches) zoom(button);
    } catch (e) {
      if (stopped || !isCurrent() || !button.isConnected) return;
      if (
        ["ADMIN_FORBIDDEN", "ADMIN_STEP_UP_REQUIRED", "AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(
          e.code,
        )
      )
        onAuthError();
      else button.textContent = "圖片暫時無法載入，展開重試";
    }
  }
  function observe(button, row) {
    const primary = row.primary_file_id ?? row.files?.[0]?.file_id;
    if (!primary) {
      button.textContent = "無圖片";
      return;
    }
    button.textContent = "載入圖片";
    button.title = "滑鼠懸停或手機長按可放大；點擊查看與審核";
    let timer = null,
      start = null,
      suppress = false;
    const cancel = () => {
      clearTimeout(timer);
      timer = null;
    };
    cleanup.add(cancel);
    button.addEventListener("pointerenter", (e) => {
      if (e.pointerType === "mouse") zoom(button);
    });
    button.addEventListener("pointerleave", () => {
      cancel();
      if (!dialog.classList.contains("is-modal")) hide();
    });
    button.addEventListener("blur", () => {
      if (!dialog.classList.contains("is-modal")) hide();
    });
    button.addEventListener("pointerdown", (e) => {
      suppress = false;
      if (e.pointerType === "mouse") return;
      start = { x: e.clientX, y: e.clientY };
      cancel();
      timer = setTimeout(() => {
        if (!button.querySelector("img")) return;
        suppress = true;
        zoom(button, true);
      }, 500);
    });
    button.addEventListener("pointermove", (e) => {
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
    });
    for (const type of ["pointerup", "pointercancel"]) button.addEventListener(type, cancel);
    button.addEventListener("contextmenu", (e) => {
      if (start) e.preventDefault();
    });
    button.addEventListener(
      "click",
      (e) => {
        if (suppress) {
          e.preventDefault();
          e.stopImmediatePropagation();
          suppress = false;
        }
      },
      true,
    );
    button.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        zoom(button, true);
      }
    });
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        observers.delete(observer);
        queue.push({ button, row, primary });
        pump();
      },
      { rootMargin: "80px" },
    );
    observers.add(observer);
    observer.observe(button);
  }
  return {
    observe,
    release(id) {
      const url = urls.get(id);
      if (url) {
        if (picture.getAttribute("src") === url) hide();
        URL.revokeObjectURL(url);
        urls.delete(id);
      }
    },
    clear() {
      stopped = true;
      ownAbort.abort();
      queue.length = 0;
      for (const o of observers) o.disconnect();
      for (const fn of cleanup) fn();
      hide();
      dialog.remove();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      urls.clear();
    },
  };
}
