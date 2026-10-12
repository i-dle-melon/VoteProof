import { api, putImage, errorMessage, PublicError } from "./api.js";
import { Submission, validateImages, queryInformation } from "./submission.js";
import { Challenge } from "./turnstile.js";
import { adminUI } from "./admin.js";
import { memberUI } from "./member.js";
import { authMessage } from "./member-api.js";
import { setupPreview } from "./preview.js";

setupPreview();

const $ = (id) => document.getElementById(id);
const submitLabel = $("submit-button").textContent.trim();
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
let submissionsEnabled = false, submissionsMessage = "正在確認投稿是否開放…", gateRequest = null, gateChecking = false, submissionStarting = false;
let campaignAvailability = "正在載入活動…";
let boardLoaded = false, boardLoading = false, boardSequence = 0, lookupBusy = false, publicBoards = [], currentBoard = null;
const challenge = new Challenge($("challenge-widget"), (text) => { $("challenge-status").textContent = text; });
const submission = new Submission({ api: async (path, options) => { await gateRequest; assertSubmissionOpen(); return api(path, options); },
put: async (...args) => { await gateRequest; assertSubmissionOpen(); return putImage(...args); }, token: async () => {
  await gateRequest;
  assertSubmissionOpen();
  await challenge.mount();
  assertSubmissionOpen();
  return challenge.take();
}, progress: (state) => {
  const labels = { verify: "確認人機驗證…", prepare: "準備安全上傳…", put: `上傳圖片 ${state.file ?? 0}／${state.count ?? 0}`,
    complete: "驗證已上傳的圖片…", case: "建立案件，請勿關閉分頁…" };
  $("upload-progress").hidden = false;
  $("progress").value = Math.round(state.fraction * 100);
  $("progress-label").textContent = labels[state.phase];
} });
let admin;
const member = memberUI({ campaignName: id => campaigns.find(c => c.campaign_id === id)?.name ?? "活動資訊目前無法取得", changed: (identity) => {
  $("member-mode").disabled = !identity;
  $("member-mode").textContent = identity ? "會員 · " + identity.nickname : "會員 · 請先登入";
  syncOwnership(); admin?.identity(identity); renderBoardPosition();
} });
admin = adminUI(member.session);

function syncOwnership() {
  // Retries keep the captured owner; fresh submissions use the current member.
  if (!submission.pending) {
    const identity = member.session.member;
    const mode = identity ? "member" : "guest";
    if ($("submission-mode").value !== mode && identity) {
      $("nickname").value = identity.nickname ?? "";
      $("player-id").value = identity.player_id ?? "";
    }
    $("submission-mode").value = mode;
  }
  $("submission-mode").disabled = true;
  $("submission-owner-hint").textContent = $("submission-mode").value === "member"
    ? "本次以會員身份投稿；審核通過後可依活動規則取得點數。登入身份改變時需重新登入原會員再重試。"
    : "訪客投稿不會綁定會員，也不計入會員點數。";
}

const campaignOpen = c => c?.status === "active" && Date.parse(c.start_at) <= Date.now() && Date.parse(c.end_at) > Date.now();
const submissionReady = () => submissionsEnabled && campaigns.some(campaignOpen);
function assertSubmissionOpen() {
  if (!submissionsEnabled) throw new PublicError("SUBMISSIONS_DISABLED");
  if (!campaignOpen(campaigns.find(c => c.campaign_id === $("campaign").value))) throw new PublicError("CAMPAIGN_NOT_OPEN");
}
const campaignDate = value => {
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date) : "—";
};
const voteDateLabel = value => /^\d{4}-\d{2}-\d{2}$/.test(value ?? "") ? value.replaceAll("-", "/") : "—";
const scoringLabel = c => c.daily_limit === 0 ? "本活動不計分" :
  `每次有效投稿：${c.points_per_proof} 點 · ${c.daily_limit === null ? "每日計分：不限次數" : `每日最多 ${c.daily_limit} 次計分`}`;
