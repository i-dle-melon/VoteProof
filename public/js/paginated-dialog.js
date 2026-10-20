// Shared read-only dialog. Actual authentication and paging are enforced by the Worker.
export function pagedListDialog({ title, opener, fetchPage, itemsKey, renderRow, emptyText, message, onClose }) {
  const node = (tag, text = '', cls = '') => {const n=document.createElement(tag);n.textContent=text;if(cls)n.className=cls;return n;};
  const button = (label, action) => {const b=node('button',label,'btn btn-white');b.type='button';b.addEventListener('click',action);return b;};
  const dialog=node('dialog','','case-dialog backup-missing-dialog paginated-list-dialog');
  dialog.setAttribute('aria-label',title);
  const header=node('div','','contact-titlebar'),close=button('關閉',()=>dialog.close());
  header.append(node('h2',title),close);
  const status=node('p'),error=node('p','','notice warn'),list=node('div','','backup-missing-list');
  status.setAttribute('role','status');error.setAttribute('role','alert');list.setAttribute('aria-label',title+'清單');
  const retry=button('重試載入清單',()=>void load(page));retry.hidden=true;
  const pager=node('form','','backup-pagination');pager.dataset.historyListPagination='';
  const pageLabel=node('label','頁碼'),input=node('input'),totalPages=node('span','／ 1 頁');
  input.type='number';input.min='1';input.max='1';input.step='1';input.value='1';input.required=true;input.inputMode='numeric';
  pageLabel.append(input);
  const previous=button('上一頁',()=>void load(page-1)),next=button('下一頁',()=>void load(page+1));
  const go=node('button','前往','btn btn-white');go.type='submit';
  pager.append(previous,pageLabel,totalPages,go,next);
  let page=1,pages=1,loading=false;
  const sync=()=>{previous.disabled=loading||page<=1;next.disabled=loading||page>=pages;input.disabled=go.disabled=retry.disabled=loading;list.setAttribute('aria-busy',String(loading));};
  async function load(target,mayClamp=true){
    if(loading||!dialog.open||!Number.isSafeInteger(target)||target<1)return;
    loading=true;sync();status.textContent='載入中…';error.textContent='';retry.hidden=true;
    try{
      const data=await fetchPage(target);
      if(!dialog.open||!dialog.isConnected)return;
      if(!Array.isArray(data?.[itemsKey])||data[itemsKey].length>10||data.page_size!==10||data.page!==target||
         !Number.isSafeInteger(data.total)||data.total<0||data.total_pages!==Math.max(1,Math.ceil(data.total/10)))throw {code:'SERVICE_UNAVAILABLE'};
      if(target>data.total_pages){
        if(!mayClamp)throw {code:'SERVICE_UNAVAILABLE'};
        loading=false;await load(data.total_pages,false);return;
      }
      page=target;pages=data.total_pages;input.max=String(pages);input.value=String(page);totalPages.textContent='／ '+pages+' 頁';
      list.replaceChildren();
      for(const record of data[itemsKey])list.append(renderRow(record));
      if(!data[itemsKey].length)list.append(node('p',emptyText));
      status.textContent='共 '+data.total+' 筆 · 第 '+page+'／'+pages+' 頁 · 每頁 10 筆';
    }catch(cause){
      if(!dialog.open||!dialog.isConnected)return;
      status.textContent='';error.textContent=message(cause);retry.hidden=false;input.value=String(page);
    }finally{loading=false;if(dialog.isConnected)sync();}
  }
  pager.addEventListener('submit',event=>{event.preventDefault();if(loading||!pager.reportValidity())return;const target=Number(input.value);if(Number.isSafeInteger(target)&&target>=1&&target<=pages)void load(target);});
  dialog.addEventListener('click',event=>{const r=dialog.getBoundingClientRect();if(event.target===dialog&&(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom))dialog.close();});
  dialog.addEventListener('close',()=>{dialog.remove();onClose?.();if(opener.isConnected)opener.focus();});
  dialog.append(header,status,error,list,retry,pager);document.body.append(dialog);dialog.showModal();close.focus();void load(1);
  return dialog;
}
