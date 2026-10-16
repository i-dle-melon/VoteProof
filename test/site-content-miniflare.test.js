// Provider-equivalent D1 binding coverage. Never replaced by the SQLite harness.
import test from 'node:test';
import assert from 'node:assert/strict';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
test('real Miniflare content migration, announcement authorization, publication and audit',async()=>{
 const h=await localAdminRuntime();
 try{const actor=await h.identity({role:'super_admin'}),reviewer=await h.identity({role:'reviewer'});
 const input={title:'Synthetic announcement',body:'Partner notes\nSafe plain text',enabled:true,dismissible:true,starts_at:null,ends_at:null,button_label:'',button_url:''};
 assert.equal((await h.local.fetch('/api/admin/announcements','POST',input,reviewer.headers)).status,403);
 const created=await h.local.fetch('/api/admin/announcements','POST',input,actor.headers);assert.equal(created.status,201,await created.clone().text());const row=(await created.json()).data;
 const list=await h.local.fetch('/api/announcements');assert.equal(list.status,200);assert.equal((await list.json()).data.announcements[0].announcement_id,row.announcement_id);
 const stale=await h.local.fetch('/api/admin/announcements/'+row.announcement_id+'/update','POST',{...input,expected_version:99},actor.headers);assert.equal(stale.status,409);
 assert.equal((await h.local.db.prepare("SELECT COUNT(*) n FROM admin_content_audit WHERE action='announcement_create'").first()).n,1);
 assert.deepEqual((await h.local.db.prepare('PRAGMA foreign_key_check').all()).results,[]);assert.equal((await h.local.db.prepare('PRAGMA quick_check').first()).quick_check,'ok');
 }finally{await h.local.runtime.dispose();}
});
test('real Miniflare private R2 campaign assets: authorization, safe read, replacement and scoped removal',async()=>{
 const h=await localAdminRuntime(),l=h.local;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jh0kAAAAASUVORK5CYII=','base64');
 const data=async(r,status=200)=>{assert.equal(r.status,status,await r.clone().text());return(await r.json()).data;};
 try{
 const actor=await h.identity({role:'admin'}),reviewer=await h.identity({role:'reviewer'}),campaign_id='ASSET_RC',input={campaign_id,name:'Synthetic R2 campaign',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null};
 await data(await l.fetch('/api/admin/campaigns','POST',input,actor.headers),201);
 const upload=(bytes=png,mime='image/png',headers=actor.headers)=>l.runtime.dispatchFetch('https://voteproof.example/api/admin/campaign-assets/'+campaign_id,{method:'POST',headers:{'Content-Type':mime,...headers},body:bytes});
 assert.equal((await upload(png,'image/png',{})).status,401);assert.equal((await upload(png,'image/png',reviewer.headers)).status,403);assert.equal((await upload('<svg/>','image/svg+xml')).status,400);assert.equal((await upload(new Uint8Array(5242881))).status,413);
 const first=await data(await upload(),201),key=(await l.db.prepare('SELECT object_key FROM campaign_example_assets WHERE asset_id=?').bind(first.asset_id).first()).object_key;assert.match(key,/^campaign-assets\/ASSET_RC\/example\//);await l.bucket.put('proofs/rc-untouched',png,{httpMetadata:{contentType:'image/png'}});
 const {campaign_id:_id,...fields}=input;let version=0;const save=async(asset)=>data(await l.fetch('/api/admin/campaigns/'+campaign_id+'/update','POST',{...fields,expected_version:version++,submission_instructions:'Partner\nNotes',example_asset_id:asset},actor.headers));await save(first.asset_id);
 assert.equal((await l.fetch('/api/admin/campaign-assets/'+first.asset_id)).status,401);assert.equal((await l.fetch('/api/admin/campaign-assets/'+first.asset_id,'GET',undefined,reviewer.headers)).status,403);
 const response=await l.fetch('/api/campaigns/'+campaign_id+'/example');assert.equal(response.status,200);assert.equal(response.headers.get('X-Content-Type-Options'),'nosniff');assert.deepEqual(Buffer.from(await response.arrayBuffer()),png);
 assert.equal((await upload('<html/>','image/png')).status,400);assert.ok(await l.bucket.head(key));const second=await data(await upload(),201);assert.ok(await l.bucket.head(key));await save(second.asset_id);assert.equal(await l.bucket.head(key),null);await save(null);assert.equal((await l.fetch('/api/campaigns/'+campaign_id+'/example')).status,404);assert.ok(await l.bucket.head('proofs/rc-untouched'));
 assert.equal((await l.db.prepare("SELECT COUNT(*) n FROM admin_content_audit WHERE action='example_image_delete'").first()).n,1);
 }finally{await l.runtime.dispose();}
});
