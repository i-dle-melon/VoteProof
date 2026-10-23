// BUILD-ONLY synthetic DTOs. No real identities, credentials, query keys or proof.
import { PREVIEW } from "./preview.js";
import { previewState as state } from "./pages-preview-state.js";
import { exportFixture } from './preview-exports.js';
import {contentFixture,savePreviewContent} from './preview-content.js';
const isStaff=['admin','super_admin','reviewer'].includes(state.identity),isManager=['admin','super_admin'].includes(state.identity);
const staffMembers=[{nickname:'展示主管理員',fan_id:'preview_owner',role:'super_admin',status:'active'}];
let previewLoggedOut=false;
const blockedMembers=[{fan_id:'preview_blocked_fan',nickname:'展示已封鎖粉絲',status:'suspended',reason:'展示封鎖原因・假資料',blocked_at:'2026-10-17T02:00:00.000Z'}];
export const identity = {
  member_id: "PREVIEW-MEMBER-001",
  nickname: "葉子",
  player_id: "fan_yeh", fan_id:"fan_yeh",
  status: "active",
};
export const campaign = {
  campaign_id: "PREVIEW-CAMPAIGN",
  name: "展示回歸應援・假資料",
  category: "Solo",solo_target:"miyeon",
  start_at: "2026-01-01T00:00:00Z",
  end_at: "2099-12-31T00:00:00Z",
  campaign_timezone: "Asia/Taipei",
  vote_start_date: "2026-01-01",
  vote_end_date: "2099-12-31",
  points_per_proof: 10,
  daily_limit: null,
  status: "active",
  version: 1,
  note: "UI PREVIEW 假資料",
};
const tierNames = ["普通", "青銅", "白銀", "黃金", "白金", "翡翠", "鑽石", "星耀"];
export const tiers = [
  "normal",
  "bronze",
  "silver",
  "gold",
  "platinum",
  "emerald",
  "diamond",
  "stellar",
].map((tier_id, i) => ({
  tier_id,
  name: tierNames[i],
  icon_key: tier_id,
  rank_order: i + 1,
  min_points: [0, 50, 150, 300, 600, 1000, 1600, 2400][i],
  status: "active",
  version: 1,
}));
const rankings = [
  "展示小宇 P002",
  "展示 Mina P003",
  "展示 ABC P004",
  identity.nickname,
  "展示 Sora P005",
].map((nickname, i) => ({
  rank: i + 1,
  nickname,fan_id:i===3?"fan_yeh":"preview_fan_"+i,
  member_id: i === 3 ? identity.member_id : "PREVIEW-PUBLIC-" + i,
  points: [580, 530, 490, 420, 120][i],
  proof_count: [58, 53, 49, 42, 12][i],
  tier: tiers[i === 3 ? 3 : 2],
  tier_configuration_ready: true,
}));
export const boards = [
  ["history", "歷史累計", "all_time", null],
  ["comeback", "本次回歸", "campaign", null],
  ["group", "團體排行", "all_time", "團體"],
  ["solo", "Solo 總排行", "all_time", "Solo"],
  ["custom-one", "展示生日應援榜", "custom", null],
  ["custom-two", "展示週末衝刺榜", "custom", null],
  ["custom-three", "展示特別活動榜", "custom", null],
].map(([leaderboard_id, name, type, vote_type]) => ({
  leaderboard_id: type==='all_time'?'system-'+leaderboard_id:"PREVIEW-" + leaderboard_id,
  name,
  type,
  vote_type,
  campaign_id: type === "campaign" ? "PREVIEW-CAMPAIGN" : null,
  start_date: type === "custom" ? "2026-01-01" : null,
  end_date: type === "custom" ? "2099-12-31" : null,
  generated_at: "2026-10-14T04:00:00Z",
  rankings,
  top_n: 100,
  is_public: true,
  is_current_comeback: leaderboard_id === 'comeback',
  status: "active",
  system_fixed:type==="all_time",rule:type==="all_time"?"系統固定榜：跨所有活動正式歷史積分累積，Solo 不再細分對象。":undefined,
  version: 1,
}));
export const cases = ["pending", "approved", "rejected", "pending", "completed"].map(
  (status, i) => ({
    case_id: "VP-PREVIEW-00" + (i + 1),
    nickname: identity.nickname,
    player_id: identity.player_id,source:"member",review_stage:"initial",review_risk_reason:null,
    campaign_id: campaign.campaign_id,
    campaign_name: campaign.name,
    vote_type: "Solo",
    vote_date: "2026-10-14",
    created_at: "2026-10-14T03:00:00Z",
    status,
    status_reason: status === "rejected" ? "展示退件原因：投票日期不清楚（假資料）" : null,
    rejection_reason: status === "rejected" ? "展示退件原因：投票日期不清楚（假資料）" : null,
    points_awarded: ["approved", "completed"].includes(status) ? 10 : 0,
    version: 1,
    files: [{ file_id: "PREVIEW-IMAGE-" + i, content_type: "image/png", size: 4096 }],
    duplicate_evidence: {
      hash_state: "verified",
      analyses: [
        {
          state: ["pending", "processing", "clear", "exact_duplicate", "failed"][i],
          ...(i === 3
            ? { canonical_case_id: "VP-PREVIEW-001", canonical_file_id: "PREVIEW-IMAGE-0" }
            : {}),
        },
      ],
    },
  }),
);
export const adminCases=[...cases,{...cases[0],case_id:"VP-PREVIEW-006",nickname:"匿名投稿",player_id:"匿名投稿",source:"guest",files:[{file_id:"PREVIEW-IMAGE-6",content_type:"image/png",size:4096}]},{...cases[0],case_id:"VP-PREVIEW-007",nickname:"展示其他粉絲",player_id:"preview_other_fan",review_stage:"detailed",review_risk_reason:"manual_flag",status_reason:"展示人工疑慮（假資料）",files:[{file_id:"PREVIEW-IMAGE-7",content_type:"image/png",size:4096}]}];
export const previewCampaigns=[campaign,{...campaign,campaign_id:"PREVIEW-GROUP",name:"展示團體活動・假資料",category:"團體",solo_target:null}];
const soloTargets=['miyeon','minnie','soyeon','yuqi','shuhua'].map((target_id,i)=>({target_id,display_name:target_id.toUpperCase(),active:true,sort_order:i+1}));
const partialFailures=new Set();
const mailLookups=new Set(),mailSends=new Map();
const paged = (key, data) => ({ [key]: state.data === "empty" ? [] : data, next_cursor: null });
export async function fixtureResponse(path, { method = "GET",body } = {}) {
  const reply = (data, status = 200) =>
    Response.json(
      { ok: status === 200, ...(status === 200 ? { data } : { error: { code: data } }) },
      { status, headers: { "Cache-Control": "no-store" } },
    );
  if (!PREVIEW || typeof path !== "string" || !path.startsWith("/api/"))
    return reply("UI_PREVIEW_ONLY", 403);
  const url = new URL(path, "https://preview.invalid"),
    p = url.pathname;
  if(p==='/api/auth/logout'){previewLoggedOut=true;return reply({logged_out:true});}
  if(!previewLoggedOut&&state.identity==='blocked'&&(p.startsWith('/api/me/')||p.startsWith('/api/auth/')||p.startsWith('/api/admin/')))return reply('MEMBER_SUSPENDED',403);
  if(['/api/admin/member-lookup','/api/admin/member-mail/send'].includes(p)){
    if(!isManager||previewLoggedOut)return reply('ADMIN_FORBIDDEN',403);
    if(method!=='POST'||url.search)return reply('INVALID_MEMBER_CONTACT',400);
    const b=typeof body==='string'?JSON.parse(body):body;
    if(p.endsWith('member-lookup')){
      const fan=typeof b?.fan_id==='string'?b.fan_id.trim().toLowerCase():'';
      if(state.data==='empty'||!['fan_yeh','preview_blocked_fan','preview_multi_fan','preview_no_email'].includes(fan))return reply('MEMBER_NOT_FOUND',404);
      const id='PREVIEW-CONTACT-'+fan;mailLookups.add(id);
      return reply({member:{member_id:id,fan_id:fan,nickname:fan==='fan_yeh'?'葉子':'展示粉絲・假資料',status:fan==='preview_blocked_fan'?'suspended':'active',
        created_at:'2026-10-01T00:00:00.000Z',updated_at:'2026-10-17T02:00:00.000Z',tier:tiers[3],total_points:420,
        proof_counts:{total:45,pending:2,approved:42,rejected:1},login_methods:['Google','Email／密碼'],
        explanation:fan==='preview_blocked_fan'?'展示封鎖原因・假資料':'展示客服說明：您的案件審核進度可至「我的案件」查看。',
        emails:fan==='preview_no_email'?[]:[{email:'preview-fan-yeh@example.invalid',providers:['Google','Email／密碼'],recipient_ref:'a'.repeat(64)},...(fan==='preview_multi_fan'?[{email:'preview-second@example.invalid',providers:['Google'],recipient_ref:'b'.repeat(64)}]:[])]}});
    }
    if(!b||Object.keys(b).some(k=>!['member_id','recipient_ref','subject','body','mutation_id'].includes(k))||!b.subject?.trim()||b.subject.length>150||!b.body?.trim()||b.body.length>10000||/[\r\n]/.test(b.subject))return reply('INVALID_MEMBER_CONTACT',400);
    if(!mailLookups.has(b.member_id))return reply('MEMBER_LOOKUP_REQUIRED',403);
    const prior=mailSends.get(b.mutation_id);if(prior)return reply({...prior,replayed:true});
    await new Promise(resolve=>setTimeout(resolve,120));
    const r={send_id:b.mutation_id,outcome:state.mail==='rejected'?'rejected':state.mail==='ambiguous'?'ambiguous':'sent',replayed:false};mailSends.set(b.mutation_id,r);return reply(r);
  }
  if(p==='/api/admin/member-blocks'){
    if(!isManager)return reply('ADMIN_FORBIDDEN',403);
    if(method==='GET')return reply(paged('members',blockedMembers));
    if(state.data==='error')return reply('SERVICE_UNAVAILABLE',503);
    const b=typeof body==='string'?JSON.parse(body):body;
    if(!b||!['block','restore'].includes(b.action)||!b.fan_id?.trim()||!b.reason?.trim()||b.reason.trim().length>500||b.confirmed_fan_id!==b.fan_id)return reply('INVALID_MEMBER_BLOCK',400);
    const fan=b.fan_id.trim().toLowerCase();if(['fan_yeh','preview_owner'].includes(fan))return reply('MEMBER_BLOCK_PROTECTED',403);
    const index=blockedMembers.findIndex(m=>m.fan_id===fan);
    if(b.action==='restore'){if(index<0)return reply('MEMBER_NOT_FOUND',404);const [member]=blockedMembers.splice(index,1);return reply({member:{...member,status:'active'},outcome:'restored'});}
    if(index<0)blockedMembers.push({fan_id:fan,nickname:'展示粉絲・假資料',status:'suspended',reason:b.reason.trim(),blocked_at:new Date().toISOString()});return reply({member:blockedMembers.find(m=>m.fan_id===fan),outcome:'blocked'});
  }
  const content=await contentFixture(p,{method,body},state,previewPicture,reply);if(content)return content;
  if(state.identity==='reviewer'&&p.startsWith('/api/admin/')&&!['/api/admin/me','/api/admin/overview','/api/admin/campaigns','/api/admin/solo-targets'].includes(p)&&!p.startsWith('/api/admin/cases')&&!p.startsWith('/api/admin/image-exports'))return reply('ADMIN_FORBIDDEN',403);
  if(p.startsWith('/api/admin/image-exports'))return exportFixture(p,{method,body},state,previewPicture,reply);
  if(p==='/api/admin/staff'){
    if(state.identity!=='super_admin')return reply('ADMIN_FORBIDDEN',403);
    if(method==='GET')return reply({memberships:staffMembers});
    const input=typeof body==='string'?JSON.parse(body):body;
    if(!input||!['admin','reviewer'].includes(input.role)||typeof input.email!=='string'||!input.email.includes('@'))return reply('INVALID_STAFF_REQUEST',400);
    const row={nickname:'展示新成員・假資料',fan_id:'preview_staff_'+(staffMembers.length+1),role:input.role,status:'active'};staffMembers.push(row);return reply({membership:row,outcome:'granted'},201);
  }
  const storageFixture={budget:{budget:10000000000},used_bytes:{normal:7200000000,high:9100000000,stopped:9600000000,recovered:8400000000}[state.storage]??0,reserved_bytes:20000000,blocked:['stopped','unknown'].includes(state.storage),observed_at:1791979200,trusted_until:1791979800,cleanup_mode:'dry-run',retention_approved:false,anomaly:state.storage==='cleanup_failed'?'CLEANUP_VERIFICATION_FAILED':state.storage==='unknown'?'USAGE_UNKNOWN':null,history:[{created_at:1791975600,bytes:7000000000,object_count:1400,staging_bytes:10000000,other_bytes:20000000}],drive_quota:{state:state.storage==='drive_error'?'error':state.storage==='unknown'?'unknown':'known',total_bytes:state.storage==='unknown'?null:15*1024**3,used_bytes:10*1024**3,remaining_percent:['unknown','drive_error'].includes(state.storage)?null:33.3,observed_at:1791979200,stale:false}};
  if(state.storage==='unknown'){storageFixture.used_bytes=null;storageFixture.observed_at=null;}
  if(p.startsWith('/api/admin/storage')&&(!isManager||previewLoggedOut))return reply('ADMIN_FORBIDDEN',403);
  if(p==='/api/admin/storage/history'){
    if(state.data==='error')return reply('SERVICE_UNAVAILABLE',503);
    const page=Number(url.searchParams.get('page')??1),total=state.data==='empty'?0:23;
    const history=Array.from({length:Math.max(0,Math.min(10,total-(page-1)*10))},(_,i)=>{
      const number=(page-1)*10+i+1;
      return {created_at:1791979200-number*3600,bytes:7000000000-number*10000000,
        object_count:1400-number,staging_bytes:10000000,other_bytes:20000000};
    });
    return reply({history,page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
  }
  if(p==='/api/admin/storage')return reply(storageFixture);
  if(p==='/api/admin/storage/inventory')return reply({complete:true,bytes:storageFixture.used_bytes});
  if(p==='/api/admin/storage/dry-run')return reply({dry_run:true,retention_approved:false,items:state.storage==='cleanup_failed'?[{state:'blocked',would_delete:false}]:[{state:'dry_run',would_delete:true}]});
  if(method!=="GET") {
    if(method==='POST' && isManager && /^\/api\/admin\/leaderboards(?:\/[^/]+\/update)?$/.test(p)) {
      if(state.data==='error')return reply('SERVICE_UNAVAILABLE',503);
      const input=typeof body==='string'?JSON.parse(body):body,existing=boards.find(b=>p.endsWith('/'+b.leaderboard_id+'/update'));
      if(!input||!['campaign','custom'].includes(input.type)||input.is_current_comeback&&(input.type!=='campaign'||input.status==='archived'))return reply('INVALID_LEADERBOARD_REQUEST',400);
      if(input.campaign_id&&!previewCampaigns.some(c=>c.campaign_id===input.campaign_id))return reply('INVALID_CAMPAIGN',400);
      if(input.type==='campaign'&&!input.campaign_id)return reply('INVALID_LEADERBOARD_REQUEST',400);
      if(existing&&(existing.system_fixed||existing.status==='archived'||input.expected_version!==existing.version))return reply('LEADERBOARD_CONFLICT',409);
      if(input.is_current_comeback)for(const b of boards)if(b!==existing&&b.is_current_comeback){b.is_current_comeback=false;b.version++;}
      if(existing){const invalidate=['name','type','campaign_id','start_date','end_date','vote_type','top_n','is_public','status'].some(k=>existing[k]!==input[k]);Object.assign(existing,input,{version:existing.version+1,...(invalidate?{rankings:[],generated_at:null}:{})});return reply({...existing});}
      const row={...input,leaderboard_id:input.leaderboard_id??'PREVIEW-'+crypto.randomUUID(),version:0,rankings:[],generated_at:null};boards.push(row);return reply({...row},201);
    }
    if(method==='POST' && isManager && /^\/api\/admin\/campaigns(?:\/[^/]+\/update)?$/.test(p)) {
      if(state.data==='error')return reply('SERVICE_UNAVAILABLE',503);
      const input=typeof body==='string'?JSON.parse(body):body;
      if(!input || !['Solo','團體'].includes(input.category) || (input.category==='團體'&&input.solo_target!==null))return reply('INVALID_CAMPAIGN_REQUEST',400);
      if(input.category==='Solo'&&!soloTargets.some(t=>t.target_id===input.solo_target&&t.active))return reply('SOLO_TARGET_UNAVAILABLE',400);
      const existing=previewCampaigns.find(c=>p.endsWith('/'+c.campaign_id+'/update'));
      if(existing){if(input.expected_version!==existing.version || input.solo_target!==existing.solo_target || input.category!==existing.category)return reply('CAMPAIGN_CONFLICT',409);Object.assign(existing,input,{version:existing.version+1});savePreviewContent(existing.campaign_id,input);return reply({...existing});}
      if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.campaign_id??''))return reply('INVALID_CAMPAIGN_REQUEST',400);
      if(previewCampaigns.some(c=>c.campaign_id===input.campaign_id))return reply('CAMPAIGN_EXISTS',409);
      const row={...input,version:0};savePreviewContent(row.campaign_id,input);previewCampaigns.push(row);return reply({...row},201);
    }
    if(method==="POST" && p==="/api/admin/cases/batch-approve" && isStaff){
      const input=typeof body==="string"?JSON.parse(body):body;
      if(!Array.isArray(input?.cases)||!input.cases.length||input.cases.length>4||new Set(input.cases.map(c=>c.case_id)).size!==input.cases.length)return reply("INVALID_REVIEW_BATCH",400);
      const results=input.cases.map(item=>{
        const row=adminCases.find(c=>c.case_id===item.case_id);
        if(!row)return {ok:false,case_id:item.case_id,code:"CASE_NOT_FOUND",status:404};
        if(row.status==="approved" && row.version===item.expected_version+1)return {ok:true,...row,outcome:"already_approved"};
        if(state.data==="error" || state.review==="error" || (state.review==="partial" && item.case_id==="VP-PREVIEW-004" && !partialFailures.has(item.case_id))){partialFailures.add(item.case_id);return {ok:false,case_id:item.case_id,code:"ADMIN_SERVICE_UNAVAILABLE",status:503};}
        if(row.review_stage!=="initial")return {ok:false,case_id:item.case_id,code:"DETAILED_REVIEW_REQUIRED",status:409};
        if(row.status!=="pending" || row.version!==item.expected_version)return {ok:false,case_id:item.case_id,code:"CASE_STATUS_CONFLICT",status:409};
        row.status="approved";row.version++;row.points_awarded=row.source==="guest"?0:10;return {ok:true,...row,outcome:"approved"};
      });return reply({results,succeeded:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length});
    }

    if(method==="POST" && p==="/api/auth/profile-warning") return reply({duplicate:state.nickname==="duplicate"});
    if(method==="PATCH" && p==="/api/me/profile" && state.identity!=="guest") {
      const input=typeof body==="string"?JSON.parse(body):body;
      if(input?.player_id && input.player_id!==identity.player_id)return reply("FAN_ID_IMMUTABLE",409);
      if(typeof input?.nickname!=="string" || !input.nickname.trim())return reply("INVALID_AUTH_REQUEST",400);
      identity.nickname=input.nickname.trim();return reply({member:{...identity},nickname_warning:{duplicate:state.nickname==="duplicate"}});
    }
    if(method==="POST" && /^\/api\/admin\/cases\/VP-PREVIEW-\d+\/review$/.test(p) && isStaff) {
      if(state.review==="error" || state.data==="error")return reply("SERVICE_UNAVAILABLE",503);
      const input=typeof body==="string"?JSON.parse(body):body,row=adminCases.find(c=>p.includes('/'+c.case_id+'/'));
      if(!row || !["approve","reject","mark_duplicate","complete","revoke","flag_detailed"].includes(input?.action))return reply("UI_PREVIEW_ONLY",403);
      if(!isManager&&['complete','revoke'].includes(input.action))return reply('ADMIN_FORBIDDEN',403);
      if(input.expected_version!==row.version)return reply("CASE_VERSION_CONFLICT",409);
      if(["reject","mark_duplicate","revoke"].includes(input.action) && !input.reason?.trim())return reply("INVALID_ADMIN_REQUEST",400);
      if(input.action==="flag_detailed"){
        if(!["manual_flag","exact_duplicate","auto_check_failed","other"].includes(input.review_risk_reason))return reply("INVALID_REVIEW_REQUEST",400);
        row.review_stage="detailed";row.review_risk_reason=input.review_risk_reason;row.status_reason=input.reason??null;row.version++;return reply({...row});
      }
      row.status={approve:"approved",reject:"rejected",mark_duplicate:"duplicate",complete:"completed",revoke:"revoked"}[input.action];row.version++;row.status_reason=input.reason??null;row.rejection_reason=row.status==="rejected"?input.reason:null;row.points_awarded=row.status==="approved"?10:0;
      return reply({...row});
    }
    return reply("UI_PREVIEW_ONLY",403);
  }
  if (p === "/api/auth/me")
    return state.identity === "guest"||previewLoggedOut
      ? reply("AUTH_REQUIRED", 401)
      : reply({
          member: identity,
          elevated_until: isStaff ? 4102444800 : undefined,
        });
  if (p === '/api/admin/overview'){
    if(!isStaff)return reply('ADMIN_FORBIDDEN',403);const counts=Object.fromEntries(['pending','approved','completed','rejected','duplicate','revoked'].map(k=>[k,state.data==='empty'?0:adminCases.filter(c=>c.status===k).length]));
    return reply({member_count:state.data==='empty'?0:1284,case_counts:counts,case_totals:{pending:counts.pending,approved:counts.approved+counts.completed,rejected:counts.rejected+counts.duplicate,revoked:counts.revoked}});
  }
  if (p === "/api/admin/me")
    return isStaff
      ? reply({ member_id: identity.member_id, role: state.identity })
      : reply("ADMIN_FORBIDDEN", 403);
  if (p === "/api/auth/registration-status") return reply({ registration_available: false });
  if (p === "/api/submissions/status")
    return reply({
      submissions_enabled: state.gate === "on",
      submissions_message:
        state.gate === "on"
          ? "UI PREVIEW：展示開放狀態，實際不收件。"
          : "UI PREVIEW：展示暫停狀態。",
    });
  if (
    (p.startsWith("/api/me/") ||
      p === "/api/auth/login-security" ||
      p === "/api/auth/trusted-devices") &&
    state.identity === "guest"
  )
    return reply("AUTH_REQUIRED", 401);
  if (p.startsWith("/api/admin/") && !isStaff)
    return reply("ADMIN_FORBIDDEN", 403);
  if (state.data === "error") return reply("SERVICE_UNAVAILABLE", 503);
  if (p === "/api/campaigns") return reply(paged("campaigns", previewCampaigns.filter(c=>c.status==='active'&&Date.parse(c.start_at)<=Date.now()&&Date.parse(c.end_at)>Date.now()).map(c=>Object.fromEntries(['campaign_id','name','category','start_at','end_at','campaign_timezone','vote_start_date','vote_end_date','points_per_proof','daily_limit','status'].map(k=>[k,c[k]])))));
  if (p === '/api/admin/solo-targets') return reply({targets:soloTargets});
  if (p === "/api/leaderboards/solo-targets") return reply("NOT_FOUND",404);
  if (p === "/api/leaderboards") {
    if(url.searchParams.has("solo_target"))return reply("INVALID_LEADERBOARD_QUERY",400);
    const selected =
      state.data === "empty"
        ? []
        : boards.filter(
            (b) => !url.searchParams.has("id") || b.leaderboard_id === url.searchParams.get("id"),
          );
    return reply({
      generated_at: "2026-10-14T04:00:00Z",
      leaderboards: url.searchParams.has('id')?selected:selected.map(b=>({...b,rankings:[],generated_at:null})),
      custom_boards: selected
        .filter((b) => b.type === "custom")
        .map(({ leaderboard_id, name, type, campaign_id, vote_type }) => ({
          leaderboard_id,
          name,
          type,
          campaign_id,
          vote_type,
        })),
    });
  }
  if(p==='/api/me/point-transactions'){
    if(state.identity==='guest'||previewLoggedOut)return reply('AUTH_REQUIRED',401);
    if(state.data==='error')return reply('SERVICE_UNAVAILABLE',503);
    const offset=Number(url.searchParams.get('page')??0)>0?(Number(url.searchParams.get('page'))-1)*10:Number(url.searchParams.get('cursor')??0),
      all=Array.from({length:23},(_,i)=>({transaction_id:'PREVIEW-POINT-'+i,created_at:new Date(Date.UTC(2026,9,17-i)).toISOString(),category:i===3?'proof_revoked':'proof_approved',points:i===3?-10:10,reason:i===3?'展示撤銷積分・假資料':'展示投稿核准・假資料',campaign_name:campaign.name})),rows=state.data==='empty'?[]:all;
    if(url.searchParams.has('page'))return reply({transactions:rows.slice(offset,offset+10),page:Number(url.searchParams.get('page')),page_size:10,total:rows.length,total_pages:Math.max(1,Math.ceil(rows.length/10))});
    return reply({transactions:rows.slice(offset,offset+10),next_cursor:rows.length>offset+10?String(offset+10):null});
  }
  if (p === "/api/me/points")
    return reply({
      total_points: state.data === "empty" ? 0 : 420,
      tier: tiers[state.data === "empty" ? 0 : 3],
      tier_configuration_ready: true,
      next_tier: tiers[state.data === "empty" ? 1 : 4],
    });
  if (p === "/api/auth/login-security")
    return reply({
      google: { connected: true, email: "展示帳號・無真實信箱" },
      password: { configured: true },
      authenticator: { configured: true },
      recovery: { remaining: 8 },
      current_method: "google",
      unlink_supported: false,
    });
  if (p === "/api/auth/trusted-devices")
    return reply(
      paged("devices", [
        { id: "PREVIEW-DEVICE", label: "展示手機・假資料", expires_at: 4102444800 },
      ]),
    );
  if (p === "/api/me/cases")
    return reply(paged("cases", cases.slice(0, Number(url.searchParams.get("limit") ?? 10))));
  if (p.startsWith("/api/me/cases/")) {
    const row = cases.find((c) => p.endsWith("/" + c.case_id));
    return row && state.data !== "empty" ? reply(row) : reply("CASE_NOT_FOUND", 404);
  }
  if(p==='/api/admin/cases/initial-review'){
    const list=state.data==='empty'?[]:adminCases.filter(c=>c.status==='pending'&&c.review_stage==='initial'&&!c.review_risk_reason).sort((a,b)=>a.case_id.localeCompare(b.case_id));
    if(!url.searchParams.has('cutoff'))return reply({total:list.length,cutoff:new Date().toISOString(),cases:[],next_cursor:null});
    const cursor=url.searchParams.get('cursor')??'',rows=list.filter(c=>c.case_id>cursor).slice(0,21);
    return reply({cases:rows.slice(0,20).map(c=>({case_id:c.case_id,expected_version:c.version})),next_cursor:rows.length>20?rows[19].case_id:null});
  }
  if(p==='/api/admin/cases/batch-status'){
    const items=JSON.parse(url.searchParams.get('items')??'[]');return reply({results:items.map(i=>{const c=adminCases.find(c=>c.case_id===i.case_id);return c&&c.status==='approved'&&c.version===i.expected_version+1?{ok:true,...c}:{ok:false,case_id:i.case_id,code:'REVIEW_RESULT_UNCONFIRMED'};})});
  }
  if(p==='/api/admin/backups/jobs')return reply({files:[],page:Number(url.searchParams.get('page')??1),page_size:10,total:0,total_pages:1});
  if (p === "/api/admin/cases")
    return reply(
      paged(
        "cases",
        adminCases.filter(c=>(!url.searchParams.get("status") || c.status===url.searchParams.get("status")) && (!url.searchParams.get("review_stage") || c.review_stage===url.searchParams.get("review_stage"))).map(c=>({...c,primary_file_id:c.files[0].file_id})),
      ),
    );
  if (p === '/api/admin/backups/missing') {
    const page = Number(url.searchParams.get('page') ?? 1), total = state.data === 'empty' ? 0 : 23;
    return reply({files:Array.from({length:Math.max(0,Math.min(10,total-(page-1)*10))},(_,i)=>({file_id:'PREVIEW-UNSCHEDULED-'+((page-1)*10+i+1),case_id:'VP-PREVIEW-001',created_at:'2026-10-21T02:00:00.000Z',content_type:'image/png',size:1024})),page,page_size:10,total,total_pages:Math.max(1,Math.ceil(total/10))});
  }
  if (p === "/api/admin/backups" || /^\/api\/admin\/cases\/VP-PREVIEW-\d+\/backups$/.test(p))
    return reply({
      enabled: false,
      ready: false,
      configured: false,
      transport: "apps_script_pull",
      storage:storageFixture,
      counts: { pending: 0, processing: 0, confirmed: 0, failed: 0 },
      missing: state.data === 'empty' ? 0 : 23,
      audit: [],
      backups: [],
    });
  if (p.startsWith("/api/admin/cases/")) {
    const row = adminCases.find((c) => p.endsWith("/" + c.case_id));
    return row && state.data !== "empty"
      ? reply({
          ...row,
          duplicate_evidence: {
            hash_state: "verified",
            analyses: [
              {
                state: state.analysis,
                ...(state.analysis === "exact_duplicate"
                  ? { canonical_case_id: "VP-PREVIEW-001", canonical_file_id: "PREVIEW-IMAGE-0" }
                  : {}),
              },
            ],
          },
        })
      : reply("CASE_NOT_FOUND", 404);
  }
  if (p === "/api/admin/campaigns") return reply(paged("campaigns", previewCampaigns));
  if (p === "/api/admin/leaderboards") return reply({...paged("leaderboards", boards.filter(b=>!b.system_fixed)),system_boards:boards.filter(b=>b.system_fixed)});
  if (/^\/api\/admin\/leaderboards\/[^/]+\/results$/.test(p))
    return reply({
      leaderboards:
        state.data === "empty"
          ? []
          : [boards.find((b) => p.includes(b.leaderboard_id)) ?? boards[0]],
    });
  if (p === "/api/admin/member-tiers") return reply({ tiers, configuration_ready: true });
  if (p === "/api/admin/submissions")
    return reply({
      submissions_enabled: state.gate === "on",
      submissions_message: "UI PREVIEW・展示設定，不會保存",
      version: 1,
    });
  if(p.startsWith('/api/admin/audit-logs/'))return reply({log:{id:'00000000-0000-4000-8000-000000000001',source:'admin',actor_kind:'admin',operator_fan_id:'preview_admin',action:'leaderboard_update',created_at:'2026-10-14T03:00:00.000Z',target:'PREVIEW-custom-one',reason:'展示操作紀錄・假資料',before:{is_public:false},after:{is_public:true}}});
  if (p === "/api/admin/audit-logs")
    return reply(
      paged("logs", [
        {
          id: "00000000-0000-4000-8000-000000000001",source:'admin',actor_kind:'admin',operator_fan_id:'preview_admin',
          action: "leaderboard_update",
          created_at: "2026-10-14T03:00:00Z",
          admin_member_id: "PREVIEW-ADMIN",
          target_id: "PREVIEW-custom-one",
          reason: "展示操作紀錄・假資料",
        },
      ]),
    );
  return reply("UI_PREVIEW_ONLY", 403);
}
export async function previewPicture(index = 1) {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#18291c";
  ctx.fillRect(0, 0, 640, 360);
  ctx.fillStyle = "#00cd3c";
  ctx.font = "bold 36px sans-serif";
  ctx.fillText("UI PREVIEW", 48, 110);
  ctx.fillStyle = "#fff";
  ctx.font = "22px sans-serif";
  ctx.fillText("Synthetic image " + index, 48, 170);
  ctx.fillText("No real vote / private proof", 48, 220);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}
