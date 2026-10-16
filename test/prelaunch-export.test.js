import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
test('completed export re-download is an owned private read, never downgrades completed package',async()=>{
 const h=await embeddedCaseRuntime(),actor=await h.identity('reviewer'),admin=await h.identity('admin');const upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 const data=async(r,status=200)=>{const j=await r.json();assert.equal(r.status,status,JSON.stringify(j));return j.data;};
 const call=(path,body,owner=actor)=>h.fetch('/api/admin/image-exports'+path,body?'POST':'GET',body,owner.headers);
 try{
 const campaign_id='EXPORT_PRELAUNCH';await data(await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Synthetic export',category:'團體',solo_target:null,start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null},admin.headers),201);
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();const {ref}=await h.upload(campaign_id,actor);await data(await h.fetch('/api/cases/direct','POST',{campaign_id,vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...actor.headers,'Idempotency-Key':randomUUID()}),201);
 const job=await data(await call('/jobs',{job_id:randomUUID(),filters:{campaign_id,entire_campaign:true,statuses:['pending'],vote_types:['團體'],sources:['member']}}));assert.equal(job.image_count,1);
 const base='/jobs/'+job.id+'/packages/1',attempt_id=randomUUID(),start=await data(await call(base+'/start',{attempt_id,expected_attempt_id:null}));assert.equal(start.items.length,1);
 await data(await call(base+'/state',{attempt_id,status:'completed'}));const before=await h.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(job.id).first();
 const repeated=await data(await call(base+'/start',{attempt_id:randomUUID(),expected_attempt_id:attempt_id}));assert.equal(repeated.read_only,true);assert.equal(repeated.package.attempt_id,attempt_id);assert.equal(repeated.package.status,'completed');
 const path=base+'/attempts/'+attempt_id+'/files/'+repeated.items[0].file_id;const image=await call(path);assert.equal(image.status,200);assert.equal(image.headers.get('Cache-Control'),'no-store');assert.equal((await image.arrayBuffer()).byteLength,3);assert.equal((await call(path,undefined,admin)).status,404);
 assert.equal((await call(base+'/state',{attempt_id,status:'failed',error_code:'EXPORT_CANCELLED'})).status,409);assert.deepEqual(await h.db.prepare('SELECT * FROM export_packages WHERE job_id=? AND number=1').bind(job.id).first(),before);
 }finally{upstream.mock.restore();h.close();}
});
