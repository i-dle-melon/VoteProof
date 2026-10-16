import test from 'node:test';
import assert from 'node:assert/strict';
import { bestPublicRank, boardCategory } from '../public/js/leaderboard-ui.js';
import { localCalendarDate, defaultVoteDate, setDefaultVoteDate } from '../public/js/vote-date.js';
import { boardInput } from '../src/lib/leaderboard-policy.js';
import { definition } from '../scripts/lib/local-leaderboard-runtime.mjs';
import {MemberSession,adminPath} from '../public/js/member-api.js';
test('best public numeric rank is invariant to board order; hidden/inactive/invalid ranks excluded',()=>{
 const rows=[8,2,5].map(rank=>({rankings:[{member_id:'fan',rank}]}));
 for(const boards of [rows,[...rows].reverse(),[rows[1],rows[2],rows[0]]])assert.equal(bestPublicRank(boards,'fan'),2);
 assert.equal(bestPublicRank([...rows,{is_public:false,rankings:[{member_id:'fan',rank:1}]},{status:'archived',rankings:[{member_id:'fan',rank:1}]}],'fan'),2);
 for(const rank of [0,-1,1.5,'1',NaN])assert.equal(bestPublicRank([{rankings:[{member_id:'fan',rank}]}],'fan'),null);
 assert.equal(bestPublicRank(rows,'other'),null);assert.equal(bestPublicRank(rows,null),null);
});
test('only explicitly selected campaign occupies comeback; named/custom boards stay independent',()=>{
 assert.equal(boardCategory({type:'campaign',leaderboard_id:'old'}),'named:old');
 assert.equal(boardCategory({type:'campaign',leaderboard_id:'new',is_current_comeback:true}),'comeback');
 assert.equal(boardCategory({type:'custom',leaderboard_id:'extra'}),'custom:extra');
 assert.equal(boardCategory({type:'all_time',vote_type:'Solo'}),'solo');
});
test('local date uses calendar getters rather than UTC, clamps legal bounds and preserves edits',()=>{
 const local={getFullYear:()=>2026,getMonth:()=>9,getDate:()=>16,toISOString:()=>{throw Error('UTC prohibited');}};
 assert.equal(localCalendarDate(local),'2026-10-16');
 assert.equal(defaultVoteDate('2026-10-16','2026-10-17','2026-10-20'),'2026-10-17');
 assert.equal(defaultVoteDate('2026-10-16','2026-10-01','2026-10-15'),'2026-10-15');
 const input={value:'2026-10-12'};setDefaultVoteDate(input,{min:'2026-10-01',max:'2026-10-20'},true,local);assert.equal(input.value,'2026-10-12');
 setDefaultVoteDate(input,{min:'2026-10-17',max:'2026-10-20'},false,local);assert.equal(input.value,'2026-10-17');
});
test('board IDs are generated collision-safely when omitted; explicit legacy IDs remain supported',()=>{
 const body=definition();delete body.leaderboard_id;
 const ids=new Set(Array.from({length:100},()=>boardInput(body).leaderboard_id));assert.equal(ids.size,100);
 for(const id of ids)assert.match(id,/^board-[0-9a-f-]{36}$/);
 assert.equal(boardInput(definition({leaderboard_id:'LEGACY_2026'})).leaderboard_id,'LEGACY_2026');
});
test('current comeback API validation rejects custom, archived and non-boolean flags',()=>{
 for(const extra of [{is_current_comeback:true},{type:'campaign',campaign_id:'C',start_date:null,end_date:null,status:'archived',is_current_comeback:true},{is_current_comeback:1}])assert.throws(()=>boardInput(definition(extra)));
 assert.equal(boardInput(definition()).is_current_comeback,false);
});
test('Campaign example upload sends actual binary with session/CSRF; paths stay allowlisted',async()=>{
 const file=new Blob([new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0])],{type:'image/png'});let sent;
 const session=new MemberSession({fetcher:async(path,options)=>{sent={path,options};return Response.json({ok:true,data:{asset_id:'00000000-0000-4000-8000-000000000001'}});}});
 session.accept({member:{member_id:'fixture',nickname:'Fan',player_id:'fixture_fan',status:'active'},csrf_token:'a'.repeat(64)});
 await session.adminAssetUpload('C_2026',file);assert.equal(sent.path,'/api/admin/campaign-assets/C_2026');assert.equal(sent.options.body,file);assert.equal(sent.options.credentials,'same-origin');assert.equal(sent.options.headers['Content-Type'],'image/png');assert.equal(sent.options.headers['X-CSRF-Token'],'a'.repeat(64));
 for(const path of ['/api/admin/announcements','/api/admin/campaigns/C_2026/guidance','/api/admin/staff'])assert.equal(adminPath(path),true);
 for(const path of ['/api/admin/announcements?key=x','/api/admin/campaign-assets/../proof','https://example.com/api/admin/staff'])assert.equal(adminPath(path),false);
 await assert.rejects(session.adminAssetUpload('../proof',file));await assert.rejects(session.adminAssetUpload('C_2026',new Blob(['<svg/>'],{type:'image/svg+xml'})));session.clear();
});
