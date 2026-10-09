import { api, putImage, errorMessage } from "./api.js";
import { Submission, validateImages, queryInformation } from "./submission.js";
import { Challenge } from "./turnstile.js";
import { memberUI } from "./member.js";
import { authMessage } from "./member-api.js";

const $ = (id) => document.getElementById(id);
const node = (tag, text, className) => {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const statusLabels = Object.freeze({ pending: "待審核", approved: "已通過", completed: "已完成",
  rejected: "未通過", duplicate: "重複投稿", revoked: "已撤銷" });
const casePattern = /^VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/;
const queryPattern = /^[A-Za-z0-9_-]{43}$/;
const dateLabel = (value) => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toLocaleString("zh-TW", { hour12: false }) : "—";
};
let campaigns = [], campaignLoaded = false, campaignLoading = false, images = [], success = null;
let boardLoaded = false, boardLoading = false, boardSequence = 0, lookupBusy = false;
const challenge = new Challenge($("challenge-widget"), (text) => { $("challenge-status").textContent = text; });
const submission = new Submission({ api, put: putImage, token: async () => {
  await challenge.mount();
  return challenge.take();
}, progress: (state) => {
  const labels = { verify: "確認人機驗證…", prepare: "準備安全上傳…", put: `上傳圖片 ${state.file ?? 0}／${state.count ?? 0}`,
    complete: "驗證已上傳的圖片…", case: "建立案件，請勿關閉分頁…" };
  $("upload-progress").hidden = false;
  $("progress").value = Math.round(state.fraction * 100);
  $("progress-label").textContent = labels[state.phase];
} });
const member = memberUI({ changed: (identity) => {
  $("member-mode").disabled = !identity;
  $("member-mode").textContent = identity ? "會員 · " + identity.nickname : "會員 · 請先登入";
  syncOwnership();
} });

function syncOwnership() {
  $("submission-mode").disabled = submission.pending;
  $("submission-owner-hint").textContent = $("submission-mode").value === "member"
    ? "本次投稿綁定登入會員；審核通過後可依活動規則取得點數。登入身份改變時需重新登入原會員再重試。"
    : "訪客投稿不會綁定會員，也不計入會員點數。";
}
$("submission-mode").addEventListener("change", () => {
  if (submission.pending) return;
  if ($("submission-mode").value === "member" && member.session.member) {
    $("nickname").value = member.session.member.nickname ?? "";
    $("player-id").value = member.session.member.player_id ?? "";
  }
  syncOwnership();
});

function syncForm() {
  syncOwnership();
  $("submission-fields").disabled = !campaigns.length || submission.pending;
  $("submit-button").disabled = submission.busy || (!submission.pending && (!campaignLoaded || !campaigns.length));
  $("submit-button").textContent = submission.busy ? "正在送出…" : submission.pending ? "重試本次投稿" : "送出投稿";
  $("submission-form").setAttribute("aria-busy", String(submission.busy));
  $("abandon-button").hidden = !submission.pending;
  $("abandon-button").disabled = submission.busy;
  $("challenge-retry").disabled = submission.busy;
  $("campaign-refresh").disabled = campaignLoading || submission.pending;
}
function campaignHint() {
  const selected = campaigns.find((c) => c.campaign_id === $("campaign").value);
  if (!selected) { $("campaign-hint").textContent = "請選擇開放中的活動。"; return; }
  $("campaign-hint").textContent = `投票期間 ${selected.vote_start_date} ～ ${selected.vote_end_date} · ${selected.campaign_timezone}`;
  $("vote-date").min = selected.vote_start_date;
  $("vote-date").max = [selected.vote_end_date, new Date(Date.now() + 86400000).toISOString().slice(0, 10)].sort()[0];
  if (!$("vote-date").value) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: selected.campaign_timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      $("vote-date").value = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type).value).join("-");
    } catch { $("vote-date").value = new Date().toISOString().slice(0, 10); }
  }
}
async function loadCampaigns() {
  if (campaignLoading || submission.pending) return;
  campaignLoading = true; syncForm();
  $("campaign-message").textContent = "正在載入活動…";
  try {
    const data = await api("/api/campaigns");
    if (!Array.isArray(data?.campaigns)) throw new Error();
    // Backend already filters window/public state. Ignore non-active data
    // defensively rather than offering an unavailable option.
    campaigns = data.campaigns.filter((c) => c.status === "active"); campaignLoaded = true;
    const previous = $("campaign").value;
    $("campaign").replaceChildren(new Option("請選擇活動", ""));
    $("campaign-list").replaceChildren();
    for (const c of campaigns) {
      $("campaign").append(new Option(c.name, c.campaign_id));
      const card = node("article", undefined, "card campaign-card");
      card.append(node("span", c.category, "campaign-category"), node("h3", c.name),
        node("p", `投票期間 ${c.vote_start_date} ～ ${c.vote_end_date}`), node("p", `活動時區：${c.campaign_timezone}`));
      const button = node("a", "投稿這個活動", "btn btn-soft"); button.href = "#submit";
      button.addEventListener("click", () => { if (!submission.pending) { $("campaign").value = c.campaign_id; campaignHint(); } });
      card.append(button); $("campaign-list").append(card);
    }
    if (campaigns.some((c) => c.campaign_id === previous)) $("campaign").value = previous;
    else if (campaigns.length === 1) $("campaign").value = campaigns[0].campaign_id;
    const message = campaigns.length ? `目前有 ${campaigns.length} 個開放中的活動。` : "目前沒有開放中的投票活動";
    $("campaign-message").textContent = message; $("submit-availability").textContent = message;
    campaignHint();
  } catch {
    campaignLoaded = false; campaigns = [];
    $("campaign-list").replaceChildren(); $("campaign").replaceChildren(new Option("活動暫時無法載入", ""));
    $("campaign-message").textContent = "活動暫時無法載入，請按重新載入。";
    $("submit-availability").textContent = "活動服務暫時無法使用，請返回首頁重新載入活動。";
  } finally { campaignLoading = false; syncForm(); }
}

