import {test,expect} from '@playwright/test';
import {memberFixture} from './member-fixture.mjs';
import {createHash} from 'node:crypto';

// Only synthetic response statuses and UI booleans are retained. No auth body,
// Cookie, CSRF, member identity or real account is captured.
for(const consistent of [false,true])test('pending boot '+(consistent?'consistent session stays visible':'inconsistent fixture deterministically revokes session'),async({page},info)=>{
 const state=await memberFixture(page),responses=[],errors=[],consoleErrors=[];let release;
 page.on('pageerror',error=>errors.push(error.name));
 page.on('console',message=>{if(message.type()!=='error')return;const text=message.text();consoleErrors.push({category:text.startsWith('Refused to apply a stylesheet')?'csp_stylesheet':text.startsWith('Failed to load resource')?'resource':'other',status:text.match(/\b[45]\d\d\b/)?.[0]??null,path:message.location().url?new URL(message.location().url).pathname:null,message_sha256:createHash('sha256').update(text).digest('hex')});});
 page.on('response',response=>{const path=new URL(response.url()).pathname;if(['/api/auth/me','/api/auth/login-security','/api/me/points','/api/me/cases'].includes(path))responses.push({path,status:response.status()});});
 const pending=new Promise(r=>release=r);
 await page.route('**/api/auth/me',async route=>{await pending;await route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,data:{member:state.member,csrf_token:state.csrf,expires_in:600}})});});
 try{
  await page.goto('/#login');await expect(page.locator('#login-session-status')).toBeVisible();await expect(page.locator('#login-content')).toBeHidden();
  const methods=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/auth/login-security');
  state.authenticated=consistent;release();const response=await methods;
  expect(response.status()).toBe(consistent?200:401);
  if(consistent){await expect(page).toHaveURL(/#member$/);await expect(page.locator('#member-content')).toBeVisible();}
  else await expect(page.locator('#member-content')).toBeHidden();
  expect(errors).toEqual([]);
  const evidence={consistent,responses,memberHidden:await page.locator('#member-content').isHidden(),pageErrors:errors,consoleErrors};
  console.info('LOCAL_PENDING_PROBE '+JSON.stringify(evidence));
  await info.attach('pending-session-statuses',{contentType:'application/json',body:JSON.stringify(evidence)});
 }finally{release();}
});
