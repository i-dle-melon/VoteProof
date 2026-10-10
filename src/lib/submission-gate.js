export const SUBMISSIONS_MESSAGE_MAX = 500;
export const SUBMISSIONS_DEFAULT_MESSAGE = "投稿暫停開放，請稍後再試。";
export class SubmissionError extends Error {
  constructor(code = "SUBMISSIONS_UNAVAILABLE", message = "Submission service is unavailable") {
    super(message); this.status = 503; this.code = code;
  }
}
export function safeSubmissionMessage(value) {
  return value === null || typeof value === "string" && [...value].length <= SUBMISSIONS_MESSAGE_MAX &&
    !/[\u0000-\u001f\u007f]/.test(value);
}
export async function submissionSettings(db) {
  try {
    if (typeof db?.prepare !== "function") throw new Error();
    const row = await db.prepare("SELECT submissions_enabled, submissions_message, version FROM submission_settings WHERE id=1").first();
    if (!row) return { submissions_enabled: false, submissions_message: SUBMISSIONS_DEFAULT_MESSAGE, version: 0 };
    if (![0,1].includes(row.submissions_enabled) || !safeSubmissionMessage(row.submissions_message)) throw new Error();
    return { submissions_enabled: row.submissions_enabled === 1, submissions_message: row.submissions_message, version: row.version };
  } catch { throw new SubmissionError(); }
}
export const publicSubmissionSettings = row => ({ submissions_enabled: row.submissions_enabled, submissions_message: row.submissions_message });
export async function requireSubmissionsEnabled(db) {
  if (!(await submissionSettings(db)).submissions_enabled) throw new SubmissionError("SUBMISSIONS_DISABLED", "Submissions are currently disabled");
}
