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

test('valid mobile token survives repeated mount/focus checks; duplicate waiters share one pending challenge',async()=>{
 const before={document:globalThis.document,turnstile:globalThis.turnstile};let callbacks,resets=0;
 globalThis.document={documentElement:{dataset:{}},querySelector:()=>({content:'synthetic'})};
 globalThis.turnstile={render(_n,o){callbacks=o;return 'test';},reset(){resets++;}};
 try{
  const c=new Challenge({clientWidth:300},()=>{});await c.mount();callbacks.callback('synthetic-one');
  await c.mount();await c.mount();assert.equal(await c.waitForToken(),'synthetic-one');assert.equal(resets,0);
  const p=c.waitForToken(),q=c.waitForToken();assert.equal(p,q);assert.equal(resets,1);
  callbacks.callback('synthetic-one'); // consumed response cannot authorize twice
  callbacks.callback('synthetic-two');assert.equal(await p,'synthetic-two');assert.equal(await q,'synthetic-two');
 }finally{Object.assign(globalThis,before);}
});
test('synchronous reset callback cannot be lost before the waiter exists',async()=>{
 const before={document:globalThis.document,turnstile:globalThis.turnstile};let callbacks,n=0;
 globalThis.document={documentElement:{dataset:{}},querySelector:()=>({content:'synthetic'})};
 globalThis.turnstile={render(_n,o){callbacks=o;return 'test';},reset(){callbacks.callback('synthetic-'+(++n));}};
 try{
  const c=new Challenge({clientWidth:300},()=>{});await c.mount();callbacks.callback('first');assert.equal(await c.waitForToken(),'first');
  assert.equal(await c.waitForToken(200),'synthetic-1');c.clear();
 }finally{Object.assign(globalThis,before);}
});
test('backgrounded expired token renews on the same click; error and clear settle waiting promises',async()=>{
 const before={document:globalThis.document,turnstile:globalThis.turnstile};let callbacks,resets=0,clock=0;
 globalThis.document={documentElement:{dataset:{}},querySelector:()=>({content:'synthetic'})};
 globalThis.turnstile={render(_n,o){callbacks=o;return 'test';},reset(){resets++;}};
 try{
  const c=new Challenge({clientWidth:300},()=>{},{now:()=>clock});await c.mount();callbacks.callback('expired-in-background');clock=300000;
  const p=c.waitForToken();assert.equal(resets,1);callbacks.callback('fresh');assert.equal(await p,'fresh');
  const error=c.waitForToken();callbacks['error-callback']();await assert.rejects(error,{code:'TURNSTILE_UPSTREAM_ERROR'});
  const cleared=c.waitForToken();c.clear();await assert.rejects(cleared,{code:'TURNSTILE_REQUIRED'});
 }finally{Object.assign(globalThis,before);}
});
