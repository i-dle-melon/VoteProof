// Presentation allowlists only. Roles/MFA/CSRF/transactions are enforced by Worker.
export function backupText(copy) {
  const labels = Object.fromEntries(['pending','processing','confirmed','failed'].map(k=>[k,copy('backup-'+k)]));
  const errors = Object.fromEntries(['NETWORK','RATE_LIMIT','GOOGLE_UNAVAILABLE','OAUTH_REVOKED','OAUTH_CONFIG','CONFIG_MISSING','DRIVE_ACCESS_DENIED',
    'ROOT_INACCESSIBLE','DRIVE_FULL','SOURCE_MISSING','SOURCE_CHANGED','VERIFY_FAILED','UPLOAD_INCOMPLETE','INVALID_SOURCE','INTERNAL'].map(k=>[k,copy('backup-error-'+k)]));
  return { labels: Object.freeze(labels), errors: Object.freeze(errors) };
}
export const backupLink = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(id) ? 'https://drive.google.com/file/d/' + id + '/view' : null;

export function missingBackupDialog({ request, node, button, opener, message, onClose, jobStatus=null }) {
  const dialog = node('dialog', '', 'case-dialog backup-missing-dialog');
  dialog.setAttribute('aria-labelledby', 'backup-missing-title');
  const header = node('div', '', 'contact-titlebar'), title = node('h2', jobStatus?({pending:'已排入等待執行',processing:'備份中',confirmed:'成功備份',failed:'備份失敗'}[jobStatus]):'尚未排入備份');
  title.id = 'backup-missing-title';
  const close = button('關閉', () => dialog.close());header.append(title, close);
  const status = node('p'), error = node('p', '', 'notice warn'), list = node('div', '', 'backup-missing-list');
  status.setAttribute('role', 'status');error.setAttribute('role', 'alert');list.setAttribute('aria-label', '未排入備份清單');
  const pager = node('form', '', 'backup-pagination'), label = node('label', '頁碼'), input = node('input'), totalPages = node('span', '／ 1 頁');
  pager.dataset.backupListPagination = '';
  input.id = label.htmlFor = 'backup-missing-page';input.type = 'number';input.min = '1';input.max = '1';input.step = '1';input.value = '1';input.required = true;input.inputMode = 'numeric';
  let page = 1, pages = 1, loading = false;
  const previous = button('上一頁', () => void load(page - 1)), next = button('下一頁', () => void load(page + 1));
  const go = node('button', '前往', 'btn btn-white');go.type = 'submit';
  const retry = button('重試載入清單', () => void load(page));retry.hidden = true;
  label.append(input);pager.append(previous, label, totalPages, go, next);
  const sync = () => { previous.disabled = loading || page <= 1;next.disabled = loading || page >= pages;input.disabled = go.disabled = retry.disabled = loading;list.setAttribute('aria-busy', String(loading)); };
  async function load(target, canClamp = true) {
    if (loading || !dialog.open) return;
    loading = true;sync();status.textContent = '載入中…';error.textContent = '';retry.hidden = true;
    try {
      const data = await request(jobStatus?'backups/jobs?status='+jobStatus+'&page='+target:'backups/missing?page=' + target);
      if (!dialog.open || !dialog.isConnected) return;
      if (!Array.isArray(data.files) || data.files.length > 10 || data.page_size !== 10 || data.page !== target ||
          !Number.isSafeInteger(data.total) || data.total < 0 || data.total_pages !== Math.max(1, Math.ceil(data.total / 10))) throw {code:'SERVICE_UNAVAILABLE'};
      // The queue can change between clicks. Clamp an emptied last page once.
      if (target > data.total_pages) {
        if (!canClamp) throw {code:'SERVICE_UNAVAILABLE'};
        loading = false;await load(data.total_pages, false);return;
      }
      pages = data.total_pages;page = Math.min(target, pages);input.max = String(pages);input.value = String(page);totalPages.textContent = '／ ' + pages + ' 頁';
      list.replaceChildren();
      for (const file of data.files) {
        const row = node('article', '', 'member-case');
        row.append(node('h3', file.case_id), node('p', '檔案編號：' + file.file_id),
          node('p', (jobStatus?'工作建立時間：':'投稿時間：') + new Date(jobStatus?file.created_at*1000:file.created_at).toLocaleString('zh-TW', {timeZone:'Asia/Taipei', hour12:false})),
          node('p', jobStatus?'狀態：'+({pending:'已排入等待執行',processing:'備份中',confirmed:'成功',failed:'失敗'}[file.status])+' · 嘗試次數：'+file.attempts:
            '檔案格式：' + file.content_type + ' · 大小：' + Number(file.size).toLocaleString('zh-TW') + ' bytes'));
        if(jobStatus){
          if(file.started_at)row.append(node('p','最近執行：'+new Date(file.started_at*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})));
          if(file.next_attempt_at)row.append(node('p','下次可重試：'+new Date(file.next_attempt_at*1000).toLocaleString('zh-TW',{timeZone:'Asia/Taipei'})));
          if(file.last_error_code)row.append(node('p','錯誤代碼：'+file.last_error_code));
        }
        list.append(row);
      }
      if (!data.files.length) list.append(node('p', jobStatus?'目前沒有此狀態的備份工作。':'目前沒有尚未排入備份的圖片。'));
      status.textContent = '共 ' + data.total + ' 筆 · 第 ' + page + '／' + pages + ' 頁 · 每頁 10 筆';
    } catch (cause) {
      if (!dialog.open || !dialog.isConnected) return;
      status.textContent = '';error.textContent = message(cause);retry.hidden = false;input.value = String(page);
    } finally { loading = false;if (dialog.isConnected) sync(); }
  }
  pager.addEventListener('submit', event => { event.preventDefault();if (loading || !pager.reportValidity()) return;const target = Number(input.value);if (Number.isSafeInteger(target) && target >= 1 && target <= pages) void load(target); });
  dialog.addEventListener('click', event => { const rect = dialog.getBoundingClientRect();if (event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom)) dialog.close(); });
  dialog.addEventListener('close', () => { dialog.remove();onClose?.();if (opener.isConnected) opener.focus(); });
  dialog.append(header, status, error, list, retry, pager);document.body.append(dialog);dialog.showModal();close.focus();void load(1);
  return dialog;
}
