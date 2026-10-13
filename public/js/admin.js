import { AdminAccess, dailyLimit, taipeiInput, utcFromTaipei, reviewActions, adminMessage } from "./admin-api.js";
import { PublicError } from "./api.js";
import { renderTierArtwork } from "./tier-artwork.js";
import { backupText, backupLink } from "./admin-backup.js";
import { renderDuplicateEvidence } from './admin-duplicate.js';

const $ = id => document.getElementById(id);
const copy = id => {
  const label = $("admin-ui-copy").content.getElementById(id);
  return label.textContent.trim() + (label.dataset.copySuffix ?? "");
};
const node = (tag, text = "", cls) => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
const { labels: backupLabels, errors: backupErrors } = backupText(copy);
const statusNames = { pending: copy("admin-copy-001"), approved: copy("admin-copy-002"), completed: copy("admin-copy-003"), rejected: copy("admin-copy-004"), duplicate: copy("admin-copy-005"), revoked: copy("admin-copy-006"), draft: copy("admin-copy-007"), active: copy("admin-copy-008"), closed: copy("admin-copy-009"), archived: copy("admin-copy-010"), disabled: copy("admin-copy-011") };
const reviewNames = { approve: copy("admin-copy-012"), reject: copy("admin-copy-013"), mark_duplicate: copy("admin-copy-014"), complete: copy("admin-copy-015"), revoke: copy("admin-copy-016") };
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
const tabs = { cases: copy("admin-copy-017"), campaigns: copy("admin-copy-018"), leaderboards: copy("admin-copy-019"), tiers: copy("admin-copy-020"), submissions: copy("admin-copy-021"), audit: copy("admin-copy-022") };

