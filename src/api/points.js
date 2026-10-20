import { jsonSuccess } from "./response.js";
import { adminHandler } from "./admin-response.js";
import { readReviewJson, UUID_PATTERN } from "./admin-validation.js";
import { memberSession, authDatabase } from "../lib/auth-session.js";
import { adminIdentity, adminCsrf, ELEVATED_ROLES, AdminError } from "../lib/admin-identity.js";
import { adjustmentInput, adjustmentIdentity, adjustPoints } from "../lib/point-ledger.js";
import { memberPointTier } from "../lib/member-tier.js";

export const memberPoints = adminHandler(async (env, _url, request) => {
  const member = await memberSession(request, env); return jsonSuccess(await memberPointTier(authDatabase(env), member.member_id));
});
export const memberTransactions=adminHandler(async(env,url,request)=>{
 const member=await memberSession(request,env),invalid=()=>new AdminError(400,'INVALID_PAGINATION','點數紀錄分頁無效。');
 if([...url.searchParams.keys()].some(k=>!['limit','cursor','page'].includes(k))||[...url.searchParams.keys()].some(k=>url.searchParams.getAll(k).length!==1)||url.searchParams.has('limit')&&url.searchParams.get('limit')!=='10')throw invalid();
  if(url.searchParams.has('page')){
    const raw=url.searchParams.get('page'),page=Number(raw);
    if(url.searchParams.has('cursor')||!/^[1-9]\\d*$/.test(raw)||!Number.isSafeInteger(page)||!Number.isSafeInteger(page*10))throw invalid();
    const db=authDatabase(env);
    const [count,rows]=await db.batch([
      db.prepare('SELECT COUNT(*) AS total FROM point_transactions WHERE member_id=?').bind(member.member_id),
      db.prepare(`SELECT t.created_at,t.category,t.points,t.reason,p.name AS campaign_name FROM point_transactions t
        LEFT JOIN campaigns p ON p.campaign_id=t.campaign_id WHERE t.member_id=?
        ORDER BY t.created_at DESC,t.transaction_id DESC LIMIT 10 OFFSET ?`).bind(member.member_id,(page-1)*10),
    ]);
    const total=count.results[0].total;
    return jsonSuccess({transactions:rows.results,page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
  }
 let cursor=null;const raw=url.searchParams.get('cursor');if(raw!==null){try{if(raw.length>220||!/^[A-Za-z0-9_-]+$/.test(raw))throw invalid();cursor=JSON.parse(atob(raw.replaceAll('-','+').replaceAll('_','/')));if(!Array.isArray(cursor)||cursor.length!==2||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(cursor[0])||!Number.isFinite(Date.parse(cursor[0]))||!UUID_PATTERN.test(cursor[1]))throw invalid();}catch{throw invalid();}}
 const rows=(await authDatabase(env).prepare(`SELECT t.transaction_id,t.created_at,t.category,t.points,t.reason,p.name AS campaign_name,c.case_id FROM point_transactions t
   LEFT JOIN campaigns p ON p.campaign_id=t.campaign_id LEFT JOIN cases c ON c.id=t.case_id WHERE t.member_id=?
   ${cursor?'AND (t.created_at<? OR (t.created_at=? AND t.transaction_id<?))':''} ORDER BY t.created_at DESC,t.transaction_id DESC LIMIT 11`)
   .bind(member.member_id,...(cursor?[cursor[0],cursor[0],cursor[1]]:[])).all()).results;
 const transactions=rows.slice(0,10),last=transactions.at(-1);return jsonSuccess({transactions,next_cursor:rows.length>10?btoa(JSON.stringify([last.created_at,last.transaction_id])).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,''):null});
});
export const adminMemberPoints = adminHandler(async (env, url, request) => {
  await adminIdentity(request, env, ELEVATED_ROLES);
  const id = url.pathname.split("/")[4], db = authDatabase(env);
  if (typeof id !== "string" || id.length !== 38 || !id.startsWith("M-") || !UUID_PATTERN.test(id.slice(2)) ||
      !await db.prepare("SELECT member_id FROM members WHERE member_id = ?").bind(id).first()) throw new AdminError(404, "MEMBER_NOT_FOUND", "Member not found");
  return jsonSuccess(await memberPointTier(db, id));
});
export const createAdjustment = adminHandler(async (env, _url, request) => {
  const actor = await adminIdentity(request, env, ELEVATED_ROLES); await adminCsrf(request, env, actor);
  const input = adjustmentInput(await readReviewJson(request)), identity = await adjustmentIdentity(request, actor, input);
  return jsonSuccess(await adjustPoints(authDatabase(env), actor, input, identity), "no-store", 201);
});
export function pointRoute(path) {
  if(path==='/api/me/point-transactions')return{method:'GET',handler:memberTransactions};
  if (path === "/api/me/points") return { method: "GET", handler: memberPoints };
  if (path === "/api/admin/points/adjustments") return { method: "POST", handler: createAdjustment };
  if (/^\/api\/admin\/members\/[^/]+\/points$/.test(path)) return { method: "GET", handler: adminMemberPoints };
}
