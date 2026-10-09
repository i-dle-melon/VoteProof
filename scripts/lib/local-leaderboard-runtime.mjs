// Disposable local fixtures only; never production/auth-provider requests.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { localAdminRuntime } from './local-admin-runtime.mjs';

export const definition = (extra = {}) => ({ leaderboard_id:'LB-'+randomUUID(),name:'Local leaderboard',type:'all_time',
  campaign_id:null,start_date:null,end_date:null,vote_type:null,top_n:100,is_public:true,status:'active',...extra });
export async function localLeaderboardRuntime() {
  const h = await localAdminRuntime(), { local } = h;
  const admin = await h.identity({ role:'admin' }), reviewer = await h.identity({ role:'reviewer' });
  const create = async extra => {
    const response = await local.fetch('/api/admin/leaderboards','POST',definition(extra),admin.headers);
    assert.equal(response.status,201,JSON.stringify(await response.clone().json())); return (await response.json()).data;
  };
  const rebuild = (board,actor = admin,version = board.version) => local.fetch(`/api/admin/leaderboards/${board.leaderboard_id}/rebuild`,'POST',{expected_version:version},actor.headers);
  const adjust = async (member,points,createdAt) => {
    // Explicit history fixture, preserving append-only production protections.
    const id = randomUUID();
    await local.db.prepare(`INSERT INTO point_transactions(transaction_id,created_at,member_id,category,points,reason,created_by,idempotency_hash,request_hash)
      VALUES(?,?,?,'manual_adjustment',?,'Local fixture',?,?,?)`).bind(id,createdAt ?? new Date().toISOString(),member.memberId,points,admin.memberId,
        randomUUID().replaceAll('-','').repeat(2),randomUUID().replaceAll('-','').repeat(2)).run();
    return id;
  };
  const campaign = async extra => { const id = 'LC-'+randomUUID(); await local.campaign({campaign_id:id,points_per_proof:10,daily_limit:100,...extra}); return id; };
  const award = async (member,campaignId,extra = {}) => {
    const proof = await h.makeCase({ member,metadata:{ campaign_id:campaignId,...extra } });
    assert.equal((await h.review(reviewer,proof.case_id,'approve')).status,200); return proof;
  };
  const snapshot = async (board,adminOnly = false) => {
    const response = await local.fetch(adminOnly ? `/api/admin/leaderboards/${board.leaderboard_id}/results` : '/api/leaderboards?id='+board.leaderboard_id,
      'GET',undefined,adminOnly ? admin.headers : {});
    assert.equal(response.status,200); return (await response.json()).data.leaderboards[0];
  };
  const update = (board,extra = {},actor = admin) => local.fetch(`/api/admin/leaderboards/${board.leaderboard_id}/update`,'POST',
    { ...Object.fromEntries(['name','type','campaign_id','start_date','end_date','vote_type','top_n','is_public','status'].map(k => [k,board[k]])),expected_version:board.version,...extra },actor.headers);
  return { ...h,admin,reviewer,create,rebuild,adjust,campaign,award,snapshot,update };
}
