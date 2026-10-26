import test from 'node:test';import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {MemberSession,adminPath} from '../public/js/member-api.js';

test('maintenance path is narrowly allowed without external/query/path traversal credential leakage',()=>{
 assert.equal(adminPath('/api/admin/storage/image-maintenance'),true);
 for(const p of ['https://other.invalid/api/admin/storage/image-maintenance','//other.invalid/api/admin/storage/image-maintenance','/api/admin/storage/image-maintenance?token=x','/api/admin/storage/image-maintenance/reconcile','/api/admin/storage/image-maintenance#x','/api/admin/storage/../image-maintenance'])assert.equal(adminPath(p),false);
});
test('existing Admin client carries same-origin CSRF, never polls or auto-retries maintenance',async()=>{
 let calls=0;const csrf=randomBytes(32).toString('hex');
 const session=new MemberSession({fetcher:async(p,o)=>{calls++;assert.equal(p,'/api/admin/storage/image-maintenance');assert.equal(o.credentials,'same-origin');assert.equal(o.method,'POST');assert.equal(o.headers['X-CSRF-Token'],csrf);return Response.json({ok:true,data:{mode:'draining'}});}});
 session.accept({member:{member_id:'M-'+randomUUID(),nickname:'Synthetic',player_id:'synthetic',status:'active'},csrf_token:csrf,expires_in:600});
 try{await session.adminRequest('/api/admin/storage/image-maintenance',{method:'POST',body:{action:'pause',expected_version:1,confirmed:true}});assert.equal(calls,1);await assert.rejects(session.adminRequest('https://other.invalid/api/admin/storage/image-maintenance'));assert.equal(calls,1);}finally{session.clear();}
});
