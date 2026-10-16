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
