import { AdminError, ELEVATED_ROLES } from "./admin-identity.js";
import { CASE_ID_PATTERN } from "./case-keys.js";

export const CASE_STATUSES = Object.freeze(["pending", "approved", "completed", "rejected", "duplicate", "revoked"]);
export const REVIEW_LIMITS = Object.freeze({ reason: 500, defaultPage: 20, maxPage: 50, maxCursor: 1024 });
const transitions = Object.freeze({
  approve: { from: ["pending"], to: "approved" },
  reject: { from: ["pending"], to: "rejected", reason: true },
  mark_duplicate: { from: ["pending"], to: "duplicate", reason: true },
  complete: { from: ["approved"], to: "completed", elevated: true },
  revoke: { from: ["approved", "completed"], to: "revoked", reason: true, elevated: true },
});
export const statusConflict = () => new AdminError(409, "CASE_STATUS_CONFLICT", "Case status or version has changed");
export const caseNotFound = () => new AdminError(404, "CASE_NOT_FOUND", "Case not found");
export const invalidReview = () => new AdminError(400, "INVALID_REVIEW_REQUEST", "Invalid case review request");
export const invalidDuplicate = () => new AdminError(400, "INVALID_DUPLICATE_TARGET", "A valid different case is required");

export function reviewInput(body, role) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(k => !["action", "expected_version", "reason", "duplicate_of_case_id"].includes(k))) throw invalidReview();
  const transition = typeof body.action === "string" && Object.hasOwn(transitions, body.action) && transitions[body.action];
  if (!transition || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0 || body.expected_version >= Number.MAX_SAFE_INTEGER) throw invalidReview();
  if (transition.elevated && !ELEVATED_ROLES.includes(role)) throw new AdminError(403, "ADMIN_FORBIDDEN", "This action requires an administrator");
  let reason = null;
  if (body.reason !== undefined && body.reason !== null) {
    if (typeof body.reason !== "string" || [...body.reason.trim()].length > REVIEW_LIMITS.reason || /[\u0000-\u001f\u007f]/.test(body.reason)) throw invalidReview();
    reason = body.reason.trim() || null;
  }
  if (transition.reason && !reason) throw invalidReview();
  if (body.action === "mark_duplicate") {
    if (typeof body.duplicate_of_case_id !== "string" || !CASE_ID_PATTERN.test(body.duplicate_of_case_id)) throw invalidDuplicate();
  } else if (body.duplicate_of_case_id !== undefined) throw invalidReview();
  return { action: body.action, expectedVersion: body.expected_version, reason, duplicateCaseId: body.duplicate_of_case_id ?? null, transition };
}

export function reviewTransition(row, input) {
  if (row.version !== input.expectedVersion || !input.transition.from.includes(row.status)) throw statusConflict();
  // TODO B5B: atomic point-ledger entries belong in the same transaction as the
  // transition. B5A deliberately never changes points_awarded or member totals.
  // Revoked restoration is not enabled without verified legacy business rules.
  return input.transition.to;
}
