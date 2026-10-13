import { PublicError } from "./api.js";

export function dailyLimit(mode, value) {
  if (mode === "unlimited") return null;
  if (mode === "zero") return 0;
  if (mode !== "limited" || !/^[1-9]\d{0,3}$/.test(String(value)) || Number(value) > 1000) throw new PublicError("INVALID_CAMPAIGN_REQUEST");
  return Number(value);
}
export function taipeiInput(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return "";
  return new Date(date.valueOf() + 8 * 3600000).toISOString().slice(0, 19);
}
export function utcFromTaipei(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new PublicError("INVALID_CAMPAIGN_REQUEST");
  const stamp = new Date(value + (value.length === 16 ? ":00" : "") + "+08:00");
  if (!Number.isFinite(stamp.valueOf()) || taipeiInput(stamp) !== value.padEnd(19, ":00")) throw new PublicError("INVALID_CAMPAIGN_REQUEST");
  return stamp.toISOString();
}
export function reviewActions(status, role) {
  if (!["reviewer", "admin", "super_admin"].includes(role)) return [];
  if (status === "pending") return ["approve", "reject", "mark_duplicate"];
  if (role === "reviewer") return [];
  return status === "approved" ? ["complete", "revoke"] : status === "completed" ? ["revoke"] : [];
}
export const adminMessage = error => {
  if (error?.code === 'DRIVE_BACKUP_DISABLED') return 'Google Drive 備份尚未啟用。';
  if (error?.code === 'DRIVE_BACKUP_NOT_CONFIGURED') return 'Google Drive 備份尚未設定完成。';
  if (error?.code === 'BACKUP_PROCESS_FAILED') return '備份未完成，請重新載入確認狀態；未自動重送。';
  if (["ADMIN_STEP_UP_REQUIRED", "AUTH_STEP_UP_REQUIRED", "AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(error?.code)) return "請重新驗證身份，再繼續管理操作。";
  if (error?.code === "ADMIN_FORBIDDEN") return "你目前沒有此操作的管理權限。";
  if (error?.status === 409) return "資料已更新或狀態不允許此操作。請重新載入確認；未自動重送操作。";
  if (error?.status === 400) return "請確認欄位、日期、活動與計分設定是否正確。";
  if (error?.status === 404) return "找不到此資料，請重新載入。";
  return "管理資料暫時無法載入，請稍後重新載入。操作未自動重送。";
};

// Authorization comes exclusively from the Worker; timers only close UI early.
// Every privileged read/write revalidates identity, role and elevation.
export class AdminAccess {
  constructor(session, changed) { this.session = session; this.changed = changed; this.owner = null; this.actor = null; this.epoch = 0; }
  identity(member) {
    if (member?.member_id === this.owner) return;
    this.clear(); this.owner = member?.member_id ?? null;
    if (this.owner) void this.check().catch(() => {});
  }
  clear() { clearTimeout(this.timer); this.epoch++; this.actor = null; this.changed(null); }
  async check(signal) {
    const owner = this.session.member?.member_id, epoch = this.epoch;
    if (!owner) { this.clear(); throw new PublicError("AUTH_REQUIRED"); }
    try {
      const current = await this.session.refresh();
      if (epoch !== this.epoch || current.member.member_id !== owner || this.session.member?.member_id !== owner) throw new PublicError("AUTH_IDENTITY_CHANGED");
      const actor = await this.session.adminRequest("/api/admin/me", { signal });
      if (epoch !== this.epoch || actor.member_id !== owner || !["reviewer", "admin", "super_admin"].includes(actor.role)) throw new PublicError("ADMIN_FORBIDDEN");
      this.actor = Object.freeze({ member_id: owner, role: actor.role });
      clearTimeout(this.timer);
      if (Number.isFinite(current.elevated_until)) {
        const deadline = current.elevated_until * 1000;
        if (deadline <= Date.now()) throw new PublicError("ADMIN_STEP_UP_REQUIRED");
        const expire = () => {
          if (epoch !== this.epoch) return;
          const remaining = deadline - Date.now();
          if (remaining <= 0) { this.clear(); return; }
          this.timer = setTimeout(expire, Math.min(remaining, 2147483647)); this.timer?.unref?.();
        };
        expire();
      }
      this.changed(this.actor); return this.actor;
    } catch (error) { if (epoch === this.epoch) this.clear(); throw error; }
  }
  async request(path, options = {}) {
    const actor = await this.check(options.signal), epoch = this.epoch;
    try {
      const data = await this.session.adminRequest(path, options);
      if (epoch !== this.epoch || this.session.member?.member_id !== actor.member_id) throw new PublicError("AUTH_IDENTITY_CHANGED");
      return data;
    } catch (error) {
      if (["ADMIN_FORBIDDEN", "ADMIN_STEP_UP_REQUIRED", "AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(error.code)) this.clear();
      throw error;
    }
  }
}
