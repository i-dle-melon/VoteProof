import { AuthError } from '../api/auth-validation.js';
// Preserve existing trim/display behavior; fold ASCII case only, no Unicode conversion.
export const normalizeFanId = value => value.trim().replace(/[A-Z]/g, c => c.toLowerCase());
export const fanIdTaken = () => new AuthError(409,'FAN_ID_TAKEN','這個粉絲 ID 已被使用，請選擇其他 ID。');
export const fanIdImmutable = () => new AuthError(409,'FAN_ID_IMMUTABLE','粉絲 ID 建立後無法修改。');
export function fanIdError(error) {
  const message = String(error?.message ?? error);
  if (/members_fan_id_unique|members\.player_id|FAN_ID_TAKEN/i.test(message)) return fanIdTaken();
  if (/FAN_ID_IMMUTABLE/.test(message)) return fanIdImmutable();
  return error;
}
export async function nicknameWarning(db,nickname,memberId=null) {
  return { duplicate: Boolean(await db.prepare('SELECT 1 FROM members WHERE nickname=? AND (? IS NULL OR member_id!=?) LIMIT 1').bind(nickname,memberId,memberId).first()) };
}
