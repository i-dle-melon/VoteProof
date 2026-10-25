// Disposable LOCAL fixture attestation only, never import from runtime code.
import {changeArchiveControl} from '../../src/lib/archive-fencing.js';
export const localWriterEvidence=()=>({sha256:'a'.repeat(64),verified_until:Math.floor(Date.now()/1000)+600,
  checks:{bindings:true,s3_credentials:true,multipart:true,presigned:true,inflight_puts:true,external_tools:true,other_workers:true}});
export async function activateLocalArchive(db){
  const c=await db.prepare('SELECT epoch,mode FROM storage_archive_control WHERE id=1').first();
  if(c.mode==='paused'&&c.epoch===1)await changeArchiveControl(db,{action:'resume',expected_epoch:c.epoch,confirmed:true,writer_evidence:localWriterEvidence()});
}
export function interceptBatch(db,prefix,{after=false}={}){
  let fired=false;const raw=new WeakMap(),sqls=new WeakMap();
  const wrap=(s,sql)=>{const w={bind(...args){return wrap(s.bind(...args),sql);},first:(...a)=>s.first(...a),all:(...a)=>s.all(...a),run:(...a)=>s.run(...a)};raw.set(w,s);sqls.set(w,sql);return w;};
  return{prepare:sql=>wrap(db.prepare(sql),sql),async batch(statements){
    const match=!fired&&statements.some(s=>sqls.get(s)?.startsWith(prefix));
    if(match){fired=true;if(!after)throw Error('LOCAL_BATCH_FAILED');}
    const value=await db.batch(statements.map(s=>raw.get(s)??s));if(match)throw Error('LOCAL_COMMITTED_ACK_LOST');return value;
  }};
}
