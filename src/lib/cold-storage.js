import { AdminError } from "./admin-identity.js";
export const coldError = () =>
  new AdminError(503, "DRIVE_VERIFICATION_UNAVAILABLE", "Drive 備份驗證暫時無法完成，未執行清理。");
export async function storageSignature(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return btoa(
    String.fromCharCode(
      ...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value))),
    ),
  )
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function boundedJson(response, max = 7100000) {
  const reader = response.body?.getReader();
  if (!reader) throw coldError();
  let size = 0;
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw coldError();
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let at = 0;
    for (const part of parts) {
      bytes.set(part, at);
      at += part.length;
    }
    return JSON.parse(new TextDecoder().decode(bytes));
  } finally {
    await reader.cancel().catch(() => {});
  }
}
export function scriptUrl(value) {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.hostname !== "script.google.com" ||
      u.port ||
      u.username ||
      u.password ||
      u.search ||
      u.hash ||
      !/^\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(u.pathname)
    )
      throw Error();
    return u.href;
  } catch {
    throw coldError();
  }
}
export async function scriptPost(url, payload, fetcher = fetch) {
  url = scriptUrl(url);
  for (let redirects = 0; redirects <= 2; redirects++) {
    const response = await fetcher(url, {
      method: redirects ? "GET" : "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(20000),
      ...(!redirects
        ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
        : {}),
    });
    if (response.ok) return response;
    if (![301, 302, 303].includes(response.status)) {
      await response.body?.cancel();
      throw coldError();
    }
    const next = new URL(response.headers.get("Location"), url);
    await response.body?.cancel();
    if (
      next.protocol !== "https:" ||
      next.hostname !== "script.googleusercontent.com" ||
      next.pathname !== "/macros/echo" ||
      next.port ||
      next.username ||
      next.password ||
      next.hash
    )
      throw coldError();
    url = next.href;
  }
  throw coldError();
}
export const shaBytes = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
export async function coldContext(db, key) {
  return db
    .prepare(
      `SELECT f.id file_id,f.object_key,f.size,f.content_type,f.etag,c.id case_internal_id,c.case_id,c.status,c.reviewed_at,coalesce(c.status_updated_at,c.updated_at) closed_at,c.version case_version,
 b.id backup_id,b.status backup_status,b.version backup_version,b.drive_file_id,b.drive_folder_id,b.root_folder_id,b.source_object_key,b.source_size,b.source_mime,b.source_etag,
 (SELECT sha256 FROM proof_exact_hashes h WHERE h.file_id=f.id AND h.source_etag=f.etag AND h.source_size=f.size) known_sha,
 (SELECT sha256 FROM cold_proofs p WHERE p.file_id=f.id AND p.etag=f.etag AND p.size=f.size AND p.state IN('dry_run','cold')) manifest_sha,
 (SELECT parent_folder_id FROM drive_backup_folders d WHERE d.drive_folder_id=b.drive_folder_id AND d.root_folder_id=b.root_folder_id) campaign_folder_id,
 (SELECT folder_key FROM drive_backup_folders d WHERE d.drive_folder_id=b.drive_folder_id AND d.root_folder_id=b.root_folder_id) date_key,
 (SELECT folder_key FROM drive_backup_folders d WHERE d.drive_folder_id=(SELECT parent_folder_id FROM drive_backup_folders WHERE drive_folder_id=b.drive_folder_id) AND d.root_folder_id=b.root_folder_id) campaign_key
 FROM case_files f JOIN cases c ON c.id=f.case_id JOIN proof_backups b ON b.file_id=f.id AND b.provider='google_drive' WHERE f.object_key=?`,
    )
    .bind(key)
    .first();
}
export function validColdSource(row) {
  return (
    row &&
    row.backup_status === "confirmed" &&
    row.drive_file_id &&
    row.drive_folder_id &&
    row.root_folder_id &&
    row.campaign_folder_id &&
    row.date_key &&
    row.campaign_key &&
    row.source_object_key === row.object_key &&
    row.source_size === row.size &&
    row.source_mime === row.content_type &&
    row.source_etag === row.etag &&
    row.size > 0 &&
    row.size <= 5242880
  );
}
// Drive media cold-read and Drive-to-R2 restoration are intentionally absent.
