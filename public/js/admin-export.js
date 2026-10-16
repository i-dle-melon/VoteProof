import { EXPORT_LIMITS, packageFilename } from "./export-format.js";
import { adminMessage, taipeiInput } from "./admin-api.js";
const element = (tag, text = "", cls = "") => {
  const e = document.createElement(tag);
  e.textContent = text;
  e.className = cls;
  return e;
};
const button = (text, action, cls = "btn btn-white") => {
  const b = element("button", text, cls);
  b.type = "button";
  b.addEventListener("click", action);
  return b;
};
const bytes = (n) => (n >= 1e9 ? (n / 1e9).toFixed(2) + " GB" : (n / 1e6).toFixed(2) + " MB");
const states = {
  planned: "尚未下載",
  in_progress: "下載中／可重新開始",
  completed: "已完成",
  failed: "失敗／可重試",
};
export async function renderImageExports({ container, request, session, signal }) {
  const root = element("section", "", "image-export");
  root.setAttribute("aria-label", "圖片批次匯出");
  container.append(root);
  root.append(
    element("h3", "圖片批次匯出"),
    element(
      "p",
      "以台灣時間篩選投稿；結束時間不包含在查詢區間。每包獨立下載，圖片不經伺服器壓縮。",
      "muted",
    ),
  );
  const form = element("form", "", "export-filters");
  form.dataset.previewExport = "true";
  root.append(form);
  const field = (name, label, type, value) => {
    const wrap = element("label", label),
      input = element(type === "select" ? "select" : "input");
    input.name = name;
    if (type !== "select") input.type = type;
    input.id = "export-" + name;
    input.value = value ?? "";
    wrap.append(input);
    form.append(wrap);
    return input;
  };
  const today = taipeiInput(new Date()).slice(0, 10);
  const from = field("from", "開始（Asia/Taipei）", "datetime-local", today + "T00:00"),
    to = field(
      "to",
      "結束（不包含，Asia/Taipei）",
      "datetime-local",
      taipeiInput(new Date(Date.now() + 86400000)).slice(0, 10) + "T00:00",
    );
  from.required = to.required = true;
  const campaign = field("campaign", "活動", "select");
  campaign.append(new Option("全部活動", ""));
  const entireWrap = element("label", "整個活動期間", "export-check"),
    entire = element("input");
  entire.type = "checkbox";
  entire.name = "entire";
  entireWrap.prepend(entire);
  form.append(entireWrap);
  const syncDates = () => {
    if (!campaign.value) entire.checked = false;
    entire.disabled = !campaign.value;
    from.disabled = to.disabled = entire.checked;
    from.required = to.required = !entire.checked;
  };
  entire.addEventListener("change", syncDates);
  campaign.addEventListener("change", syncDates);
  syncDates();
  const choices = (legend, name, options, defaults) => {
    const set = element("fieldset"),
      title = element("legend", legend);
    set.append(title);
    form.append(set);
    for (const [key, label] of options) {
      const wrap = element("label", label, "export-check"),
        input = element("input");
      input.type = "checkbox";
      input.name = name;
      input.value = key;
      input.checked = defaults.includes(key);
      wrap.prepend(input);
      set.append(wrap);
    }
  };
  choices(
    "審核狀態",
    "statuses",
    [
      ["pending", "待審核"],
      ["approved", "已通過（含已完成）"],
      ["rejected", "未通過（含重複投稿）"],
      ["other", "其他（已撤銷）"],
    ],
    ["pending", "approved"],
  );
  choices(
    "投稿類型",
    "vote_types",
    [
      ["Solo", "Solo"],
      ["團體", "團體"],
    ],
    ["Solo", "團體"],
  );
  choices(
    "投稿來源",
    "sources",
    [
      ["member", "會員"],
      ["guest", "匿名投稿"],
    ],
    ["member", "guest"],
  );
  const mode = field("package_bytes", "下載模式", "select");
  mode.append(
    new Option("相容下載：每包最多 64 MiB（暫存 ZIP）", String(EXPORT_LIMITS.blobMaxBytes)),
  );
  if (typeof window.showSaveFilePicker === "function") {
    mode.append(new Option("直接寫入 ZIP 檔案：每包最多 512 MiB", String(EXPORT_LIMITS.maxBytes)));
    mode.value = String(EXPORT_LIMITS.maxBytes);
  }
  const query = element("button", "查詢並規劃下載包", "btn btn-primary");
  query.type = "submit";
  form.append(query);
  const message = element("p", "", "notice info");
  message.setAttribute("role", "status");
  message.setAttribute("aria-live", "polite");
  root.append(message);
  root.append(
    element(
      "p",
      "PNG／JPEG／WEBP 使用 ZIP STORE。相容模式會暫存單包 ZIP（最多 64 MiB 圖片加少量目錄／CSV）；直接寫檔模式逐塊寫入磁碟。",
      "muted",
    ),
  );
  const history = element("div", "", "export-history"),
    results = element("div", "", "export-results");
  root.append(history, results);
  let job = null,
    active = null,
    batch = null,
    preparing = false,
    querying = false,
    pendingJob = null;
  const post = (path, body) => request("image-exports/" + path, { method: "POST", body });
  const notice = (error) =>
    error?.code === "EXPORT_SCOPE_TOO_LARGE"
      ? "一次最多規劃 20,000 張，請縮小日期或活動範圍。"
      : error?.code === "EXPORT_PROOF_UNAVAILABLE"
        ? "1 個檔案無法取得或已變更；本包未完成，可重試。"
        : adminMessage(error);
  const current = () => !signal.aborted && root.isConnected;
  const refreshHistory = async () => {
    const data = await request("image-exports");
    if (!current()) return;
    history.replaceChildren();
    if (data.jobs.length) {
      const label = element("label", "最近匯出工作（保留 7 天）"),
        select = element("select");
      select.id = "export-history";
      select.append(new Option("選擇既有工作", ""));
      for (const row of data.jobs)
        select.append(
          new Option(
            `${new Date(row.created_at).toLocaleString("zh-TW", { timeZone: "Asia/Taipei" })} · ${row.image_count} 張`,
            row.id,
          ),
        );
      label.append(select);
      history.append(label);
      select.addEventListener("change", () => {
        if (select.value && !active && !batch && !preparing)
          void loadJob(select.value).catch((e) => (message.textContent = notice(e)));
      });
    }
    return data.jobs;
  };
  const loadJob = async (id) => {
    job = await request("image-exports/jobs/" + id);
    if (current()) render();
  };
  function render() {
    results.replaceChildren();
    if (!job) return;
    const summary = element("div", "", "export-summary");
    summary.append(
      element("strong", `符合條件：${job.image_count.toLocaleString()} 張圖片`),
      element("span", `總容量：${bytes(job.total_bytes)}`),
      element("span", `${job.packages.length} 個下載包`),
    );
    results.append(summary);
    if (!job.packages.length) {
      results.append(element("p", "目前沒有符合條件的圖片。", "empty-state"));
      return;
    }
    if (job.preview_sample)
      results.append(
        element(
          "p",
          "Preview 假資料：下載僅包含 3 張示範圖片與 CSV，不會下載上述展示容量。",
          "notice info",
        ),
      );
    const list = element("div", "", "export-packages");
    results.append(list);
    for (const p of job.packages) {
      const row = element("article", "", "export-package");
      row.dataset.package = String(p.number);
      const info = element("div");
      info.append(
        element("strong", String(p.number).padStart(3, "0")),
        element("p", `${p.image_count} 張 · ${bytes(p.total_bytes)}`),
      );
      const status = element(
        "span",
        states[p.status],
        "status " +
          (p.status === "completed" ? "approved" : p.status === "failed" ? "rejected" : "pending"),
      );
      status.dataset.exportState = p.status;
      const download = button(
        p.status === "completed" ? "再次下載" : p.status === "failed" ? "重新下載" : p.status === "in_progress" ? "重新開始" : "下載",
        () => void downloadPackage(p),
        "btn btn-primary",
      );
      download.disabled = Boolean(active || batch || preparing);
      row.append(info, status, download);
      list.append(row);
    }
    const next = job.packages.find((p) => p.status !== "completed");
    if (next) {
      const b = button("下載下一包", () => void downloadPackage(next));
      b.disabled = Boolean(active || batch || preparing);
      results.append(b);
    }
    const all=button("批次全下載",()=>void downloadAll());all.disabled=Boolean(active||batch||preparing);results.append(all);
    results.append(element('p','依包號逐包下載此快照的全部套件，包含已完成套件。瀏覽器可能要求允許多個檔案下載；若被阻擋，請允許後使用各包「再次下載」。','tiny'));
    if(batch)results.append(button('停止批次下載',()=>{batch.cancelled=true;message.textContent='已要求停止；目前這包結束後不再下載下一包。';}));
  }
  async function downloadAll() {
    if(active||preparing||batch||querying||!current())return;
    const snapshot=job,queue=[...job.packages].sort((a,b)=>a.number-b.number),run={cancelled:false};batch=run;render();
    form.inert=history.inert=true;
    try{for(const p of queue){if(run.cancelled||!current()||job!==snapshot)break;if(!await downloadPackage(p,true)){run.cancelled=true;break;}}
      if(!run.cancelled&&current())message.textContent='全部套件已依序產生。請確認瀏覽器下載清單；多檔下載可能需要允許瀏覽器權限。';
    }finally{batch=null;form.inert=history.inert=false;if(current())render();}
  }
  async function downloadPackage(p, fromBatch=false) {
    if (active || preparing || (batch&&!fromBatch) || querying || !current()) return false;
    preparing=true;render();form.inert=history.inert=true;
    const downloadJob = job,
      filename = packageFilename(downloadJob, p.number);
    let handle = null,
      sink = null;
    try {
      if (!job.preview_sample && job.filters.package_bytes > EXPORT_LIMITS.blobMaxBytes) {
        if (typeof window.showSaveFilePicker !== "function") throw Error("EXPORT_DISK_REQUIRED");
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: "ZIP", accept: { "application/zip": [".zip"] } }],
        });
      }
    } catch (e) {
      message.textContent =
        e.name === "AbortError"
          ? "已取消選擇檔案。"
          : "此套件需支援直接寫檔的瀏覽器；請使用 64 MiB 相容模式重新查詢。";
      preparing=false;form.inert=history.inert=Boolean(batch);if(current())render();return false;
    }
    if (!current()) {preparing=false;return false;}
    let worker;
    try {
      worker = new Worker(new URL("./export-worker.js", import.meta.url), { type: "module" });
    } catch {
      message.textContent = "瀏覽器無法啟動 ZIP 工作，請更新瀏覽器後重試。";
      preparing=false;form.inert=history.inert=Boolean(batch);if(current())render();return false;
    }
    const attempt = crypto.randomUUID(),
      abort = new AbortController(),
      chunks = [];
    active = { worker, abort };
    preparing=false;
    render();
    form.inert = history.inert = true;
    const progress = element("p", "正在準備下載…");
    progress.id = "export-progress";
    progress.setAttribute("role", "status");
    const cancel = button("取消", () => {
      if(batch)batch.cancelled=true;
      abort.abort();
      worker.postMessage({ type: "cancel" });
      worker.terminate();
      active.reject?.(new DOMException("Cancelled", "AbortError"));
    });
    results.append(progress, cancel);
    // A fixed mobile bottom nav must not cover the newly appended Cancel.
    if (matchMedia('(max-width: 980px)').matches) cancel.scrollIntoView({block:'center',behavior:'instant'});
    let written = 0,
      started = false,
      saved = false,
      readOnly = p.status === 'completed',
      succeeded = false;
    const state = (status) =>
      post(`jobs/${downloadJob.id}/packages/${p.number}/state`, {
        attempt_id: attempt,
        status,
        ...(status === "failed"
          ? { error_code: abort.signal.aborted ? "EXPORT_CANCELLED" : "EXPORT_DOWNLOAD_FAILED" }
          : {}),
      });
    try {
      const data = await post(`jobs/${downloadJob.id}/packages/${p.number}/start`, {
        attempt_id: attempt,
        expected_attempt_id: p.attempt_id ?? null,
      });
      started = true;
      readOnly=readOnly||data.read_only===true;
      p.attempt_id = data.package.attempt_id;
      if(!readOnly)p.status = "in_progress";
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (handle) sink = await handle.createWritable();
      const sample = await session.exportSample?.();
      if (
        !sink &&
        !sample &&
        data.items.reduce((sum, i) => sum + i.file_size, 0) > EXPORT_LIMITS.blobMaxBytes
      )
        throw Error("EXPORT_MEMORY_LIMIT");
      await new Promise((resolve, reject) => {
        active.reject = reject;
        worker.onerror = () => reject(Error("EXPORT_DOWNLOAD_FAILED"));
        worker.onmessage = (event) => {
          const d = event.data;
          if (d.type === "progress")
            progress.textContent = `${d.phase}：${d.processed} / ${d.total} 張 · ${bytes(d.downloaded)} / ${bytes(d.totalBytes)}`;
          if (d.type === "chunk")
            void (async () => {
              try {
                if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
                written += d.bytes.byteLength;
                if (!sink && written > EXPORT_LIMITS.blobMaxBytes + 1024 * 1024)
                  throw Error("EXPORT_MEMORY_LIMIT");
                if (sink) await sink.write(d.bytes);
                else chunks.push(d.bytes);
                worker.postMessage({ type: "ack" });
              } catch (e) {
                reject(e);
              }
            })();
          if (d.type === "error") reject(Object.assign(Error(d.code), { code: d.code }));
          if (d.type === "done") resolve();
        };
        worker.postMessage({
          type: "start",
          items: data.items,
          proofBase:
            location.origin +
            `/api/admin/image-exports/jobs/${downloadJob.id}/packages/${p.number}/attempts/${p.attempt_id}/files/`,
          ...(sample ? { sample } : {}),
        });
      });
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      if (sink) {
        await sink.close();
        sink = null;
      } else {
        const blob = new Blob(chunks, { type: "application/zip" }),
          url = URL.createObjectURL(blob),
          link = element("a");
        link.href = url;
        link.download = filename;
        root.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      }
      if (abort.signal.aborted) throw new DOMException("Cancelled", "AbortError");
      saved = true;
      cancel.disabled = true;
      if(!readOnly)await state("completed");
      p.status = "completed";
      succeeded=true;
      message.textContent = readOnly ? "ZIP 已再次產生；原本已完成狀態保持不變。" : "ZIP 已產生，完成狀態已保存。";
    } catch (error) {
      await sink?.abort().catch(() => {});
      sink = null;
      if(readOnly){
        p.status='completed';message.textContent=abort.signal.aborted?'再次下載已取消；原本已完成狀態保持不變。':'再次下載未完成；原本已完成狀態保持不變。'+notice(error);
      } else if (saved) {
        message.textContent = "ZIP 已產生，但完成回覆未確認。可單獨重送確認，不需要重新下載。";
        const ack = button("重送完成確認", () => {
          if (active) return;
          void state("completed")
            .then(() => {
              p.status = "completed";
              if (job === downloadJob) render();
              ack.remove();
              message.textContent = "完成狀態已保存。";
            })
            .catch((e) => (message.textContent = notice(e)));
        });
        root.append(ack);
      } else {
        if (started) {
          await state("failed").catch(() => {});
          p.status = "failed";
        }
        message.textContent = abort.signal.aborted
          ? "下載已取消；本包未完成，可重新下載。"
          : notice(error);
      }
    } finally {
      worker.terminate();
      chunks.length = 0;
      active = null;
      form.inert = history.inert = Boolean(batch);
      if (current()) render();
    }
    return succeeded;
  }
  signal.addEventListener(
    "abort",
    () => {
      if(batch)batch.cancelled=true;
      active?.abort.abort();
      active?.worker.terminate();
      active?.reject?.(new DOMException("Cancelled", "AbortError"));
    },
    { once: true },
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (querying || active || batch || preparing) return;
    void (async () => {
      querying = true;
      query.disabled = true;
      try {
        const checked = (name) =>
            [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((i) => i.value),
          filters = {
            from: from.value,
            to: to.value,
            campaign_id: campaign.value || null,
            entire_campaign: entire.checked,
            statuses: checked("statuses"),
            vote_types: checked("vote_types"),
            sources: checked("sources"),
            package_bytes: Number(mode.value),
          };
        const count = await post("query", filters);
        message.textContent = `查詢結果：${count.image_count.toLocaleString()} 張 · ${bytes(count.total_bytes)}，正在固定下載包…`;
        const key = JSON.stringify(filters);
        if (pendingJob?.key !== key) pendingJob = { key, id: crypto.randomUUID() };
        job = await post("jobs", { job_id: pendingJob.id, filters });
        pendingJob = null;
        if (current()) {
          render();
          message.textContent = "下載包已固定。每次點擊只下載一包。";
          await refreshHistory();
        }
      } catch (e) {
        message.textContent = notice(e);
      } finally {
        querying = false;
        query.disabled = false;
      }
    })();
  });
  const campaigns = await request("campaigns?limit=50");
  for (const row of campaigns.campaigns) campaign.append(new Option(row.name, row.campaign_id));
  let cursor = campaigns.next_cursor;
  if (cursor) {
    const more = button(
      "載入更多活動",
      () =>
        void (async () => {
          try {
            const data = await request("campaigns?limit=50&cursor=" + encodeURIComponent(cursor));
            for (const row of data.campaigns)
              campaign.append(new Option(row.name, row.campaign_id));
            cursor = data.next_cursor;
            more.hidden = !cursor;
          } catch (e) {
            message.textContent = notice(e);
          }
        })(),
    );
    form.append(more);
  }
  const jobs = await refreshHistory();
  if (jobs?.length) await loadJob(jobs[0].id);
}
