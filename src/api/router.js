import { getHealth } from "./health.js";
import { getCampaigns } from "./campaigns.js";
import { getLeaderboards } from "./leaderboards.js";
import { jsonError } from "./response.js";
import { prepareUpload, completeUpload } from "./uploads.js";
import { createCase, getCase } from "./cases.js";
import { currentMember, logout } from "./auth.js";
import { googleStart, googleCallback, googleResult, googleConfirm, googleCancel, loginSecurity } from "./auth-google.js";
import { addPasswordStart, addPasswordVerify, googleTotpEnrollStart, googleTotpEnrollVerify, googleStepUp } from "./auth-methods.js";
import { updateProfile, listMemberCases, getMemberCase } from "./members.js";
import { adminRoute } from "./admin.js";
import { campaignRoute } from "./admin-campaigns.js";
import { pointRoute } from "./points.js";
import { leaderboardRoute } from "./admin-leaderboards.js";
import { memberTierRoute } from "./member-tiers.js";
import { registrationCredentials, registrationResend, registrationVerifyEmail, registrationStatus } from "./auth-registration.js";

import {
  registrationStart,
  registrationVerify,
  passwordLogin,
  loginTotp,
} from "./auth-login.js";
import {
  stepUp,
  passwordChange,
  passwordChangeStart,
  listDevices,
  revokeDevice,
  revokeOtherDevices,
  regenerateRecovery,
  totpResetStart,
  totpResetVerify,
} from "./auth-security.js";
import {
  passwordRecoveryStart,
  passwordRecoveryFinish,
  totpRecoveryStart,
  totpRecoveryFinish,
} from "./auth-recovery.js";
const routes = new Map([
  ["/api/health", { method: "GET", handler: getHealth }],
  ["/api/campaigns", { method: "GET", handler: getCampaigns }],
  ["/api/leaderboards", { method: "GET", handler: getLeaderboards }],
  ["/api/uploads/prepare", { method: "POST", handler: prepareUpload }],
  ["/api/uploads/complete", { method: "POST", handler: completeUpload }],
  ["/api/cases", { method: "POST", handler: createCase }],
  ["/api/auth/registration-status", { method: "GET", handler: registrationStatus }],
  ["/api/auth/google/callback", { method: "GET", handler: googleCallback }],
  ["/api/auth/google/result", { method: "GET", handler: googleResult }],
  ["/api/auth/login-security", { method: "GET", handler: loginSecurity }],
  ...Object.entries({
    "/api/auth/google/start": googleStart,
    "/api/auth/google/confirm": googleConfirm,
    "/api/auth/google/cancel": googleCancel,
    "/api/auth/google/step-up": googleStepUp,
    "/api/auth/password/add/start": addPasswordStart,
    "/api/auth/password/add/verify": addPasswordVerify,
    "/api/auth/google/totp/enroll/start": googleTotpEnrollStart,
    "/api/auth/google/totp/enroll/verify": googleTotpEnrollVerify,
    "/api/auth/register/start": registrationStart,
    "/api/auth/register/resend": registrationResend,
    "/api/auth/register/verify-email": registrationVerifyEmail,
    "/api/auth/register/credentials": registrationCredentials,
    "/api/auth/register/verify-totp": registrationVerify,
    "/api/auth/login": passwordLogin,
    "/api/auth/login/totp": loginTotp,
    "/api/auth/step-up": stepUp,
    "/api/auth/password/change": passwordChange,
    "/api/auth/password/change/start": passwordChangeStart,
    "/api/auth/recovery-codes/regenerate": regenerateRecovery,
    "/api/auth/trusted-devices/revoke-others": revokeOtherDevices,
    "/api/auth/totp/reset/start": totpResetStart,
    "/api/auth/totp/reset/verify": totpResetVerify,
    "/api/auth/recovery/password/start": passwordRecoveryStart,
    "/api/auth/recovery/password/finish": passwordRecoveryFinish,
    "/api/auth/recovery/totp/start": totpRecoveryStart,
    "/api/auth/recovery/totp/verify": totpRecoveryFinish,
  }).map(([path, handler]) => [path, { method: "POST", handler }]),
  ["/api/auth/trusted-devices", { method: "GET", handler: listDevices }],
  ["/api/auth/me", { method: "GET", handler: currentMember }],
  ["/api/auth/logout", { method: "POST", handler: logout }],
  ["/api/me/profile", { method: "PATCH", handler: updateProfile }],
  ["/api/me/cases", { method: "GET", handler: listMemberCases }],
]);

export async function routeApi(request, env, url) {
  const route =
    routes.get(url.pathname) ??
    (/^\/api\/auth\/trusted-devices\/[^/]+\/revoke$/.test(url.pathname)
      ? { method: "POST", handler: revokeDevice }
      : undefined) ??
    adminRoute(url.pathname) ??
    campaignRoute(url.pathname, request.method) ??
    pointRoute(url.pathname) ??
    leaderboardRoute(url.pathname, request.method) ??
    memberTierRoute(url.pathname) ??
    (/^\/api\/cases\/[^/]+$/.test(url.pathname)
      ? { method: "GET", handler: getCase }
      : /^\/api\/me\/cases\/[^/]+$/.test(url.pathname)
        ? { method: "GET", handler: getMemberCase }
        : undefined);
  if (!route) {
    return jsonError(404, "NOT_FOUND", "API endpoint not found");
  }
  if (request.method !== route.method) {
    return jsonError(
      405,
      "METHOD_NOT_ALLOWED",
      `Only ${route.allow ?? route.method} is supported`,
      { allow: route.allow ?? route.method },
    );
  }
  try {
    return await route.handler(env, url, request);
  } catch {
    // Never expose exception messages, environment bindings or upstream URLs.
    return jsonError(500, "INTERNAL_ERROR", "API request failed");
  }
}
