import WebSocket from 'ws';
import {spawn} from 'node:child_process';

// JSON framing used by the original CLI collector, retained for comparison.
export function jsonFrames(onValue,onError=()=>{}) {
  let depth=0,quoted=false,escaped=false,buffer='';
  return chunk=>{for(const ch of chunk){
    if(!depth){if(ch!=='{')continue;depth=1;buffer='{';continue;}
    buffer+=ch;
    if(quoted){if(escaped)escaped=false;else if(ch==='\\')escaped=true;else if(ch==='"')quoted=false;}
    else if(ch==='"')quoted=true;else if(ch==='{')depth++;
    else if(ch==='}'&&!--depth){try{onValue(JSON.parse(buffer));}catch{onError();}buffer='';}
  }};
}
export function sampleOf(event) {
  const headers=event.event?.request?.headers??{};
  const header=Object.entries(headers).find(([k])=>k.toLowerCase()==='x-isolated-sample')?.[1];
  let log;
  for(const row of event.logs??[])for(const value of row.message??[]){
    try{const data=typeof value==='string'?JSON.parse(value):value;if(data?.sample)log=data.sample;}catch{}
  }
  return {sample:header??log,source:header?'header':log?'log':null,header,log};
}
export function traceAccounting() {
  const events=[],diagnostics={messages:0,invocations:0,matched:0,unmatched:0,missing_cpu:0,
    parse_errors:0,errors:0,closes:[],sampling_messages:[],header_log_mismatches:0,non_invocation_shapes:{}};
  return{events,diagnostics,accept(v){
    diagnostics.messages++;
    if(!v.event?.request){
      const shape=Object.keys(v).sort().join(',');diagnostics.non_invocation_shapes[shape]=(diagnostics.non_invocation_shapes[shape]??0)+1;
      // Keep only public diagnostic text/fields. Never save request headers/URL.
      const text=String(v.message??v.type??'');
      if(/sampl|drop|limit|truncat/i.test(text))diagnostics.sampling_messages.push(text.slice(0,240));
      return;
    }
    diagnostics.invocations++;const found=sampleOf(v);
    if(!found.sample?.startsWith('inv-')){diagnostics.unmatched++;return;}
    diagnostics.matched++;if(!Number.isFinite(v.cpuTime))diagnostics.missing_cpu++;
    if(found.header&&found.log&&found.header!==found.log)diagnostics.header_log_mismatches++;
    events.push({sample:found.sample,source:found.source,event_timestamp:v.eventTimestamp??null,cpu_ms:Number.isFinite(v.cpuTime)?v.cpuTime:null,
      wall_ms:v.wallTime??null,outcome:v.outcome,status:v.event?.response?.status??null,
      exception_count:v.exceptions?.length??0,sampling_rate:v.samplingRate??null});
  }};
}

// Reconcile by invocation sample, never by arrival order. Either collector may
// retain a native CPU trace lost by the other; a gap in both remains UNKNOWN.
export function reconcileInventoryTraces(requests,direct,cli) {
  const rows=[],missing_ids=[],conflicts=[];
  for(const request of requests){
    const a=direct.filter(x=>x.sample===request.sample&&Number.isFinite(x.cpu_ms));
    const b=cli.filter(x=>x.sample===request.sample&&Number.isFinite(x.cpu_ms));
    const all=[...a,...b];
    if(!all.length){missing_ids.push(request.sample);continue;}
    if(new Set(all.map(x=>x.cpu_ms)).size>1)conflicts.push(request.sample);
    // Retain the largest observed value on disagreement, plus a conflict flag;
    // this must never hide an observed CPU-limit violation behind a lower value.
    const trace=all.reduce((x,y)=>x.cpu_ms>=y.cpu_ms?x:y);
    rows.push({...trace,collectors:[...(a.length?['direct']:[]),...(b.length?['cli']:[])]});
  }
  return{rows,missing_ids,conflicts};
}

export async function observeInventory({api,base,name,run,config,env}) {
  const direct=traceAccounting(),cli=traceAccounting();
  const record=await api(base+'/workers/scripts/'+name+'/tails','POST',{
    filters:[{header:{key:'x-inventory-run',query:run}}]});
  const socket=new WebSocket(record.url,'trace-v1');
  socket.on('message',data=>{try{direct.accept(JSON.parse(data.toString()));}catch{direct.diagnostics.parse_errors++;}});
  socket.on('error',()=>direct.diagnostics.errors++);
  socket.on('close',(code)=>direct.diagnostics.closes.push(code));
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('TAIL_OPEN_TIMEOUT')),15000);
    socket.once('open',()=>{clearTimeout(timer);socket.send('{"debug":false}');resolve();});
    socket.once('error',()=>{clearTimeout(timer);reject(Error('TAIL_OPEN_ERROR'));});
  });
  const child=spawn(process.execPath,['node_modules/wrangler/bin/wrangler.js','tail',name,
    '--config',config,'--format','json','--header','x-inventory-run:'+run],
    {env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const frame=jsonFrames(v=>cli.accept(v),()=>cli.diagnostics.parse_errors++);
  child.stdout.setEncoding('utf8');child.stdout.on('data',frame);
  child.stderr.on('data',s=>{if(/error|disconnect|reconnect/i.test(String(s)))cli.diagnostics.errors++;});
  child.on('exit',(code,signal)=>cli.diagnostics.closes.push({code,signal}));
  return{direct,cli,async stop(){
    socket.close();child.kill();
    await api(base+'/workers/scripts/'+name+'/tails/'+record.id,'DELETE');
  }};
}
