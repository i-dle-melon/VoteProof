import { AdminError } from "./admin-identity.js";
import { nowSeconds, storageAudit, capacityRow, STORAGE } from "./storage-capacity.js";
import { authAtomic } from "./auth-store.js";
export const coldError = () =>
  new AdminError(503, "COLD_PROOF_UNAVAILABLE", "冷儲存圖片暫時無法讀取，請稍後再試。");
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
const sameSignature = (a, b) => {
  if (typeof a !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};
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
      `SELECT f.id file_id,f.object_key,f.size,f.content_type,f.etag,c.id case_internal_id,c.case_id,c.status,c.reviewed_at,c.version case_version,
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
export async function readColdProof(env, row, expectedSha, { fetcher = fetch } = {}) {
  if (
    !validColdSource(row) ||
    !/^[a-f0-9]{64}$/.test(expectedSha ?? "") ||
    !/^[a-f0-9]{64}$/.test(env.DRIVE_BACKUP_RELAY_SECRET ?? "")
  )
    throw coldError();
  const request = {
    version: 1,
    purpose: "cold_read",
    nonce: crypto.randomUUID(),
    timestamp: nowSeconds(),
    file_id: row.drive_file_id,
  };
  request.signature = await storageSignature(
    env.DRIVE_BACKUP_RELAY_SECRET,
    JSON.stringify([
      "VoteProof/storage-read",
      request.version,
      request.purpose,
      request.nonce,
      request.timestamp,
      request.file_id,
    ]),
  );
  const result = await boundedJson(await scriptPost(env.DRIVE_COLD_RELAY_URL, request, fetcher));
  if (
    result.nonce !== request.nonce ||
    Math.abs(nowSeconds() - result.timestamp) > 120 ||
    typeof result.payload !== "string" ||
    !sameSignature(
      result.signature,
      await storageSignature(
        env.DRIVE_BACKUP_RELAY_SECRET,
        JSON.stringify([
          "VoteProof/storage-read-result",
          result.nonce,
          result.timestamp,
          result.payload,
        ]),
      ),
    )
  )
    throw coldError();
  let payload, bytes;
  try {
    payload = JSON.parse(result.payload);
    if (typeof payload.base64 !== "string" || payload.base64.length > 6990510) throw Error();
    if (typeof Uint8Array.fromBase64 === 'function') bytes=Uint8Array.fromBase64(payload.base64);
    else { const binary=atob(payload.base64);bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i); }
  } catch {
    throw coldError();
  }
  const m = payload.metadata,
    a = m?.appProperties;
  if (
    !m ||
    m.id !== row.drive_file_id ||
    m.trashed !== false ||
    m.mimeType !== row.content_type ||
    Number(m.size) !== row.size ||
    !Array.isArray(m.parents) ||
    m.parents.length !== 1 ||
    m.parents[0] !== row.drive_folder_id ||
    m.name !==
      row.case_id +
        "." +
        { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[row.content_type] ||
    !a ||
    a.source !== "voteproof" ||
    a.storage_source !== "r2" ||
    a.voteproof_case_id !== row.case_id ||
    a.voteproof_proof_id !== row.file_id ||
    payload.root_folder_id !== row.root_folder_id ||
    payload.campaign_folder_id !== row.campaign_folder_id ||
    payload.date_folder_id !== row.drive_folder_id ||
    payload.campaign_key_hash !== (await shaBytes(new TextEncoder().encode(row.campaign_key))) ||
    payload.date_key_hash !== (await shaBytes(new TextEncoder().encode(row.date_key))) ||
    bytes.length !== row.size ||
    (await shaBytes(bytes)) !== expectedSha
  )
    throw coldError();
  return bytes;
}
export async function cleanupDryRun(
  env,
  { limit = 1, retentionDays = 30, read = readColdProof } = {},
) {
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 5 ||
    !Number.isInteger(retentionDays) ||
    retentionDays < 1
  )
    throw new AdminError(400, "INVALID_STORAGE_REQUEST", "清理參數無效。");
  const db = env.DB,
    at = nowSeconds(),
    capacity = await capacityRow(db);
  if (capacity.used_bytes < STORAGE.cleanupStart && !capacity.cleanup_requested)
    return { dry_run: true, retention_approved: false, items: [], target_bytes: STORAGE.target };
  const rows = (
    await db
      .prepare(
        `SELECT f.object_key FROM case_files f JOIN cases c ON c.id=f.case_id JOIN proof_backups b ON b.file_id=f.id
 LEFT JOIN cold_proofs p ON p.file_id=f.id WHERE c.status IN('completed','rejected','revoked') AND c.reviewed_at IS NOT NULL AND julianday(c.reviewed_at)<=julianday('now',?)
 AND b.status='confirmed' AND (p.file_id IS NULL OR p.state='blocked' OR (p.state='verifying' AND p.lease_until<=?)) ORDER BY c.reviewed_at,f.id LIMIT ?`,
      )
      .bind("-" + retentionDays + " days", at, limit)
      .all()
  ).results;
  const items = [];
  for (const candidate of rows) {
    const row = await coldContext(db, candidate.object_key),
      token = crypto.randomUUID();
    const claim = await db
      .prepare(
        `INSERT INTO cold_proofs(file_id,state,lease_token,lease_until,attempts,updated_at) VALUES(?,'verifying',?,?,1,?)
 ON CONFLICT(file_id) DO UPDATE SET state='verifying',lease_token=excluded.lease_token,lease_until=excluded.lease_until,attempts=attempts+1,updated_at=excluded.updated_at
 WHERE state='blocked' OR (state='verifying' AND lease_until<=?) RETURNING file_id`,
      )
      .bind(row.file_id, token, at + 180, at, at)
      .first();
    if (!claim) continue;
    let stage = "source";
    try {
      if (!validColdSource(row)) throw coldError();
      const hot = await env.PROOFS_BUCKET.get(row.object_key, {
        onlyIf: { etagMatches: row.etag },
      });
      if (
        !hot?.body ||
        hot.size !== row.size ||
        hot.etag !== row.etag ||
        hot.httpMetadata?.contentType !== row.content_type ||
        !hot.version
      ) {
        await hot?.body?.cancel();
        throw coldError();
      }
      stage = "r2_read";
      const source = await new Response(hot.body).arrayBuffer();
      stage = "r2_hash";
      const sha = await shaBytes(source);
      stage = "r2_size";
      if (source.byteLength !== row.size) throw coldError();
      stage = "r2_checksum";
      if (row.known_sha && row.known_sha !== sha) throw coldError();
      stage = "drive_bytes";
      await read(env, row, sha);
      stage = "r2_version";
      const head = await env.PROOFS_BUCKET.head(row.object_key);
      if (!head || head.etag !== hot.etag || head.version !== hot.version || head.size !== row.size)
        throw coldError();
      // Atomic final state checks pin case/backup versions and reject other active jobs.
      stage = "operation_conflict";
      await authAtomic(
        db,
        [
          {
            sql: `EXISTS(SELECT 1 FROM cases WHERE id=? AND version=? AND status IN('completed','rejected','revoked') AND reviewed_at=?)`,
            args: [row.case_internal_id, row.case_version, row.reviewed_at],
          },
          {
            sql: "EXISTS(SELECT 1 FROM proof_backups WHERE id=? AND version=? AND status='confirmed' AND lease_until IS NULL)",
            args: [row.backup_id, row.backup_version],
          },
          {
            sql: "NOT EXISTS(SELECT 1 FROM storage_reservations WHERE object_key=? AND state='reserved')",
            args: [row.object_key],
          },
          {
            sql: "NOT EXISTS(SELECT 1 FROM export_job_items i JOIN export_packages p ON p.job_id=i.job_id AND p.number=i.package_no WHERE i.file_id=? AND p.status='in_progress')",
            args: [row.file_id],
          },
          {
            sql: "EXISTS(SELECT 1 FROM cold_proofs WHERE file_id=? AND state='verifying' AND lease_token=? AND lease_until>?)",
            args: [row.file_id, token, nowSeconds()],
          },
        ],
        [
          db
            .prepare(
              "UPDATE cold_proofs SET state='dry_run',lease_token=NULL,lease_until=NULL,sha256=?,r2_version=?,etag=?,size=?,case_version=?,backup_version=?,verified_at=?,updated_at=?,error_code=NULL WHERE file_id=?",
            )
            .bind(
              sha,
              hot.version,
              row.etag,
              row.size,
              row.case_version,
              row.backup_version,
              at,
              at,
              row.file_id,
            ),
          db
            .prepare("INSERT INTO storage_audit VALUES(?,?,?,?,?)")
            .bind(
              crypto.randomUUID(),
              at,
              "cleanup_dry_run",
              row.file_id,
              JSON.stringify({
                would_delete: true,
                retention_approved: false,
                proposed_days: retentionDays,
                sha256: sha,
                r2_version: hot.version,
              }),
            ),
        ],
      );
      items.push({ file_id: row.file_id, state: "dry_run", would_delete: true, size: row.size });
    } catch {
      await db
        .prepare(
          "UPDATE cold_proofs SET state='blocked',lease_token=NULL,lease_until=NULL,error_code=?,updated_at=? WHERE file_id=? AND lease_token=?",
        )
        .bind("VERIFY_" + stage.toUpperCase(), at, row.file_id, token)
        .run();
      await storageAudit(db, "cleanup_blocked", row.file_id);
      await db
        .prepare(
          "INSERT INTO storage_alerts(id,episode,kind,created_at) VALUES(?,?,'cleanup_failed',?) ON CONFLICT(episode,kind) DO NOTHING",
        )
        .bind(crypto.randomUUID(), capacity.episode, at)
        .run();
      items.push({ file_id: row.file_id, state: "blocked", would_delete: false });
    }
  }
  return {
    dry_run: true,
    retention_approved: false,
    proposed_days: retentionDays,
    target_bytes: STORAGE.target,
    items,
  };
}