function syncForm() {
  const ready = submissionReady();
  syncOwnership();
  $("submission-fields").disabled = !ready || submission.pending;
  $("submit-button").disabled = !ready || submissionStarting || submission.busy || (!submission.pending && !campaignLoaded);
  $("submit-button").textContent = submissionStarting ? "確認投稿狀態…" : !ready ? "投稿暫停" : submission.busy ? "正在送出…" : submission.pending ? "重試本次投稿" : submitLabel;
  $("submission-form").setAttribute("aria-busy", String(submission.busy || submissionStarting));
  $("abandon-button").hidden = !submission.pending;
  $("abandon-button").disabled = submission.busy;
  $("challenge-retry").disabled = !ready || submission.busy;
  $("campaign-refresh").disabled = campaignLoading || submission.pending;
  for (const button of document.querySelectorAll('[data-submission-action]')) {
    button.disabled = !ready;
    if (!button.classList.contains("quick")) button.textContent = ready ? (button.dataset.campaign ? "投稿這個活動" : "提交投票證明") : "投稿暫停";
  }
  for (const state of document.querySelectorAll('[data-submission-status]')) state.hidden = ready;
  $("home-submission-state").textContent = $("quick-submission-state").textContent = ready ? "開放投稿" : "投稿暫停";
  $("submit-state").textContent = ready ? "提交投票證明" : "目前暫停投稿";
  $("submit-alternatives").hidden = ready;
  $("submission-verification").hidden = !ready;
  $("proof-dropzone").setAttribute("aria-disabled", String(!ready || submission.pending));
  if (!ready && !gateChecking) { challenge.clear(); $("challenge-status").textContent = "投稿開放後即可完成人機驗證。"; }
  $("submission-gate-message").hidden = submissionsEnabled && !submissionsMessage;
  $("submission-gate-message").textContent = submissionsMessage;
  $("submit-availability").textContent = !submissionsEnabled ? submissionsMessage :
    [submissionsMessage, campaignAvailability].filter(Boolean).join(" ");
}
function loadSubmissionStatus() {
  if (gateRequest) return gateRequest;
  // Every fresh check starts closed; a stale ON is never an authorization.
  gateChecking = true; submissionsEnabled = false; syncForm();
  gateRequest = (async () => { try {
    const data = await api("/api/submissions/status");
    if (typeof data?.submissions_enabled !== "boolean" || data.submissions_message !== null &&
        (typeof data.submissions_message !== "string" || [...data.submissions_message].length > 500 || /[\u0000-\u001f\u007f]/.test(data.submissions_message))) throw new Error();
    submissionsEnabled = data.submissions_enabled;
    submissionsMessage = data.submissions_message || (submissionsEnabled ? "" : "投稿暫停開放，請稍後再試。");
  } catch { submissionsEnabled = false; submissionsMessage = "投稿服務暫時無法使用，請稍後再試。"; }
  finally { gateChecking = false; syncForm(); }
  })().finally(() => { gateRequest = null; });
  return gateRequest;
}
function campaignHint() {
  const selected = campaigns.find((c) => c.campaign_id === $("campaign").value);
  if (!selected) { $("campaign-hint").textContent = "請選擇開放中的活動。"; return; }
  $("campaign-hint").textContent = `投票期間 ${voteDateLabel(selected.vote_start_date)} ～ ${voteDateLabel(selected.vote_end_date)} · ${scoringLabel(selected)}`;
  $("vote-date").min = selected.vote_start_date;
  $("vote-date").max = [selected.vote_end_date, new Date(Date.now() + 86400000).toISOString().slice(0, 10)].sort()[0];
  if (!$("vote-date").value) {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: selected.campaign_timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
      $("vote-date").value = ["year", "month", "day"].map((type) => parts.find((p) => p.type === type).value).join("-");
    } catch { $("vote-date").value = new Date().toISOString().slice(0, 10); }
  }
}
async function loadCampaigns({ refreshGate = true } = {}) {
  if (campaignLoading || submission.pending) return;
  campaignLoading = true; syncForm();
  if (refreshGate) await loadSubmissionStatus();
  $("campaign-message").textContent = "正在載入活動…";
  try {
    const data = await api("/api/campaigns");
    if (!Array.isArray(data?.campaigns)) throw new Error();
    // Backend already filters window/public state. Ignore non-active data
    // defensively rather than offering an unavailable option.
    campaigns = data.campaigns.filter(campaignOpen); campaignLoaded = true;
    const previous = $("campaign").value;
    $("campaign").replaceChildren(new Option("請選擇活動", ""));
    $("campaign-list").replaceChildren();
    for (const c of campaigns) {
      $("campaign").append(new Option(c.name, c.campaign_id));
      const card = node("article", undefined, "card campaign-card");
      card.append(node("span", c.category, "campaign-category"), node("h3", c.name), node("span", "活動進行中", "status"),
        node("p", `活動期間 ${campaignDate(c.start_at)} ～ ${campaignDate(c.end_at)}（台灣時間）`),
        node("p", `投票期間 ${voteDateLabel(c.vote_start_date)} ～ ${voteDateLabel(c.vote_end_date)}`), node("p", scoringLabel(c)));
      const button = node("button", "投稿暫停", "btn btn-soft"); button.type = "button";
      button.dataset.submissionAction = ""; button.dataset.campaign = c.campaign_id; button.disabled = true;
      card.append(button); $("campaign-list").append(card);
    }
    if (campaigns.some((c) => c.campaign_id === previous)) $("campaign").value = previous;
    else if (campaigns.length === 1) $("campaign").value = campaigns[0].campaign_id;
    const message = campaigns.length ? `目前有 ${campaigns.length} 個開放中的活動。` : "目前沒有進行中的活動。";
    campaignAvailability = message;
    $("campaign-message").textContent = message; $("submit-availability").textContent = message;
    campaignHint();
  } catch {
    campaignLoaded = false; campaigns = [];
    $("campaign-list").replaceChildren(); $("campaign").replaceChildren(new Option("活動暫時無法載入", ""));
    $("campaign-message").textContent = "活動暫時無法載入，請按重新載入。";
    $("submit-availability").textContent = "活動服務暫時無法使用，請返回首頁重新載入活動。";
    campaignAvailability = $("submit-availability").textContent;
  } finally {
    campaignLoading = false;
    $("home-campaign-name").textContent = campaigns[0]?.name ?? (campaignLoaded ? "目前沒有開放中的活動" : "活動暫時無法載入");
    $("home-campaign-state").textContent = campaigns.length ? "活動進行中" : campaignLoaded ? "尚無開放活動" : "暫時無法確認";
    syncForm();
  }
}

