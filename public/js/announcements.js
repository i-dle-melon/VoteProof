import {api} from './api.js';
const storageKey='voteproof-announcement-dismissals';
const safeURL=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
export function setupAnnouncements(){
 const dialog=document.getElementById('announcement-dialog'),list=document.getElementById('announcement-body'),close=document.getElementById('announcement-close'),open=document.getElementById('announcement-open');
 let rows=[],current=null,opener=null,dismissed={};
 try{const value=JSON.parse(localStorage.getItem(storageKey)??'{}');if(value&&typeof value==='object'&&!Array.isArray(value))dismissed=value;}catch{}
 const safeFlow=()=>['login','register','recover','security','submit','admin'].includes(location.hash.slice(1))||/^\/admin\/?$/.test(location.pathname);
 function remember(){if(!current)return;dismissed[current.announcement_id]=current.version;const entries=Object.entries(dismissed).filter(([id,v])=>/^[a-f0-9-]{36}$/.test(id)&&Number.isSafeInteger(v)).slice(-100);try{localStorage.setItem("voteproof-announcement-dismissals",JSON.stringify(Object.fromEntries(entries)));}catch{}}
 function show(force=false,source=null){
  if(safeFlow()||dialog.open||document.querySelector('dialog[open]'))return;
  current=rows.find(r=>force||dismissed[r.announcement_id]!==r.version);if(!current)return;
  list.replaceChildren();const title=document.getElementById('announcement-title');title.textContent=current.title;
  const body=document.createElement('p');body.className='content-lines';body.textContent=current.body;list.append(body);
  const href=safeURL(current.button_url);if(href&&current.button_label){const a=document.createElement('a');a.textContent=current.button_label;a.href=href;a.target='_blank';a.rel='noopener noreferrer';a.className='btn btn-primary';list.append(a);}
  close.hidden=!current.dismissible;opener=source??document.activeElement;dialog.showModal();(current.dismissible?close:document.getElementById('announcement-security')).focus();
 }
 close.addEventListener('click',()=>{remember();dialog.close();});
 dialog.addEventListener('cancel',e=>{if(!current?.dismissible)e.preventDefault();else remember();});
 dialog.addEventListener('close',()=>{if(opener?.isConnected)opener.focus();});
 dialog.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...dialog.querySelectorAll('button:not([hidden]),a[href]')],first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}});
 open.addEventListener('click',()=>show(true,open));
 document.getElementById('announcement-security').addEventListener('click',()=>dialog.close());
 window.addEventListener('hashchange',()=>{if(safeFlow()){if(dialog.open)dialog.close();}else show();});
 void api('/api/announcements').then(data=>{if(!Array.isArray(data.announcements))return;rows=data.announcements.filter(r=>/^[a-f0-9-]{36}$/.test(r.announcement_id)&&Number.isSafeInteger(r.version)&&typeof r.title==='string'&&typeof r.body==='string'&&typeof r.dismissible==='boolean');open.hidden=!rows.length;show();}).catch(()=>{});
}
