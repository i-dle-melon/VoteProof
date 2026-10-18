// Shared local/cloud acceptance assertions. Only synthetic owned fixtures.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
const day=86400,now=()=>Math.floor(Date.now()/1000),date=n=>new Date(n*1000).toISOString();
const q=v=>"'"+String(v).replaceAll("'","''")+"'";
export const scenarios=[
  ['unconfirmed',async h=>{await h.sql("UPDATE proof_backups SET status='pending' WHERE file_id=?",[h.f.file]);await h.noDelete('normal','no_eligible_proofs');}],
  ['young',async h=>{await h.sql('UPDATE cases SET status_updated_at=? WHERE id=?',[date(now()-7*day+30),h.f.id]);await h.noDelete('normal','no_eligible_proofs');}],
  ['unclosed',async h=>{await h.sql("UPDATE cases SET status='approved' WHERE id=?",[h.f.id]);await h.noDelete('normal','no_eligible_proofs');}],
  ['no-review',async h=>{await h.sql('UPDATE cases SET reviewed_at=NULL WHERE id=?',[h.f.id]);await h.noDelete('normal','no_eligible_proofs');}],
  ['sha-mismatch',async h=>{await h.noDelete('sha-mismatch','blocked');}],
  ['signature-mismatch',async h=>{await h.noDelete('signature-mismatch','blocked');}],
  ['nonce-mismatch',async h=>{await h.noDelete('nonce-mismatch','blocked');}],
  ['expired',async h=>{await h.noDelete('expired','blocked');}],
  ['etag-mismatch',async h=>{await h.sql("UPDATE case_files SET etag='wrong' WHERE id=?",[h.f.file]);await h.sql("UPDATE proof_backups SET source_etag='wrong' WHERE file_id=?",[h.f.file]);await h.noDelete('normal','blocked');}],
  ['version-mismatch',async h=>{await h.noDelete('replace-version','blocked');}],
  ['below-start',async h=>{await h.sql('UPDATE storage_capacity SET used_bytes=8999999999,cleanup_requested=0 WHERE id=1');await h.noDelete('normal','idle');}],
  ['at-target',async h=>{await h.sql('UPDATE storage_capacity SET used_bytes=8500000000,cleanup_requested=1 WHERE id=1');await h.noDelete('normal','target_reached');}],
  ['below-target',async h=>{await h.sql('UPDATE storage_capacity SET used_bytes=8499999999,cleanup_requested=1 WHERE id=1');await h.noDelete('normal','target_reached');}],
  ['hysteresis',async h=>{await h.sql('UPDATE storage_capacity SET used_bytes=8500000001,cleanup_requested=1 WHERE id=1');await h.cold('normal');}],
  ['exact-seven-days',async h=>{await h.sql('UPDATE cases SET status_updated_at=? WHERE id=?',[date(now()-7*day),h.f.id]);await h.cold('normal');}],
  ['dry-run',async h=>{await h.noDelete('dry-run','dry_run');}],
  ['writer-race',async h=>{const r=await h.cold('writer-race');assert.equal(r.assertions.writer_blocked,true);}],
  ['upload-inflight',async h=>{const id=randomUUID();await h.sql("INSERT INTO storage_reservations(id,object_key,bytes,state,created_at) VALUES(?,'other/inflight',1,'reserved',?)",[id,now()]);
    try{await h.noDelete('normal','unavailable');}finally{await h.sql("UPDATE storage_reservations SET state='cancelled' WHERE id=?",[id]);}}],
  ['review-race',async h=>{const r=await h.cold('review-race');assert.equal(r.assertions.review_blocked,true);}],
  ['export-race',async h=>{const r=await h.cold('export-race');assert.equal(r.assertions.export_blocked,true);}],
  ['export-existing',async h=>{await addExport(h);await h.noDelete('normal','blocked');}],
  ['cleanup-concurrent',async h=>{const r=await Promise.all([h.call('normal'),h.call('normal')]);assert.equal(r.reduce((n,x)=>n+x.counters.r2.delete,0),1);await h.isCold();}],
  ['delete-failure',async h=>{const r=await h.call('delete-failure');assert.equal(r.result.state,'delete_ambiguous');assert.equal(r.counters.r2.delete,0);assert.equal((await h.snapshot()).exists,true);await h.expire();await h.cold('normal');}],
  ['delete-ack-lost',async h=>{const r=await h.call('delete-ack-lost');assert.equal(r.result.state,'delete_ambiguous');assert.equal(r.counters.r2.delete,1);assert.equal((await h.snapshot()).exists,false);
    await assert.rejects(h.sql('UPDATE cases SET updated_at=? WHERE id=?',[date(now()),h.f.id]));await assert.rejects(addExport(h));
    await h.expire();await h.noDelete('sha-mismatch','blocked',false,true);assert.equal((await h.snapshot()).archive.state,'deleting');await h.expire();
    const recovered=await h.call('normal');assert.equal(recovered.result.state,'cold_reconciled');assert.equal(recovered.counters.r2.delete,0);await h.isCold();}],
  ['commit-failure',async h=>{const r=await h.call('commit-failure');assert.equal(r.result.state,'delete_ambiguous');assert.equal((await h.snapshot()).archive.state,'deleting');await h.expire();const recovered=await h.call('normal');assert.equal(recovered.result.state,'cold_reconciled');assert.equal(recovered.counters.r2.delete,0);await h.isCold();}],
  ['commit-ack-lost',async h=>{const r=await h.call('commit-ack-lost');assert.equal(r.result.state,'delete_ambiguous');await h.isCold();const again=await h.call('normal');assert.equal(again.counters.r2.delete,0);await h.isCold();}],
  ['response-lost',async h=>{await h.call('response-lost',503);await h.isCold();const again=await h.call('normal');assert.equal(again.counters.r2.delete,0);await h.isCold();}],
  ['upload-stop',async h=>{await h.sql('UPDATE storage_capacity SET used_bytes=9500000000,blocked=1 WHERE id=1');const r=await h.putProbe();assert.equal(r.error,'R2_STORAGE_CAPACITY_EXCEEDED');assert.equal(r.puts,0);assert.equal((await h.snapshot()).exists,true);}],
];
async function addExport(h){
  const job=randomUUID(),at=date(now());
  await h.sql("INSERT INTO export_jobs(id,owner_member_id,created_at,expires_at,filters_json,from_utc,to_utc) VALUES(?,'SYNTHETIC-ADMIN',?,?,'{}','2020-01-01','2100-01-01')",[job,at,date(now()+3600)]);
  await h.sql(`INSERT INTO export_job_items SELECT ?,1,1,f.id,c.case_id,c.created_at,c.campaign_id,'Synthetic',c.vote_type,c.source,c.status,c.review_stage,f.content_type,f.size,f.etag,NULL FROM case_files f JOIN cases c ON c.id=f.case_id WHERE f.id=?`,[job,h.f.file]);
}
export async function runScenario(adapter,f,name,run){
  await adapter.seed(f);
  const h={...adapter,f,call:(mode,expected)=>adapter.call(mode,expected),snapshot:()=>adapter.snapshot(f),
    expire:()=>adapter.sql('UPDATE cold_proofs SET lease_until=0 WHERE file_id=?',[f.file])};
  h.isCold=async()=>{const s=await h.snapshot();assert.equal(s.exists,false);assert.equal(s.archive.state,'cold');assert.equal(s.backup.status,'confirmed');assert.equal(s.audit,1);};
  h.noDelete=async(mode,state,exists=true,recovery=false)=>{const r=await h.call(mode);assert.equal(r.result.state,state);assert.equal(r.counters.r2.delete,0);assert.equal((await h.snapshot()).exists,exists);if(!recovery)assert.notEqual((await h.snapshot()).archive?.state,'cold');return r;};
  h.cold=async mode=>{const r=await h.call(mode);assert.equal(r.result.state,'cold');assert.equal(r.counters.r2.delete,1);await h.isCold();return r;};
  try{await run(h);return {name,result:'PASS'};}
  finally{
    // Retire only non-destructive synthetic candidates; never clear a delete pin.
    const s=await h.snapshot();if(!['deleting','cold'].includes(s.archive?.state))await h.sql('UPDATE cases SET status_updated_at=? WHERE id=?',[date(now()+86400),f.id]);
  }
}