function clearImages() { for (const item of images) URL.revokeObjectURL(item.url); images = []; $("image-list").replaceChildren(); $("proof-images").value = ""; }
function renderImages() {
  $("image-list").replaceChildren();
  for (const [index, item] of images.entries()) {
    const card = node("div", undefined, "image-item"), preview = node("img");
    preview.src = item.url; preview.alt = `投票證明 ${index + 1} 預覽`;
    preview.onerror = () => { $("image-error").textContent = "有圖片無法預覽，請移除並改選有效的 PNG、JPEG 或 WebP。"; };
    const remove = node("button", `移除圖片 ${index + 1}`, "btn btn-white"); remove.type = "button";
    remove.addEventListener("click", () => {
      if (submission.pending) return;
      URL.revokeObjectURL(item.url); images = images.filter((image) => image !== item); renderImages();
      $("image-error").textContent = "";
    });
    card.append(preview, node("p", item.file.name), node("p", `${(item.file.size / 1024 / 1024).toFixed(2)} MiB`), remove);
    $("image-list").append(card);
  }
}
$("proof-images").addEventListener("change", () => {
  if (submission.pending) return;
  const added = [...$("proof-images").files];
  $("proof-images").value = "";
  if (!added.length) return;
  try {
    validateImages([...images.map((i) => i.file), ...added]);
    images.push(...added.map((file) => ({ file, url: URL.createObjectURL(file) }))); renderImages();
    $("image-error").textContent = "";
  } catch (e) { $("image-error").textContent = errorMessage(e); }
});
async function mountChallenge() {
  try { await challenge.mount(); }
  catch (e) { $("challenge-status").textContent = errorMessage(e); }
}
$("challenge-retry").addEventListener("click", async () => { challenge.reset(); await mountChallenge(); });
$("campaign").addEventListener("change", campaignHint);
$("campaign-refresh").addEventListener("click", loadCampaigns);

