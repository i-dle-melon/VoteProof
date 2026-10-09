import qrcode from "./vendor/qrcode.js";
import { PublicError } from "./api.js";

export function enrollmentKey(uri) {
  let url;
  try { url = new URL(uri); } catch { /* Reject a malformed enrollment grant. */ }
  if (!url || url.protocol !== "otpauth:" || url.hostname !== "totp" || uri.length > 2048 ||
      !/^[A-Z2-7]{32}$/.test(url.searchParams.get("secret") ?? "")) throw new PublicError("SERVICE_UNAVAILABLE");
  return url.searchParams.get("secret");
}
export function drawEnrollment(canvas, uri) {
  enrollmentKey(uri);
  const qr = qrcode(0, "M"); qr.addData(uri, "Byte"); qr.make();
  // Integer pixels and four-module quiet zone, with theme-independent contrast.
  const count = qr.getModuleCount(), scale = 5, padding = 4;
  canvas.width = canvas.height = (count + padding * 2) * scale;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000";
  for (let y = 0; y < count; y++) for (let x = 0; x < count; x++)
    if (qr.isDark(y, x)) context.fillRect((x + padding) * scale, (y + padding) * scale, scale, scale);
}
export function clearEnrollment(canvas) {
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  canvas.width = canvas.height = 0;
}