document.addEventListener("click", event => {
  const button = event.target.closest('[data-submission-action]');
  if (!button || button.disabled || !submissionReady()) return;
  if (button.dataset.campaign && !submission.pending) { $("campaign").value = button.dataset.campaign; campaignHint(); }
  location.hash = "submit";
});

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
function addImages(added) {
  if (!submissionReady() || submission.pending) return;
  if (!added.length) return;
  try {
    validateImages([...images.map((i) => i.file), ...added]);
    images.push(...added.map((file) => ({ file, url: URL.createObjectURL(file) }))); renderImages();
    $("image-error").textContent = "";
  } catch (e) { $("image-error").textContent = errorMessage(e); }
}
$("proof-images").addEventListener("change", () => {
  const added = [...$("proof-images").files]; $("proof-images").value = ""; addImages(added);
});
for (const type of ["dragover", "drop"]) $("proof-dropzone").addEventListener(type, event => {
  event.preventDefault();
  $("proof-dropzone").classList.toggle("drag", type === "dragover" && submissionReady() && !submission.pending);
  if (type === "drop") addImages([...event.dataTransfer.files]);
});
$("proof-dropzone").addEventListener("dragleave", () => $("proof-dropzone").classList.remove("drag"));
async function mountChallenge() {
  if (!submissionReady() || success || location.hash !== "#submit") return;
  try { await challenge.mount(); }
  catch (e) { $("challenge-status").textContent = errorMessage(e); }
}
$("challenge-retry").addEventListener("click", async () => { if (!submissionReady()) return; challenge.reset(); await mountChallenge(); });
$("campaign").addEventListener("change", campaignHint);
$("campaign-refresh").addEventListener("click", () => { void loadCampaigns(); });

$("submission-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!submissionReady() || submission.busy || submissionStarting) return;
  submissionStarting = true; syncForm();
  await member.ready;
  await loadSubmissionStatus();
  if (!submission.pending) await loadCampaigns({ refreshGate: false });
  submissionStarting = false; syncForm();
  if (!submissionReady()) return;
  $("submission-error").textContent = "";
  if (!submission.pending) {
    if (!$("submission-form").reportValidity()) { $("submission-error").textContent = "請完成必填欄位並確認投票日期。"; return; }
    if (!images.length) { $("submission-error").textContent = "請至少選擇 1 張投票證明圖片。"; $("proof-images").focus(); return; }
    try { submission.start(Object.fromEntries(new FormData($("submission-form"))), images.map((i) => i.file),
      { caseApi: member.session.member ? ((sender) => async (path, options) => { await gateRequest; assertSubmissionOpen(); return sender(path, options); })(member.session.caseSender()) : undefined }); }
    catch (e) { $("submission-error").textContent = e.code?.startsWith("AUTH_") ? authMessage(e) : errorMessage(e); return; }
  }
  $("retry-note").hidden = true;
  const attempt = submission.attempt(); syncForm();
  try {
    success = await attempt;
    void member.loadRecentCases();
    $("success-case-id").textContent = success.case_id; $("success-query-key").textContent = success.query_key;
    $("submission-form").hidden = true; $("submission-success").hidden = false;
    clearImages(); $("success-title").focus();
  } catch (e) {
    $("submission-error").textContent = e.code?.startsWith("AUTH_") || ["MEMBER_SUSPENDED", "CSRF_REJECTED"].includes(e.code) ? authMessage(e) : errorMessage(e); $("retry-note").hidden = false;
    if (["SUBMISSIONS_DISABLED", "SUBMISSIONS_UNAVAILABLE"].includes(e.code)) await loadSubmissionStatus();
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

const lookupGeneric = "找不到案件，請確認案件編號與查詢碼。";
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
      ["投票活動", campaign?.name ?? "活動資訊目前無法取得"], ["投票類型", data.vote_type], ["投票日期", data.vote_date], ["案件狀態", statusLabels[data.status] ?? "狀態更新中"]]) {
      const description = node("dd", value ?? "—");
      if (label === "案件狀態") { description.replaceChildren(node("span", value, "status")); }
      $("case-details").append(node("dt", label), description);
    }
    $("lookup-result").hidden = false; $("lookup-message").textContent = "查詢完成。";
  } catch (e) { $("lookup-message").textContent = e.status === 404 ? lookupGeneric : errorMessage(e); }
  finally { lookupBusy = false; $("lookup-button").disabled = false; $("lookup-id").disabled = $("lookup-key").disabled = false; $("lookup-button").textContent = "查詢案件"; $("lookup-form").setAttribute("aria-busy", "false"); }
});

