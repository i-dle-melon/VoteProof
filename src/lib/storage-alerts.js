// Independent purpose, secret, quota, outbox and audit. No auth/support mail changes.
import { resolveContactEmails, ADMIN_MAIL_FROM } from "./admin-member-contact.js";
import { normalizeEmail } from "../api/auth-validation.js";
import { storageSignature, scriptPost, boundedJson, shaBytes, scriptUrl } from "./cold-storage.js";
import { nowSeconds, storageAudit } from "./storage-capacity.js";
export { ADMIN_MAIL_FROM as STORAGE_ALERT_FROM };
export async function storageRecipients(env) {
  const recipients = new Set(["a0909323005@gmail.com", ADMIN_MAIL_FROM]);
  const rows = (
    await env.DB.prepare(
      `SELECT m.member_id FROM members m JOIN admin_memberships a ON a.member_id=m.member_id WHERE m.status='active' AND a.status='active' AND a.role IN('admin','super_admin')`,
    ).all()
  ).results;
  for (const row of rows) {
    let identities;
    try {
      identities = await resolveContactEmails(env.DB, env, row.member_id);
    } catch {
      await storageAudit(env.DB, "alert_recipient_unavailable", "verified_admin");
      continue;
    }
    for (const identity of identities) recipients.add(normalizeEmail(identity.email));
  }
  return [...recipients].sort();
}
export async function deliverStorageAlert(config, body, fetcher = fetch) {
  try {
    const payload = {
      ...body,
      version: 1,
      purpose: "storage_alert",
      timestamp: nowSeconds(),
      from: ADMIN_MAIL_FROM,
    };
    payload.signature = await storageSignature(
      config.secret,
      JSON.stringify([
        "VoteProof/storage-alert",
        payload.version,
        payload.purpose,
        payload.timestamp,
        payload.send_id,
        payload.from,
        payload.to,
        payload.kind,
      ]),
    );
    const r = await boundedJson(await scriptPost(config.url, payload, fetcher), 4096);
    const expected = await storageSignature(
      config.secret,
      JSON.stringify(["VoteProof/storage-alert-result", r.send_id, r.outcome]),
    );
    if (
      r.send_id !== body.send_id ||
      !["sent", "rejected", "ambiguous"].includes(r.outcome) ||
      typeof r.signature !== "string" ||
      r.signature.length !== expected.length
    )
      return "ambiguous";
    let diff = 0;
    for (let i = 0; i < expected.length; i++)
      diff |= expected.charCodeAt(i) ^ r.signature.charCodeAt(i);
    return diff ? "ambiguous" : r.outcome;
  } catch {
    return "ambiguous";
  }
}
export async function processStorageAlerts(env, { send = deliverStorageAlert } = {}) {
  if (env.STORAGE_ALERT_ENABLED !== "true") return { state: "disabled", sent: 0 };
  // Reject any shared auth/support secret or endpoint. No unsafe transport fallback.
  const url = scriptUrl(env.STORAGE_ALERT_RELAY_URL),
    secret = env.STORAGE_ALERT_RELAY_SECRET;
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    Object.entries(env).some(
      ([key, value]) =>
        key !== "STORAGE_ALERT_RELAY_SECRET" && /(SECRET|KEY|TOKEN)$/.test(key) && value === secret,
    ) ||
    [env.MAIL_RELAY_URL, env.ADMIN_MAIL_RELAY_URL, env.DRIVE_COLD_RELAY_URL].includes(url)
  )
    throw Error("STORAGE_ALERT_NOT_CONFIGURED");
  const recipients = await storageRecipients(env),
    db = env.DB,
    at = nowSeconds();
  const token = crypto.randomUUID();
  const alert = await db
    .prepare(
      `UPDATE storage_alerts SET state='claimed',lease_token=?,lease_until=? WHERE id=(SELECT id FROM storage_alerts WHERE state='pending' OR (state='claimed' AND lease_until<=?) ORDER BY created_at,id LIMIT 1) AND (state='pending' OR (state='claimed' AND lease_until<=?)) RETURNING *`,
    )
    .bind(token, at + 180, at, at)
    .first();
  if (!alert) return { state: "idle", sent: 0 };
  let sent = 0,
    uncertain = false,
    deferred = false;
  for (const recipient of recipients) {
    const hash = await shaBytes(new TextEncoder().encode(recipient)),
      id = crypto.randomUUID();
    const prior = await db
      .prepare("SELECT state FROM storage_alert_deliveries WHERE alert_id=? AND recipient_hash=?")
      .bind(alert.id, hash)
      .first();
    if (prior) {
      if (prior.state !== "sent") uncertain = true;
      continue;
    }
    const reserved = await db
      .prepare(
        `INSERT INTO storage_alert_deliveries(id,alert_id,recipient_hash,created_at,state) SELECT ?,?,?,?,'reserved'
 WHERE EXISTS(SELECT 1 FROM storage_alerts WHERE id=? AND lease_token=? AND lease_until>?) AND (SELECT count(*) FROM storage_alert_deliveries WHERE created_at>?)<20 AND (SELECT count(*) FROM storage_alert_deliveries WHERE created_at>?)<5 ON CONFLICT(alert_id,recipient_hash) DO NOTHING RETURNING id`,
      )
      .bind(id, alert.id, hash, at, alert.id, token, nowSeconds(), at - 86400, at - 3600)
      .first();
    if (!reserved) {
      deferred = true;
      await storageAudit(db, "alert_quota_or_duplicate", alert.id);
      continue;
    }
    await storageAudit(db, "alert_reserved", id, { kind: alert.kind });
    const outcome = await send({ url, secret }, { send_id: id, to: recipient, kind: alert.kind });
    await db
      .prepare("UPDATE storage_alert_deliveries SET state=? WHERE id=? AND state='reserved'")
      .bind(outcome, id)
      .run();
    await storageAudit(db, "alert_" + outcome, id);
    if (outcome === "sent") sent++;
    else uncertain = true;
  }
  const state = deferred ? "pending" : uncertain ? "ambiguous" : "sent";
  await db
    .prepare(
      "UPDATE storage_alerts SET state=?,lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?",
    )
    .bind(state, alert.id, token)
    .run();
  return { state, sent };
}
