import test from 'node:test';
import assert from 'node:assert/strict';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {changeArchiveControl} from '../src/lib/archive-fencing.js';
import {ELEVATED_AUTH_GUARD,actorBindings} from '../src/lib/admin-identity.js';
import {localWriterEvidence} from './helpers/archive-fence-fixture.mjs';
import {adminPath} from '../public/js/member-api.js';
import {createHash,randomBytes} from 'node:crypto';
test('control API enforces super admin, MFA, CSRF, origin and atomic session revocation',async()=>{
  const h=await localAdminRuntime({submissionsEnabled:false});try{
    const env={...h.local.authConfig,DB:h.local.db,PROOFS_BUCKET:h.local.bucket,R2_EXCLUSIVE_WRITER_CONFIRMED:'true'};
    const path='/api/admin/storage/archive-control';
    const call=(actor,method='GET',body,extra={})=>h.local.fetch(path,method,body,{...actor?.headers,'Content-Type':'application/json','X-VoteProof-Request':'1',...extra});
    assert.equal(adminPath(path),true);assert.equal(adminPath(path+'?token=forged'),false);
    for(const role of [undefined,'reviewer','admin'])assert.equal((await call(await h.identity({role}))).status,403);
    const expiredMfa=await h.identity({role:'super_admin',elevated:false});assert.equal((await call(expiredMfa)).status,403);
    const owner=await h.identity({role:'super_admin'}),body={action:'pause',expected_epoch:1,confirmed:true};
    assert.equal((await call(owner)).status,200);
    assert.equal((await call(owner,'POST',body,{'X-CSRF-Token':'wrong'})).status,403);
    assert.equal((await call(owner,'POST',body,{Origin:'https://wrong.invalid'})).status,403);
    const paused=await call(owner,'POST',body);assert.equal(paused.status,200);assert.equal((await paused.json()).data.drained,true);
    const revokeDb={prepare:sql=>h.local.db.prepare(sql),batch:async statements=>{
      await h.local.db.prepare('UPDATE auth_sessions SET revoked_at=? WHERE token_hash=?').bind(Math.floor(Date.now()/1000),owner.hash).run();return h.local.db.batch(statements);
    }};
    const actor={member:{member_id:owner.memberId,tokenHash:owner.hash},role:'super_admin'};
    await assert.rejects(changeArchiveControl(revokeDb,{...body,expected_epoch:2},[{sql:ELEVATED_AUTH_GUARD,args:actorBindings(actor)}]));
    assert.equal(await h.local.db.prepare('SELECT epoch FROM storage_archive_control').first('epoch'),2);
    assert.equal(await h.local.db.prepare("SELECT count(*) n FROM storage_audit WHERE action='archive_control_pause'").first('n'),1);
  }finally{await h.local.runtime.dispose();}
});
test('legacy upload retry is create-only and remains recoverable without double capacity accounting',async()=>{
  const h=await localAdminRuntime({submissionsEnabled:true});try{
    const bytes=new Uint8Array([1,2,3]);
    const response=await h.local.fetch('/api/uploads/prepare','POST',{turnstile_token:randomBytes(24).toString('hex'),files:[{name:'local.png',type:'image/png',size:3,algorithm:'sha256',sha256:createHash('sha256').update(bytes).digest('hex')}]});
    assert.equal(response.status,200);const prepared=(await response.json()).data,grant=prepared.uploads[0];
    await h.local.put(grant,bytes);const original=await h.local.bucket.head(grant.key),before=await h.local.db.prepare('SELECT used_bytes FROM storage_capacity').first('used_bytes');
    await h.local.put(grant,bytes); // ACK-lost retry must reuse the original version
    assert.equal((await h.local.bucket.head(grant.key)).version,original.version);
    assert.equal(await h.local.db.prepare('SELECT used_bytes FROM storage_capacity').first('used_bytes'),before);
    assert.equal(await h.local.db.prepare('SELECT reserved_bytes FROM storage_capacity').first('reserved_bytes'),0);
    assert.equal((await h.local.fetch('/api/uploads/complete','POST',{session_id:prepared.session_id,keys:[grant.key]})).status,200);
  }finally{await h.local.runtime.dispose();}
});
