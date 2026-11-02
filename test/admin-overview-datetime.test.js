import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {installResetExtensionLocal} from '../scripts/lib/prelaunch-selective-reset.mjs';
import {adminPath,MemberSession} from '../public/js/member-api.js';

let h,admin,reviewer,member,expired;
const stats=[];
const path='/api/admin/overview';
const precise=(from_at,to_at)=>path+'?'+new URLSearchParams({from_at,to_at});
const request=(url,actor=admin)=>h.fetch(url,'GET',undefined,actor?.headers);
const body=async url=>{const r=await request(url);assert.equal(r.status,200,await r.clone().text());return(await r.json()).data;};
const changes=()=>h.sqlite.prepare('SELECT total_changes() n').get().n;
before(async()=>{
  h=await embeddedCaseRuntime();admin=await h.identity('admin');reviewer=await h.identity('reviewer');member=await h.identity();expired=await h.identity('admin');
  await h.db.prepare('UPDATE auth_sessions SET elevated_until=0 WHERE member_id=?').bind(expired.memberId).run();
  await h.db.prepare('UPDATE submission_settings SET submissions_enabled=1 WHERE id=1').run();
  await h.db.prepare("INSERT INTO campaigns(campaign_id,name,category,start_at,end_at,campaign_timezone,vote_start_date,vote_end_date,points_per_proof,status,created_at,updated_at) VALUES('OVERVIEW','Date fixture','團體','2000-01-01','2100-01-01','Asia/Taipei','2000-01-01','2099-12-31',1,'active',?,?)")
    .bind(new Date().toISOString(),new Date().toISOString()).run();
  const rows=[
    ['2026-11-01T14:59:59.999Z','pending'],
    ['2026-11-01T15:00:00.000Z','pending'],
    ['2026-11-01T15:00:59.999Z','approved'],
    ['2026-11-01T15:01:00.000Z','completed'],
    ['2026-11-02T14:59:59.999Z','rejected'],
    ['2026-11-02T15:00:00.000Z','duplicate'],
    ['2026-11-01T20:00:00.000Z','duplicate'],
    ['2026-11-01T17:00:00.000Z','revoked'],
    ['2026-10-31T15:00:00.000Z','pending'],
    ['2026-12-31T15:00:00.000Z','pending'],
    ['2027-01-01T15:00:00.000Z','rejected'],
  ];
  let canonical=null;
  for(const[created,status]of rows){
    const id=randomUUID();
    await h.db.prepare('INSERT INTO completed_uploads(session_id,manifest_hash,completed_at) VALUES(?,?,?)').bind(id,'a'.repeat(64),created).run();
    await h.db.prepare(`INSERT INTO cases(id,case_id,created_at,updated_at,nickname,player_id,campaign_id,vote_type,vote_date,query_key_hash,status,upload_session_id,reviewed_at,duplicate_flag,duplicate_of_case_id)
      VALUES(?,?,?,?,?,?,?,'團體','2026-11-01',?,?,?,?,?,?)`)
      .bind(id,'VP-20261101-'+id.replaceAll('-','').slice(0,16).toUpperCase(),created,created,'Date fixture','fan_fixture','OVERVIEW',
        'b'.repeat(64),status,id,status==='pending'?null:'2030-01-01T00:00:00.000Z',status==='duplicate'?1:0,status==='duplicate'?canonical:null).run();
    if(status==='approved')canonical=id;
  }
  installResetExtensionLocal(h.sqlite,fs.readFileSync('migrations-reset-v1/0001_reset_fence.sql','utf8'));
  h.sqlite.exec("UPDATE prelaunch_reset_control SET epoch=1,mode='open'");h.env.PRELAUNCH_RESET_FENCE_ENABLED='true';
  const db=h.env.DB;
  h.env.DB={...db,prepare(sql){const s=db.prepare(sql);if(!sql.includes('COUNT(*) AS member_count')&&!sql.includes('SELECT status,COUNT(*) AS count FROM cases'))return s;
    return{...s,bind(...values){stats.push({sql,values});return s.bind(...values);}};
  }};
});
after(()=>h?.close());

