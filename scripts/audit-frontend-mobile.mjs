import {chromium} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {adminFixture} from '../frontend-tests/admin-fixture.mjs';
const out='.wrangler/frontend-contracts';await mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'chrome',headless:true}),rows=[],errors=[];
try{
 for(const width of [320,375,390,430,768])for(const theme of ['dark','light']){
  const context=await browser.newContext({viewport:{width,height:844}}),page=await context.newPage();
  page.on('pageerror',e=>errors.push({width,theme,code:'PAGEERROR',message:e.message.slice(0,200)}));
  const state=await adminFixture(page);await page.addInitScript(t=>localStorage.setItem('voteproof-theme',t),theme);
  for(const surface of ['home','login','submit','member','lookup','leaderboards','admin']){
   state.authenticated=surface!=='login';
   // Distinct query forces a real navigation, clearing the previous authenticated UI session.
   await page.goto('http://127.0.0.1:4173/?audit='+surface+'#'+surface);await page.locator('#view-'+surface).waitFor({state:'visible'});
   if(surface==='admin'){await page.locator('#admin-panel').getByRole('button',{name:'查看與審核',exact:true}).click();await page.getByRole('region',{name:'檔案比對提示'}).waitFor();}
   await page.waitForTimeout(60);
   const row=await page.evaluate(({width,theme,surface})=>{
     const shown=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'&&!e.closest('[hidden]');};
     const root=document.getElementById('view-'+surface),elements=[...root.querySelectorAll('*')].filter(shown);
     const controls=elements.filter(e=>e.matches('button,input,select,textarea,a[href]'));
     const unlabeled=controls.filter(e=>e.matches('input:not([type=hidden]),select,textarea')&&!e.labels?.length&&!e.getAttribute('aria-label')&&!e.getAttribute('aria-labelledby')).map(e=>e.id||e.tagName);
     const short=controls.filter(e=>{const r=e.getBoundingClientRect();return r.width<44||r.height<44;}).map(e=>({id:e.id||null,tag:e.tagName,width:Math.round(e.getBoundingClientRect().width),height:Math.round(e.getBoundingClientRect().height)}));
     const overflow=elements.filter(e=>{const r=e.getBoundingClientRect();return r.left<-.5||r.right>innerWidth+.5;}).slice(0,15).map(e=>({tag:e.tagName,id:e.id||null,class:e.className}));
     const parse=c=>{const a=c.match(/[\d.]+/g)?.map(Number);return a?.length>=3?a.slice(0,3):null;},lum=c=>{const x=c.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return .2126*x[0]+.7152*x[1]+.0722*x[2];};
     const contrasts=[];for(const el of elements.filter(e=>e.textContent.trim()&&!e.children.length).slice(0,150)){
       const fg=parse(getComputedStyle(el).color);let ancestor=el,bg;
       while(ancestor){const color=getComputedStyle(ancestor).backgroundColor;if(!/^rgba\([^)]*,\s*0\)$/.test(color)){bg=parse(color);if(bg)break;}ancestor=ancestor.parentElement;}
       if(!fg||!bg)continue;const l1=lum(fg),l2=lum(bg),ratio=(Math.max(l1,l2)+.05)/(Math.min(l1,l2)+.05),s=getComputedStyle(el),large=parseFloat(s.fontSize)>=24||(parseFloat(s.fontSize)>=18.66&&Number(s.fontWeight)>=700);
       if(ratio<(large?3:4.5))contrasts.push({tag:el.tagName,id:el.id||null,ratio:Math.round(ratio*100)/100,large});
     }
     return {width,theme,actual_theme:document.documentElement.dataset.theme,surface,document_overflow:document.documentElement.scrollWidth>innerWidth,scroll_width:document.documentElement.scrollWidth,overflow_elements:overflow,small_tap_targets:short,unlabeled_controls:unlabeled,contrast_candidates:contrasts,headings:elements.filter(e=>/^H[1-6]$/.test(e.tagName)).map(e=>e.tagName),dialogs:document.querySelectorAll('dialog,[role=dialog]').length};
   },{width,theme,surface});rows.push(row);
   if(width===320&&['member','admin'].includes(surface))await page.screenshot({path:out+'/'+surface+'-'+theme+'-320.png',fullPage:true});
  }
  await context.close();
 }
 const result={environment:'isolated local API fixtures',widths:[320,375,390,430,768],themes:['dark','light'],surface_runs:rows.length,
  overflow_runs:rows.filter(x=>x.document_overflow).length,unlabeled_control_runs:rows.filter(x=>x.unlabeled_controls.length).length,
  small_tap_target_runs:rows.filter(x=>x.small_tap_targets.length).length,contrast_candidate_runs:rows.filter(x=>x.contrast_candidates.length).length,errors,rows,
  limits:['Computed contrast candidates require manual review for gradients/opacity/inherited backgrounds','44px tap target is an audit heuristic, not an automated WCAG conformance verdict','No real member data or Production API']};
 await writeFile(out+'/mobile-accessibility.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({surface_runs:result.surface_runs,overflow_runs:result.overflow_runs,unlabeled_control_runs:result.unlabeled_control_runs,small_tap_target_runs:result.small_tap_target_runs,contrast_candidate_runs:result.contrast_candidate_runs,page_errors:errors.length}));
}finally{await browser.close();}
