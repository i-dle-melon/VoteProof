// Fixture identities/sessions are inserted only into disposable local D1.
// B5 fixtures model sessions with a recent, server-verified MFA elevation.
import { randomUUID, randomBytes, createHash, createHmac } from "node:crypto";
import {ensureCaseBackups} from '../../src/lib/proof-backup-store.js';
import {localPrehashCase} from './local-prehash-case-fixture.mjs';
import { localCaseRuntime, guestBody } from "./local-case-runtime.mjs";

export async function localAdminRuntime(options) {
  const local = await localCaseRuntime(options);
  async function identity({ role, fanId, nickname="本機審核員", status = "active", membershipStatus = "active", expired = false, revoked = false, elevated = true } = {}) {
    const memberId = "M-" + randomUUID(), token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update("VoteProof/member-session/v1:" + token).digest("hex");
    const now = Math.floor(Date.now() / 1000), timestamp = new Date().toISOString();
    const db = local.db;
    await db.batch([
      db.prepare(`INSERT INTO members (id, member_id, login_name, nickname, player_id, status, created_at, updated_at, last_login_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .bind(randomUUID(), memberId, randomUUID().replaceAll("-", ""), nickname, fanId===undefined?"local-"+memberId:fanId, status, timestamp, timestamp, timestamp),
      db.prepare(`INSERT INTO auth_sessions (token_hash, member_id, created_at, expires_at, revoked_at, elevated_until) VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(hash, memberId, now - 60, expired ? now - 1 : now + 3600, revoked ? now : null, elevated ? now + 3600 : now - 1),
    ]);
    if (role) await db.prepare(`INSERT INTO admin_memberships (id, member_id, role, status, created_at, created_by, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?)`)
      .bind(randomUUID(), memberId, role, membershipStatus, timestamp, timestamp).run();
    const csrf = createHmac("sha256", Buffer.from(local.authSecret, "hex"))
      .update(JSON.stringify(["VoteProof/auth/v1", "csrf", hash])).digest("hex");
    return { memberId, token, hash, csrf, role, headers: { Cookie: "__Host-vp-session=" + token,
      Origin: "https://voteproof.example", "X-CSRF-Token": csrf } };
  }
  async function makeCase({ member, metadata = {}, idempotencyKey = randomUUID() } = {}) {
    if (metadata.campaign_id) await local.campaign({ campaign_id: metadata.campaign_id,category:metadata.vote_type??"Solo" });
    // Historical migration fixtures must seed the old writer contract directly.
    // Never weaken current Production capacity checks to populate an old schema.
    if(local.migrationThrough && local.migrationThrough<'0025_storage_cold_v1.sql'){const historical=await localPrehashCase(local,{member,metadata,verified:local.migrationThrough>='0012_proof_exact_hashes.sql'});await ensureCaseBackups({...local.authConfig,DB:local.db,PROOFS_BUCKET:local.bucket},historical.id);return historical;}
    const reference = await local.upload();
    const body = { ...guestBody(reference), ...metadata };
    const headers = { ...(member?.headers ?? {}), "Idempotency-Key": idempotencyKey };
    const response = await local.fetch("/api/cases", "POST", body, headers);
    if (response.status !== 201) throw new Error("Local case fixture failed");
    const data = (await response.json()).data;
    const row = await local.db.prepare("SELECT id FROM cases WHERE case_id = ?").bind(data.case_id).first();
    return { ...data, id: row.id, body, headers, reference };
  }
  const review = (actor, caseId, action, expectedVersion = 0, extra = {}) => local.fetch(`/api/admin/cases/${caseId}/review`,
    "POST", { action, expected_version: expectedVersion, ...extra }, actor.headers);
  return { local, identity, makeCase, review };
}
