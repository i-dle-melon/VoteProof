// Shared Production/Preview renderer. Only the injected transport differs.
const FROM='idle.voteproof.verify@gmail.com';
export function supportMailTemplate(member){
 const nickname=typeof member.nickname==='string'&&member.nickname.trim()?member.nickname:'',explanation=typeof member.explanation==='string'?member.explanation:'';
 return{subject:'VoteProof 會員通知',body:`您好${nickname?' '+nickname:''}，

這是 VoteProof 管理團隊寄出的會員通知。

粉絲 ID：${member.fan_id??''}

通知內容：
${explanation}

如有任何問題，可直接回覆此郵件與我們聯絡。

VoteProof 管理團隊`};
}
const node=(tag,text='',cls)=>{const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
const button=(name,action,cls='btn btn-white')=>{const b=node('button',name,cls);b.type='button';b.addEventListener('click',action);return b;};
const message=e=>({MEMBER_NOT_FOUND:'找不到此粉絲 ID 的會員。',MEMBER_EMAIL_UNAVAILABLE:'沒有可使用的已驗證 Email，或收件資料已變更，請重新查詢。',MEMBER_LOOKUP_REQUIRED:'查詢已過期，請重新查詢會員。',ADMIN_MAIL_NOT_CONFIGURED:'客服寄信尚未設定完成。',ADMIN_MAIL_RATE_LIMITED:'客服寄信已達保留配額限制，請稍後再試。',INVALID_MEMBER_CONTACT:'請確認粉絲 ID、主旨（150 字內）與內容（10000 字內）。',MEMBER_MAIL_MUTATION_CONFLICT:'此寄信編號已用於其他內容，請重新查詢後建立新信件。',ADMIN_STEP_UP_REQUIRED:'請重新完成 MFA 驗證。',ADMIN_FORBIDDEN:'你目前沒有此操作的管理權限。'}[e?.code]??'操作未完成，未自動重送。請確認狀態後再試。');
const stamp=v=>v?new Date(v).toLocaleString('zh-TW',{timeZone:'Asia/Taipei',hour12:false}):'—';
function field(form,name,label,kind='input',value='',readonly=false){
 const wrap=node('div','','field'),caption=node('label',label),input=node(kind);caption.htmlFor=input.id='contact-'+name;input.name=name;input.value=value;input.autocomplete='off';input.readOnly=readonly;wrap.append(caption,input);form.append(wrap);return input;
}
function modal(title,cls,opener){
 const d=node('dialog','','case-dialog member-contact-dialog '+cls);d.setAttribute('aria-label',title);const header=node('div','','contact-titlebar'),h=node('h2',title),close=button('關閉',()=>d.close());header.append(h,close);d.append(header);
 d.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const controls=[...d.querySelectorAll('button,input,textarea,select,[tabindex="0"]')].filter(n=>!n.disabled&&!n.hidden),first=controls[0],last=controls.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}});
 d.addEventListener('close',()=>{d.remove();if(opener?.isConnected)opener.focus();});document.body.append(d);return{d,close};
}
export function memberContactUI({request,opener,initialFanId=''}){
 let lookup=null,compose=null,disposed=false,epoch=0;
 const cleanup=()=>{disposed=true;epoch++;compose?.close();lookup?.close();compose?.remove();lookup?.remove();};
 function openCompose(member,email,source){
  if(disposed||compose?.open)return;
  const{d,close}=modal('寄信給會員','member-mail-compose',source);compose=d;
  const f=node('form');f.dataset.memberMailEditor='';
  field(f,'from','寄件者（唯讀）','input',FROM,true);field(f,'to','收件者（唯讀）','input',email.email,true);
  const template=supportMailTemplate(member),subject=field(f,'subject','主旨','input',template.subject),body=field(f,'body','內容（純文字）','textarea',template.body);subject.required=true;subject.maxLength=150;body.required=true;body.maxLength=10000;body.rows=10;
  if(member.explanation)f.append(button('帶入說明',()=>{body.value=supportMailTemplate(member).body;body.focus();}));
  const status=node('p','','notice');status.setAttribute('role','status');const footer=node('div','','contact-footer'),send=node('button','傳送','btn btn-primary'),discard=button('捨棄',()=>d.close());send.type='submit';footer.append(send,discard);f.append(status,footer);d.append(f);
  let inFlight=false,mutation=null,fingerprint=null,terminal=false;
  const freezeDraft=()=>{subject.readOnly=body.readOnly=true;};
  d.addEventListener('cancel',e=>{if(inFlight)e.preventDefault();});
  f.addEventListener('submit',async e=>{
   e.preventDefault();if(inFlight||terminal||!f.reportValidity())return;
   const data={subject:subject.value,body:body.value},print=JSON.stringify(data);
   if(mutation&&fingerprint!==print){status.textContent='前次傳送尚未確認，請先確認原信件結果。';return;}
   mutation??=crypto.randomUUID();fingerprint=print;inFlight=true;send.disabled=discard.disabled=close.disabled=true;freezeDraft();status.textContent='傳送中…';
   const born=epoch;
   try{
    const r=await request('member-mail/send',{method:'POST',body:{member_id:member.member_id,recipient_ref:email.recipient_ref,...data,mutation_id:mutation}});
    if(disposed||born!==epoch||!d.open)return;
    if(r.outcome==='sent'){terminal=true;status.textContent='郵件已傳送。';send.textContent='已傳送';}
    else if(r.outcome==='ambiguous'){terminal=true;status.textContent='寄送結果不明，可能已送達；請勿重送這封信，先確認收件或操作紀錄。';send.textContent='結果不明';}
    else if(r.outcome==='rejected'){status.textContent='服務已確認未寄出；草稿已保留，可調整後再試。';mutation=fingerprint=null;subject.readOnly=body.readOnly=false;}
    else{terminal=true;status.textContent='寄送結果不明，請勿重送。';}
   }catch(error){
    if(disposed||born!==epoch||!d.open)return;
    if(['INVALID_MEMBER_CONTACT','ADMIN_MAIL_NOT_CONFIGURED','ADMIN_MAIL_RATE_LIMITED','MEMBER_LOOKUP_REQUIRED','MEMBER_EMAIL_UNAVAILABLE'].includes(error.code)){mutation=fingerprint=null;subject.readOnly=body.readOnly=false;status.textContent=message(error);}
    else status.textContent=message(error)+' 草稿已保留；再次按傳送僅確認同一寄信編號，不會重複寄信。';
   }finally{inFlight=false;if(d.isConnected){send.disabled=terminal;discard.disabled=close.disabled=false;}}
  });
  d.addEventListener('close',()=>{f.reset();subject.value=body.value='';if(compose===d)compose=null;});d.showModal();subject.focus();
 }
 function open(){
  if(disposed||lookup?.open)return;const{d}=modal('會員查詢','member-lookup',opener);lookup=d;
  const f=node('form');f.dataset.memberLookupEditor='';const fan=field(f,'fan_id','粉絲 ID');fan.value=initialFanId;fan.required=true;fan.maxLength=100;const search=node('button','查詢','btn btn-primary');search.type='submit';f.append(search);
  const status=node('p','','notice');status.setAttribute('role','status');const result=node('section','','member-lookup-result');d.append(f,status,result);let searching=false;
  f.addEventListener('submit',async e=>{
   e.preventDefault();if(searching||!f.reportValidity())return;searching=true;search.disabled=true;result.replaceChildren();status.textContent='查詢中…';const born=++epoch;
   try{
    const{member:m}=await request('member-lookup',{method:'POST',body:{fan_id:fan.value}});if(disposed||born!==epoch||!d.open)return;
    const dl=node('dl','','case-details'),counts=m.proof_counts;
    for(const[label,val]of [['粉絲 ID',m.fan_id],['暱稱',m.nickname],['會員狀態',m.status==='suspended'?'已被封鎖':'正常'],['會員等級',m.tier?.name],['目前總點數',m.total_points],['累計投稿數',counts.total],['待審核',counts.pending],['已通過',counts.approved],['未通過',counts.rejected],['註冊時間',stamp(m.created_at)],['登入方式',m.login_methods.join('、')||'未設定'],['最後更新時間',stamp(m.updated_at)]])dl.append(node('dt',label),node('dd',String(val??'—')));
    result.append(dl);if(m.explanation)result.append(node('p',m.explanation,'content-lines'));
    result.append(node('h3','已驗證 Email'));if(!m.emails.length)result.append(node('p','沒有可使用的已驗證 Email。'));
    for(const email of m.emails){const row=node('article','','contact-email-row');row.append(node('p',email.email),node('p',email.providers.join('、'),'tiny'));const composeButton=button('寄信給會員',()=>openCompose(m,email,composeButton),'btn btn-primary');row.append(composeButton);result.append(row);}
    status.textContent=m.emails.length>1?'有多個不同的已驗證 Email，請選擇對應的寄信按鈕。':'查詢完成。';
   }catch(error){if(!disposed&&born===epoch&&d.open)status.textContent=message(error);}
   finally{searching=false;if(search.isConnected)search.disabled=false;}
  });
  d.addEventListener('close',()=>{if(lookup===d){epoch++;compose?.close();lookup=null;}result.replaceChildren();fan.value='';});d.showModal();fan.focus();
 }
 return{open,cleanup};
}