test('Taipei 23:00 to 23:00 includes start and excludes end; totals use creation time',async()=>{
  stats.length=0;const n=changes();
  const d=await body(precise('2026-11-01T23:00+08:00','2026-11-02T23:00+08:00'));
  assert.equal(d.member_count,null);
  assert.deepEqual(d.case_counts,{pending:1,approved:1,completed:1,rejected:1,duplicate:1,revoked:1});
  assert.deepEqual(d.case_totals,{pending:1,approved:2,rejected:2,revoked:1});
  assert.deepEqual(stats.map(x=>x.values),[['2026-11-01T15:00:00.000Z','2026-11-02T15:00:00.000Z']]);
  assert.match(stats[0].sql,/created_at>=\? AND created_at<\?/);assert.doesNotMatch(stats[0].sql,/reviewed_at|status_updated_at/);
  assert.equal(changes(),n);assert.equal((await h.db.prepare('SELECT COUNT(*) n FROM prelaunch_reset_operations').first()).n,0);
});

test('minute precision and explicit UTC or mixed offset representations select the same instants',async()=>{
  const url=precise('2026-11-01T23:00+08:00','2026-11-01T23:01+08:00');
  const expected=await body(url);assert.deepEqual(expected.case_totals,{pending:1,approved:1,rejected:0,revoked:0});
  assert.deepEqual(await body(precise('2026-11-01T15:00:00.000Z','2026-11-01T15:01:00.000Z')),expected);
  assert.deepEqual(await body(precise('2026-11-01T16:00+01:00','2026-11-01T23:01+08:00')),expected);
});

test('millisecond boundaries retain end exclusivity',async()=>{
  const d=await body(precise('2026-11-01T15:00:59.999Z','2026-11-01T15:01:00.000Z'));
  assert.deepEqual(d.case_totals,{pending:0,approved:1,rejected:0,revoked:0});
});

test('month and year rollover ranges are normalized before querying',async()=>{
  assert.deepEqual((await body(precise('2026-10-31T23:00+08:00','2026-11-01T23:00+08:00'))).case_totals,{pending:2,approved:0,rejected:0,revoked:0});
  assert.deepEqual((await body(precise('2026-12-31T23:00+08:00','2027-01-01T23:00+08:00'))).case_totals,{pending:1,approved:0,rejected:0,revoked:0});
  assert.equal((await request(precise('2028-02-29T23:00+08:00','2028-03-01T23:00+08:00'))).status,200);
});

test('legacy date range remains inclusive of the final Taipei calendar day',async()=>{
  const legacy=await body(path+'?from=2026-11-02&to=2026-11-02');
  assert.deepEqual(legacy.case_totals,{pending:0,approved:0,rejected:3,revoked:1});
  assert.deepEqual(legacy,await body(precise('2026-11-02T00:00+08:00','2026-11-03T00:00+08:00')));
});

test('unfiltered overview and member totals remain unchanged after range queries',async()=>{
  const expected=await body(path);assert.equal(expected.member_count,4);
  assert.deepEqual(expected.case_totals,{pending:4,approved:2,rejected:4,revoked:1});
  await body(precise('2026-11-01T23:00+08:00','2026-11-02T23:00+08:00'));
  assert.deepEqual(await body(path),expected);
});