export function adminUI(session) {
  let visible = false, tab = "cases", sequence = 0, busy = false, controller = new AbortController(), urls = [], confirmedRole = null;
  function clearImages() { for (const url of urls) URL.revokeObjectURL(url); urls = []; }
  function clearPanel() { sequence++; controller.abort(); controller = new AbortController(); clearImages(); $("admin-panel").replaceChildren(); $("admin-panel").setAttribute("aria-busy", "false"); $("admin-panel").inert = $("admin-tabs").inert = false; busy = false; }
  const access = new AdminAccess(session, actor => {
    $("admin-nav-group").hidden = $("member-admin-entry").hidden = !actor;
    $("admin-content").hidden = !actor; $("admin-gate").hidden = Boolean(actor);
    if (!actor) { confirmedRole = null; clearPanel(); $("admin-tabs").replaceChildren(); if (visible) $("admin-status").textContent = copy("admin-copy-023"); }
    else {
      const changedRole = confirmedRole && confirmedRole !== actor.role; confirmedRole = actor.role;
      if (changedRole) { clearPanel(); if (visible) queueMicrotask(() => void load()); }
    }
  });
  async function run(action, expected = sequence) {
    if (busy || !visible || expected !== sequence) return;
    busy = true; $("admin-panel").setAttribute("aria-busy", "true"); $("admin-status").textContent = copy("admin-copy-024");
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
        if (error.status === 409) { clearPanel(); $("admin-panel").append(button(copy("admin-copy-025"), () => void load())); }
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
      if (!window.confirm(copy("admin-copy-026"))) return;
      await action(); if (current()) { await load(); $("admin-status").textContent = copy("admin-copy-027"); }
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
    const list = node("div", "", "grid grid-2"), more = button(copy("admin-copy-028"), () => void run(async current => { await page(cursor, current); }));
    let cursor = null; const born = sequence;
    const page = async (after, current = () => sequence === born && visible) => {
      const params = new URLSearchParams(filters); params.set("limit", "20"); if (after) params.set("cursor", after);
      const data = await request(path + "?" + params);
      if (!current()) return;
      if (!Array.isArray(data[key])) throw new PublicError("SERVICE_UNAVAILABLE");
      for (const row of data[key]) list.append(render(row));
      cursor = data.next_cursor; more.hidden = !cursor;
      if (!list.children.length) list.append(node("p", path === "cases" ? copy("admin-copy-029") : path === "audit-logs" ? copy("admin-copy-030") : copy("admin-copy-031")));
    };
    $("admin-panel").append(list, more); await page(null);
  }
  async function cases() {
    heading(copy("admin-copy-017"), copy("admin-copy-032"));
    if (management(access.actor)) await backupOverview();
    const filters = node("form", "", "admin-filter"), params = new URLSearchParams();
    const status = field(filters, "filter-status", copy("admin-copy-033"), "select", "", { choices: [["", copy("admin-copy-034")], ...["pending", "approved", "completed", "rejected", "duplicate", "revoked"].map(k => [k, statusNames[k]])] });
    const campaign = field(filters, "filter-campaign", copy("admin-copy-035"), "text", "", { maxLength: 100 });
    const vote = field(filters, "filter-vote", copy("admin-copy-036"), "select", "", { choices: [["", copy("admin-copy-034")], ["Solo", "Solo"], ["團體", "團體"]] });
    submitButton(filters, copy("admin-copy-037")); $("admin-panel").append(filters);
    const area = node("section"); $("admin-panel").append(area);
    const render = row => {
      const card = node("article", "", "member-case"); card.append(node("strong", row.case_id), node("p", row.nickname), node("span", statusNames[row.status] ?? copy("admin-copy-038"), "status"), node("p", stamp(row.created_at)), button(copy("admin-copy-039"), () => void caseDetail(row.case_id))); return card;
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
  async function backupOverview() {
    const box = node('section', '', 'member-case'); $('admin-panel').append(box);
    box.append(node('h3', copy('backup-title')));
    try {
      const data = await request('backups');
      box.append(node('p', Object.entries(backupLabels).map(([key, label]) => label + '：' + data.counts[key]).join(' · ')));
      if (!data.ready) box.append(node('p', copy(data.enabled ? 'backup-unconfigured' : 'backup-off'), 'tiny'));
      if (data.transport === 'apps_script_pull') box.append(node('p', copy('backup-relay'), 'tiny'));
      if (data.transport === 'apps_script_pull' && data.ready) box.append(node('p', copy('backup-ready'), 'tiny'));
      if (data.blocked_error_code) box.append(node('p', backupErrors[data.blocked_error_code] ?? backupErrors.INTERNAL, 'notice warn'));
      box.append(node('p', copy('backup-missing') + '：' + data.missing));
      // A bounded dry run first; enqueue requires a separate explicit confirmation.
      if (data.missing) box.append(button(copy('backup-check'), () => void run(async () => {
        const preview = await mutate('backups/backfill', { dry_run: true, limit: 25 });
        box.append(node('p', copy('backup-check-summary').replaceAll('{scanned}',preview.scanned).replaceAll('{ready}',preview.ready.length).replaceAll('{missing}',preview.missing.length).replaceAll('{changed}',preview.changed.length)));
        if (data.ready === true && preview.ready.length) box.append(button(copy('backup-enqueue'), () => void run(async () => {
          if (!window.confirm(copy('backup-enqueue-confirm'))) return;
          await mutate('backups/backfill', { dry_run: false, file_ids: preview.ready }); await load();
        })));
      })));
      for (const audit of data.audit ?? []) box.append(node('p', copy(audit.target_id?.startsWith('process:') ? 'backup-process' : audit.action === 'retry' ? 'backup-retry' : 'backup-enqueue') + ` · ${audit.affected_count} · ` + stamp(audit.created_at * 1000), 'tiny'));
    } catch (error) {
      if (['ADMIN_FORBIDDEN','ADMIN_STEP_UP_REQUIRED','AUTH_REQUIRED','MEMBER_SUSPENDED','REQUEST_CANCELLED'].includes(error.code)) throw error;
      box.append(node('p', copy('backup-unavailable'), 'tiny'));
    }
  }
  async function caseDetail(id) {
    if (busy) return; clearPanel();
    await run(async current => {
      const data = await request("cases/" + encodeURIComponent(id)); if (!current()) return;
      heading(copy("admin-copy-017")); $("admin-panel").append(button(copy("admin-copy-040"), () => void load()), detailFields(data, [[copy("admin-copy-041"), data.case_id], [copy("admin-copy-042"), data.nickname], [copy("admin-copy-043"), data.player_id], [copy("admin-copy-044"), data.campaign_id], [copy("admin-copy-045"), data.vote_date], [copy("admin-copy-046"), data.vote_type], [copy("admin-copy-047"), stamp(data.created_at)], [copy("admin-copy-048"), statusNames[data.status]], [copy("admin-copy-049"), data.status_reason], [copy("admin-copy-050"), data.note], [copy("admin-copy-051"), data.points_awarded]]));
      const backupBox = node('section', '', 'member-case'); backupBox.append(node('h3', copy('backup-title'))); $('admin-panel').append(backupBox);
      try {
        const backups = await request('cases/' + encodeURIComponent(id) + '/backups');
        if (!backups.ready) backupBox.append(node('p', copy(backups.enabled ? 'backup-unconfigured' : 'backup-off'), 'tiny'));
        if (!backups.backups.length) backupBox.append(node('p', copy('backup-missing')));
        for (const item of backups.backups) {
          backupBox.append(node('p', backupLabels[item.status] ?? copy('backup-unknown')));
          if (item.status === 'confirmed') {
            backupBox.append(node('p', stamp(item.completed_at * 1000)));
            const href = backupLink(item.drive_file_id);
            if (href) { const a = node('a', copy('backup-open')); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; backupBox.append(a); }
          }
          if (item.status === 'failed') {
            backupBox.append(node('p', backupErrors[item.last_error_code] ?? backupErrors.INTERNAL));
            if (backups.ready === true && management(access.actor)) backupBox.append(button(copy('backup-retry'), () => void run(async () => {
              if (!window.confirm(copy('backup-retry-confirm'))) return;
              await mutate('backups/' + item.id + '/retry', { expected_version: item.version }); await load();
            })));
          }
          if (backups.transport === 'deprecated_worker_oauth' && backups.ready === true && management(access.actor) && (item.status === 'pending' || (item.status === 'failed' && item.next_attempt_at != null))) {
            backupBox.append(button(copy('backup-process'), () => void run(async () => {
              if (!window.confirm(copy('backup-process-confirm'))) return;
              const result = await mutate('backups/' + item.id + '/process', {});
              if (result.state === 'failed' || result.state === 'unavailable') throw { code: 'BACKUP_PROCESS_FAILED' };
              await load();
            })));
          }
        }
      } catch (error) {
        if (['ADMIN_FORBIDDEN','ADMIN_STEP_UP_REQUIRED','AUTH_REQUIRED','MEMBER_SUSPENDED','REQUEST_CANCELLED'].includes(error.code)) throw error;
        backupBox.append(node('p', copy('backup-proof-unavailable')));
      }
      $("admin-panel").append(renderDuplicateEvidence(data.duplicate_evidence));
      const preview = node("div", "", "admin-proof-grid"); $("admin-panel").append(preview);
      for (const [index, file] of data.files.entries()) {
        const card = node("article", "", "member-case"), loadProof = button(copy("admin-copy-052") + (index + 1), () => void run(async stillCurrent => {
          await access.check(controller.signal);
          const blob = await session.adminProof("/api/admin/cases/" + data.case_id + "/files/" + file.file_id, controller.signal);
          if (!stillCurrent()) return;
          const url = URL.createObjectURL(blob), img = node("img"); urls.push(url); img.src = url; img.alt = copy("admin-copy-053") + (index + 1); card.replaceChildren(img);
        })); card.append(loadProof); preview.append(card);
      }
      const choices = reviewActions(data.status, access.actor.role); if (!choices.length) { $("admin-panel").append(node("p", copy("admin-copy-054"))); return; }
      const form = formCard(copy("admin-copy-055"));
      const action = field(form, "action", copy("admin-copy-056"), "select", choices[0], { choices: choices.map(key => [key, reviewNames[key]]) });
      const reason = field(form, "reason", copy("admin-copy-049"), "textarea", "", { maxLength: 500 });
      const duplicate = field(form, "duplicate", copy("admin-copy-057"), "text", "", { maxLength: 28 });
      const sync = () => { reason.required = ["reject", "mark_duplicate", "revoke"].includes(action.value); duplicate.disabled = action.value !== "mark_duplicate"; duplicate.required = !duplicate.disabled; };
      action.addEventListener("change", sync); sync(); submitButton(form, copy("admin-copy-058"));
      bindForm(form, () => mutate("cases/" + data.case_id + "/review", { action: action.value, expected_version: data.version, reason: reason.value.trim() || null, ...(action.value === "mark_duplicate" ? { duplicate_of_case_id: duplicate.value.trim() } : {}) }));
    });
  }
  async function campaigns() {
    heading(copy("admin-copy-018"), copy("admin-copy-059"));
    $("admin-panel").append(button(copy("admin-copy-060"), () => campaignEditor(null), "btn btn-primary"));
    await paged("campaigns", "campaigns", row => {
      const c = node("article", "", "member-case"); c.append(node("h3", row.name), node("span", statusNames[row.status], "status"), node("p", stamp(row.start_at) + " ～ " + stamp(row.end_at) + copy("admin-copy-061")), node("p", `每次通過 ${row.points_per_proof} 點 · ` + (row.daily_limit === null ? copy("admin-copy-062") : row.daily_limit === 0 ? copy("admin-copy-063") : `每日最多 ${row.daily_limit} 次計分`)), button(row.status === "archived" ? copy("admin-copy-064") : copy("admin-copy-065"), () => campaignEditor(row))); return c;
    });
  }
  function campaignEditor(row) {
    if (busy) return; clearPanel(); heading(copy("admin-copy-018"), copy("admin-copy-066"));
    const f = formCard(row ? copy("admin-copy-065") : copy("admin-copy-060")), locked = row && row.status !== "draft";
    if (!row) field(f, "campaign_id", copy("admin-copy-067"), "text", "", { required: true, pattern: "[A-Za-z0-9][A-Za-z0-9_-]{0,99}", maxLength: 100 });
    field(f, "name", copy("admin-copy-068"), "text", row?.name, { required: true, maxLength: 100 }); field(f, "category", copy("admin-copy-069"), "text", row?.category, { required: true, maxLength: 50 });
    field(f, "start_at", copy("admin-copy-070"), "datetime-local", taipeiInput(row?.start_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "end_at", copy("admin-copy-071"), "datetime-local", taipeiInput(row?.end_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "campaign_timezone", copy("admin-copy-072"), "text", row?.campaign_timezone ?? "Asia/Taipei", { required: true, maxLength: 100, disabled: Boolean(locked) });
    field(f, "points_per_proof", copy("admin-copy-073"), "number", row?.points_per_proof ?? "", { required: true, min: 0, max: 1000000, step: 1 });
    const mode = field(f, "daily_mode", copy("admin-copy-074"), "select", row?.daily_limit === null ? "unlimited" : row?.daily_limit === 0 ? "zero" : "limited", { choices: [["unlimited", copy("admin-copy-075")], ["zero", copy("admin-copy-076")], ["limited", copy("admin-copy-077")]] });
    const cap = field(f, "daily_limit", copy("admin-copy-078"), "number", row?.daily_limit ?? "", { min: 1, max: 1000, step: 1 });
    const sync = () => { cap.disabled = mode.value !== "limited"; cap.required = !cap.disabled; }; mode.addEventListener("change", sync); sync();
    const statuses = row ? ({ draft: ["draft", "active", "archived"], active: ["active", "closed"], closed: ["closed", "archived"], archived: ["archived"] }[row.status]) : ["draft", "active"];
    field(f, "status", copy("admin-copy-079"), "select", row?.status ?? "draft", { choices: statuses.map(key => [key, statusNames[key]]) }); field(f, "note", copy("admin-copy-080"), "textarea", row?.note, { maxLength: 1000 });
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", copy("admin-copy-081"))); }
    else { submitButton(f, copy("admin-copy-082")); bindForm(f, () => mutate(row ? "campaigns/" + row.campaign_id + "/update" : "campaigns", {
      ...(row ? { expected_version: row.version } : { campaign_id: value(f, "campaign_id") }), name: value(f, "name"), category: value(f, "category"),
      start_at: locked ? row.start_at : utcFromTaipei(value(f, "start_at")), end_at: locked ? row.end_at : utcFromTaipei(value(f, "end_at")), campaign_timezone: row?.campaign_timezone && locked ? row.campaign_timezone : value(f, "campaign_timezone"),
      points_per_proof: integer(f, "points_per_proof", 0, 1000000), daily_limit: dailyLimit(mode.value, cap.value), status: value(f, "status"), note: value(f, "note") || null,
    })); } f.append(button(copy("admin-copy-083"), () => void load()));
  }
  async function boards() {
    heading(copy("admin-copy-019"), copy("admin-copy-084"));
    $("admin-panel").append(button(copy("admin-copy-085"), () => boardEditor(null), "btn btn-primary"));
    await paged("leaderboards", "leaderboards", row => {
      const c = node("article", "", "member-case"); c.append(node("h3", row.name), node("span", statusNames[row.status], "status"), node("p", row.is_public ? copy("admin-copy-086") : copy("admin-copy-087")));
      c.append(button(copy("admin-copy-088"), () => boardEditor(row)), button(copy("admin-copy-089"), () => void boardResults(row)));
      if (row.status !== "archived") c.append(button(copy("admin-copy-090"), () => { if (window.confirm(copy("admin-copy-091"))) void run(async current => { await mutate("leaderboards/" + row.leaderboard_id + "/rebuild", { expected_version: row.version }); if (current()) await load(); }); })); return c;
    });
  }
  async function boardResults(row) {
    if (busy) return; clearPanel(); await run(async current => {
      const data = await request("leaderboards/" + row.leaderboard_id + "/results"); if (!current()) return;
      heading(row.name); const board = data.leaderboards?.find(b => b.leaderboard_id === row.leaderboard_id);
      $("admin-panel").append(board?.rankings?.length ? rowsTable(board.rankings, [["rank", copy("admin-copy-092")], ["nickname", copy("admin-copy-093")], ["points", copy("admin-copy-094")], ["proof_count", copy("admin-copy-095")]]) : node("p", copy("admin-copy-096")), button(copy("admin-copy-097"), () => void load()));
    });
  }
  function boardEditor(row) {
    if (busy) return; clearPanel(); heading(copy("admin-copy-019")); const f = formCard(row ? copy("admin-copy-098") : copy("admin-copy-085"));
    if (!row) field(f, "leaderboard_id", copy("admin-copy-099"), "text", "", { required: true, maxLength: 100, pattern: "[A-Za-z0-9][A-Za-z0-9_-]{0,99}" });
    field(f, "name", copy("admin-copy-100"), "text", row?.name, { required: true, maxLength: 100 });
    const type = field(f, "type", copy("admin-copy-101"), "select", row?.type ?? "all_time", { choices: [["all_time", copy("admin-copy-102")], ["campaign", copy("admin-copy-103")], ["custom", copy("admin-copy-104")]] });
    const campaign = field(f, "campaign_id", copy("admin-copy-105"), "text", row?.campaign_id, { maxLength: 100 });
    const start = field(f, "start_date", copy("admin-copy-106"), "date", row?.start_date), end = field(f, "end_date", copy("admin-copy-107"), "date", row?.end_date);
    const sync = () => { campaign.disabled = type.value === "all_time"; campaign.required = type.value === "campaign"; start.disabled = end.disabled = type.value !== "custom"; start.required = end.required = !start.disabled; };
    type.addEventListener("change", sync); sync();
    field(f, "vote_type", copy("admin-copy-036"), "select", row?.vote_type ?? "", { choices: [["", copy("admin-copy-034")], ["Solo", "Solo"], ["團體", "團體"]] });
    field(f, "top_n", copy("admin-copy-108"), "number", row?.top_n ?? "", { required: true, min: 1, max: 100, step: 1 });
    field(f, "is_public", copy("admin-copy-109"), "select", row?.is_public ? "true" : "false", { choices: [["false", copy("admin-copy-087")], ["true", copy("admin-copy-086")]] });
    field(f, "status", copy("admin-copy-110"), "select", row?.status ?? "draft", { choices: (row?.status === "archived" ? ["archived"] : row?.status === "active" ? ["active", "archived"] : ["draft", "active", ...(row ? ["archived"] : [])]).map(k => [k, statusNames[k]]) });
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", copy("admin-copy-111"))); }
    else { submitButton(f, copy("admin-copy-112")); bindForm(f, () => mutate(row ? "leaderboards/" + row.leaderboard_id + "/update" : "leaderboards", {
      ...(row ? { expected_version: row.version } : { leaderboard_id: value(f, "leaderboard_id") }), name: value(f, "name"), type: type.value,
      campaign_id: type.value === "all_time" ? null : campaign.value.trim() || null, start_date: type.value === "custom" ? start.value : null, end_date: type.value === "custom" ? end.value : null,
      vote_type: value(f, "vote_type") || null, top_n: integer(f, "top_n", 1, 100), is_public: value(f, "is_public") === "true", status: value(f, "status"),
    })); } f.append(button(copy("admin-copy-113"), () => void load()));
  }
  async function tiers() {
    heading(copy("admin-copy-020"), copy("admin-copy-114"));
    const data = await request("member-tiers");
    for (const row of data.tiers) {
      const card = node("article", "", "member-case tier-card");
      const artwork = node("div", "", "tier-artwork"); renderTierArtwork(artwork, row.tier_id);
      card.append(artwork, node("h3", row.name), node("span", row.status === "active" ? copy("admin-copy-115") : copy("admin-copy-011"), "status"), node("p", row.min_points === null ? copy("admin-copy-116") : `門檻：${row.min_points} 點`));
      if (row.tier_id !== "normal") card.append(button(copy("admin-copy-117"), () => {
        if (busy) return; clearPanel(); heading(copy("admin-copy-020")); const f = formCard(row.name);
        field(f, "min_points", copy("admin-copy-118"), "number", row.min_points ?? "", { required: true, min: 1, max: 1000000000, step: 1 });
        field(f, "status", copy("admin-copy-048"), "select", row.status, { choices: [["disabled", copy("admin-copy-011")], ["active", copy("admin-copy-115")]] });
        field(f, "reason", copy("admin-copy-119"), "textarea", "", { required: true, maxLength: 500 }); submitButton(f, copy("admin-copy-120"));
        bindForm(f, () => mutate("member-tiers/" + row.tier_id + "/update", { min_points: integer(f, "min_points", 1, 1000000000), status: value(f, "status"), reason: value(f, "reason"), expected_version: row.version })); f.append(button(copy("admin-copy-121"), () => void load()));
      })); $("admin-panel").append(card);
    }
  }
  async function submissions() {
    heading(copy("admin-copy-021"), copy("admin-copy-122"));
    const data = await request("submissions"), f = formCard(copy("admin-copy-123"));
    const enabled = field(f, "submissions_enabled", copy("admin-copy-123"), "select", String(data.submissions_enabled), { choices: [["false", copy("admin-copy-124")], ["true", copy("admin-copy-125")]] });
    field(f, "submissions_message", copy("admin-copy-126"), "textarea", data.submissions_message ?? "", { maxLength: 500 }); submitButton(f, copy("admin-copy-127"));
    const born = sequence;
    f.addEventListener("submit", event => { event.preventDefault(); if (!f.reportValidity()) return;
      if (!window.confirm(enabled.value === "true" && !data.submissions_enabled ? copy("admin-copy-128") : copy("admin-copy-129"))) return;
      void run(async current => { await mutate("submissions/update", { submissions_enabled: enabled.value === "true", submissions_message: value(f, "submissions_message") || null, expected_version: data.version });
        if (current()) { document.dispatchEvent(new Event("voteproof-submissions-updated")); await load(); }
      }, born);
    });
  }
  async function audit() {
    heading(copy("admin-copy-022"), copy("admin-copy-130"));
    await paged("audit-logs", "logs", row => {
      const labels = { approve: copy("admin-copy-131"), reject: copy("admin-copy-132"), mark_duplicate: copy("admin-copy-014"), complete: copy("admin-copy-015"), revoke: copy("admin-copy-016"), case_approve: copy("admin-copy-131"), case_reject: copy("admin-copy-132"), case_mark_duplicate: copy("admin-copy-014"), case_complete: copy("admin-copy-015"), case_revoke: copy("admin-copy-016"), campaign_create: copy("admin-copy-060"), campaign_update: copy("admin-copy-133"), leaderboard_create: copy("admin-copy-085"), leaderboard_update: copy("admin-copy-134"), leaderboard_rebuild: copy("admin-copy-135"), leaderboard_archive: copy("admin-copy-136"), member_tier_update: copy("admin-copy-137"), admin_bootstrap: copy("admin-copy-138"), manual_adjustment: copy("admin-copy-139") };
      const c = node("article", "", "member-case"); c.append(node("h3", labels[row.action] ?? copy("admin-copy-140")), node("p", stamp(row.created_at)), detailFields(row, [[copy("admin-copy-141"), row.admin_member_id], [copy("admin-copy-142"), row.target_id], [copy("admin-copy-143"), row.reason]])); return c;
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
      $("admin-panel").append(button(copy("admin-copy-144"), () => void load())); await loaders[tab]();
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
