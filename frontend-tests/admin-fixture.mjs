// Contract fixtures remain outside public/. Real Worker smoke verifies contracts.
import { randomUUID } from "node:crypto";
import { memberFixture, png } from "./member-fixture.mjs";
export async function adminFixture(page, options = {}) {
  const state = await memberFixture(page, { authenticated: true, dual: true, adminRole: "admin", submissionsOff: true, ...options });
  state.role = options.role ?? "admin"; state.elevationUntil = options.expiredMfa ? 0 : Date.now() / 1000 + 600;
  state.soloTargets=['miyeon','minnie','soyeon','yuqi','shuhua'].map((target_id,i)=>({target_id,display_name:target_id.toUpperCase(),active:true,sort_order:i+1}));
  state.campaigns = [{ campaign_id: "LOCAL", name: "本機應援活動", category: "Solo",solo_target:"miyeon", start_at: "2026-09-10T15:00:00.000Z", end_at: "2026-10-20T14:59:00.000Z", campaign_timezone: "Asia/Taipei", status: "active", daily_limit: null, points_per_proof: 10, version: 0, note: null }];
  state.cases = [{ case_id: state.caseId, created_at: "2026-10-09T10:00:00.000Z", nickname: "本機會員", player_id: "local-player", campaign_id: "LOCAL", vote_type: "Solo", vote_date: "2026-10-09", review_stage:"initial",review_risk_reason:null,status: options.caseStatus ?? "pending", version: 0, points_awarded: 0, files: [{ file_id: randomUUID(), content_type: "image/png", size: png.length }] }];
  state.boards = [{ leaderboard_id: "BOARD", name: "本機公開成績", type: "campaign",campaign_id:"LOCAL", campaign_id: null, start_date: null, end_date: null, vote_type: null, top_n: 10, is_public: true, status: "active", version: 0 }];
  state.tiers = ["普通", "青銅", "白銀", "黃金", "白金", "翡翠", "鑽石", "星耀"].map((name, i) => ({ tier_id: ["normal", "bronze", "silver", "gold", "platinum", "emerald", "diamond", "stellar"][i], name, min_points: i ? null : 0, status: i ? "disabled" : "active", version: 0 }));
  state.submissions = { submissions_enabled: false, submissions_message: "尚未開放投稿", version: 0 };
  state.content={};state.assets=new Map();state.announcements=[];state.audit = []; state.conflict = false; state.failAdmin = false;
  state.backupReadiness = {enabled:true,configured:true,ready:true,state:'ready',transport:options.backupTransport ?? 'apps_script_pull'}; state.backups = []; state.backupMissing = 0; state.backupBlocked = null; state.backupAudit = [];
  if (options.autoConfirm !== false) page.on("dialog", dialog => dialog.accept());
  await page.route("**/api/admin/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, body = request.postData() && request.headers()["content-type"]?.includes("application/json") ? request.postDataJSON() : null;
    state.calls.push({ path, method: request.method(), body, headers: request.headers() });
    const reply = (data, status = 200) => route.fulfill({ status, contentType: "application/json", headers: { "Cache-Control": "no-store" }, body: JSON.stringify({ ok: true, data }) });
    const error = (code, status) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ ok: false, error: { code, message: "private SQL upstream message" } }) });
    if (!state.authenticated || state.revoked) return error("AUTH_REQUIRED", 401);
    if (!state.role) return error("ADMIN_FORBIDDEN", 403);
    if (state.elevationUntil <= Date.now() / 1000) return error("ADMIN_STEP_UP_REQUIRED", 403);
    if (state.failAdmin) return error("ADMIN_SERVICE_UNAVAILABLE", 503);
    if (path === '/api/admin/overview') return reply({member_count:1284});
    if (path === "/api/admin/me") return reply({ member_id: state.member.member_id, role: state.role, csrf_token: state.csrf });
    if (path === '/api/admin/solo-targets') return reply({targets:state.soloTargets});
    if(path==='/api/admin/staff'){
      if(state.role!=='super_admin')return error('ADMIN_FORBIDDEN',403);
      state.staff??=[{nickname:'Owner fixture',fan_id:'fixture_owner',role:'super_admin',status:'active'}];
      if(!body)return reply({memberships:state.staff});
      if(!['admin','reviewer'].includes(body.role))return error('INVALID_STAFF_REQUEST',400);
      const membership={nickname:'Fixture staff',fan_id:'fixture_staff',role:body.role,status:'active'};state.staff.push(membership);return reply({membership,outcome:'granted'},201);
    }
    if (state.role === "reviewer" && !path.startsWith("/api/admin/cases") && path!=='/api/admin/overview' && !(path==='/api/admin/campaigns'&&request.method()==='GET') && !path.startsWith('/api/admin/image-exports')) return error("ADMIN_FORBIDDEN", 403);
    if(path==='/api/admin/image-exports')return reply({jobs:[]});
    if (request.method() === "POST") {
      if (request.headers()["x-csrf-token"] !== state.csrf || request.headers()["x-voteproof-request"] !== "1") return error("CSRF_REJECTED", 403);
      if (state.conflict) return error("CASE_STATUS_CONFLICT", 409);
      state.audit.push({ id: randomUUID(), action: path.includes("campaigns") ? "campaign_update" : "approve", target_id: "LOCAL", admin_member_id: state.member.member_id, created_at: new Date().toISOString() });
    }
    if (path === '/api/admin/backups') return reply({ ...state.backupReadiness, counts: Object.fromEntries(['pending','processing','confirmed','failed'].map(k=>[k,state.backups.filter(b=>b.status===k).length])), missing: state.backupMissing, blocked_error_code: state.backupBlocked, audit: state.backupAudit.slice(0,10), audit_total:state.backupAudit.length });
    if (path === '/api/admin/backups/audit') {
       const page=Number(url.searchParams.get('page')??1),total=state.backupAudit.length;
       return reply({audit:state.backupAudit.slice((page-1)*10,page*10),page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
     }
     if (path === '/api/admin/backups/missing') {
      const current = Number(url.searchParams.get('page') ?? 1), total = state.backupMissing;
      return reply({ files: Array.from({length:Math.max(0,Math.min(10,total-(current-1)*10))}, (_,i) => ({ file_id:'local-proof-'+((current-1)*10+i+1), case_id:state.caseId, created_at:'2026-10-21T02:00:00.000Z', size:1024, content_type:'image/png' })), page:current, page_size:10, total, total_pages:Math.max(1,Math.ceil(total/10)) });
    }
    if (path.endsWith('/backups')) return reply({ ...state.backupReadiness, backups: state.backups });
    if (/\/backups\/[^/]+\/process$/.test(path)) { if(state.backupReadiness.transport!=='deprecated_worker_oauth')return error('DIRECT_BACKUP_PROCESSING_RETIRED',410);const b=state.backups.find(b=>path.includes(b.id)); b.status='confirmed';return reply({state:'complete',confirmed:1}); }
    if (/\/backups\/[^/]+\/retry$/.test(path)) { const b = state.backups.find(b=>path.includes(b.id)); b.status='pending'; return reply({ status:'pending' }); }
    if (path === '/api/admin/backups/backfill') return reply({ scanned: state.backupMissing, ready: state.backupMissing ? ['local-proof'] : [], missing: [], changed: [], enqueued: body.dry_run ? 0 : state.backupMissing });
    if (path === "/api/admin/cases") return reply({ cases: options.emptyCases ? [] : state.cases, next_cursor: null });
    if (path.includes("/files/")) return route.fulfill({ contentType: "image/png", headers: { "Cache-Control": "no-store" }, body: png });
    if (path.endsWith("/review") && body.action==="flag_detailed"){state.cases[0].review_stage="detailed";state.cases[0].review_risk_reason=body.review_risk_reason;state.cases[0].version++;return reply(state.cases[0]);}
    if (path.endsWith("/review")) { state.cases[0].status = { approve: "approved", reject: "rejected", mark_duplicate: "duplicate", complete: "completed", revoke: "revoked" }[body.action]; state.cases[0].version++; return reply(state.cases[0]); }
    if (path.startsWith("/api/admin/cases/")) return reply(state.cases[0]);
    if(path.startsWith('/api/admin/campaign-assets/')){if(request.method()==='GET')return route.fulfill({contentType:'image/png',body:png});const asset_id=randomUUID();state.assets.set(asset_id,request.postDataBuffer()??png);return reply({asset_id,size:(request.postDataBuffer()??png).length,content_type:'image/png'},201);}
    if(path.endsWith('/guidance')){const id=path.split('/')[4];return reply(state.content[id]??{submission_instructions:'',example_asset_id:null,version:0});}
    if(path.startsWith('/api/admin/announcements')){if(!body)return reply({announcements:state.announcements});const old=state.announcements.find(a=>path.includes('/'+a.announcement_id+'/'));const row={...body,announcement_id:old?.announcement_id??randomUUID(),version:(old?.version??-1)+1,updated_at:new Date().toISOString()};if(old)Object.assign(old,row);else state.announcements.push(row);return reply(row);}
    if (path === "/api/admin/campaigns") { if (body) { state.content[body.campaign_id]={submission_instructions:body.submission_instructions??'',example_asset_id:body.example_asset_id??null,version:0}; state.campaigns.push({ ...body, version: 0 }); return reply(state.campaigns.at(-1), 201); } return reply({ campaigns: state.campaigns, next_cursor: null }); }
    if (path.startsWith("/api/admin/campaigns/")) { state.content[state.campaigns[0].campaign_id]={submission_instructions:body.submission_instructions??'',example_asset_id:body.example_asset_id??null,version:1};Object.assign(state.campaigns[0], body, { version: state.campaigns[0].version + 1 }); return reply(state.campaigns[0]); }
    if (path === "/api/admin/leaderboards") { if (body) { if(body.is_current_comeback)for(const b of state.boards)b.is_current_comeback=false;state.boards.push({ ...body, leaderboard_id:body.leaderboard_id??'board-'+randomUUID(), version: 0 }); return reply(state.boards.at(-1), 201); } return reply({ leaderboards: state.boards, next_cursor: null }); }
    if (path.endsWith("/results")) return reply({ leaderboards: [{ ...state.boards.find(row => row.leaderboard_id === path.split('/').at(-2)), rankings: [{ rank: 4, nickname: "已發布會員", points: 80, proof_count: 8 }] }] });
    if (path.endsWith("/rebuild")) return reply({ run_id: randomUUID(), row_count: 1 });
    if (path.startsWith("/api/admin/leaderboards/")) { Object.assign(state.boards[0], body, { version: state.boards[0].version + 1 }); return reply(state.boards[0]); }
    if (path === "/api/admin/member-tiers") return reply({ tiers: state.tiers, configuration_ready: false });
    if (path.startsWith("/api/admin/member-tiers/")) { const row = state.tiers.find(t => path.includes(t.tier_id)); Object.assign(row, body); row.version++; return reply(row); }
    if (path === "/api/admin/submissions") return reply(state.submissions);
    if (path === "/api/admin/submissions/update") { Object.assign(state.submissions, body); state.submissions.version++; return reply(state.submissions); }
    if (path === "/api/admin/audit-logs") return reply({ logs: state.audit, next_cursor: null });
    return error("NOT_FOUND", 404);
  });
  return state;
}