for(const [name,from,to]of[
  ['equal','2026-11-01T23:00+08:00','2026-11-01T23:00+08:00'],
  ['equal instants with different offsets','2026-11-01T23:00+08:00','2026-11-01T15:00Z'],
  ['reversed','2026-11-02T23:00+08:00','2026-11-01T23:00+08:00'],
  ['reversed across offsets','2026-11-01T23:00+07:00','2026-11-01T23:00+08:00'],
  ['missing timezone','2026-11-01T23:00','2026-11-02T23:00+08:00'],
  ['unknown offset','2026-11-01T15:00-00:00','2026-11-02T15:00Z'],
  ['invalid calendar date','2026-11-31T23:00+08:00','2026-12-02T23:00+08:00'],
  ['non-leap day','2026-02-29T23:00+08:00','2026-03-02T23:00+08:00'],
  ['hour 24','2026-11-01T24:00+08:00','2026-11-02T23:00+08:00'],
  ['minute 60','2026-11-01T23:60+08:00','2026-11-02T23:00+08:00'],
  ['invalid offset','2026-11-01T23:00+24:00','2026-11-02T23:00+08:00'],
  ['UTC year underflow','0000-01-01T00:00+08:00','2026-11-02T23:00+08:00'],
  ['UTC year overflow','2026-11-01T23:00+08:00','9999-12-31T23:00-08:00'],
  ['SQL text',"2026-11-01T23:00+08:00' OR 1=1 --",'2026-11-02T23:00+08:00'],
  ['empty','', '2026-11-02T23:00+08:00'],
])test('invalid precise range rejects '+name+' before statistics SQL',async()=>{
  stats.length=0;const n=changes(),r=await request(precise(from,to));assert.equal(r.status,400);
  assert.equal((await r.json()).error.code,'INVALID_ADMIN_QUERY');assert.deepEqual(stats,[]);assert.equal(changes(),n);
});

test('missing, duplicate, unknown or mixed parameters are rejected without statistics SQL',async()=>{
  const from='2026-11-01T15:00Z',to='2026-11-02T15:00Z';
  const queries=[new URLSearchParams({from_at:from}),new URLSearchParams({to_at:to}),
    new URLSearchParams([['from_at',from],['from_at',from],['to_at',to]]),
    new URLSearchParams([['from_at',from],['to_at',to],['to_at',to]]),
    new URLSearchParams({from_at:from,to_at:to,from:'2026-11-01',to:'2026-11-02'}),
    new URLSearchParams({from_at:from,to:'2026-11-02'}),new URLSearchParams({from_at:from,to_at:to,extra:'1'}),
    new URLSearchParams({from:'2026-11-02'}),new URLSearchParams({from:'2026-11-31',to:'2026-11-31'}),
    new URLSearchParams([['from','2026-11-01'],['from','2026-11-01'],['to','2026-11-02']])];
  const n=changes();for(const q of queries){stats.length=0;assert.equal((await request(path+'?'+q)).status,400);assert.deepEqual(stats,[]);}assert.equal(changes(),n);
});

test('precise query retains admin RBAC and MFA checks',async()=>{
  const url=precise('2026-11-01T23:00+08:00','2026-11-02T23:00+08:00');
  assert.equal((await request(url,reviewer)).status,200);
  for(const[actor,status]of[[null,401],[member,403],[expired,403]])assert.equal((await request(url,actor)).status,status);
});

test('frontend allowlist permits exact date or datetime pairs without widening other admin queries',async()=>{
  const query=new URLSearchParams({from_at:'2026-11-01T15:00:00.000Z',to_at:'2026-11-02T15:00:00.000Z'}),url=path+'?'+query;
  for(const input of[path,path+'?from=2026-11-01&to=2026-11-02',url])assert.equal(adminPath(input),true,input);
  for(const suffix of['&from=2026-11-01','&to=2026-11-02','&from_at=2026-11-01T15%3A00Z','&to_at=2026-11-02T15%3A00Z','&token=x','&extra=1'])assert.equal(adminPath(url+suffix),false,suffix);
  for(const input of[path+'?from_at=2026-11-01T15%3A00Z',path+'?to_at=2026-11-02T15%3A00Z','https://example.com'+url,'/api/admin/health-monitor/summary?'+query])assert.equal(adminPath(input),false,input);
  const sent=[],session=new MemberSession({fetcher:async(p,o)=>{sent.push({path:p,method:o.method,credentials:o.credentials});return Response.json({ok:true,data:{}});}});
  session.accept({member:{member_id:'M-'+randomUUID(),status:'active'},csrf_token:'c'.repeat(64),expires_in:600});
  try{await session.adminRequest(url);assert.deepEqual(sent,[{path:url,method:'GET',credentials:'same-origin'}]);}
  finally{session.clear();}
});
