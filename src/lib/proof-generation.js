// The epoch is supplied only by the D1-backed request fence. Never take it
// from request JSON, a query parameter, a grant claim or an R2 object.
export function proofGeneration(env){
 if(env.PRELAUNCH_RESET_FENCE_ENABLED!=='true')return null;
 const epoch=env.PRELAUNCH_RESET_CONTEXT?.epoch;
 if(!Number.isSafeInteger(epoch)||epoch<0)throw Error('TRUSTED_PROOF_GENERATION_REQUIRED');
 return epoch;
}
export function proofKey(env,kind,suffix){
 if(!['staging','final','cases'].includes(kind))throw Error('INVALID_PROOF_KEY_KIND');
 const epoch=proofGeneration(env);return `proofs/${kind}/${epoch===null?'':`g${epoch}/`}${suffix}`;
}
export function proofKeyEpoch(key){
 const match=/^proofs\/(?:staging|final|cases)\/g(0|[1-9]\d{0,15})\//.exec(key);
 if(!match)return null;const n=Number(match[1]);return Number.isSafeInteger(n)?n:null;
}
export function currentProofKey(env,key){
 const epoch=proofGeneration(env);return epoch===null||proofKeyEpoch(key)===epoch;
}
