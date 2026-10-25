// Pure controller/reporting. No cloud provisioning, credentials, or network default.
export const ARCHIVE_PATH='/api/internal/drive-backup/storage/archive';
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const handoffPattern=new RegExp('^'+uuid+'\\.'+uuid+'$');
export function samplePlan(repetitions=5){
  if(!Number.isInteger(repetitions)||repetitions<1||repetitions>5)throw Error('BOUNDED_REPETITIONS_REQUIRED');
  return [1,3,5].flatMap(mib=>Array.from({length:repetitions},(_,i)=>({label:`${mib}m-${i+1}`,mib,
    A:`arc-${mib}m-${i+1}-A`,B:`arc-${mib}m-${i+1}-B`}))); // <= 30 CPU requests + 15 relay subrequests
}
export async function runPair(post,journal,sample){
  // Adapter must persist the journal BEFORE HTTP. Any ambiguous response holds
  // this controller; NEVER replay A/B automatically or send the legacy {} body.
  if(await journal.read())return{state:'operator_hold',requests:0};
  const run=async(phase,body)=>{
    await journal.write({phase,sample:sample[phase],label:sample.label});
    return post(body,sample[phase]);
  };
  try{
    const a=await run('A',{canary:true}),v=a?.body?.data?.cleanup;
    if(a.status!==200||!a.body.ok||v?.state!=='verification_ready'||v.phase!=='verify'||v.mode!=='live'||
       v.retention_days!==7||v.deleted!==0||!handoffPattern.test(v.handoff??'')||v.file_id!==v.handoff.split('.')[0])
      return{state:'operator_hold',requests:1};
    const b=await run('B',{canary:true,handoff:v.handoff}),w=b?.body?.data?.cleanup;
    if(b.status!==200||!b.body.ok||w?.state!=='cold'||w.file_id!==v.file_id||w.phase!=='delete'||w.deleted!==1||w.retention_days!==7||w.mode!=='live')
      return{state:'operator_hold',requests:2};
    await journal.clear();return{state:'complete',requests:2};
  }catch{return{state:'operator_hold',requests:null};}
}
const quantile=(v,p)=>v.length?v[Math.max(0,Math.ceil(p*v.length)-1)]:null;
// Only pre-sanitized native tail invocation events are accepted. CPU is NEVER
// inferred from client wall time, custom console logs, or Node process CPU.
export function cpuReport(requests,events){
  const unique=new Set(requests.map(r=>r.sample));
  if(unique.size!==requests.length||requests.some(r=>!/^arc-[135]m-[1-5]-[AB]$/.test(r.sample)||!['A','B'].includes(r.phase)||r.sample.at(-1)!==r.phase||![1,3,5].includes(r.mib)||!r.sample.startsWith('arc-'+r.mib+'m-')||r.path!==ARCHIVE_PATH||typeof r.success!=='boolean'))throw Error('INVALID_REQUEST_LEDGER');
  const groups=[];let rejected=0;
  const accepted=events.filter(e=>{
    const ok=e.source==='cloudflare-native-tail'&&unique.has(e.sample)&&e.path===ARCHIVE_PATH&&e.method==='POST'&&
      Number.isFinite(e.cpuTime)&&e.cpuTime>=0&&Number.isFinite(e.wallTime)&&e.wallTime>=0;
    if(!ok)rejected++;return ok;
  });
  for(const mib of [1,3,5])for(const phase of ['A','B']){
    const req=requests.filter(r=>r.phase===phase&&r.mib===mib),cpu=[],wall=[];let missing=0,conflicts=0,failed=0;
    for(const r of req){
      const traces=accepted.filter(e=>e.sample===r.sample);
      if(!traces.length){missing++;if(!r.success)failed++;continue;}
      if(new Set(traces.map(e=>JSON.stringify([e.cpuTime,e.wallTime,e.outcome,e.status]))).size>1)conflicts++;
      cpu.push(Math.max(...traces.map(e=>e.cpuTime)));wall.push(Math.max(...traces.map(e=>e.wallTime)));
      if(!r.success||traces.some(e=>e.outcome!=='ok'||e.status!==200))failed++;
    }
    cpu.sort((a,b)=>a-b);wall.sort((a,b)=>a-b);
    const exceeded=cpu.filter(n=>n>10).length,eventsFor=accepted.filter(e=>req.some(r=>r.sample===e.sample));
    const nativeCpuErrors=eventsFor.filter(e=>e.outcome==='exceededCpu').length;
    const http1102=req.filter(r=>r.http1102===true).length;
    const fail=exceeded||failed||nativeCpuErrors||http1102;
    groups.push({mib,phase,expected:req.length,valid:cpu.length,missing,conflicts,
      p50:quantile(cpu,.5),p95:quantile(cpu,.95),p99:quantile(cpu,.99),max:cpu.at(-1)??null,
      wall_p50:quantile(wall,.5),wall_max:wall.at(-1)??null,above_10ms:exceeded,
      successes:req.length-failed,failures:failed,exceededCpu:nativeCpuErrors,http1102,
      readiness:fail?'FAIL':!req.length||missing||conflicts?'UNKNOWN':'PASS'});
  }
  return{method:'native invocation CPU; no local/wall substitution',groups,rejected,
    readiness:groups.some(g=>g.readiness==='FAIL')?'FAIL':groups.every(g=>g.readiness==='PASS')?'PASS':'UNKNOWN',
    memory_peak_bytes:null,memory_limit_events:accepted.length?accepted.filter(e=>e.outcome==='exceededMemory').length:null,d1_rows_read:null,d1_rows_written:null,r2_operations:null};
}
export function nativeTrace(event){
  // Official tail event envelope. Strip headers, request body, logs and secrets.
  const r=event.event?.request,headers=r?.headers??{};
  const sample=Object.entries(headers).find(([k])=>k.toLowerCase()==='x-isolated-sample')?.[1];
  if(!/^arc-[135]m-[1-5]-[AB]$/.test(sample??''))return null;
  let path;try{path=new URL(r?.url).pathname;}catch{return null;}
  return{source:'cloudflare-native-tail',sample,path,method:r.method,cpuTime:event.cpuTime,wallTime:event.wallTime,
    outcome:event.outcome,status:event.event?.response?.status};
}
