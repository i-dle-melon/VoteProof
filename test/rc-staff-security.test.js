import test from 'node:test';
import {embeddedCaseRuntime} from './helpers/embedded-case-runtime.mjs';
import {localAdminRuntime} from '../scripts/lib/local-admin-runtime.mjs';
import {verifyStaffSecurity} from './helpers/staff-security.mjs';
test('native staff security matrix: no privilege escalation, suspension, CSRF, MFA, audit or owner lockout',async()=>{
 const h=await embeddedCaseRuntime();try{await verifyStaffSecurity(h);}finally{h.close();}
});
test('real Miniflare staff security matrix including direct unauthorized management APIs',async()=>{
 const h=await localAdminRuntime();try{await verifyStaffSecurity({db:h.local.db,fetch:h.local.fetch,env:{AUTH_SECRET:h.local.authSecret},identity:role=>h.identity({role})});}finally{await h.local.runtime.dispose();}
});
