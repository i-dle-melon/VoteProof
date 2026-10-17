import {api} from './api.js';
// Only explicit opt-outs are persistent. Earlier automatic close records are not opt-outs.
const storageKey='voteproof-announcement-opt-outs';
const safeURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
export function setupAnnouncements(){
 const dialog=document.getElementById('announcement-dialog'),list=document.getElementById('announcement-body'),close=document.getElementById('announcement-close'),open=document.getElementById('announcement-open'),never=document.getElementById('announcement-never'),optOut=document.getElementById('announcement-opt-out');
 let rows=[],current=null,opener=null,dismissed={};const shown=new Set();
 try{const v=JSON.parse(localStorage.getItem(storageKey)??'{}');if(v&&typeof v==='object'&&!Array.isArray(v))dismissed=v;}catch{}
 const safeFlow=()=>['login','register','recover','security','submit','admin'].includes(location.hash.slice(1))||/^\/admin\/?$/.test(location.pathname);
 function remember(){if(!current||!current.dismissible)return;if(never.checked)dismissed[current.announcement_id]=current.version;else if(Object.hasOwn(dismissed,current.announcement_id))delete dismissed[current.announcement_id];else return;const entries=Object.entries(dismissed).filter(([id,v])=>/^[a-f0-9-]{36}$/.test(id)&&Number.isSafeInteger(v)).slice(-100);try{localStorage.setItem("voteproof-announcement-opt-outs",JSON.stringify(Object.fromEntries(entries)));}catch{}}
 function show(force=false,source=null){
  if(safeFlow()||dialog.open||document.querySelector('dialog[open]'))return;
  current=rows.find(r=>force||!shown.has(r.announcement_id+':'+r.version)&&dismissed[r.announcement_id]!==r.version);if(!current)return;
  list.replaceChildren();const title=document.getElementById('announcement-title');title.textContent=current.title;
  const body=document.createElement('p');body.className='content-lines';body.textContent=current.body;list.append(body);
  const href=safeURL(current.button_url);if(current.button_enabled!==false&&href&&current.button_label){const a=document.createElement('a');a.textContent=current.button_label;a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.className='btn btn-primary';list.append(a);}
  never.checked=dismissed[current.announcement_id]===current.version;close.hidden=optOut.hidden=!current.dismissible;opener=source??document.activeElement;shown.add(current.announcement_id+':'+current.version);dialog.showModal();(current.dismissible?close:title).focus();
 }
 close.addEventListener('click',()=>{remember();dialog.close();});
 dialog.addEventListener('cancel',e=>{if(!current?.dismissible)e.preventDefault();else remember();});
 dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
 dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button,a[href],input')].filter(n=>n.getClientRects().length),first=controls[0],last=controls.at(-1);if(!first){e.preventDefault();document.getElementById('announcement-title').focus();}else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
 open.addEventListener('click',()=>show(true,open));
 window.addEventListener('hashchange',()=>{if(safeFlow()){if(dialog.open)dialog.close();}else show();});
 void api('/api/announcements').then(data=>{if(!Array.isArray(data.announcements))return;rows=data.announcements.filter(r=>/^[a-f0-9-]{36}$/.test(r.announcement_id)&&Number.isSafeInteger(r.version)&&typeof r.title==='string'&&typeof r.body==='string'&&typeof r.dismissible==='boolean');open.hidden=!rows.length;show();}).catch(()=>{});
}
