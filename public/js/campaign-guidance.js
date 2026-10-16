import {api,campaignExample} from './api.js';
export function campaignGuidance(){
 const section=document.getElementById('campaign-guidance'),text=document.getElementById('campaign-instructions'),image=document.getElementById('campaign-example'),button=document.getElementById('campaign-example-open'),dialog=document.getElementById('campaign-example-dialog'),large=document.getElementById('campaign-example-large');
 let sequence=0,url=null,controller=null,opener=null;
 function clear(){controller?.abort();if(dialog.open)dialog.close();image.removeAttribute('src');large.removeAttribute('src');if(url)URL.revokeObjectURL(url);url=null;section.hidden=true;text.textContent='';button.hidden=true;}
 document.getElementById('campaign-example-close').addEventListener('click',()=>dialog.close());
 button.addEventListener('click',()=>{if(!url)return;opener=button;large.src=url;dialog.showModal();document.getElementById('campaign-example-close').focus();});
 dialog.addEventListener('close',()=>{large.removeAttribute('src');if(opener?.isConnected)opener.focus();});
 dialog.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();document.getElementById('campaign-example-close').focus();}});
 window.addEventListener('pagehide',clear);
 return async id=>{
  clear();const born=++sequence;if(!id)return;controller=new AbortController();const signal=controller.signal;
  try{const data=await api('/api/campaigns/'+encodeURIComponent(id)+'/guidance');if(born!==sequence||signal.aborted)return;
    if(typeof data.submission_instructions!=='string')throw Error();text.textContent=data.submission_instructions;text.closest('div').hidden=!text.textContent;section.hidden=!text.textContent&&!data.example_image_url;
    if(data.example_image_url){const path='/api/campaigns/'+encodeURIComponent(id)+'/example';if(data.example_image_url!==path)throw Error();const blob=await campaignExample(path,signal);if(born!==sequence||signal.aborted)return;url=URL.createObjectURL(blob);image.src=url;button.hidden=false;}
  }catch{if(born!==sequence||signal.aborted)return;section.hidden=!text.textContent;button.hidden=true;}
 };
}