function renderHomeBoard(board, message) {
  $("home-board-results").replaceChildren(); $("home-board-table").hidden = true;
  $("home-board-name").textContent = board?.name ?? "";
  $("home-boards-message").textContent = message ?? (!board ? "目前沒有公開排行榜。" : "這個排行榜目前還沒有成績。");
  if (!Array.isArray(board?.rankings) || !board.rankings.length) return;
  for (const row of board.rankings.slice(0, 5)) {
    const tr = node("tr");
    for (const field of ["rank", "nickname", "points", "proof_count"]) tr.append(node("td", String(row[field] ?? "—")));
    $("home-board-results").append(tr);
  }
  $("home-boards-message").textContent = ""; $("home-board-table").hidden = false;
}
function renderBoardPosition() {
  const identity = member.session.member;
  $("board-position-login").hidden = Boolean(identity);
  $("board-position-content").hidden = !identity;
  $("board-member-summary").replaceChildren();
  $("board-member-name").textContent = identity?.nickname ?? "";
  $("board-member-avatar").textContent = [...(identity?.nickname ?? "")][0] || "◎";
  $("board-member-rank").textContent = "—";
  $("board-member-points").textContent = "—";
  if (!identity) { $("board-position-message").textContent = "登入後可查看你在已公布成績中的位置。"; return; }
  const own = currentBoard?.rankings?.find(row => row.member_id === identity.member_id);
  $("board-position-message").textContent = own ? "" : currentBoard ? "你尚未列入這個排行榜的已公布名單。" : "目前沒有可查看的公開排行榜。";
  if (own) { $("board-member-rank").textContent = "#" + own.rank; $("board-member-points").textContent = Number(own.points).toLocaleString("zh-TW") + " 點"; }
  for (const board of publicBoards) {
    const result = board.rankings?.find(row => row.member_id === identity.member_id);
    const line = node("div", undefined, "mini-kpi");
    line.append(node("span", board.name), node("strong", result ? Number(result.points).toLocaleString("zh-TW") : "—"));
    $("board-member-summary").append(line);
  }
}
function renderBoardTabs() {
  $("leader-tabs").replaceChildren();
  for (const board of publicBoards) {
    const tab = node("button", board.name, "tab"); tab.type = "button"; tab.dataset.board = board.leaderboard_id;
    tab.classList.toggle("active", board.leaderboard_id === $("board-select").value);
    tab.setAttribute("aria-pressed", String(board.leaderboard_id === $("board-select").value));
    tab.disabled = boardLoading;
    tab.addEventListener("click", () => { $("board-select").value = board.leaderboard_id; void selectBoard(); });
    $("leader-tabs").append(tab);
  }
}
function renderBoard(board) {
  currentBoard = board ?? null;
  $("board-results").replaceChildren(); $("board-table").hidden = true;
  $("board-name").textContent = board?.name ?? "";
  $("board-generated").textContent = board?.generated_at ? `更新時間：${dateLabel(board.generated_at)}` : "";
  $("board-progress").value = board ? 100 : 0;
  renderBoardPosition();
  if (!board) { $("boards-message").textContent = "目前沒有公開排行榜。"; return; }
  if (!Array.isArray(board.rankings)) throw new Error();
  if (!board.rankings.length) { $("boards-message").textContent = "這個排行榜目前還沒有成績。"; return; }
  for (const row of board.rankings) {
    // Keep authoritative snapshot ranks and order, including gaps and ties.
    const tr = node("tr"), rank = node("td"), name = node("td", undefined, "grow");
    rank.append(node("span", String(row.rank), "rank-badge" + (Number(row.rank) <= 3 ? " top" : "")));
    name.append(node("strong", row.nickname ?? "—"), node("span", board.name));
    tr.append(rank, name, node("td", Number(row.points).toLocaleString("zh-TW") + " 點", "points"), node("td", String(row.proof_count ?? "—"), "board-proof-count"));
    $("board-results").append(tr);
  }
  $("boards-message").textContent = ""; $("board-table").hidden = false;
}
async function loadBoards() {
  if (boardLoading) return;
  boardLoading = true; const sequence = ++boardSequence;
  $("board-select").disabled = true; $("boards-refresh").disabled = true;
  publicBoards = []; renderBoardTabs(); renderBoard(null);
  $("boards-message").textContent = "正在載入排行榜…";
  renderHomeBoard(null, "正在載入排行榜…");
  try {
    const data = await api("/api/leaderboards");
    if (!Array.isArray(data?.leaderboards)) throw new Error();
    if (sequence !== boardSequence) return;
    publicBoards = data.leaderboards; const previous = $("board-select").value;
    $("board-select").replaceChildren(...publicBoards.map(b => new Option(b.name, b.leaderboard_id)));
    if (publicBoards.some(b => b.leaderboard_id === previous)) $("board-select").value = previous;
    if (!publicBoards.length) $("board-select").append(new Option("沒有公開排行榜", ""));
    renderBoard(publicBoards.find(b => b.leaderboard_id === $("board-select").value));
    renderHomeBoard(publicBoards[0]);
    boardLoaded = true; $("board-select").disabled = !publicBoards.length;
  } catch {
    boardLoaded = false; publicBoards = []; renderBoard(null); $("boards-message").textContent = "排行榜暫時無法載入，請按重新載入。";
    renderHomeBoard(null, "排行榜暫時無法載入，請前往排行榜重新載入。");
  } finally { boardLoading = false; $("boards-refresh").disabled = false; renderBoardTabs(); }
}
async function selectBoard() {
  const id = $("board-select").value, sequence = ++boardSequence;
  renderBoardTabs(); renderBoard(null); $("boards-message").textContent = "正在載入成績…";
  try {
    const data = await api("/api/leaderboards?id=" + encodeURIComponent(id));
    if (sequence === boardSequence) {
      const board = data.leaderboards?.find(b => b.leaderboard_id === id);
      if (board) publicBoards = publicBoards.map(b => b.leaderboard_id === id ? board : b);
      renderBoard(board);
    }
  } catch { if (sequence === boardSequence) $("boards-message").textContent = "成績暫時無法載入，請重新選擇或按重新載入。"; }
}
$("board-select").addEventListener("change", selectBoard);
$("boards-refresh").addEventListener("click", loadBoards);

