import { AdminAccess, dailyLimit, taipeiInput, utcFromTaipei, reviewActions, adminMessage } from "./admin-api.js";
import { PublicError } from "./api.js";

const $ = id => document.getElementById(id);
const node = (tag, text = "", cls) => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
const statusNames = { pending: "待審核", approved: "已通過", completed: "已完成", rejected: "未通過", duplicate: "重複投稿", revoked: "已撤銷", draft: "草稿", active: "開放", closed: "已結束", archived: "已封存", disabled: "未啟用" };
const reviewNames = { approve: "通過", reject: "不通過", mark_duplicate: "標記重複", complete: "完成案件", revoke: "撤銷通過" };
const stamp = value => { const d = new Date(value); return Number.isFinite(d.valueOf()) ? d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—"; };
const text = value => value == null ? "—" : String(value);
const button = (label, action, cls = "btn btn-white") => { const b = node("button", label, cls); b.type = "button"; b.addEventListener("click", action); return b; };
function field(form, name, label, type = "text", value = "", options = {}) {
  const wrap = node("div", "", "field"), caption = node("label", label), id = "admin-field-" + name;
  const control = node(type === "textarea" ? "textarea" : type === "select" ? "select" : "input");
  caption.htmlFor = control.id = id; control.name = name;
  if (type === "select") for (const [key, title] of options.choices ?? []) control.append(new Option(title, key));
  else if (type !== "textarea") control.type = type;
  control.value = value ?? ""; control.autocomplete = "off";
  for (const [key, val] of Object.entries(options)) if (key !== "choices") control[key] = val;
  wrap.append(caption, control); form.append(wrap); return control;
}
const value = (form, name) => form.elements.namedItem(name).value.trim();
const integer = (form, name, min, max) => {
  const raw = value(form, name), n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new PublicError("INVALID_ADMIN_QUERY", 400);
  return n;
};
const submitButton = (form, label) => { const b = node("button", label, "btn btn-primary"); b.type = "submit"; form.append(b); };
const management = actor => ["admin", "super_admin"].includes(actor?.role);
const tabs = { cases: "案件審核", campaigns: "活動管理", leaderboards: "排行榜管理", tiers: "會員等級", submissions: "投稿設定", audit: "操作紀錄" };

export function adminUI(session) {
  let visible = false, tab = "cases", sequence = 0, busy = false, controller = new AbortController(), urls = [], confirmedRole = null;
  function clearImages() { for (const url of urls) URL.revokeObjectURL(url); urls = []; }
  function clearPanel() { sequence++; controller.abort(); controller = new AbortController(); clearImages(); $("admin-panel").replaceChildren(); $("admin-panel").setAttribute("aria-busy", "false"); $("admin-panel").inert = $("admin-tabs").inert = false; busy = false; }
  const access = new AdminAccess(session, actor => {
    $("admin-nav-group").hidden = $("member-admin-entry").hidden = !actor;
    $("admin-content").hidden = !actor; $("admin-gate").hidden = Boolean(actor);
    if (!actor) { confirmedRole = null; clearPanel(); $("admin-tabs").replaceChildren(); if (visible) $("admin-status").textContent = "請重新確認權限或重新驗證身份。"; }
    else {
      const changedRole = confirmedRole && confirmedRole !== actor.role; confirmedRole = actor.role;
      if (changedRole) { clearPanel(); if (visible) queueMicrotask(() => void load()); }
    }
  });
  async function run(action, expected = sequence) {
    if (busy || !visible || expected !== sequence) return;
    busy = true; $("admin-panel").setAttribute("aria-busy", "true"); $("admin-status").textContent = "正在載入或處理資料…";
    $("admin-panel").inert = $("admin-tabs").inert = true;
    const controls = [...$("admin-panel").querySelectorAll("button")]; for (const b of controls) b.disabled = true;
    try {
      await action(() => visible && sequence === expected, { signal: controller.signal });
      if (sequence === expected && visible) $("admin-status").textContent = "";
    } catch (error) {
      if (["ADMIN_FORBIDDEN", "ADMIN_STEP_UP_REQUIRED", "AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(error.code) && access.actor) access.clear();
      if (visible && (sequence === expected || !access.actor)) {
        $("admin-status").textContent = adminMessage(error);
        // Uncertain/conflicting mutation is never repeated. Require an explicit
        // fresh read before the next edit, even if the old form remains visible.
        if (error.status === 409) { clearPanel(); $("admin-panel").append(button("重新載入確認", () => void load())); }
      }
    } finally {
      if (sequence === expected) { busy = false; $("admin-panel").setAttribute("aria-busy", "false"); $("admin-panel").inert = $("admin-tabs").inert = false; for (const b of controls) if (b.isConnected) b.disabled = false; }
    }
  }
  const request = async (path, options = {}) => {
    const born = sequence, data = await access.request("/api/admin/" + path, { ...options, signal: controller.signal });
    if (!visible || born !== sequence) throw new PublicError("REQUEST_CANCELLED");
    return data;
  };
  const mutate = (path, body) => request(path, { method: "POST", body });
  function heading(title, copy) { $("admin-panel").append(node("h2", title)); if (copy) $("admin-panel").append(node("p", copy, "tiny")); }
  function formCard(title) { const f = node("form", "", "admin-editor"); f.noValidate = false; f.append(node("h3", title)); $("admin-panel").append(f); return f; }
  function bindForm(form, action) {
    const born = sequence;
    form.addEventListener("submit", event => { event.preventDefault(); if (!form.reportValidity()) return; void run(async current => {
      if (!window.confirm("確定送出這次變更？")) return;
      await action(); if (current()) { await load(); $("admin-status").textContent = "變更已完成。"; }
    }, born); });
  }
  function rowsTable(rows, fields) {
    const wrap = node("div", "", "table-wrap"), table = node("table"), head = node("tr"), body = node("tbody");
    for (const [, label] of fields) { const th = node("th", label); th.scope = "col"; head.append(th); }
    const thead = node("thead"); thead.append(head); table.append(thead);
    for (const row of rows) { const tr = node("tr"); for (const [key] of fields) tr.append(node("td", text(row[key]))); body.append(tr); }
    table.append(body); wrap.append(table); return wrap;
  }
  function detailFields(data, fields) {
    const dl = node("dl", "", "case-details");
    for (const [label, val] of fields) dl.append(node("dt", label), node("dd", text(val)));
    return dl;
  }
  async function paged(path, key, render, filters = new URLSearchParams()) {
    const list = node("div", "", "grid grid-2"), more = button("載入更多", () => void run(async current => { await page(cursor, current); }));
    let cursor = null; const born = sequence;
    const page = async (after, current = () => sequence === born && visible) => {
      const params = new URLSearchParams(filters); params.set("limit", "20"); if (after) params.set("cursor", after);
      const data = await request(path + "?" + params);
      if (!current()) return;
      if (!Array.isArray(data[key])) throw new PublicError("SERVICE_UNAVAILABLE");
      for (const row of data[key]) list.append(render(row));
      cursor = data.next_cursor; more.hidden = !cursor;
      if (!list.children.length) list.append(node("p", path === "cases" ? "目前沒有符合條件的案件。" : path === "audit-logs" ? "目前沒有操作紀錄。" : "目前沒有資料。"));
    };
    $("admin-panel").append(list, more); await page(null);
  }
  async function cases() {
    heading("案件審核", "圖片僅供授權審核。案件狀態與點數以審核結果為準。");
    const filters = node("form", "", "admin-filter"), params = new URLSearchParams();
    const status = field(filters, "filter-status", "案件狀態", "select", "", { choices: [["", "全部"], ...["pending", "approved", "completed", "rejected", "duplicate", "revoked"].map(k => [k, statusNames[k]])] });
    const campaign = field(filters, "filter-campaign", "活動代號", "text", "", { maxLength: 100 });
    const vote = field(filters, "filter-vote", "投票類型", "select", "", { choices: [["", "全部"], ["Solo", "Solo"], ["團體", "團體"]] });
    submitButton(filters, "篩選"); $("admin-panel").append(filters);
    const area = node("section"); $("admin-panel").append(area);
    const render = row => {
      const card = node("article", "", "member-case"); card.append(node("strong", row.case_id), node("p", row.nickname), node("span", statusNames[row.status] ?? "狀態更新中", "status"), node("p", stamp(row.created_at)), button("查看與審核", () => void caseDetail(row.case_id))); return card;
    };
    const loadFiltered = async () => {
      // Lists are attached to the panel; remove only the prior list/page button.
      while (area.nextSibling) area.nextSibling.remove();
      await paged("cases", "cases", render, params);
    };
    filters.addEventListener("submit", event => { event.preventDefault(); if (busy) return; params.delete("status"); params.delete("campaign_id"); params.delete("vote_type");
      if (status.value) params.set("status", status.value); if (campaign.value.trim()) params.set("campaign_id", campaign.value.trim()); if (vote.value) params.set("vote_type", vote.value);
      void run(loadFiltered);
    }); await loadFiltered();
  }
  async function caseDetail(id) {
    if (busy) return; clearPanel();
    await run(async current => {
      const data = await request("cases/" + encodeURIComponent(id)); if (!current()) return;
      heading("案件審核"); $("admin-panel").append(button("返回案件列表", () => void load()), detailFields(data, [["案件編號", data.case_id], ["投稿者", data.nickname], ["玩家 ID", data.player_id], ["活動", data.campaign_id], ["投票日期", data.vote_date], ["類型", data.vote_type], ["投稿時間", stamp(data.created_at)], ["狀態", statusNames[data.status]], ["審核說明", data.status_reason], ["備註", data.note], ["已給點數", data.points_awarded]]));
      const preview = node("div", "", "admin-proof-grid"); $("admin-panel").append(preview);
      for (const [index, file] of data.files.entries()) {
        const card = node("article", "", "member-case"), loadProof = button("查看證明 " + (index + 1), () => void run(async stillCurrent => {
          await access.check(controller.signal);
          const blob = await session.adminProof("/api/admin/cases/" + data.case_id + "/files/" + file.file_id, controller.signal);
          if (!stillCurrent()) return;
          const url = URL.createObjectURL(blob), img = node("img"); urls.push(url); img.src = url; img.alt = "投票證明 " + (index + 1); card.replaceChildren(img);
        })); card.append(loadProof); preview.append(card);
      }
      const choices = reviewActions(data.status, access.actor.role); if (!choices.length) { $("admin-panel").append(node("p", "此狀態目前沒有可用審核操作。")); return; }
      const form = formCard("更新審核結果");
      const action = field(form, "action", "審核操作", "select", choices[0], { choices: choices.map(key => [key, reviewNames[key]]) });
      const reason = field(form, "reason", "審核說明", "textarea", "", { maxLength: 500 });
      const duplicate = field(form, "duplicate", "原案件編號（標記重複時必填）", "text", "", { maxLength: 28 });
      const sync = () => { reason.required = ["reject", "mark_duplicate", "revoke"].includes(action.value); duplicate.disabled = action.value !== "mark_duplicate"; duplicate.required = !duplicate.disabled; };
      action.addEventListener("change", sync); sync(); submitButton(form, "確認審核結果");
      bindForm(form, () => mutate("cases/" + data.case_id + "/review", { action: action.value, expected_version: data.version, reason: reason.value.trim() || null, ...(action.value === "mark_duplicate" ? { duplicate_of_case_id: duplicate.value.trim() } : {}) }));
    });
  }
  async function campaigns() {
    heading("活動管理", "活動開放與投稿開關分別設定。開放活動不會自動開啟投稿。");
    $("admin-panel").append(button("建立活動", () => campaignEditor(null), "btn btn-primary"));
    await paged("campaigns", "campaigns", row => {
      const c = node("article", "", "member-case"); c.append(node("h3", row.name), node("span", statusNames[row.status], "status"), node("p", stamp(row.start_at) + " ～ " + stamp(row.end_at) + "（台灣時間）"), node("p", `每次通過 ${row.points_per_proof} 點 · ` + (row.daily_limit === null ? "每日計分：不限次數" : row.daily_limit === 0 ? "本活動不計分" : `每日最多 ${row.daily_limit} 次計分`)), button(row.status === "archived" ? "查看活動" : "編輯活動", () => campaignEditor(row))); return c;
    });
  }
  function campaignEditor(row) {
    if (busy) return; clearPanel(); heading("活動管理", "下方起訖時間以台灣時間輸入。已開放的活動不能變更期間與時區。");
    const f = formCard(row ? "編輯活動" : "建立活動"), locked = row && row.status !== "draft";
    if (!row) field(f, "campaign_id", "活動代號（英文、數字、連字號）", "text", "", { required: true, pattern: "[A-Za-z0-9][A-Za-z0-9_-]{0,99}", maxLength: 100 });
    field(f, "name", "活動名稱", "text", row?.name, { required: true, maxLength: 100 }); field(f, "category", "活動分類", "text", row?.category, { required: true, maxLength: 50 });
    field(f, "start_at", "開始時間（台灣時間）", "datetime-local", taipeiInput(row?.start_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "end_at", "結束時間（台灣時間）", "datetime-local", taipeiInput(row?.end_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "campaign_timezone", "活動計分時區", "text", row?.campaign_timezone ?? "Asia/Taipei", { required: true, maxLength: 100, disabled: Boolean(locked) });
    field(f, "points_per_proof", "每次通過點數", "number", row?.points_per_proof ?? "", { required: true, min: 0, max: 1000000, step: 1 });
    const mode = field(f, "daily_mode", "每日計分規則", "select", row?.daily_limit === null ? "unlimited" : row?.daily_limit === 0 ? "zero" : "limited", { choices: [["unlimited", "不限次數"], ["zero", "不計分"], ["limited", "限制次數"]] });
    const cap = field(f, "daily_limit", "每日最多計分次數", "number", row?.daily_limit ?? "", { min: 1, max: 1000, step: 1 });
    const sync = () => { cap.disabled = mode.value !== "limited"; cap.required = !cap.disabled; }; mode.addEventListener("change", sync); sync();
    const statuses = row ? ({ draft: ["draft", "active", "archived"], active: ["active", "closed"], closed: ["closed", "archived"], archived: ["archived"] }[row.status]) : ["draft", "active"];
    field(f, "status", "活動狀態", "select", row?.status ?? "draft", { choices: statuses.map(key => [key, statusNames[key]]) }); field(f, "note", "活動說明（選填）", "textarea", row?.note, { maxLength: 1000 });
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", "已封存的活動無法修改。")); }
    else { submitButton(f, "保存活動"); bindForm(f, () => mutate(row ? "campaigns/" + row.campaign_id + "/update" : "campaigns", {
      ...(row ? { expected_version: row.version } : { campaign_id: value(f, "campaign_id") }), name: value(f, "name"), category: value(f, "category"),
      start_at: locked ? row.start_at : utcFromTaipei(value(f, "start_at")), end_at: locked ? row.end_at : utcFromTaipei(value(f, "end_at")), campaign_timezone: row?.campaign_timezone && locked ? row.campaign_timezone : value(f, "campaign_timezone"),
      points_per_proof: integer(f, "points_per_proof", 0, 1000000), daily_limit: dailyLimit(mode.value, cap.value), status: value(f, "status"), note: value(f, "note") || null,
    })); } f.append(button("返回活動列表", () => void load()));
  }
  async function boards() {
    heading("排行榜管理", "成績來自正式應援點數。重建完成前保留上一版結果；名次與點數不可直接編輯。");
    $("admin-panel").append(button("建立排行榜", () => boardEditor(null), "btn btn-primary"));
    await paged("leaderboards", "leaderboards", row => {
      const c = node("article", "", "member-case"); c.append(node("h3", row.name), node("span", statusNames[row.status], "status"), node("p", row.is_public ? "公開" : "不公開"));
      c.append(button("查看設定", () => boardEditor(row)), button("查看目前成績", () => void boardResults(row)));
      if (row.status !== "archived") c.append(button("重建成績", () => { if (window.confirm("重建此排行榜？成功後將更新公開成績。")) void run(async current => { await mutate("leaderboards/" + row.leaderboard_id + "/rebuild", { expected_version: row.version }); if (current()) await load(); }); })); return c;
    });
  }
  async function boardResults(row) {
    if (busy) return; clearPanel(); await run(async current => {
      const data = await request("leaderboards/" + row.leaderboard_id + "/results"); if (!current()) return;
      heading(row.name); const board = data.leaderboards?.find(b => b.leaderboard_id === row.leaderboard_id);
      $("admin-panel").append(board?.rankings?.length ? rowsTable(board.rankings, [["rank", "名次"], ["nickname", "暱稱"], ["points", "點數"], ["proof_count", "證明數"]]) : node("p", "目前沒有已發布成績。"), button("返回排行榜管理", () => void load()));
    });
  }
  function boardEditor(row) {
    if (busy) return; clearPanel(); heading("排行榜管理"); const f = formCard(row ? "編輯排行榜" : "建立排行榜");
    if (!row) field(f, "leaderboard_id", "排行榜代號", "text", "", { required: true, maxLength: 100, pattern: "[A-Za-z0-9][A-Za-z0-9_-]{0,99}" });
    field(f, "name", "排行榜名稱", "text", row?.name, { required: true, maxLength: 100 });
    const type = field(f, "type", "範圍", "select", row?.type ?? "all_time", { choices: [["all_time", "全部應援紀錄"], ["campaign", "指定活動"], ["custom", "指定投票日期"]] });
    const campaign = field(f, "campaign_id", "活動代號（指定活動必填）", "text", row?.campaign_id, { maxLength: 100 });
    const start = field(f, "start_date", "開始投票日期", "date", row?.start_date), end = field(f, "end_date", "結束投票日期", "date", row?.end_date);
    const sync = () => { campaign.disabled = type.value === "all_time"; campaign.required = type.value === "campaign"; start.disabled = end.disabled = type.value !== "custom"; start.required = end.required = !start.disabled; };
    type.addEventListener("change", sync); sync();
    field(f, "vote_type", "投票類型", "select", row?.vote_type ?? "", { choices: [["", "全部"], ["Solo", "Solo"], ["團體", "團體"]] });
    field(f, "top_n", "顯示名次數", "number", row?.top_n ?? "", { required: true, min: 1, max: 100, step: 1 });
    field(f, "is_public", "公開設定", "select", row?.is_public ? "true" : "false", { choices: [["false", "不公開"], ["true", "公開"]] });
    field(f, "status", "排行榜狀態", "select", row?.status ?? "draft", { choices: (row?.status === "archived" ? ["archived"] : row?.status === "active" ? ["active", "archived"] : ["draft", "active", ...(row ? ["archived"] : [])]).map(k => [k, statusNames[k]]) });
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", "已封存的排行榜不能修改。")); }
    else { submitButton(f, "保存排行榜"); bindForm(f, () => mutate(row ? "leaderboards/" + row.leaderboard_id + "/update" : "leaderboards", {
      ...(row ? { expected_version: row.version } : { leaderboard_id: value(f, "leaderboard_id") }), name: value(f, "name"), type: type.value,
      campaign_id: type.value === "all_time" ? null : campaign.value.trim() || null, start_date: type.value === "custom" ? start.value : null, end_date: type.value === "custom" ? end.value : null,
      vote_type: value(f, "vote_type") || null, top_n: integer(f, "top_n", 1, 100), is_public: value(f, "is_public") === "true", status: value(f, "status"),
    })); } f.append(button("返回排行榜列表", () => void load()));
  }
  async function tiers() {
    heading("會員等級", "門檻需由低到高依序設定；未啟用的等級不會授予會員。");
    const data = await request("member-tiers");
    for (const row of data.tiers) {
      const card = node("article", "", "member-case"); card.append(node("h3", row.name), node("span", row.status === "active" ? "已啟用" : "未啟用", "status"), node("p", row.min_points === null ? "門檻尚未設定" : `門檻：${row.min_points} 點`));
      if (row.tier_id !== "normal") card.append(button("編輯等級", () => {
        if (busy) return; clearPanel(); heading("會員等級"); const f = formCard(row.name);
        field(f, "min_points", "點數門檻", "number", row.min_points ?? "", { required: true, min: 1, max: 1000000000, step: 1 });
        field(f, "status", "狀態", "select", row.status, { choices: [["disabled", "未啟用"], ["active", "已啟用"]] });
        field(f, "reason", "變更原因", "textarea", "", { required: true, maxLength: 500 }); submitButton(f, "保存等級");
        bindForm(f, () => mutate("member-tiers/" + row.tier_id + "/update", { min_points: integer(f, "min_points", 1, 1000000000), status: value(f, "status"), reason: value(f, "reason"), expected_version: row.version })); f.append(button("返回會員等級", () => void load()));
      })); $("admin-panel").append(card);
    }
  }
  async function submissions() {
    heading("投稿設定", "關閉後將停止所有新投稿；案件查詢與其他功能不受影響。活動開放不會自動啟用投稿。");
    const data = await request("submissions"), f = formCard("投稿功能");
    const enabled = field(f, "submissions_enabled", "投稿功能", "select", String(data.submissions_enabled), { choices: [["false", "OFF · 關閉"], ["true", "ON · 開放"]] });
    field(f, "submissions_message", "公開訊息（選填）", "textarea", data.submissions_message ?? "", { maxLength: 500 }); submitButton(f, "保存投稿設定");
    const born = sequence;
    f.addEventListener("submit", event => { event.preventDefault(); if (!f.reportValidity()) return;
      if (!window.confirm(enabled.value === "true" && !data.submissions_enabled ? "確定開放所有新投稿？仍需要有效活動；請確認正式驗收已完成。" : "確定保存投稿設定？")) return;
      void run(async current => { await mutate("submissions/update", { submissions_enabled: enabled.value === "true", submissions_message: value(f, "submissions_message") || null, expected_version: data.version });
        if (current()) { document.dispatchEvent(new Event("voteproof-submissions-updated")); await load(); }
      }, born);
    });
  }
  async function audit() {
    heading("操作紀錄", "顯示可查閱的管理操作，不等同會員點數明細。");
    await paged("audit-logs", "logs", row => {
      const labels = { approve: "通過案件", reject: "不通過案件", mark_duplicate: "標記重複", complete: "完成案件", revoke: "撤銷通過", case_approve: "通過案件", case_reject: "不通過案件", case_mark_duplicate: "標記重複", case_complete: "完成案件", case_revoke: "撤銷通過", campaign_create: "建立活動", campaign_update: "更新活動", leaderboard_create: "建立排行榜", leaderboard_update: "更新排行榜", leaderboard_rebuild: "重建排行榜", leaderboard_archive: "封存排行榜", member_tier_update: "更新會員等級", admin_bootstrap: "建立初始管理員", manual_adjustment: "調整點數" };
      const c = node("article", "", "member-case"); c.append(node("h3", labels[row.action] ?? "管理操作"), node("p", stamp(row.created_at)), detailFields(row, [["操作會員", row.admin_member_id], ["目標", row.target_id], ["原因", row.reason]])); return c;
    });
  }
  const loaders = { cases, campaigns, leaderboards: boards, tiers, submissions, audit };
  async function load() {
    if (!visible) return; clearPanel(); const born = sequence;
    await run(async current => {
      const actor = await access.check(controller.signal); if (!current()) return;
      if (!management(actor)) tab = "cases";
      $("admin-tabs").replaceChildren();
      for (const [key, label] of Object.entries(tabs)) if (key === "cases" || management(actor)) {
        const b = button(label, () => { if (!busy) { tab = key; void load(); } }, "btn " + (tab === key ? "btn-primary" : "btn-white")); b.setAttribute("aria-pressed", String(tab === key)); $("admin-tabs").append(b);
      }
      $("admin-panel").append(button("重新載入", () => void load())); await loaders[tab]();
    }, born);
  }
  $("admin-retry").addEventListener("click", () => void load());
  document.addEventListener("voteproof-security-verified", () => { void access.check().catch(() => {}); });
  // Revalidate on return without erasing an editor, or restarting any write.
  const recheck = () => { if (access.actor && !busy) void access.check().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recheck(); });
  window.addEventListener("focus", recheck);
  window.addEventListener("pagehide", () => access.clear());
  return { identity(member) { const previous = access.owner; access.identity(member); if (visible && member && previous !== member.member_id) void load(); }, enter(view) { const next = view === "admin"; if (next === visible) return; visible = next; if (visible) void load(); else clearPanel(); } };
}
