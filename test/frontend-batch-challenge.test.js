import test from 'node:test';
import assert from 'node:assert/strict';
import {Challenge} from '../public/js/turnstile.js';

test('batch consumes one token without showing another challenge until a new authorization requests it',async()=>{
 const oldDocument=globalThis.document,oldTurnstile=globalThis.turnstile;
 let callback,resets=0;
 globalThis.document={documentElement:{dataset:{theme:'light'}},querySelector:()=>({content:'synthetic-site-key'})};
 globalThis.turnstile={render(_node,options){callback=options.callback;queueMicrotask(()=>callback('first-synthetic-token'));return 'local';},reset(){resets++;queueMicrotask(()=>callback('next-synthetic-token'));}};
 try{
  const c=new Challenge({clientWidth:400},()=>{});await c.mount();
  assert.equal(await c.waitForToken(),'first-synthetic-token');assert.equal(resets,0);
  assert.equal(await c.waitForToken(),'next-synthetic-token');assert.equal(resets,1);
  c.clear();await assert.rejects(c.waitForToken(),{code:'TURNSTILE_REQUIRED'});
 }finally{globalThis.document=oldDocument;globalThis.turnstile=oldTurnstile;}
});