function theme(value) {
  const light = value === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  $("theme-toggle").textContent = light ? "☾ 深色" : "☀ 淺色";
  $("theme-toggle").setAttribute("aria-label", light ? "切換深色" : "切換淺色");
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
  const view = ["home", "submit", "lookup", "leaderboards", "about", "register", "login", "recover", "member", "google", "security", "admin"].includes(requested) ? requested : "home";
  member.enter(view); admin.enter(view);
  for (const section of $("main").querySelectorAll("[data-view-panel]")) section.hidden = section.id !== "view-" + view;
  for (const link of document.querySelectorAll("[data-view]")) {
    if (link.dataset.view === view) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  }
  if (focus) { $("view-" + view).querySelector("[data-view-title]").focus(); window.scrollTo(0, 0); }
  if (view === "submit") void loadSubmissionStatus().then(mountChallenge);
  if (view === "leaderboards" && !boardLoaded) void loadBoards();
}
window.addEventListener("hashchange", () => navigate());
function refreshAvailability() { void loadSubmissionStatus().then(mountChallenge); }
window.addEventListener("focus", refreshAvailability);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshAvailability(); });
document.addEventListener("voteproof-submissions-updated", refreshAvailability);
window.addEventListener("beforeunload", (event) => {
  if (submission.pending) { event.preventDefault(); event.returnValue = ""; }
});
navigate(false);
void loadCampaigns().then(() => { if (location.hash === "#submit" && campaigns.length) void mountChallenge(); });
void loadBoards();
