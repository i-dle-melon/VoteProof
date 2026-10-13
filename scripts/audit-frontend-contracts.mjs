import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {htmlHooks,functionalDataHooks} from './check-frontend-hooks.mjs';
const dir=path.resolve('.wrangler/frontend-contracts');await mkdir(dir,{recursive:true});
const html=await readFile('public/index.html','utf8'),css=await readFile('public/css/app.css','utf8');
const jsFiles=(await readdir('public/js')).filter(n=>n.endsWith('.js')),js=Object.fromEntries(await Promise.all(jsFiles.map(async n=>['public/js/'+n,await readFile('public/js/'+n,'utf8')])));
const tests=(await readdir('frontend-tests')).filter(n=>n.endsWith('.js')||n.endsWith('.mjs'));
const testSource=(await Promise.all(tests.map(async n=>[n,await readFile('frontend-tests/'+n,'utf8')])));
const ids=[...htmlHooks(html)].map(([id,n])=>({id,tag:n.tag,attributes:n.attributes,classification:'MUST PRESERVE',
  js_files:Object.entries(js).filter(([,s])=>s.includes(id)).map(([p])=>p),test_files:testSource.filter(([,s])=>s.includes(id)).map(([p])=>p)}));
const classes=[...new Set([...html.matchAll(/\bclass="([^"]+)"/g)].flatMap(m=>m[1].split(/\s+/)))].sort().map(cls=>({class:cls,
  classification:Object.values(js).some(s=>s.includes('.'+cls)||new RegExp('classList\\.[^(]+\\([^)]*["\']'+cls+'["\']').test(s))?'MUST PRESERVE':Object.values(js).some(s=>s.includes(cls))?'safe to rename if JS/CSS/tests updated':'CSS-only; safe to rename with CSS/test review',
  js_files:Object.entries(js).filter(([,s])=>s.includes(cls)).map(([p])=>p)}));
const selectors=[];for(const [file,s] of [...Object.entries(js),...testSource.map(([f,s])=>['frontend-tests/'+f,s])]){
 s.split(/\r?\n/).forEach((line,i)=>{if(/querySelector|querySelectorAll|getElementById|\.locator\(|getByRole\(|getByLabel\(|\$\(/.test(line))selectors.push({file,line:i+1,expression:line.trim(),classification:'MUST PRESERVE or update JS/tests together'});});
}
const forms=[...html.matchAll(/<(input|select|textarea|button)\b([^>]+)>/g)].map(m=>({tag:m[1],attributes:m[2]})).filter(x=>/\b(name|id|aria-|required|pattern|min|max)/.test(x.attributes));
await writeFile(path.join(dir,'dom-hooks.json'),JSON.stringify({ids,classes,data_attributes:functionalDataHooks(html),selectors,forms,dynamic_hook_policy:'String-composed view/security/admin-field IDs require source review; fixed fixture hooks must not be relaxed'},null,2)+'\n');
const group=file=>file.includes('admin')?'Admin':file.includes('member')?'member':file.includes('submission')?'submission':file.includes('api')?'errors':file.includes('tier')?'Tier':'public/auth/cases/leaderboard/system';
const copy=[];const entity=s=>s.replaceAll('&nbsp;',' ').replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>');
let section='public';html.split(/\r?\n/).forEach((line,i)=>{const view=line.match(/id="view-([^"]+)"/);if(view)section=view[1];for(const m of line.matchAll(/>([^<>]*[\u3400-\u9fff][^<>]*)</g)){const text=entity(m[1].trim());if(text)copy.push({group:section,file:'public/index.html',line:i+1,source:'HTML',text});}});
for(const [file,s] of Object.entries(js))s.split(/\r?\n/).forEach((line,i)=>{for(const m of line.matchAll(/(["'`])([^\n]*?[\u3400-\u9fff][^\n]*?)\1/g))copy.push({group:group(file),file,line:i+1,source:'JS literal/template; interpolation must remain functional',text:m[2]});});
const freq=new Map();for(const row of copy)freq.set(row.text,(freq.get(row.text)??0)+1);
await writeFile(path.join(dir,'copy-inventory.json'),JSON.stringify({strings:copy,duplicated:[...freq].filter(([,n])=>n>1).map(([text,count])=>({text,count})),review_notes:['Static HTML and dynamic JS both included','Admin fixed copy lives in admin-ui-copy template','JS template extraction is a review aid; compare rendered dynamic states','Do not expose OAuth/provider/token wording in public flow','Use 投稿/案件/證明 consistently; existing mixed 提交/投稿 and proof/status terms require editorial review']},null,2)+'\n');
const themeBlocks=[...css.matchAll(/(:root|html\[data-theme="light"\])\s*\{([^}]+)\}/g)].map(m=>({selector:m[1],variables:Object.fromEntries([...m[2].matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(x=>[x[1],x[2].trim()]))}));
const properties=name=>[...new Set([...css.matchAll(new RegExp('\\b'+name+':\\s*([^;}]+)','g'))].map(m=>m[1].trim()))];
const tokens={themes:themeBlocks,breakpoints:[...new Set([...css.matchAll(/@media\s*([^\{]+)/g)].map(m=>m[1].trim()))],fonts:properties('font'),font_sizes:properties('font-size'),spacing:{padding:properties('padding'),margin:properties('margin'),gap:properties('gap')},radii:properties('border-radius'),shadows:properties('box-shadow'),buttons:['.btn','.btn-primary','.btn-white'],components:['.card','.field','.status','.member-case','.table-wrap'],intent:{dark_base:'#121212',dark_accent:'#00cd3c',light_accent:'#5E0E8B'}};
await writeFile(path.join(dir,'design-tokens.json'),JSON.stringify(tokens,null,2)+'\n');
const routes=[],fields=[];for(const n of await readdir('src/api')){if(!n.endsWith('.js'))continue;const text=await readFile('src/api/'+n,'utf8');text.split(/\r?\n/).forEach((line,i)=>{if(line.includes('/api/')||line.includes('\\/api\\/'))routes.push({file:'src/api/'+n,line:i+1,declaration:line.trim()});});
 for(const m of text.matchAll(/onlyFields\(body,\s*\[([\s\S]*?)\]\)/g))fields.push({file:'src/api/'+n,line:text.slice(0,m.index).split('\n').length,fields:[...m[1].matchAll(/["']([\w_]+)["']/g)].map(x=>x[1])});
}
await writeFile(path.join(dir,'endpoint-source-inventory.json'),JSON.stringify(routes,null,2)+'\n');
await writeFile(path.join(dir,'request-field-whitelists.json'),JSON.stringify({whitelists:fields,other_validators:'case-validation.js, upload-validation.js, admin-validation.js and per-domain policy functions validate the remaining request fields; see API/UI matrix'},null,2)+'\n');
await writeFile(path.join(dir,'inventory-summary.json'),JSON.stringify({ids:ids.length,classes:classes.length,selector_lines:selectors.length,copy_strings:copy.length,duplicate_copy: [...freq].filter(([,n])=>n>1).length,endpoint_declarations:routes.length,theme_blocks:themeBlocks.length,source:'current checked-out local candidate; not Production APIs'},null,2)+'\n');
console.log(JSON.stringify({result:'PASS',ids:ids.length,selectors:selectors.length,copy:copy.length,endpoints:routes.length,output:'.wrangler/frontend-contracts'}));
