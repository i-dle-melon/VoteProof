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
import {requireExportV2,startExportPackage,finishExportPackage,exportAudit} from "../lib/shared-export.js";
import {authAtomic} from "../lib/auth-store.js";
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
  filters: exportFilters(JSON.parse(filters_json)),
  expired: job.expires_at <= new Date().toISOString(),
});
async function sharedJob(db, actor, id, creator=true) {
  if (!UUID_PATTERN.test(id ?? "")) fail();
  const job = await db
    .prepare(creator?"SELECT j.*,m.nickname creator_name,m.player_id creator_fan_id FROM export_jobs j JOIN members m ON m.member_id=j.owner_member_id WHERE j.id=?":"SELECT * FROM export_jobs WHERE id=?")
    .bind(id)
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
          "SELECT number,image_count,total_bytes,status,attempt_id,completed_at,error_code,claim_member_id,lease_until,(SELECT MAX(l.lease_until) FROM export_file_claims l WHERE l.job_id=p.job_id AND l.package_no=p.number) active_lease_until FROM export_packages p WHERE job_id=? ORDER BY number",
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
  await requireExportV2(db);
  const pageRaw=url.searchParams.get('page')??'1',page=Number(pageRaw);
  if (url.search && (parts[0]||request.method!=='GET'||[...url.searchParams.keys()].some(k=>k!=='page')||url.searchParams.getAll('page').length!==1||!/^[1-9]\d*$/.test(pageRaw)||!Number.isSafeInteger(page*10))) fail(400, "INVALID_EXPORT_QUERY");
  if (request.method === "POST") await adminCsrf(request, env, actor);
  if (parts[0] === "query") {
    const scope = await exportScope(db, exportFilters(await readExportJson(request)));
    return jsonSuccess({ ...(await countExport(db, scope)), ...scope, limits: EXPORT_LIMITS });
  }
  if (!parts[0])
    return jsonSuccess({
      version:2, completion_definition:"已確認完成匯出（不保證檔案永久保存）",
      page, page_size:10,
      has_more:Boolean(await db.prepare('SELECT 1 FROM export_jobs ORDER BY created_at DESC,id DESC LIMIT 1 OFFSET ?').bind(page*10).first()),
      jobs: (
        await db
          .prepare(
            "SELECT j.*,m.nickname creator_name,m.player_id creator_fan_id FROM export_jobs j JOIN members m ON m.member_id=j.owner_member_id ORDER BY j.created_at DESC,j.id DESC LIMIT 10 OFFSET ?",
          )
          .bind((page-1)*10)
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
        JSON.stringify(exportFilters(JSON.parse(job.filters_json))) !== JSON.stringify(filters)
      )
        fail(409, "EXPORT_JOB_CONFLICT");
      await authAtomic(db,[{sql:REVIEW_AUTH_GUARD,args:actorBindings(actor)}],[exportAudit(db,actor,job,null,"reuse")]);
      const found=await sharedJob(db,actor,job.id);if(found.expires_at<=new Date().toISOString())fail(410,'EXPORT_SNAPSHOT_EXPIRED');
      return jsonSuccess({...await detail(db,found),reused:true});
    };
    if (existing) return replay(existing);
    const scope = await exportScope(db, filters);
    const scopeKey=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([filters,scope.from_utc,scope.to_utc]))))].map(n=>n.toString(16).padStart(2,'0')).join('');
    const shared=()=>db.prepare("SELECT j.* FROM export_scope_locks l JOIN export_jobs j ON j.id=l.job_id WHERE l.scope_key=? AND j.sealed=1 AND j.expires_at>?"+(filters.only_undownloaded?" AND EXISTS(SELECT 1 FROM export_packages p WHERE p.job_id=j.id AND p.status!='completed')":"")).bind(scopeKey,new Date().toISOString()).first();
    const prior=await shared();if(prior)return replay(prior);
    const count = await countExport(db, scope);
    if (count.image_count > EXPORT_LIMITS.maxJobFiles) fail(400, "EXPORT_SCOPE_TOO_LARGE");
    try {
      await snapshotExport(db, actor, body.job_id, scope,scopeKey);
    } catch (error) {
      if(String(error?.message??"").includes("EXPORT_ARCHIVED_PROOF"))throw new AdminError(409,"EXPORT_ARCHIVED_PROOF","範圍包含已封存至 Google Drive 的圖片，不提供 ZIP 匯出；請調整範圍。");
      const raced = await db
        .prepare("SELECT * FROM export_jobs WHERE id=?")
        .bind(body.job_id)
        .first();
      if (raced) return replay(raced);
      const winner=await shared();if(winner)return replay(winner);
      throw error;
    }
    return jsonSuccess(await detail(db, await sharedJob(db, actor, body.job_id)));
  }
  if (parts[0] !== "jobs") fail();
  const job = await sharedJob(db, actor, parts[1],!parts[2]);
  if (!parts[2]) return jsonSuccess(await detail(db, job));
  if(job.expires_at<=new Date().toISOString())fail(410,'EXPORT_SNAPSHOT_EXPIRED');
  const number = packageNumber(parts[3]);
  if (parts[4] === "start") {
    const b = await readExportJson(request);
    if (
      !UUID_PATTERN.test(b.attempt_id ?? "") ||
      (b.expected_attempt_id !== null && !UUID_PATTERN.test(b.expected_attempt_id ?? "")) ||
      Object.keys(b).some((k) => !["attempt_id", "expected_attempt_id"].includes(k))
    )
      fail(400, "INVALID_EXPORT_QUERY");
    const started=await startExportPackage(db,actor,job,number,b),p=started.package;
    const items = (
      await db
        .prepare("SELECT * FROM export_job_items WHERE job_id=? AND package_no=? ORDER BY ordinal")
        .bind(job.id, number)
        .all()
    ).results.map(({ job_id, package_no, ...item }) => item);
    return jsonSuccess({ package: p, items, read_only: started.read_only,download_attempt_id:started.download_attempt_id??p.attempt_id });
  }
  if (parts[4] === "state") {
    const b = await readExportJson(request);
    if (
      !UUID_PATTERN.test(b.attempt_id ?? "") ||
      (b.status==="completed" && b.confirmed!==true) ||
      !["completed", "failed"].includes(b.status) ||
      Object.keys(b).some((k) => !["attempt_id", "status", "error_code", "confirmed"].includes(k)) ||
      (b.error_code &&
        !["EXPORT_CANCELLED", "EXPORT_PROOF_UNAVAILABLE", "EXPORT_DOWNLOAD_FAILED"].includes(
          b.error_code,
        ))
    )
      fail(400, "INVALID_EXPORT_QUERY");
    return jsonSuccess(await finishExportPackage(db,actor,job,number,b));
  }

  // Export proof remains private; its bytes must match the immutable snapshot.
  if (parts[4] === "attempts" && parts[6] === "files") {
    if (!UUID_PATTERN.test(parts[5] ?? "") || !UUID_PATTERN.test(parts[7] ?? "")) fail();
    const file = await db
      .prepare(
        `SELECT f.object_key,i.content_type,i.file_size size,i.etag FROM export_job_items i JOIN export_packages p ON p.job_id=i.job_id AND p.number=i.package_no
      JOIN case_files f ON f.id=i.file_id JOIN cases c ON c.id=f.case_id AND c.case_id=i.case_id
      WHERE i.job_id=? AND i.package_no=? AND i.file_id=? AND p.attempt_id=? AND
       ((p.status='completed' AND EXISTS(SELECT 1 FROM export_file_claims l WHERE l.file_id=i.file_id AND l.job_id=i.job_id AND l.package_no=i.package_no AND l.member_id=? AND l.lease_until>CAST(strftime('%s','now') AS INTEGER)))
       OR (p.status='in_progress' AND p.claim_member_id=? AND p.lease_until>CAST(strftime('%s','now') AS INTEGER))) AND f.etag=i.etag AND f.size=i.file_size AND f.content_type=i.content_type`,
      )
      .bind(job.id, number, parts[7], parts[5],actor.member.member_id,actor.member.member_id)
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
