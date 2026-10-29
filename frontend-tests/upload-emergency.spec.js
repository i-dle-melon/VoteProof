import {test,expect} from '@playwright/test';

// Browser-native XHR/ESM, synthetic payloads, local server only.
async function run(page,scenario){
 let puts=0;const errors=[];page.on('pageerror',e=>errors.push(e.name));
 await page.route('**/api/uploads/put/**',async route=>{
  puts++;
  if(scenario==='unknown'){await route.abort();return;}
  if(scenario==='d1'||puts===1){await route.fulfill({status:scenario==='d1'?502:403,contentType:'application/json',headers:{'X-VoteProof-Upload-Stage':scenario==='d1'?'capacity_admission':'grant','X-VoteProof-Put-State':'not_started','X-VoteProof-Grant-Reason':'expired'},body:JSON.stringify({ok:false,error:{code:scenario==='d1'?'R2_UPLOAD_ERROR':'UPLOAD_GRANT_INVALID',message:'private diagnostics must never be displayed'}})});return;}
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({ok:true,data:{uploaded:true}})});
 });
 await page.goto('/js/api.js');
 const result=await page.evaluate(async scenario=>{
  const {Submission}=await import('/js/submission.js'),{putImage,PublicError}=await import('/js/api.js');let prepares=0,cases=0,clock=Date.now();const posts=[];
  const api=async(path,options)=>{
   if(path.endsWith('/prepare')){prepares++;const s=crypto.randomUUID(),p=crypto.randomUUID();return{completion_mode:'direct',session_id:s,expires_in:300,uploads:[{key:`proofs/final/g1/${s}/${p}.png`,method:'PUT',upload_url:location.origin+`/api/uploads/put/${s}/${p}`,headers:{'Content-Type':'image/png','X-Upload-Grant':'A'.repeat(64)}}]};}
   cases++;posts.push({body:options.body,key:options.headers['Idempotency-Key']});if(scenario==='unknown'&&cases===1)throw new PublicError('UPLOAD_INCOMPLETE',400);
   return{case_id:'VP-20261030-'+'A'.repeat(16),query_key:'A'.repeat(43)};
  };
  const flow=new Submission({api,put:putImage,token:async()=>'synthetic',directIntent:true,now:()=>clock});flow.start({campaign_id:'LOCAL-TEST',vote_date:'2026-10-30'},[new File([new Uint8Array([1,2,3])],'synthetic.png',{type:'image/png'})]);
  let first;try{await flow.attempt();}catch(e){first={code:e.code,stage:e.uploadStage,putState:e.putState,reason:e.grantReason,leak:e.message.includes('private')};}
  const firstCases=cases;clock+=301000;let second;try{await flow.attempt();second='success';}catch(e){second=e.code;}
  return{first,firstCases,second,prepares,cases,stable:posts.length<2||posts[0].body===posts[1].body&&posts[0].key===posts[1].key};
 },scenario);
 return{result,puts,errors};
}
test('expired Grant 403 preserves its code, skips Case and safely renews authorization',async({page})=>{
 const {result:r,puts,errors}=await run(page,'expired');expect(r.first).toEqual({code:'UPLOAD_GRANT_INVALID',stage:'grant',putState:'not_started',reason:'expired',leak:false});
 expect(r.firstCases).toBe(0);expect(r.second).toBe('success');expect(r.prepares).toBe(2);expect(r.cases).toBe(1);expect(puts).toBe(2);expect(errors).toEqual([]);
});
test('lost PUT response + missing proof retries only Case verification, with immutable body/key',async({page})=>{
 const {result:r,puts,errors}=await run(page,'unknown');expect(r.first.code).toBe('UPLOAD_INCOMPLETE');expect(r.second).toBe('success');expect(r.prepares).toBe(1);expect(r.cases).toBe(2);expect(r.stable).toBe(true);expect(puts).toBe(1);expect(errors).toEqual([]);
});
test('D1 rejection with unknown commit stops without speculative Case or a second PUT',async({page})=>{
 const {result:r,puts,errors}=await run(page,'d1');expect(r.first).toMatchObject({code:'R2_UPLOAD_ERROR',stage:'capacity_admission',putState:'not_started',leak:false});expect(r.second).toBe('PUT_RESULT_UNCONFIRMED');expect(r.prepares).toBe(1);expect(r.cases).toBe(0);expect(puts).toBe(1);expect(errors).toEqual([]);
});