$("submission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (submission.busy || (!submission.pending && !campaigns.length)) return;
  $("submission-error").textContent = "";
  if (!submission.pending) {
    if (!$("submission-form").reportValidity()) { $("submission-error").textContent = "請完成必填欄位並確認投票日期。"; return; }
    if (!images.length) { $("submission-error").textContent = "請至少選擇 1 張投票證明圖片。"; $("proof-images").focus(); return; }
    try { submission.start(Object.fromEntries(new FormData($("submission-form"))), images.map((i) => i.file),
      { caseApi: $("submission-mode").value === "member" ? member.session.caseSender() : undefined }); }
    catch (e) { $("submission-error").textContent = e.code?.startsWith("AUTH_") ? authMessage(e) : errorMessage(e); return; }
  }
  $("retry-note").hidden = true;
  const attempt = submission.attempt(); syncForm();
  try {
    success = await attempt;
    $("success-case-id").textContent = success.case_id; $("success-query-key").textContent = success.query_key;
    $("submission-form").hidden = true; $("submission-success").hidden = false;
    clearImages(); $("success-title").focus();
  } catch (e) {
    $("submission-error").textContent = e.code?.startsWith("AUTH_") || ["MEMBER_SUSPENDED", "CSRF_REJECTED"].includes(e.code) ? authMessage(e) : errorMessage(e); $("retry-note").hidden = false;
  } finally { syncForm(); }
});
function resetSubmission() {
  submission.abandon(); success = null; clearImages(); $("submission-form").reset();
  $("submission-form").hidden = false; $("submission-success").hidden = true; $("retry-note").hidden = true;
  $("upload-progress").hidden = true; $("submission-error").textContent = "";
  $("success-case-id").textContent = $("success-query-key").textContent = $("copy-status").textContent = "";
  $("lookup-key").value = ""; challenge.reset();
  if (campaigns.length === 1) $("campaign").value = campaigns[0].campaign_id;
  campaignHint(); syncForm();
}
$("abandon-button").addEventListener("click", () => {
  if (submission.busy) return;
  if (window.confirm("確定放棄本次投稿？若先前送出已成功，放棄後可能無法取回查詢碼。")) resetSubmission();
});
$("new-submission").addEventListener("click", () => {
  if (window.confirm("請先保存案件編號與查詢碼。確定開始另一筆投稿？")) resetSubmission();
});
for (const [id, value] of [["copy-case", () => success?.case_id], ["copy-key", () => success?.query_key], ["copy-all", () => success && queryInformation(success)]]) {
  $(id).addEventListener("click", async () => {
    if (!success) return;
    try { await navigator.clipboard.writeText(value()); $("copy-status").textContent = "已複製，請貼至你自己的安全筆記保存。"; }
    catch { $("copy-status").textContent = "瀏覽器未允許複製，請手動選取上方資訊並保存。"; }
  });
}
$("lookup-created").addEventListener("click", () => {
  if (!success) return;
  $("lookup-id").value = success.case_id; $("lookup-key").value = success.query_key; location.hash = "lookup";
});

const lookupGeneric = "無法查詢此案件，請確認案件編號與查詢碼。";
$("lookup-form").addEventListener("submit", async (event) => {
  event.preventDefault(); if (lookupBusy) return;
  const id = $("lookup-id").value.trim(), key = $("lookup-key").value.trim();
  $("lookup-result").hidden = true; $("case-details").replaceChildren();
  if (!casePattern.test(id) || !queryPattern.test(key)) { $("lookup-message").textContent = lookupGeneric; return; }
  lookupBusy = true; $("lookup-button").disabled = true; $("lookup-button").textContent = "正在查詢…";
  $("lookup-id").disabled = $("lookup-key").disabled = true;
  $("lookup-form").setAttribute("aria-busy", "true"); $("lookup-message").textContent = "正在查詢案件…";
  try {
    const data = await api(`/api/cases/${encodeURIComponent(id)}`, { headers: { "X-Case-Query-Key": key } });
    if (!data || data.case_id !== id) throw new Error();
    const campaign = campaigns.find((c) => c.campaign_id === data.campaign_id);
    for (const [label, value] of [["案件編號", data.case_id], ["建立時間", dateLabel(data.created_at)],
      ["投票活動", campaign?.name ?? data.campaign_id], ["投票類型", data.vote_type], ["投票日期", data.vote_date], ["案件狀態", statusLabels[data.status] ?? "狀態更新中"]]) {
      const description = node("dd", value ?? "—");
      if (label === "案件狀態") { description.replaceChildren(node("span", value, "status")); }
      $("case-details").append(node("dt", label), description);
    }
    $("lookup-result").hidden = false; $("lookup-message").textContent = "查詢完成。";
  } catch (e) { $("lookup-message").textContent = e.status === 404 ? lookupGeneric : errorMessage(e); }
  finally { lookupBusy = false; $("lookup-button").disabled = false; $("lookup-id").disabled = $("lookup-key").disabled = false; $("lookup-button").textContent = "查詢案件"; $("lookup-form").setAttribute("aria-busy", "false"); }
});

