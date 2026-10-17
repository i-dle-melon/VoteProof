// Actual Wrangler local migrations apply, including the real d1_migrations
// registry. No Cloudflare credentials, remote database, or Production access.
import test,{mock} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir,mkdir,writeFile,copyFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
const quote=value=>value===null?'NULL':typeof value==='number'?String(value):"'"+String(value).replaceAll("'","''")+"'";
test('actual Wrangler populated 0019 → 0020 → 0021 → 0022 preserves data and final registry exactly', {timeout:180000},async()=>{
 const root=resolve('.wrangler','rc-migrations-'+randomUUID()),dir=resolve(root,'migrations');await mkdir(dir,{recursive:true});
 const names=(await readdir('migrations')).filter(n=>/^\d+_.+\.sql$/.test(n)).sort(),baseline=names.filter(n=>n<'0020');
 const config=resolve(root,'wrangler.json');await writeFile(config,JSON.stringify({name:'rc-local-migrations',compatibility_date:'2026-10-07',d1_databases:[{binding:'DB',database_name:'rc-local-only',database_id:'00000000-0000-4000-8000-000000000021',migrations_dir:dir}]}));
 const cli=resolve('node_modules/wrangler/bin/wrangler.js');function run(args){const r=spawnSync(process.execPath,[cli,...args,'--config',config,'--local','--persist-to',resolve(root,'state')],{encoding:'utf8',windowsHide:true,maxBuffer:32*1024*1024,timeout:60000,env:{...process.env,CI:'true',WRANGLER_SEND_METRICS:'false'}});assert.equal(r.error,undefined);assert.equal(r.status,0,JSON.stringify({args,stdout:r.stdout,stderr:r.stderr}));return r.stdout;}
 const query=sql=>{const rows=JSON.parse(run(['d1','execute','rc-local-only','--command',sql,'--json']));assert.ok(rows.every(r=>r.success));return rows;};
 for(const name of baseline)await copyFile(resolve('migrations',name),resolve(dir,name));run(['d1','migrations','apply','rc-local-only']);assert.deepEqual(query('SELECT name FROM d1_migrations ORDER BY id')[0].results.map(r=>r.name),baseline);
 const h=await embeddedCaseRuntime({migrationThrough:'0019_solo_target_registry.sql'}),upstream=mock.method(globalThis,'fetch',async()=>Response.json({success:true}));
 try{
 const owner=await h.identity('super_admin'),member=await h.identity(),campaign_id='RC_HISTORICAL';
 const made=await h.fetch('/api/admin/campaigns','POST',{campaign_id,name:'Production-like synthetic campaign',category:'Solo',solo_target:'yuqi',start_at:'2000-01-01T00:00:00.000Z',end_at:'2100-01-01T00:00:00.000Z',status:'active',points_per_proof:10,daily_limit:null},owner.headers);assert.equal(made.status,201,await made.clone().text());
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
 for(const storageVersion of [1,2]){const {ref}=await h.upload(campaign_id,member,{direct:false,storageVersion}),r=await h.fetch('/api/cases','POST',{campaign_id,vote_date:new Date().toISOString().slice(0,10),upload_session:ref},{...member.headers,'Idempotency-Key':randomUUID()});assert.equal(r.status,201,await r.clone().text());const c=(await r.json()).data;assert.equal((await h.fetch('/api/admin/cases/'+c.case_id+'/review','POST',{action:'approve',expected_version:0},owner.headers)).status,200);}
 await h.db.prepare('UPDATE submission_settings SET submissions_enabled=0,version=16 WHERE id=1').run();
 await h.db.prepare(`INSERT INTO leaderboards(leaderboard_id,name,type,start_date,end_date,top_n,is_public,status,created_at,updated_at,created_by,updated_by) VALUES('RC_BOARD','Historical board','custom','2000-01-01','2099-12-31',10,1,'active','2026-10-01T00:00:00.000Z','2026-10-01T00:00:00.000Z',?,?)`).bind(owner.memberId,owner.memberId).run();
 const tables=(await h.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all()).results.map(r=>r.name),priority=['members','campaigns','auth_sessions','admin_memberships','completed_uploads','completed_upload_files','cases','proof_upload_intents','case_files','point_transactions'];tables.sort((a,b)=>(priority.includes(a)?priority.indexOf(a):99)-(priority.includes(b)?priority.indexOf(b):99));
 // Import authoritative rows once; duplicate_enqueue generates its own jobs/groups.
 const seed=['PRAGMA defer_foreign_keys=ON;','UPDATE submission_settings SET submissions_enabled=1 WHERE id=1;'];for(const table of tables){if(['member_tiers','solo_targets','submission_settings','proof_duplicate_jobs','proof_duplicate_groups'].includes(table))continue;for(const row of(await h.db.prepare('SELECT * FROM '+table).all()).results)seed.push('INSERT INTO '+table+'('+Object.keys(row).join(',')+') VALUES('+Object.values(row).map(quote).join(',')+');');}seed.push('UPDATE submission_settings SET submissions_enabled=0,version=16 WHERE id=1;');const file=resolve(root,'synthetic-seed.sql');await writeFile(file,seed.join('\n'));run(['d1','execute','rc-local-only','--file',file]);
 const core=['members','auth_sessions','admin_memberships','campaigns','cases','case_files','point_transactions','admin_audit_logs','proof_backups','leaderboards','solo_targets','submission_settings'];core.push(...tables.filter(t=>!core.includes(t)));const snapshot=()=>query(core.map(t=>'SELECT * FROM '+t+' ORDER BY rowid').join(';')).map(r=>r.results);const before=snapshot();assert.equal(before[4].length,2);assert.equal(before[5].length,2);assert.equal(before[6].length,2);
 const schema=query("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations' ORDER BY name")[0].results;
 for(const name of ['0020_current_comeback.sql','0021_campaign_content_announcements.sql','0022_announcement_button_visibility.sql']){const sql=await readFile(resolve('migrations',name),'utf8');assert.doesNotMatch(sql,/\bDROP\s+(?:TABLE|COLUMN|INDEX|TRIGGER)\b/i);await copyFile(resolve('migrations',name),resolve(dir,name));run(['d1','migrations','apply','rc-local-only']);assert.deepEqual(query('PRAGMA foreign_key_check')[0].results,[]);}
 const after=snapshot().map((rows,i)=>i===9?rows.map(({is_current_comeback,...r})=>r):rows);assert.deepEqual(after,before);
 const afterSchema=query("SELECT name,type,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name!='d1_migrations' ORDER BY name")[0].results;for(const row of schema){if(row.name==='leaderboards')continue;assert.deepEqual(afterSchema.find(r=>r.name===row.name),row,row.name);}
 assert.deepEqual(query('SELECT name FROM d1_migrations ORDER BY id')[0].results.map(r=>r.name),names);assert.equal(names.at(-1),'0022_announcement_button_visibility.sql');assert.equal(query('PRAGMA quick_check')[0].results[0].quick_check,'ok');assert.deepEqual(query('SELECT submissions_enabled,version FROM submission_settings WHERE id=1')[0].results,[{submissions_enabled:0,version:16}]);
 run(['d1','migrations','apply','rc-local-only']);assert.deepEqual(query('SELECT name FROM d1_migrations ORDER BY id')[0].results.map(r=>r.name),names);
 }finally{upstream.mock.restore();h.close();}
});
