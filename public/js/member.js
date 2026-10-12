import { MemberSession, emailValue, passwordValue, codeValue, authMessage } from "./member-api.js";
import { PublicError } from "./api.js";
import { Challenge } from "./turnstile.js";
import { drawEnrollment, clearEnrollment, enrollmentKey } from "./qr.js";
import { tierArtwork, renderTierArtwork } from "./tier-artwork.js";
import { memberTierProgress } from "./member-tier-progress.js";

const $ = id => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text;
  if (className) node.className = className;
  return node;
};
const memberDate = value => { const d = new Date(value); return Number.isFinite(d.valueOf()) ? d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—"; };
const statuses = { pending: "待審核", approved: "已通過", completed: "已完成", rejected: "未通過", duplicate: "重複投稿", revoked: "已撤銷" };
const authViews = ["register", "login", "recover", "google", "security"];

export function memberUI({ changed = () => {}, campaignName = () => "活動資訊目前無法取得" } = {}) {
  let view = "", epoch = 0, busy = false, controller = new AbortController();
  let registration = "email", challengeId = "", transactionId = "", deadline = 0, cooldown = 0;
  let loginTx = "", loginDeadline = 0, recoveryTx = "", recoveryDeadline = 0, recoveryCodes = [];
  let memberEpoch = 0, casesCursor = null, casesBusy = null, wasLoggedIn = false;
  let profileSnapshot = null, recentSequence = 0;
  let googleTx = "", googleProfile = false, googleDeadline = 0, methodTx = "", methodDeadline = 0, pendingEmailAdd = null;
  let loginSessionChecked = false, linkPurpose = "connect", setupKind = "enroll", setupTx = "", setupDeadline = 0, recoveryLogout = false;
  const session = new MemberSession({ changed: member => {
    if (member) { $("account-status").hidden = true; $("account-status").textContent = ""; }
    else if (wasLoggedIn) {
      $("account-status").textContent = "登入已失效，請重新登入。訪客投稿資料仍保留在此分頁。"; $("account-status").hidden = false;
      if (["security", "google"].includes(view)) resetAuth();
    }
    wasLoggedIn = Boolean(member);
    $("lookup-member-shortcut").hidden = !member;
    $("top-avatar").textContent = member ? [...(member.nickname || "")][0] || "◎" : "G";
    $("top-avatar").href = member ? "#member" : "#login";
    $("top-avatar").setAttribute("aria-label", member ? "會員中心" : "會員登入");
    $("login-entry").hidden = Boolean(member); $("member-entry").hidden = $("logout-button").hidden = !member;
    $("member-welcome").textContent = member ? `${member.nickname}，歡迎回來。` : "";
    $("member-gate").hidden = Boolean(member); $("member-content").hidden = !member;
    if (member) {
      $("member-id").textContent = member.member_id;
      $("member-avatar").textContent = [...(member.nickname || "")][0] || "◎"; $("member-profile-name").textContent = member.nickname; $("member-profile-player").textContent = member.player_id ? "玩家 ID · " + member.player_id : "尚未設定玩家 ID";
      const newOwner = profileSnapshot?.member_id !== member.member_id;
      if (newOwner) $("member-record-total").textContent = "—";
      for (const [id, key] of [["profile-nickname", "nickname"], ["profile-player", "player_id"]]) {
        if (newOwner || $(id).value === (profileSnapshot?.[key] ?? "")) $(id).value = member[key] ?? "";
      }
      profileSnapshot = { member_id: member.member_id, nickname: member.nickname, player_id: member.player_id };
    } else {
      recentSequence++; $("recent-cases").replaceChildren(); $("recent-cases-member").hidden = true;
      $("recent-cases-status").textContent = "登入後可查看最近投稿；訪客可使用案件編號與查詢碼查詢。";
      $("member-record-total").textContent = "—";
      profileSnapshot = null; memberEpoch++; $("member-id").textContent = ""; for (const id of ["member-avatar", "member-profile-name", "member-profile-player"]) $(id).textContent = ""; $("profile-form").reset();
      $("member-cases").replaceChildren(); $("member-case-fields").replaceChildren();
      $("member-case-detail").hidden = true; $("points-content").hidden = true;
      $("member-points").textContent = "";
      $("member-tier").textContent = ""; $("member-tier-artwork").replaceChildren();
      $("tier-message").textContent = $("tier-points").textContent = $("tier-gap").textContent = "";
      $("tier-next").hidden = true; $("tier-progress").value = 0;
    }
    syncLogin();
    changed(member);
    if (view === "submit" && member) void loadRecentCases();
  } });
  const challenge = new Challenge($("register-challenge"), text => { $("register-challenge-status").textContent = text; });
  function syncLogin() {
    $("login-session-status").hidden = loginSessionChecked || Boolean(session.member);
    $("login-content").hidden = !loginSessionChecked || Boolean(session.member);
    if (view === "login" && session.member) location.hash = "member";
  }
  for (const button of document.querySelectorAll('[data-auth-view] button[type="submit"]')) button.dataset.idleLabel = button.textContent;

  const clearSetup = () => { clearEnrollment($("enrollment-qr")); $("enrollment-key").textContent = ""; };
  const clearRecovery = () => {
    recoveryCodes = []; $("recovery-codes").replaceChildren(); $("recovery-ack").checked = false;
    $("recovery-copy-status").textContent = ""; $("registration-done").disabled = true;
  };
  function syncCooldown() {
    const remaining = Math.max(0, Math.ceil((cooldown - Date.now()) / 1000));
    $("register-resend").textContent = remaining ? `重新寄送（${remaining} 秒）` : "重新寄送";
    $("register-resend").disabled = busy || remaining > 0 || registration !== "code";
    $("registration-done").disabled = busy || !$("recovery-ack").checked;
    $("security-done").disabled = busy || !$("security-recovery-ack").checked;
    const expiry = (id, time) => {
      $(id).textContent = !time ? "" : time <= Date.now() ? "本步驟已過期，請重新開始。" : `本步驟剩餘 ${Math.ceil((time - Date.now()) / 60000)} 分鐘。`;
    };
    expiry("register-expiry", ["email", "recovery", "success"].includes(registration) ? 0 : deadline);
    expiry("login-expiry", loginDeadline); expiry("recover-expiry", recoveryDeadline);
  }
  function registrationStep(step) {
    registration = step;
    const steps = ["email", "code", "password", "totp", "recovery", "success"];
    const labels = ["驗證信箱", "輸入信箱驗證碼", "設定密碼", "設定 Authenticator", "保存復原碼", "會員註冊完成"];
    $("register-step").textContent = `${steps.indexOf(step) + 1} / 6 · ${labels[steps.indexOf(step)]}`;
    for (const [name, id] of [["email", "register-email-form"], ["code", "register-code-form"], ["password", "register-password-form"], ["totp", "register-totp-form"], ["recovery", "register-recovery"], ["success", "register-success"]]) $(id).hidden = step !== name;
    $("register-restart").hidden = ["email", "recovery", "success"].includes(step);
    syncCooldown();
    const target = { code: "register-code", password: "register-password", totp: "register-totp", recovery: "recovery-codes-title" }[step];
    if (target) $(target).focus();
  }
  function resetAuth() {
    epoch++; controller.abort(); controller = new AbortController(); busy = false;
    for (const name of authViews) {
      for (const form of $("view-" + name).querySelectorAll("form")) form.reset();
      $(name === "recover" ? "recover-error" : name + "-error").textContent = "";
      for (const input of $("view-" + name).querySelectorAll("input")) {
        input.disabled = false;
        if (input.autocomplete.includes("password")) input.type = "password";
      }
      for (const button of $("view-" + name).querySelectorAll("button")) {
        button.disabled = false; if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
      }
    }
    for (const button of document.querySelectorAll("[data-password]")) { button.textContent = "顯示"; button.setAttribute("aria-pressed", "false"); }
    challengeId = transactionId = loginTx = recoveryTx = ""; deadline = cooldown = loginDeadline = recoveryDeadline = 0;
    clearSetup(); clearRecovery(); registrationStep("email");
    $("login-form").hidden = false; $("login-totp-form").hidden = true;
    $("login-methods").hidden = false; $("login-password-options").open = false;
    $("recover-proof-form").hidden = false; $("recover-password-form").hidden = $("recover-success").hidden = true;
    $("logout-button").disabled = false; challenge.clear();
    googleTx = methodTx = setupTx = ""; googleDeadline = methodDeadline = setupDeadline = 0;
    clearEnrollment($("security-enroll-qr")); $("security-enroll-key").textContent = ""; $("security-devices").replaceChildren(); $("security-step-status").textContent = "";
    for (const id of ["google-step-form", "security-enroll-form", "security-step-form", "security-google-step", "security-enroll"]) $(id).hidden = true;
    clearEnrollment($("security-qr")); $("security-key").textContent = "";
    $("security-recovery-codes").replaceChildren(); $("security-recovery-ack").checked = false;
    $("security-done").disabled = true; $("google-email").textContent = ""; $("google-message").textContent = "";
    for (const id of ["google-confirm-form", "security-password-form", "security-recovery", "security-change-form", "security-link-notice", "security-link-confirm", "security-link-cancel", "security-add-notice", "security-add-confirm", "security-add-cancel"]) $(id).hidden = true;
    for (const id of ["security-google", "security-password", "security-totp"]) $(id).textContent = "";
  }
  async function run(name, action) {
    if (busy) return;
    const current = epoch; busy = true; $(name + "-error").textContent = "";
    const section = $("view-" + name); section.setAttribute("aria-busy", "true");
    const submit = [...section.querySelectorAll('button[type="submit"]')].find(button => !button.closest("form").hidden);
    const label = submit?.textContent;
    if (submit) submit.textContent = name === "register" && registration === "email" ? "正在寄送…" : "正在處理…";
    for (const button of section.querySelectorAll("button")) button.disabled = true;
    $("logout-button").disabled = true;
    try { await action(() => current === epoch && view === name); }
    catch (error) {
      if (current === epoch) {
        $(name + "-error").textContent = authMessage(error);
        if (name === "register" && error.retryAfter) cooldown = Date.now() + error.retryAfter * 1000;
      }
    } finally {
      if (current === epoch) {
        busy = false; section.setAttribute("aria-busy", "false");
        if (submit) submit.textContent = label;
        for (const button of section.querySelectorAll("button")) button.disabled = false;
        $("logout-button").disabled = false; syncCooldown();
      }
    }
  }
  const post = (path, body) => session.request("/api/auth/" + path, { method: "POST", body, signal: controller.signal });
  const unexpired = time => { if (Date.now() >= time) throw new PublicError("AUTH_VERIFICATION_FAILED"); };
  const expires = data => Date.now() + data.expires_in * 1000;
  const form = (id, name, action) => $(id).addEventListener("submit", event => { event.preventDefault(); void run(name, action); });

  async function beginGoogle(current, purpose = "login") {
    const data = await post("google/start", { purpose, ...(purpose !== "login" ? { confirmed: true } : {}) });
    if (!current()) return;
    const url = new URL(data.authorize_url);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/auth/v1/authorize" || url.searchParams.get("provider") !== "google") throw new PublicError("SERVICE_UNAVAILABLE");
    // Full-page provider navigation only: no SDK, provider password, token
    // storage or browser fetch to the provider.
    location.assign(url.href);
  }
  for (const name of ["login", "register"]) $(name + "-google").addEventListener("click", () => void run(name, current => beginGoogle(current)));
  async function loadGoogle() {
    const current = epoch;
    try {
      await session.refresh().catch(() => {});
      const data = await session.request("/api/auth/google/result", { signal: controller.signal });
      if (current !== epoch || view !== "google") return;
      if (data.purpose === "security") {
        googleTx = data.transaction_id; googleDeadline = expires(data);
        $("google-title").textContent = "重新驗證身份"; $("google-step-form").hidden = false;
        $("google-step-code").focus(); return;
      }
      $("google-title").textContent = "Google 登入確認";
      googleTx = data.transaction_id; googleDeadline = expires(data); googleProfile = data.status === "GOOGLE_PROFILE_REQUIRED";
      $("google-email").textContent = data.email;
      $("google-message").textContent = googleProfile ? "Google 已驗證信箱。請設定 VoteProof 資料，即可建立會員；不需要 VoteProof 密碼。" :
        data.provider_already_linked && data.status === "GOOGLE_CONFIRM_REQUIRED" ? "這個 Google 帳號符合既有 VoteProof 會員。Google 已連結至既有帳號。確認後啟用同一會員的 Google 登入；取消只停止本次啟用，不會解除登入方式。" : "Google 已驗證身份，繼續登入同一 VoteProof 會員。取消不會解除登入方式。";
      $("google-profile").hidden = !googleProfile; $("google-confirm-form").hidden = false;
    } catch (error) { if (current === epoch && view === "google") $("google-error").textContent = authMessage(error); }
  }
  form("google-confirm-form", "google", async current => {
    unexpired(googleDeadline);
    const body = { transaction_id: googleTx, confirmed: true, remember_me: $("google-remember").checked };
    if (googleProfile) { body.nickname = $("google-nickname").value.trim(); const player = $("google-player").value.trim(); if (player) body.player_id = player; }
    const data = await post("google/confirm", body);
    if (current()) { session.accept(data); googleTx = ""; location.hash = "member"; }
  });
  $("google-cancel").addEventListener("click", () => void run("google", async current => {
    await post("google/cancel", { transaction_id: googleTx });
    if (current()) { googleTx = ""; location.hash = session.member ? "member" : "login"; }
  }));
  async function loadSecurity() {
    const current = epoch;
    for (const id of ["security-connect", "security-reauth", "security-add", "security-change", "security-manage"]) $(id).hidden = true;
    if (pendingEmailAdd) {
      $("security-google").textContent = "信箱已驗證，屬於使用 Google 登入的既有會員。";
      $("security-password").textContent = "你可以為同一會員新增密碼登入，不會建立第二個會員。";
      $("security-add-notice").hidden = $("security-add-confirm").hidden = $("security-add-cancel").hidden = false;
      return;
    }
    try {
      await session.refresh(); if (current !== epoch || view !== "security") return;
      const data = await session.request("/api/auth/login-security", { signal: controller.signal });
      if (current !== epoch || view !== "security") return;
      $("security-google").textContent = data.google.connected ? "Google · 已連結 · " + data.google.email : "Google · 尚未連結";
      $("security-password").textContent = data.password.configured ? "信箱與密碼 · 已設定" : "信箱與密碼 · 尚未設定";
      $("security-totp").textContent = data.authenticator.configured ? (data.password.configured ? "VoteProof Authenticator · 已設定，用於密碼登入與管理員安全驗證" : "VoteProof Authenticator · 已設定，用於額外安全驗證；一般 Google 登入不需要") : "VoteProof Authenticator · 一般 Google 登入不需要；新增密碼或管理員存取時必須設定";
      $("security-connect").hidden = data.google.connected; $("security-reauth").hidden = !data.google.connected;
      $("security-add").hidden = data.password.configured; $("security-change").hidden = !data.password.configured;
      $("security-manage").hidden = !data.authenticator.configured;
      $("security-enroll").hidden = data.authenticator.configured || !data.google.connected;
      $("security-google-step").hidden = !data.google.connected || !data.authenticator.configured;
      $("security-step-form").hidden = !data.password.configured;
      $("security-step-status").textContent = "";
      void loadDevices(current);
    } catch (error) { if (current === epoch && view === "security") $("security-error").textContent = authMessage(error); }
  }
  const explainLink = () => { linkPurpose = "connect"; $("security-link-notice").hidden = $("security-link-confirm").hidden = $("security-link-cancel").hidden = false; };
  $("security-connect").addEventListener("click", explainLink); $("security-reauth").addEventListener("click", () => { explainLink(); });
  $("security-link-confirm").addEventListener("click", () => void run("security", current => beginGoogle(current, linkPurpose)));
  $("security-link-cancel").addEventListener("click", () => { $("security-link-notice").hidden = $("security-link-confirm").hidden = $("security-link-cancel").hidden = true; });
  $("security-add").addEventListener("click", () => { $("security-add-notice").hidden = $("security-add-confirm").hidden = $("security-add-cancel").hidden = false; });
  $("security-add-cancel").addEventListener("click", () => { pendingEmailAdd = null; $("security-add-notice").hidden = $("security-add-confirm").hidden = $("security-add-cancel").hidden = true; });
  $("security-add-confirm").addEventListener("click", () => void run("security", async current => {
    if (pendingEmailAdd) unexpired(pendingEmailAdd.deadline);
    const data = await post("password/add/start", { confirmed: true, ...(pendingEmailAdd ? { transaction_id: pendingEmailAdd.transaction_id } : {}) });
    if (!current()) return;
    methodTx = data.transaction_id; methodDeadline = expires(data); pendingEmailAdd = null;
    $("security-add-notice").hidden = $("security-add-confirm").hidden = $("security-add-cancel").hidden = true;
    $("security-add").hidden = true; $("security-password-form").hidden = false;
    clearEnrollment($("security-qr")); $("security-key").textContent = "";
    $("security-qr").hidden = $("security-key").hidden = !data.otpauth_uri;
    if (data.otpauth_uri) { drawEnrollment($("security-qr"), data.otpauth_uri); $("security-key").textContent = enrollmentKey(data.otpauth_uri); }
    $("security-new-password").focus();
  }));
  form("security-password-form", "security", async current => {
    unexpired(methodDeadline); const new_password = passwordValue($("security-new-password").value, $("security-confirm-password").value), code = codeValue($("security-code").value);
    $("security-new-password").value = $("security-confirm-password").value = $("security-code").value = "";
    const data = await post("password/add/verify", { transaction_id: methodTx, new_password, code });
    if (!current()) return; session.accept(data);
    clearEnrollment($("security-qr")); $("security-key").textContent = ""; methodTx = ""; methodDeadline = 0;
    if (!Array.isArray(data.recovery_codes) || data.recovery_codes.length !== 10 || data.recovery_codes.some(c => !/^[A-Za-z0-9_-]{43}$/.test(c))) throw new PublicError("SERVICE_UNAVAILABLE");
    $("security-recovery-codes").replaceChildren(...data.recovery_codes.map(c => element("li", c)));
    $("security-password-form").hidden = true; $("security-recovery").hidden = false;
  });
  $("security-recovery-ack").addEventListener("change", () => { $("security-done").disabled = !$("security-recovery-ack").checked; });
  $("security-done").addEventListener("click", () => { if ($("security-recovery-ack").checked) { $("security-recovery-codes").replaceChildren(); $("security-recovery").hidden = true; if (recoveryLogout) { recoveryLogout = false; location.hash = "login"; } else void loadSecurity(); } });
  $("security-change").addEventListener("click", () => { $("security-change-form").hidden = false; $("security-current-password").focus(); });
  form("security-change-form", "security", async current => {
    const password = passwordValue($("security-current-password").value), code = codeValue($("security-change-code").value), new_password = passwordValue($("security-change-password").value, $("security-change-confirm").value);
    $("security-change-form").reset(); await post("step-up", { password, code }); if (!current()) return;
    const tx = await post("password/change/start", {}); if (!current()) return;
    await post("password/change", { transaction_id: tx.transaction_id, new_password });
    if (current()) { session.clear(); location.hash = "login"; }
  });


  const confirmed = text => window.confirm(text);
  function securityComplete(data) {
    document.dispatchEvent(new CustomEvent("voteproof-security-verified", { detail: { elevated_until: data.elevated_until } }));
    $("account-status").textContent = "身份驗證完成。"; $("account-status").hidden = false;
  }
  form("google-step-form", "google", async current => {
    unexpired(googleDeadline); const code = codeValue($("google-step-code").value); $("google-step-code").value = "";
    const data = await post("google/step-up", { transaction_id: googleTx, code });
    if (current()) { googleTx = ""; securityComplete(data); location.hash = "security"; }
  });
  $("google-step-cancel").addEventListener("click", () => void run("google", async current => {
    await post("google/cancel", { transaction_id: googleTx }); if (current()) location.hash = "security";
  }));
  $("security-google-step").addEventListener("click", () => {
    if (confirmed("重新驗證 Google，並使用 Authenticator 完成身份驗證？")) void run("security", current => beginGoogle(current, "security"));
  });
  form("security-step-form", "security", async current => {
    const password = passwordValue($("security-step-password").value), code = codeValue($("security-step-code").value);
    $("security-step-form").reset(); const data = await post("step-up", { password, code });
    if (current()) { securityComplete(data); $("security-step-status").textContent = "身份驗證完成，可繼續安全設定與已授權的管理操作。"; }
  });
  async function loadDevices(sequence = epoch) {
    const owner = session.member?.member_id; $("security-devices-status").textContent = "正在載入裝置…"; $("security-devices").replaceChildren();
    try {
      const data = await session.request("/api/auth/trusted-devices", { signal: controller.signal });
      if (sequence !== epoch || view !== "security" || owner !== session.member?.member_id) return;
      $("security-devices-status").textContent = data.devices.length ? "" : "目前沒有信任的裝置。";
      for (const device of data.devices) {
        const card = element("article", "", "member-case"), revoke = element("button", "撤銷裝置信任", "btn btn-white"); revoke.type = "button";
        const stamp = value => new Date(value * 1000).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
        card.append(element("strong", device.label || "信任裝置"), element("p", "到期時間 · " + stamp(device.expires_at)), revoke);
        revoke.addEventListener("click", () => { if (confirmed("撤銷這個裝置的信任？下次密碼登入將需要 Authenticator。")) void run("security", async current => {
          await post("trusted-devices/" + device.id + "/revoke", {}); if (current()) await loadDevices();
        }); }); $("security-devices").append(card);
      }
    } catch (error) { if (sequence === epoch && view === "security") $("security-devices-status").textContent = authMessage(error); }
  }
  function showSecurityRecovery(data) {
    if (!Array.isArray(data.recovery_codes) || data.recovery_codes.length !== 10 || data.recovery_codes.some(code => !/^[A-Za-z0-9_-]{43}$/.test(code))) throw new PublicError("SERVICE_UNAVAILABLE");
    $("security-recovery-codes").replaceChildren(...data.recovery_codes.map(code => element("li", code)));
    $("security-recovery-ack").checked = false; $("security-done").disabled = true; $("security-recovery").hidden = false;
    $("security-recovery").scrollIntoView({ block: "start" });
  }
  $("security-refresh").addEventListener("click", () => { if (!busy) void loadSecurity(); });
  $("security-revoke-others").addEventListener("click", () => { if (confirmed("撤銷其他信任裝置？仍保留目前裝置的信任。")) void run("security", async current => { await post("trusted-devices/revoke-others", {}); if (current()) await loadDevices(); }); });
  $("security-regenerate").addEventListener("click", () => { if (confirmed("重新產生復原碼？所有舊復原碼將立即失效。")) void run("security", async current => { const data = await post("recovery-codes/regenerate", {}); if (current()) showSecurityRecovery(data); }); });
  async function startAuthenticator(kind, current) {
    const data = await post(kind === "reset" ? "totp/reset/start" : "google/totp/enroll/start", kind === "reset" ? {} : { confirmed: true });
    if (!current()) return; setupKind = kind; setupTx = data.transaction_id; setupDeadline = expires(data);
    drawEnrollment($("security-enroll-qr"), data.otpauth_uri); $("security-enroll-key").textContent = enrollmentKey(data.otpauth_uri);
    $("security-enroll-form").hidden = false; $("security-enroll-code").focus();
  }
  $("security-enroll").addEventListener("click", () => { if (confirmed("為額外安全驗證設定 Authenticator？一般 Google 登入仍不需要此驗證。")) void run("security", current => startAuthenticator("enroll", current)); });
  $("security-reset").addEventListener("click", () => { if (confirmed("重設 Authenticator？完成後所有登入與裝置信任將失效，並需保存新的復原碼。")) void run("security", current => startAuthenticator("reset", current)); });
  form("security-enroll-form", "security", async current => {
    unexpired(setupDeadline); const code = codeValue($("security-enroll-code").value); $("security-enroll-code").value = "";
    const data = await post(setupKind === "reset" ? "totp/reset/verify" : "google/totp/enroll/verify", { transaction_id: setupTx, code });
    if (!current()) return; setupTx = ""; clearEnrollment($("security-enroll-qr")); $("security-enroll-key").textContent = ""; $("security-enroll-form").hidden = true;
    if (data.logged_out) session.clear(); // Clear triggers resetAuth before the new one-time codes are rendered.
    recoveryLogout = Boolean(data.logged_out); showSecurityRecovery(data);
  });
  $("login-password-options").addEventListener("toggle", () => $("login-password-summary").setAttribute("aria-expanded", String($("login-password-options").open)));

  form("register-email-form", "register", async current => {
    const email = emailValue($("register-email").value);
    const availability = await session.request("/api/auth/registration-status", { signal: controller.signal });
    if (!current()) return;
    if (!availability.registration_available) throw new PublicError("AUTH_REGISTRATION_UNAVAILABLE");
    await challenge.mount(); if (!current()) return;
    const token = challenge.take(); if (!token) throw new PublicError("TURNSTILE_REQUIRED");
    const data = await post("register/start", { email, turnstile_token: token });
    if (!current()) return;
    challengeId = data.challenge_id; deadline = expires(data); cooldown = Date.now() + 60000;
    $("register-email").value = ""; registrationStep("code");
  });
  $("register-resend").addEventListener("click", () => {
    if (Date.now() < cooldown) return;
    void run("register", async current => {
      const data = await post("register/resend", { challenge_id: challengeId });
      if (current()) { deadline = expires(data); cooldown = Date.now() + 60000; $("register-sent").textContent = "驗證信已重新寄送，請使用最新的一封。"; }
    });
  });
  form("register-code-form", "register", async current => {
    unexpired(deadline); const code = codeValue($("register-code").value); $("register-code").value = "";
    const data = await post("register/verify-email", { challenge_id: challengeId, code });
    if (current()) {
      transactionId = data.transaction_id; challengeId = ""; deadline = expires(data);
      if (data.status === "ADD_PASSWORD_REQUIRED") { pendingEmailAdd = { transaction_id: data.transaction_id, deadline }; location.hash = "security"; }
      else registrationStep("password");
    }
  });
  form("register-password-form", "register", async current => {
    unexpired(deadline); const password = passwordValue($("register-password").value, $("register-confirm").value);
    $("register-password").value = $("register-confirm").value = "";
    const data = await post("register/credentials", { transaction_id: transactionId, password });
    if (!current()) return;
    const manual = enrollmentKey(data.otpauth_uri);
    drawEnrollment($("enrollment-qr"), data.otpauth_uri); $("enrollment-key").textContent = manual;
    transactionId = data.transaction_id; deadline = expires(data); registrationStep("totp");
  });
  form("register-totp-form", "register", async current => {
    unexpired(deadline); const code = codeValue($("register-totp").value); $("register-totp").value = "";
    const data = await post("register/verify-totp", { transaction_id: transactionId, code,
      trust_this_device: $("register-trust").checked, remember_me: $("register-remember").checked });
    if (!current()) return;
    session.accept(data); clearSetup(); transactionId = ""; deadline = 0;
    if (!Array.isArray(data.recovery_codes) || data.recovery_codes.length !== 10 || data.recovery_codes.some(code => !/^[A-Za-z0-9_-]{43}$/.test(code))) throw new PublicError("SERVICE_UNAVAILABLE");
    recoveryCodes = [...data.recovery_codes];
    $("recovery-codes").replaceChildren(...recoveryCodes.map(code => element("li", code)));
    registrationStep("recovery");
  });
  $("copy-recovery-codes").addEventListener("click", async () => {
    if (registration !== "recovery" || !recoveryCodes.length) return;
    const current = epoch;
    try { await navigator.clipboard.writeText(recoveryCodes.join("\n")); if (epoch === current) $("recovery-copy-status").textContent = "已複製，請保存到自己的安全筆記。"; }
    catch { if (epoch === current) $("recovery-copy-status").textContent = "瀏覽器未允許複製，請手動選取全部復原碼並保存。"; }
  });
  $("recovery-ack").addEventListener("change", syncCooldown);
  $("registration-done").addEventListener("click", () => { if ($("recovery-ack").checked) { clearRecovery(); registrationStep("success"); } });
  $("register-restart").addEventListener("click", () => { if (!busy) { resetAuth(); void mountRegistration(); } });
  $("register-challenge-retry").addEventListener("click", () => { challenge.reset(); void mountRegistration(); });

  form("login-form", "login", async current => {
    const email = emailValue($("login-email").value), password = passwordValue($("login-password").value);
    $("login-password").value = "";
    const data = await post("login", { email, password, remember_me: $("login-remember").checked });
    if (!current()) return;
    $("login-email").value = "";
    if (data.member) { session.accept(data); location.hash = "member"; }
    else if (data.status === "MFA_REQUIRED") {
      loginTx = data.transaction_id; loginDeadline = expires(data);
      $("login-methods").hidden = true;
      $("login-form").hidden = true; $("login-totp-form").hidden = false; $("login-totp").focus(); syncCooldown();
    } else throw new PublicError("SERVICE_UNAVAILABLE");
  });
  form("login-totp-form", "login", async current => {
    unexpired(loginDeadline); const code = codeValue($("login-totp").value); $("login-totp").value = "";
    const data = await post("login/totp", { transaction_id: loginTx, code, trust_this_device: $("login-trust").checked });
    if (current()) { session.accept(data); location.hash = "member"; }
  });
  $("login-restart").addEventListener("click", () => {
    if (!busy) { resetAuth(); $("login-password-options").open = true; $("login-email").focus(); }
  });
  form("recover-proof-form", "recover", async current => {
    const email = emailValue($("recover-email").value), code = codeValue($("recover-totp").value), recovery_code = $("recover-code").value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(recovery_code)) throw new PublicError("RECOVERY_FORMAT");
    $("recover-email").value = $("recover-totp").value = $("recover-code").value = "";
    // A generic transaction is NOT evidence the proofs are valid: finish is
    // authoritative. Do not announce existence/verification of this identity.
    const data = await post("recovery/password/start", { email, code, recovery_code });
    if (current()) {
      recoveryTx = data.transaction_id; recoveryDeadline = expires(data);
      $("recover-proof-form").hidden = true; $("recover-password-form").hidden = false; $("recover-password").focus(); syncCooldown();
    }
  });
  form("recover-password-form", "recover", async current => {
    unexpired(recoveryDeadline); const new_password = passwordValue($("recover-password").value, $("recover-confirm").value);
    $("recover-password").value = $("recover-confirm").value = "";
    const data = await post("recovery/password/finish", { transaction_id: recoveryTx, new_password });
    if (current() && data.recovered === true && data.login_required === true) {
      session.clear(); recoveryTx = ""; recoveryDeadline = 0;
      $("recover-password-form").hidden = true; $("recover-success").hidden = false; syncCooldown();
    }
  });
  $("recover-restart").addEventListener("click", () => { if (!busy) resetAuth(); });
  for (const button of document.querySelectorAll("[data-password]")) {
    button.setAttribute("aria-controls", button.dataset.password);
    button.setAttribute("aria-label", "顯示或隱藏" + document.querySelector(`label[for="${button.dataset.password}"]`).textContent);
    button.addEventListener("click", () => {
      const input = $(button.dataset.password), show = input.type === "password";
      input.type = show ? "text" : "password"; button.textContent = show ? "隱藏" : "顯示"; button.setAttribute("aria-pressed", String(show));
    });
  }
  // Single accessible control accepts an entire pasted code, preserving zeros.
  for (const input of document.querySelectorAll('[data-role="auth-code"]')) input.addEventListener("paste", event => {
    const code = event.clipboardData?.getData("text").trim();
    if (/^\d{6}$/.test(code ?? "")) { event.preventDefault(); input.value = code; input.dispatchEvent(new Event("input", { bubbles: true })); }
  });
  $("logout-button").addEventListener("click", async () => {
    if (busy || $("logout-button").disabled) return;
    $("logout-button").disabled = true;
    try {
      await session.request("/api/auth/logout", { method: "POST", body: {} });
      $("logout-button").textContent = "登出";
      session.clear(); resetAuth(); if (["member", "security", "google"].includes(view)) location.hash = "login";
      $("account-status").textContent = "已登出。"; $("account-status").hidden = false;
    } catch (error) { $("account-status").textContent = authMessage(error); $("account-status").hidden = false; $("logout-button").textContent = "重試登出"; }
    finally { $("logout-button").disabled = false; }
  });

  async function mountRegistration() {
    const current = epoch;
    try { await challenge.mount(); }
    catch (error) { if (current === epoch) $("register-challenge-status").textContent = authMessage(error); }
    if (view !== "register") challenge.clear();
  }
  function caseRow(row) {
    const card = element("div", "", "row member-case legacy-case-row"), text = element("div", "", "grow");
    text.append(element("strong", row.case_id + " · " + (session.member?.nickname ?? "")),
      element("span", [campaignName(row.campaign_id), row.vote_type, row.vote_date].filter(Boolean).join("｜")));
    const status = element("span", statuses[row.status] ?? "狀態更新中", "status");
    if (Object.hasOwn(statuses, row.status)) status.classList.add(row.status);
    card.append(text, status); return card;
  }
  async function loadRecentCases() {
    if (view !== "submit" || !session.member) return;
    const owner = session.member.member_id, sequence = ++recentSequence;
    $("recent-cases").replaceChildren(); $("recent-cases-status").textContent = "正在載入最近投稿…";
    $("recent-cases-member").hidden = true;
    const sameOwner = () => view === "submit" && recentSequence === sequence && session.member?.member_id === owner;
    try {
      const data = await session.request("/api/me/cases?limit=3");
      if (!sameOwner()) return;
      for (const row of data.cases) {
        const card = caseRow(row), icon = element("span", "▣", "case-icon"); icon.setAttribute("aria-hidden", "true");
        card.prepend(icon); $("recent-cases").append(card);
      }
      $("recent-cases-status").textContent = data.cases.length ? "" : "目前沒有案件紀錄。";
      $("recent-cases-member").hidden = false;
    } catch (error) { if (sameOwner()) $("recent-cases-status").textContent = authMessage(error); }
  }
  const sameMember = (owner, sequence) => view === "member" && memberEpoch === sequence && session.member?.member_id === owner;
  async function loadCases(append = false, sequence = memberEpoch) {
    if (!session.member || casesBusy === sequence || append && !casesCursor) return;
    const owner = session.member.member_id; casesBusy = sequence; $("member-cases-more").disabled = true;
    $("member-cases-status").textContent = "正在載入案件…";
    try {
      const data = await session.request("/api/me/cases?limit=10" + (append ? "&cursor=" + encodeURIComponent(casesCursor) : ""));
      if (!sameMember(owner, sequence)) return;
      if (!append) $("member-cases").replaceChildren();
      for (const row of data.cases) {
        const card = caseRow(row), button = element("button", "▣", "case-icon"); button.type = "button";
        button.setAttribute("aria-label", "查看案件 " + row.case_id);
        card.prepend(button);
        button.addEventListener("click", async () => {
          if (!sameMember(owner, sequence) || button.disabled) return;
          button.disabled = true;
          try {
            const detail = await session.request("/api/me/cases/" + encodeURIComponent(row.case_id));
            if (!sameMember(owner, sequence)) return;
            $("member-case-fields").replaceChildren();
            for (const [name, value] of [["案件編號", detail.case_id], ["活動", campaignName(detail.campaign_id)], ["投稿時間", memberDate(detail.created_at)], ["已給點數", detail.points_awarded ?? "—"], ["投票日期", detail.vote_date],
              ["類型", detail.vote_type], ["狀態", statuses[detail.status] ?? "狀態更新中"]]) $("member-case-fields").append(element("dt", name), element("dd", value));
            $("member-case-detail").hidden = false;
          } catch (error) { if (sameMember(owner, sequence)) $("member-cases-status").textContent = error.status === 404 ? "無法查詢此案件。" : authMessage(error); }
          finally { button.disabled = false; }
        });
        $("member-cases").append(card);
      }
      casesCursor = data.next_cursor; $("member-cases-more").hidden = !casesCursor;
      $("member-cases-status").textContent = $("member-cases").children.length ? "" : "目前沒有案件紀錄。";
    } catch (error) { if (sameMember(owner, sequence)) $("member-cases-status").textContent = authMessage(error); }
    finally { if (casesBusy === sequence) { casesBusy = null; $("member-cases-more").disabled = false; } }
  }
  async function loadMember() {
    const sequence = ++memberEpoch;
    $("member-error").textContent = "";
    $("member-record-total").textContent = "—";
    try { await session.refresh(); }
    catch (error) { if (view === "member") $("member-error").textContent = authMessage(error); return; }
    if (view !== "member" || !session.member || sequence !== memberEpoch) return;
    const owner = session.member.member_id;
    $("points-content").hidden = true; $("points-status").textContent = "正在載入點數…"; $("member-refresh").disabled = true;
    casesCursor = null; $("member-case-detail").hidden = true;
    const cases = loadCases(false, sequence);
    try {
      const data = await session.request("/api/me/points");
      if (!sameMember(owner, sequence)) return;
      $("member-record-total").textContent = Number(data.total_points).toLocaleString("zh-TW");
      $("member-points").textContent = String(data.total_points);
      const art = tierArtwork(data.tier?.tier_id);
      $("member-tier").textContent = art ? art.name : "暫時無法取得";
      renderTierArtwork($("member-tier-artwork"), art ? data.tier.tier_id : null);
      const progress = memberTierProgress(data);
      $("tier-message").textContent = progress.state === "unconfigured" ? "升級門檻尚未設定" : progress.state === "highest" ? "已達目前最高等級" : "";
      $("tier-next").hidden = progress.state !== "next";
      $("tier-points").textContent = progress.state === "next" ? `${progress.totalPoints} / ${progress.requiredPoints} 點` : "";
      $("tier-gap").textContent = progress.state === "next" ? `距離「${progress.nextName}」還差 ${progress.remainingPoints} 點` : "";
      $("tier-progress").value = progress.state === "next" ? progress.percent : 0;
      $("points-status").textContent = ""; $("points-content").hidden = false;
    } catch (error) { if (sameMember(owner, sequence)) $("points-status").textContent = authMessage(error); }
    finally { await cases; $("member-refresh").disabled = false; }
  }
  $("member-refresh").addEventListener("click", () => { if (!$("member-refresh").disabled) void loadMember(); });
  $("member-cases-more").addEventListener("click", () => { void loadCases(true); });
  $("profile-form").addEventListener("submit", async event => {
    event.preventDefault(); const button = $("profile-save"); if (button.disabled || !session.member) return;
    const nickname = $("profile-nickname").value.trim(), player_id = $("profile-player").value.trim();
    if (!nickname || [...nickname].length > 50 || [...player_id].length > 100 || /[\u0000-\u001f\u007f]/.test(nickname + player_id)) {
      $("profile-status").textContent = "請填寫 1～50 字暱稱；玩家 ID 最多 100 字。"; return;
    }
    const owner = session.member.member_id, sequence = memberEpoch; button.disabled = true;
    try {
      const data = await session.request("/api/me/profile", { method: "PATCH", body: { nickname, ...(player_id ? { player_id } : {}) } });
      if (sameMember(owner, sequence)) { session.updateProfile(data.member); $("profile-status").textContent = "會員資料已保存。"; }
    } catch (error) { if (view === "member") $("profile-status").textContent = authMessage(error); }
    finally { button.disabled = false; }
  });
  let ticker;
  function enter(next) {
    if (next === view) return;
    if (!(next === "security" && view === "register")) pendingEmailAdd = null;
    if (authViews.includes(view)) {
      $("view-" + view).setAttribute("aria-busy", "false");
      resetAuth();
    }
    memberEpoch++; view = next; clearInterval(ticker);
    if (view === "login") {
      const url = new URL(location.href), notice = url.searchParams.get("auth_notice");
      const messages = { google_cancelled: "Google 登入已取消；沒有建立新的 VoteProof 登入。你仍可使用訪客功能或重新登入。",
        google_failed: "Google 登入未完成；請稍後重試。訪客功能仍可使用。" };
      if (Object.hasOwn(messages, notice)) $("login-error").textContent = messages[notice];
      if (url.searchParams.has("auth_notice")) {
        url.searchParams.delete("auth_notice"); history.replaceState(null, "", url.pathname + url.search + url.hash);
      }
      syncLogin();
    }
    if (authViews.includes(view)) ticker = setInterval(syncCooldown, 1000);
    if (view === "register") void mountRegistration();
    if (view === "member") void loadMember();
    if (view === "submit") void loadRecentCases();
    if (view === "google") void loadGoogle();
    if (view === "security") void loadSecurity();
  }
  // One boot probe, independent of all public API loading. No polling/redirect
  // loop and no provider connection; failed auth leaves Guest untouched.
  const ready = session.refresh().catch(() => {}).finally(() => { loginSessionChecked = true; syncLogin(); });
  window.addEventListener("pagehide", () => { pendingEmailAdd = null; resetAuth(); clearInterval(ticker); });
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    if (authViews.includes(view)) ticker = setInterval(syncCooldown, 1000);
    if (view === "register") void mountRegistration();
    if (view === "google") void loadGoogle();
    if (view === "security") void loadSecurity();
    if (view === "member") void loadMember(); else void session.refresh().catch(() => {});
  });
  return { session, enter, loadRecentCases, ready };
}
