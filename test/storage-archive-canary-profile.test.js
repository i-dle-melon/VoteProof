import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {archiveCanaryRuntime} from './helpers/archive-canary-runtime.mjs';
for(const mib of [1,3,5])test(`bounded LOCAL operation profile ${mib} MiB, not Cloudflare CPU`,async()=>{
  const h=await archiveCanaryRuntime({profile:true});
  try{
    await h.seed('profile-'+mib,mib);const observations=[];
    for(const phase of ['A','B']){
      const before={...h.state},start=performance.now();
      const r=await h.post(phase==='A'?{canary:true}:{canary:true,handoff:observations[0].handoff});
      const elapsed=performance.now()-start;assert.equal(r.status,200);const result=r.body.data.cleanup;
      assert.equal(result.state,phase==='A'?'verification_ready':'cold');assert.equal(r.metrics.r2.delete,phase==='A'?0:1);
      observations.push({phase,state:result.state,handoff:result.handoff,metrics:r.metrics,local_wall_ms:elapsed,
        google_mock:{relay:h.state.relay-before.relay,metadata:h.state.metadata-before.metadata,permissions:h.state.permissions-before.permissions,media:h.state.media-before.media}});
    }
    console.log(JSON.stringify({local_archive_profile:true,mib,observations:observations.map(({handoff,...safe})=>safe),cloudflare_cpu:{p50:null,p95:null,p99:null,max:null,readiness:'UNKNOWN',reason:'No cloud deployment authorized'},memory_peak:'UNKNOWN'}));
  }finally{await h.close();}
});
