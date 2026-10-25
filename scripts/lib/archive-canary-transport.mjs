// Test bundle injection ONLY: isolates each concurrent request's mock binding.
import {AsyncLocalStorage} from 'node:async_hooks';
const context=new AsyncLocalStorage();
export const withMockTransport=(env,action)=>context.run(env,action);
export function canaryFetch(input,init){
  const env=context.getStore(),url=new URL(typeof input==='string'?input:input.url);
  if(!env||url.origin!=='https://script.google.com'||url.pathname!=='/macros/s/isolated_canary/exec'||init?.method!=='POST')throw Error('MOCK_OUTBOUND_DENIED');
  return env.MOCK_RELAY.fetch(new Request(env.TEST_ORIGIN+'/__canary_mock',{
    method:'POST',headers:{'Content-Type':'application/json','X-Isolated-Access':env.TEST_ACCESS},body:init.body}));
}