function renderBoard(board) {
  $("board-results").replaceChildren(); $("board-table").hidden = true;
  $("board-name").textContent = board?.name ?? "";
  $("board-generated").textContent = board?.generated_at ? `更新時間：${dateLabel(board.generated_at)}` : "";
  if (!board) { $("boards-message").textContent = "目前沒有公開排行榜"; return; }
  if (!Array.isArray(board.rankings)) throw new Error();
  if (!board.rankings.length) { $("boards-message").textContent = "這個排行榜目前還沒有成績。"; return; }
  for (const row of board.rankings) {
    // Preserve the server rank and order; never recalculate or request members.
    const tr = node("tr");
    for (const field of ["rank", "nickname", "points", "proof_count"]) tr.append(node("td", String(row[field] ?? "—")));
    $("board-results").append(tr);
  }
  $("boards-message").textContent = ""; $("board-table").hidden = false;
}
async function loadBoards() {
  if (boardLoading) return;
  boardLoading = true; const sequence = ++boardSequence;
  $("board-select").disabled = true; $("boards-refresh").disabled = true; renderBoard(null);
  $("boards-message").textContent = "正在載入排行榜…";
  try {
    const data = await api("/api/leaderboards");
    if (!Array.isArray(data?.leaderboards)) throw new Error();
    if (sequence !== boardSequence) return;
    const boards = data.leaderboards, previous = $("board-select").value;
    $("board-select").replaceChildren(...boards.map((b) => new Option(b.name, b.leaderboard_id)));
    if (boards.some((b) => b.leaderboard_id === previous)) $("board-select").value = previous;
    if (!boards.length) $("board-select").append(new Option("沒有公開排行榜", ""));
    renderBoard(boards.find((b) => b.leaderboard_id === $("board-select").value));
    boardLoaded = true; $("board-select").disabled = !boards.length;
  } catch {
    boardLoaded = false; renderBoard(null); $("boards-message").textContent = "排行榜暫時無法載入，請按重新載入。";
  } finally { boardLoading = false; $("boards-refresh").disabled = false; }
}
$("board-select").addEventListener("change", async () => {
  const id = $("board-select").value, sequence = ++boardSequence;
  renderBoard(null); $("boards-message").textContent = "正在載入成績…";
  try {
    const data = await api("/api/leaderboards?id=" + encodeURIComponent(id));
    if (sequence === boardSequence) renderBoard(data.leaderboards?.find((b) => b.leaderboard_id === id));
  } catch { if (sequence === boardSequence) $("boards-message").textContent = "成績暫時無法載入，請重新選擇或按重新載入。"; }
});
$("boards-refresh").addEventListener("click", loadBoards);

function theme(value) {
  const light = value === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  $("theme-toggle").textContent = light ? "切換深色" : "切換淺色";
  $("theme-toggle").setAttribute("aria-pressed", String(light));
  document.querySelector('meta[name="theme-color"]').content = light ? "#faf8fc" : "#121212";
}
try { theme(localStorage.getItem("voteproof-theme")); } catch { theme("dark"); }
$("theme-toggle").addEventListener("click", () => {
  const value = document.documentElement.dataset.theme === "dark" ? "light" : "dark"; theme(value);
  try { localStorage.setItem("voteproof-theme", value); } catch { /* Theme still works without storage. */ }
});
function navigate(focus = true) {
  const requested = location.hash.slice(1);
  if (requested === "main") { $("main").focus(); return; }
  const view = ["home", "submit", "lookup", "leaderboards", "about", "register", "login", "recover", "member"].includes(requested) ? requested : "home";
  member.enter(view);
  for (const section of document.querySelectorAll("main > .view")) section.hidden = section.id !== "view-" + view;
  for (const link of document.querySelectorAll("[data-view]")) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  if (focus) { document.querySelector(`#view-${view} h1`).focus(); window.scrollTo(0, 0); }
  if (view === "submit" && campaigns.length && !success) void mountChallenge();
  if (view === "leaderboards" && !boardLoaded) void loadBoards();
}
window.addEventListener("hashchange", () => navigate());
window.addEventListener("beforeunload", (event) => {
  if (submission.pending) { event.preventDefault(); event.returnValue = ""; }
});
navigate(false);
void loadCampaigns().then(() => { if (location.hash === "#submit" && campaigns.length) void mountChallenge(); });
