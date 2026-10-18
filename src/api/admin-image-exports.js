import { adminHandler } from "./admin-response.js";
import { jsonSuccess } from "./response.js";
import { readReviewJson, UUID_PATTERN } from "./admin-validation.js";
import { authDatabase } from "../lib/auth-session.js";
import {
  AdminError,
  adminIdentity,
  adminCsrf,
  ADMIN_ROLES,
  REVIEW_AUTH_GUARD,
  actorBindings,
} from "../lib/admin-identity.js";
import { exportFilters, exportScope, countExport, snapshotExport } from "../lib/image-export.js";
import { EXPORT_LIMITS } from "../../public/js/export-format.js";
import { privateProofResponse } from "./admin.js";
const fail = (status = 404, code = "EXPORT_NOT_FOUND") => {
  throw new AdminError(status, code, "Export is unavailable");
};
async function readExportJson(request) {
  const body = await readReviewJson(request);
  if (!body || typeof body !== "object" || Array.isArray(body)) fail(400, "INVALID_EXPORT_QUERY");
  return body;
}
const safeJob = ({ owner_member_id, filters_json, ...job }) => ({
  ...job,
  filters: JSON.parse(filters_json),
});
async function ownedJob(db, actor, id) {
  if (!UUID_PATTERN.test(id ?? "")) fail();
  const job = await db
    .prepare("SELECT * FROM export_jobs WHERE id=? AND owner_member_id=? AND expires_at>?")
    .bind(id, actor.member.member_id, new Date().toISOString())
    .first();
  if (!job) fail();
  return job;
}
async function detail(db, job) {
  return {
    ...safeJob(job),
    packages: (
      await db
        .prepare(
          "SELECT number,image_count,total_bytes,status,attempt_id,completed_at,error_code FROM export_packages WHERE job_id=? ORDER BY number",
        )
        .bind(job.id)
        .all()
    ).results,
  };
}
function packageNumber(raw) {
  if (!/^[1-9]\d{0,4}$/.test(raw ?? "")) fail();
  return Number(raw);
}
export const imageExportHandler = adminHandler(async (env, url, request) => {
  const actor = await adminIdentity(request, env, ADMIN_ROLES),
    db = authDatabase(env),
    parts = url.pathname.split("/").slice(4);
  if (url.search) fail(400, "INVALID_EXPORT_QUERY");
  if (request.method === "POST") await adminCsrf(request, env, actor);
  if (parts[0] === "query") {
    const scope = await exportScope(db, exportFilters(await readExportJson(request)));
    return jsonSuccess({ ...(await countExport(db, scope)), ...scope, limits: EXPORT_LIMITS });
  }
  if (!parts[0])
    return jsonSuccess({
      jobs: (
        await db
          .prepare(
            "SELECT * FROM export_jobs WHERE owner_member_id=? AND expires_at>? ORDER BY created_at DESC,id DESC LIMIT 10",
          )
          .bind(actor.member.member_id, new Date().toISOString())
          .all()
      ).results.map(safeJob),
    });
  if (parts[0] === "jobs" && !parts[1]) {
    const body = await readExportJson(request);
    if (
      !UUID_PATTERN.test(body.job_id ?? "") ||
      Object.keys(body).some((k) => !["job_id", "filters"].includes(k))
    )
      fail(400, "INVALID_EXPORT_QUERY");
    const filters = exportFilters(body.filters),
      existing = await db.prepare("SELECT * FROM export_jobs WHERE id=?").bind(body.job_id).first();
    const replay = async (job) => {
      if (
        job.owner_member_id !== actor.member.member_id ||
        job.filters_json !== JSON.stringify(filters)
      )
        fail(409, "EXPORT_JOB_CONFLICT");
      return jsonSuccess(await detail(db, await ownedJob(db, actor, job.id)));
    };
    if (existing) return replay(existing);
    const scope = await exportScope(db, filters),
      count = await countExport(db, scope);
    if (count.image_count > EXPORT_LIMITS.maxJobFiles) fail(400, "EXPORT_SCOPE_TOO_LARGE");
    try {
      await snapshotExport(db, actor, body.job_id, scope);
    } catch (error) {
      if(String(error?.message??"").includes("EXPORT_ARCHIVED_PROOF"))throw new AdminError(409,"EXPORT_ARCHIVED_PROOF","範圍包含已封存至 Google Drive 的圖片，請先手動還原。");
      const raced = await db
        .prepare("SELECT * FROM export_jobs WHERE id=?")
        .bind(body.job_id)
        .first();
      if (raced) return replay(raced);
      throw error;
    }
    return jsonSuccess(await detail(db, await ownedJob(db, actor, body.job_id)));
  }
  if (parts[0] !== "jobs") fail();
  const job = await ownedJob(db, actor, parts[1]);
  if (!parts[2]) return jsonSuccess(await detail(db, job));
  const number = packageNumber(parts[3]);
  if (parts[4] === "start") {
    const b = await readExportJson(request);
    if (
      !UUID_PATTERN.test(b.attempt_id ?? "") ||
      (b.expected_attempt_id !== null && !UUID_PATTERN.test(b.expected_attempt_id ?? "")) ||
      Object.keys(b).some((k) => !["attempt_id", "expected_attempt_id"].includes(k))
    )
      fail(400, "INVALID_EXPORT_QUERY");
    const completed = await db.prepare("SELECT * FROM export_packages WHERE job_id=? AND number=? AND status='completed'").bind(job.id,number).first();
    if (completed && completed.attempt_id !== b.expected_attempt_id) fail(409,"EXPORT_PACKAGE_CONFLICT");
    if (!completed) await db
      .prepare(
        `UPDATE export_packages SET status='in_progress',attempt_id=?,started_at=?,error_code=NULL WHERE job_id=? AND number=? AND status!='completed' AND (attempt_id IS ? OR (attempt_id=? AND status='in_progress')) AND ${REVIEW_AUTH_GUARD}`,
      )
      .bind(
        b.attempt_id,
        new Date().toISOString(),
        job.id,
        number,
        b.expected_attempt_id,
        b.attempt_id,
        ...actorBindings(actor),
      )
      .run();
    const p = await db
      .prepare("SELECT * FROM export_packages WHERE job_id=? AND number=?")
      .bind(job.id, number)
      .first();
    if (!p || (completed ? p.status !== 'completed' || p.attempt_id !== completed.attempt_id : p.attempt_id !== b.attempt_id || p.status !== "in_progress"))
      fail(409, "EXPORT_PACKAGE_CONFLICT");
    const items = (
      await db
        .prepare("SELECT * FROM export_job_items WHERE job_id=? AND package_no=? ORDER BY ordinal")
        .bind(job.id, number)
        .all()
    ).results.map(({ job_id, package_no, ...item }) => item);
    return jsonSuccess({ package: p, items, read_only: Boolean(completed) });
  }
  if (parts[4] === "state") {
    const b = await readExportJson(request);
    if (
      !UUID_PATTERN.test(b.attempt_id ?? "") ||
      !["completed", "failed"].includes(b.status) ||
      Object.keys(b).some((k) => !["attempt_id", "status", "error_code"].includes(k)) ||
      (b.error_code &&
        !["EXPORT_CANCELLED", "EXPORT_PROOF_UNAVAILABLE", "EXPORT_DOWNLOAD_FAILED"].includes(
          b.error_code,
        ))
    )
      fail(400, "INVALID_EXPORT_QUERY");
    await db
      .prepare(
        `UPDATE export_packages SET status=?,completed_at=CASE WHEN ?='completed' THEN ? ELSE NULL END,error_code=? WHERE job_id=? AND number=? AND attempt_id=? AND status IN ('in_progress',?) AND ${REVIEW_AUTH_GUARD}`,
      )
      .bind(
        b.status,
        b.status,
        new Date().toISOString(),
        b.status === "failed" ? (b.error_code ?? "EXPORT_DOWNLOAD_FAILED") : null,
        job.id,
        number,
        b.attempt_id,
        b.status,
        ...actorBindings(actor),
      )
      .run();
    const p = await db
      .prepare(
        "SELECT number,status,attempt_id,error_code FROM export_packages WHERE job_id=? AND number=?",
      )
      .bind(job.id, number)
      .first();
    if (!p || p.attempt_id !== b.attempt_id || p.status !== b.status)
      fail(409, "EXPORT_PACKAGE_CONFLICT");
    return jsonSuccess(p);
  }
  // Export proof remains private; its bytes must match the immutable snapshot.
  if (parts[4] === "attempts" && parts[6] === "files") {
    if (!UUID_PATTERN.test(parts[5] ?? "") || !UUID_PATTERN.test(parts[7] ?? "")) fail();
    const file = await db
      .prepare(
        `SELECT f.object_key,i.content_type,i.file_size size,i.etag FROM export_job_items i JOIN export_packages p ON p.job_id=i.job_id AND p.number=i.package_no
      JOIN case_files f ON f.id=i.file_id JOIN cases c ON c.id=f.case_id AND c.case_id=i.case_id
      WHERE i.job_id=? AND i.package_no=? AND i.file_id=? AND p.attempt_id=? AND p.status IN ('in_progress','completed') AND f.etag=i.etag AND f.size=i.file_size AND f.content_type=i.content_type`,
      )
      .bind(job.id, number, parts[7], parts[5])
      .first();
    if (!file) fail(409, "EXPORT_PROOF_UNAVAILABLE");
    return privateProofResponse(env, file);
  }
  fail();
});
export function imageExportRoute(path) {
  if (path === "/api/admin/image-exports") return { method: "GET", handler: imageExportHandler };
  if (/^\/api\/admin\/image-exports\/(?:query|jobs)$/.test(path))
    return { method: "POST", handler: imageExportHandler };
  if (
    /^\/api\/admin\/image-exports\/jobs\/[^/]+(?:\/packages\/[1-9]\d{0,4}(?:\/(?:start|state)|\/attempts\/[^/]+\/files\/[^/]+))?$/.test(
      path,
    )
  )
    return { method: /\/(start|state)$/.test(path) ? "POST" : "GET", handler: imageExportHandler };
}
