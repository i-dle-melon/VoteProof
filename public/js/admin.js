import {renderStorage} from './admin-storage.js';
import { AdminAccess, dailyLimit, taipeiInput, utcFromTaipei, reviewActions, adminMessage, watchCampaignStatus } from "./admin-api.js";
import { proofThumbnails } from "./admin-proof-thumbnails.js";
import { PublicError } from "./api.js";
import { renderTierArtwork } from "./tier-artwork.js";
import { backupText, backupLink, missingBackupDialog } from "./admin-backup.js";
import { renderDuplicateEvidence } from './admin-duplicate.js';
import { renderImageExports } from './admin-export.js';
import { memberContactUI } from './admin-member-contact.js';
import { renderMemberOverview } from './admin-members-overview.js';
import { renderHealthMonitor } from './admin-health-monitor.js';

const $ = id => document.getElementById(id);
const copy = id => {
  const label = $("admin-ui-copy").content.getElementById(id);
  return label.textContent.trim() + (label.dataset.copySuffix ?? "");
};
const node = (tag, text = "", cls) => { const n = document.createElement(tag); n.textContent = text; if (cls) n.className = cls; return n; };
const { labels: backupLabels, errors: backupErrors } = backupText(copy);
const statusNames = { pending: copy("admin-copy-001"), approved: copy("admin-copy-002"), completed: copy("admin-copy-003"), rejected: copy("admin-copy-004"), duplicate: copy("admin-copy-005"), revoked: copy("admin-copy-006"), draft: copy("admin-copy-007"), active: copy("admin-copy-008"), closed: copy("admin-copy-009"), archived: copy("admin-copy-010"), disabled: copy("admin-copy-011") };
const riskNames={manual_flag:"人工標記",exact_duplicate:"相同檔案 evidence",auto_check_failed:"既有檢查失敗",other:"其他原因"};
const reviewNames = { flag_detailed:"轉詳細審核", approve: copy("admin-copy-012"), reject: copy("admin-copy-013"), mark_duplicate: copy("admin-copy-014"), complete: copy("admin-copy-015"), revoke: copy("admin-copy-016") };
const stamp = value => { const d = new Date(value); return Number.isFinite(d.valueOf()) ? d.toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false }) : "—"; };
const text = value => value == null ? "—" : String(value);
const button = (label, action, cls = "btn btn-white") => { const b = node("button", label, cls); b.type = "button"; b.addEventListener("click", action); return b; };
function field(form, name, label, type = "text", value = "", options = {}) {
  const wrap = node("div", "", "field"), caption = node("label", label), id = "admin-field-" + name;
  const control = node(type === "textarea" ? "textarea" : type === "select" ? "select" : "input");
  caption.htmlFor = control.id = id; control.name = name;
  if (type === "select") for (const [key, title] of options.choices ?? []) control.append(new Option(title, key));
  else if (type !== "textarea") control.type = type;
  control.value = value ?? ""; control.autocomplete = "off";
  for (const [key, val] of Object.entries(options)) if (key !== "choices") control[key] = val;
  wrap.append(caption, control); form.append(wrap); return control;
}
const value = (form, name) => form.elements.namedItem(name).value.trim();
const integer = (form, name, min, max) => {
  const raw = value(form, name), n = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(n) || n < min || n > max) throw new PublicError("INVALID_ADMIN_QUERY", 400);
  return n;
};
const submitButton = (form, label) => { const b = node("button", label, "btn btn-primary"); b.type = "submit"; form.append(b); };
const management = actor => ["admin", "super_admin"].includes(actor?.role);
const tabs = { overview: "工作總覽", members:'會員管理', healthMonitor:'系統健康監控', cases: copy("admin-copy-017"), backups: 'Google Drive 備份', announcements:'彈窗公告', exports: '圖片批次匯出', campaigns: copy("admin-copy-018"), leaderboards: copy("admin-copy-019"), tiers: copy("admin-copy-020"), blocks:'會員封鎖', submissions: copy("admin-copy-021"), audit: copy("admin-copy-022"), staff:'管理員管理' };
const canUseTab=(actor,key)=>key==='staff'?actor?.role==='super_admin':['cases','overview','exports'].includes(key)||management(actor);

export function adminUI(session) {
  let reviewMode="album",selectedReviews=new Map(),thumbnails=null;
  let boardsArchived = false;
  let reviewReport=null,reviewWorking=false,stopReview=false,caseFilterState={status:null,campaign:"",vote:"",search:""};
  const renderReviewReport=box=>{if(!reviewReport)return;box.append(node('p',reviewReport.summary,'notice info'));for(const row of reviewReport.failures)box.append(node('p',row.case_id+' · '+row.reason,'notice warn'));};
  document.addEventListener('click',e=>{if(reviewWorking&&e.target.closest('a[href]')){e.preventDefault();$('admin-status').textContent='審核仍在執行；請先安全停止並等候目前批次結果。';}},true);
  window.addEventListener('beforeunload',e=>{if(reviewWorking){e.preventDefault();e.returnValue='';}});
  const clearAlbumImages=()=>{thumbnails?.clear();thumbnails=null;};
  let expanded=null;
  let blockDialog=null;
  let backupDialog=null;
  let memberContact=null;
  let campaignWatches=[];
  let adminInsightsStop=null;
  function collapseReview(){if(!expanded)return;expanded.panel.remove();for(const b of expanded.card.querySelectorAll("[aria-controls]"))b.setAttribute("aria-expanded","false");clearImages();expanded=null;}
  let visible = false, tab = "cases", sequence = 0, busy = false, controller = new AbortController(), urls = [], confirmedRole = null;
  function clearImages() { for (const url of urls) URL.revokeObjectURL(url); urls = []; }
  function clearPanel() { adminInsightsStop?.();adminInsightsStop=null;for(const stop of campaignWatches)stop();campaignWatches=[];backupDialog?.close();backupDialog?.remove();backupDialog=null;memberContact?.cleanup();memberContact=null;blockDialog?.close();blockDialog?.remove();blockDialog=null;clearAlbumImages();selectedReviews.clear();collapseReview();sequence++; controller.abort(); controller = new AbortController(); clearImages(); $("admin-panel").replaceChildren(); $("admin-panel").setAttribute("aria-busy", "false"); $("admin-panel").inert = $("admin-tabs").inert = false; busy = false; }
  const access = new AdminAccess(session, actor => {
    $("admin-nav-group").hidden = $("member-admin-entry").hidden = !actor;
    $("admin-content").hidden = !actor; $("admin-gate").hidden = Boolean(actor);
    if (!actor) { reviewReport=null;confirmedRole = null; clearPanel(); $("admin-tabs").replaceChildren(); if (visible) $("admin-status").textContent = copy("admin-copy-023"); }
    else {
      const changedRole = confirmedRole && confirmedRole !== actor.role; confirmedRole = actor.role;
      if (changedRole) { clearPanel(); if (visible) queueMicrotask(() => void load()); }
    }
  });
  async function run(action, expected = sequence, {review=false}={}) {
    if (busy || !visible || expected !== sequence) return;
    busy = true; $("admin-panel").setAttribute("aria-busy", "true"); $("admin-status").textContent = copy("admin-copy-024");
    $("admin-panel").inert = !review; $("admin-tabs").inert = true;reviewWorking=review;
    const controls = [...$("admin-panel").querySelectorAll("button,input,select,textarea")]; const priorDisabled=new Map(controls.map(b=>[b,b.disabled]));for (const b of controls) b.disabled = !b.hasAttribute("data-review-stop");
    try {
      await action(() => visible && sequence === expected, { signal: controller.signal });
      if (sequence === expected && visible) $("admin-status").textContent = "";
    } catch (error) {
      if (["ADMIN_FORBIDDEN", "ADMIN_STEP_UP_REQUIRED", "AUTH_REQUIRED", "MEMBER_SUSPENDED"].includes(error.code) && access.actor) access.clear();
      if (visible && (sequence === expected || !access.actor)) {
        $("admin-status").textContent = adminMessage(error);
        // Uncertain/conflicting mutation is never repeated. Require an explicit
        // fresh read before the next edit, even if the old form remains visible.
        if (error.status === 409 && !expanded) { clearPanel(); $("admin-panel").append(button(copy("admin-copy-025"), () => void load())); }
      }
    } finally {
      reviewWorking=false;
      if (sequence === expected) { busy = false; $("admin-panel").setAttribute("aria-busy", "false"); $("admin-panel").inert = $("admin-tabs").inert = false; for (const b of controls) if (b.isConnected) b.disabled = b.dataset.reviewCommitted==='true'||b.closest('form')?.inert?true:priorDisabled.get(b);if($("admin-batch-approve"))$("admin-batch-approve").disabled=Number($("admin-batch-approve").dataset.selectionCount??0)<1; }
    }
  }
  const request = async (path, options = {}) => {
    const born = sequence, data = await access.request("/api/admin/" + path, { ...options, signal: controller.signal });
    if (!visible || born !== sequence) throw new PublicError("REQUEST_CANCELLED");
    return data;
  };
  const mutate = (path, body) => request(path, { method: "POST", body });
  function heading(title, copy) { $("admin-panel").append(node("h2", title)); if (copy) $("admin-panel").append(node("p", copy, "tiny")); }
  function formCard(title,container=$("admin-panel")) { const f = node("form", "", "admin-editor"); f.noValidate = false; f.append(node("h3", title)); container.append(f); return f; }
  function bindForm(form, action, errorTarget = null) {
    const born = sequence;
    // HTML validation can prevent the submit event entirely. Surface that failure
    // beside the Save button instead of silently ignoring the user's click.
    if (errorTarget) form.addEventListener("invalid", () => {
      errorTarget.textContent = "請確認必填欄位及輸入格式；尚未送出保存。";
    }, true);
    form.addEventListener("submit", event => { event.preventDefault(); if (!form.reportValidity()) return;
      if(errorTarget) errorTarget.textContent = "";
      void run(async current => {
        if (!window.confirm(copy("admin-copy-026"))) return;
        try {
          await action(); if (current()) { await load(); $("admin-status").textContent = copy("admin-copy-027"); }
        } catch (error) {
          if (errorTarget?.isConnected) {
            errorTarget.textContent = adminMessage(error);
            errorTarget.scrollIntoView({block:"nearest"});
          }
          throw error;
        }
      }, born);
    });
  }
  function rowsTable(rows, fields) {
    const wrap = node("div", "", "table-wrap"), table = node("table"), head = node("tr"), body = node("tbody");
    for (const [, label] of fields) { const th = node("th", label); th.scope = "col"; head.append(th); }
    const thead = node("thead"); thead.append(head); table.append(thead);
    for (const row of rows) { const tr = node("tr"); for (const [key] of fields) tr.append(node("td", text(row[key]))); body.append(tr); }
    table.append(body); wrap.append(table); return wrap;
  }
  function detailFields(data, fields) {
    const dl = node("dl", "", "case-details");
    for (const [label, val] of fields) dl.append(node("dt", label), node("dd", text(val)));
    return dl;
  }
  async function paged(path, key, render, filters = new URLSearchParams(), { accept = () => true, emptyMessage } = {}) {
    const list = node("div", "", path === "cases" ? "admin-case-list"+(reviewMode==="album"?" review-album":"") : "grid grid-2"), more = button(copy("admin-copy-028"), () => void run(async current => { await page(cursor, current); }));
    let cursor = null; const born = sequence;
    const page = async (after, current = () => sequence === born && visible) => {
      const previousCount = list.children.length, seen = new Set(after ? [after] : []);
      do {
        const params = new URLSearchParams(filters); params.set("limit", "20"); if (after) params.set("cursor", after);
        const data = await request(path + "?" + params);
        if (!current()) return;
        if (!Array.isArray(data[key])) throw new PublicError("SERVICE_UNAVAILABLE");
        if(key==="leaderboards" && !after)for(const row of data.system_boards??[])if(accept(row))list.append(render(row));
        for (const row of data[key]) if(accept(row))list.append(render(row));
        cursor = data.next_cursor;
        if (cursor && seen.has(cursor)) throw new PublicError("SERVICE_UNAVAILABLE");
        if (cursor) seen.add(cursor);
        after = cursor;
      } while (cursor && list.children.length === previousCount);
      more.hidden = !cursor;
      if (!list.children.length) list.append(node("p", emptyMessage ?? (path === "cases" ? copy("admin-copy-029") : path === "audit-logs" ? copy("admin-copy-030") : copy("admin-copy-031"))));
    };
    $("admin-panel").append(list, more); await page(null);
  }
  async function cases() {
    heading(copy("admin-copy-017"), copy("admin-copy-032"));
    const modes=node("nav","","tabs review-modes");modes.setAttribute("aria-label","審核工作流程");
    for(const [key,label] of [["album","相簿快速初審"],["detailed","詳細審核"],["all","全部案件"]]){const b=button(label,()=>{if(busy)return;reviewMode=key;caseFilterState.status=null;void load();},"tab");b.setAttribute("aria-pressed",String(reviewMode===key));modes.append(b);}$("admin-panel").append(modes);
    const filters = node("form", "", "admin-filter"), params = new URLSearchParams();
    if(reviewMode!=="all"){params.set("review_stage",reviewMode==="album"?"initial":"detailed");params.set("status","pending");}
    const status = field(filters, "filter-status", copy("admin-copy-033"), "select", caseFilterState.status??(reviewMode==="all"?"":"pending"), { choices: [["", copy("admin-copy-034")], ...["pending", "approved", "completed", "rejected", "duplicate", "revoked"].map(k => [k, statusNames[k]])] });
    const campaign = field(filters, "filter-campaign", copy("admin-copy-035"), "text", caseFilterState.campaign, { maxLength: 100 });
    const vote = field(filters, "filter-vote", copy("admin-copy-036"), "select", caseFilterState.vote, { choices: [["", copy("admin-copy-034")], ["Solo", "Solo"], ["團體", "團體"]] });
    const search=field(filters,"filter-search","搜尋已載入案件 / 暱稱 / 粉絲 ID","search",caseFilterState.search,{maxLength:100});
    params.delete("status");if(status.value)params.set("status",status.value);if(campaign.value)params.set("campaign_id",campaign.value);if(vote.value)params.set("vote_type",vote.value);
    const matches=row=>[row.case_id,row.nickname,row.player_id].filter(Boolean).join(" ").toLocaleLowerCase().includes(search.value.trim().toLocaleLowerCase());
    search.addEventListener("input",()=>{clearSelection();caseFilterState.search=search.value;for(const card of $("admin-panel").querySelectorAll(".admin-case-row"))card.hidden=!card.dataset.search.includes(search.value.trim().toLocaleLowerCase());});
    submitButton(filters, copy("admin-copy-037"));const filterDisclosure=node("details","","review-filter-disclosure");filterDisclosure.open=reviewMode==="all";filterDisclosure.append(node("summary","篩選案件：活動 / 類型 / 搜尋"),filters);$("admin-panel").append(filterDisclosure);
    const statusTabs=node("div","","tabs admin-status-tabs");statusTabs.setAttribute("aria-label","案件狀態篩選");(reviewMode==="album"?filterDisclosure:$("admin-panel")).append(statusTabs);
    const area = node("section"); $("admin-panel").append(area);
    const batchBox=node("section","","batch-review-controls"),batchCount=node("p","尚未選擇案件"),batchStatus=node("div","","batch-review-results");batchStatus.setAttribute("role","status");
    let selectionMode='manual',allSelection=null;
    const selectable=new Map();
    const inAllScope=row=>Boolean(allSelection&&row.created_at<=allSelection.cutoff&&row.updated_at<=allSelection.cutoff);
    function clearSelection(){selectionMode='manual';allSelection=null;selectedReviews.clear();syncSelected();}
    const progress=node('progress'),progressText=node('p');progress.hidden=true;progress.setAttribute('aria-label','審核進度');
    const stop=button('停止後續批次',()=>{stopReview=true;progressText.textContent+=' · 已要求停止，等待目前批次的正式結果。';});stop.dataset.reviewStop='';stop.hidden=true;
    async function executeReview(){
      if(busy)return;
      const all=selectionMode==='all',plan=allSelection;
      if(all?!plan?.total:!selectedReviews.size)return;
      const born=sequence;let finished=false;
      await run(async current=>{
        let total,cutoff,queue=[],cursor=null,more=all;stopReview=false;
        const nextPage=async()=>{const params=new URLSearchParams({cutoff});if(cursor)params.set('cursor',cursor);
          const page=await request('cases/initial-review?'+params);queue=page.cases;cursor=page.next_cursor;more=Boolean(cursor);
          if(!Array.isArray(queue)||queue.length>20)throw new PublicError('SERVICE_UNAVAILABLE');};
        if(all){total=plan.total;cutoff=plan.cutoff;
          // Revalidate access with the first required metadata page, then reuse
          // that page after confirmation; never fetch the COUNT a second time.
          await nextPage();if(!current())return;
          if(!window.confirm('確定要通過已選的全站 '+total+' 件待審初審案件嗎？\n選取截止時間：'+cutoff+'\n此操作將正式變更案件審核狀態，並可能發放會員積分。截止後新增或變更的案件不會納入。'))return;
        }else{queue=[...selectedReviews.values()].map(r=>({case_id:r.case_id,expected_version:r.version}));total=queue.length;if(!total)return;
          if(!window.confirm('確認通過以下明確案件 ID？\n'+queue.map(r=>r.case_id).join('\n')))return;}
        const report={summary:'',failures:[]};reviewReport=report;batchStatus.replaceChildren();progress.hidden=stop.hidden=false;progress.max=total;progress.value=0;
        let done=0,success=0,failed=0;
        const update=()=>{progress.value=done;progressText.textContent='已處理 '+done+'／'+total+' · '+Math.floor(done/total*100)+'% · 成功 '+success+' · 失敗 '+failed+' · 剩餘 '+Math.max(0,total-done);};update();
        try{
          while(current()&&!stopReview&&(queue.length||more)){
            if(!queue.length){await nextPage();if(!queue.length)continue;}
            const chunk=queue.splice(0,4);let result,uncertain=false;
            try{result=await mutate('cases/batch-approve',{cases:chunk});}
            catch(error){uncertain=true;stopReview=true;
              try{result=await request('cases/batch-status?items='+encodeURIComponent(JSON.stringify(chunk)));}
              catch{result={results:chunk.map(r=>({case_id:r.case_id,ok:false,code:'REVIEW_RESULT_UNCONFIRMED'}))};}}
            if(!current())return;
            if(!Array.isArray(result.results)||result.results.length!==chunk.length||new Set(result.results.map(r=>r.case_id)).size!==chunk.length||result.results.some(r=>!chunk.some(c=>c.case_id===r.case_id)))throw new PublicError('SERVICE_UNAVAILABLE');
            for(const row of result.results){
              done++;
              if(row.ok&&['approved','completed'].includes(row.status)){success++;selectedReviews.delete(row.case_id);}
              else{failed++;report.failures.push({case_id:row.case_id,reason:row.code==='REVIEW_RESULT_UNCONFIRMED'?'結果尚未確認；請重新讀取案件及稽核，未自動重送。':adminMessage(row)+' ('+(row.code??'SERVICE_UNAVAILABLE')+')'});}
            }
            update();if(uncertain)progressText.textContent+=' · 上批回覆曾中斷，已停止後續提交。';
          }
        }catch(error){report.failures.push({case_id:'尚未提交批次',reason:adminMessage(error)});}
        finally{
          stop.hidden=true;
          report.summary=progressText.textContent+(done<total?' · 未提交或條件已變更：'+(total-done):'')+(stopReview?' · 已停止。':' · 處理完成。');
          batchStatus.replaceChildren();renderReviewReport(batchStatus);finished=true;
          try{await request('overview');}catch{report.summary+=' · 工作總覽更新失敗，可稍後重試；已通過結果不受影響。';}
        }
      },sequence,{review:true});
      // run() must release busy/inert before load() creates a new sequence.
      if(finished&&visible&&tab==='cases'&&sequence===born){
        try{await load();}catch{}
        if(reviewReport&&$('admin-panel')){
          if(!$('admin-panel').querySelector('.batch-review-results')){const saved=node('section','','batch-review-results');renderReviewReport(saved);$('admin-panel').prepend(saved);}
        }
      }
    }
    const approveSelected=button('通過已選案件',()=>void executeReview(),'btn btn-primary');approveSelected.id='admin-batch-approve';
    const approveAll=button('選取全部未審案件',()=>void selectAll());approveAll.id='admin-approve-all';
    const pickLoaded=button('選取前20張初審案件',()=>{
      if(busy)return;if(selectionMode==='first20'){clearSelection();return;}clearSelection();
      for(const {row,box,card} of selectable.values()){if(selectedReviews.size>=20)break;if(!box.isConnected||box.disabled||card.hidden)continue;selectedReviews.set(row.case_id,row);}
      selectionMode=selectedReviews.size?'first20':'manual';syncSelected();
    });
    function syncSelected(){
      const total=selectionMode==='all'?allSelection.total:selectedReviews.size;
      batchCount.textContent=selectionMode==='all'?'已選全站 '+total+' 件合格初審案件（含未載入；不受本頁篩選限制）':selectionMode==='first20'?'已選目前可見前 '+total+' 件初審案件':'已選 '+total+' 筆明確案件';
      approveSelected.dataset.selectionCount=String(total);approveSelected.disabled=busy||!total;
      for(const [b,active]of [[pickLoaded,selectionMode==='first20'],[approveAll,selectionMode==='all']]){b.setAttribute('aria-pressed',String(active));b.classList.toggle('btn-primary',active);b.classList.toggle('btn-white',!active);}
      for(const {row,box}of selectable.values())box.checked=selectionMode==='all'?inAllScope(row):selectedReviews.has(row.case_id);
    }
    async function selectAll(){
      if(busy)return;if(selectionMode==='all'){clearSelection();return;}clearSelection();const born=sequence;
      await run(async current=>{
        const plan=await request('cases/initial-review');if(!current())return;
        if(!Number.isSafeInteger(plan.total)||plan.total<0||typeof plan.cutoff!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(plan.cutoff)||!Number.isFinite(Date.parse(plan.cutoff)))throw new PublicError('SERVICE_UNAVAILABLE');
        if(!plan.total){batchStatus.replaceChildren(node('p','目前沒有符合條件的待審初審案件。'));return;}
        allSelection={total:plan.total,cutoff:plan.cutoff};selectionMode='all';syncSelected();
      },born);
    }
    batchBox.hidden=reviewMode!=="album";batchBox.append(batchCount,approveAll,pickLoaded,approveSelected,progress,progressText,stop,node("p","選取不會核准；只有「通過已選案件」確認後才送出。全部模式手動改選時會清除全選，改為最多20件明確選取。成功不重送，版本衝突需重新載入。","tiny"),batchStatus);$("admin-panel").append(batchBox);renderReviewReport(batchStatus);
    const render = row => {
      const card=node("article","","member-case admin-case-row"),summary=node("div","","case-summary"),player=node("div","","review-person"),actions=node("div","","review-actions");
      const image=button("🖼️",()=>void caseDetail(row.case_id),"case-icon case-preview");image.setAttribute("aria-label","查看證明與審核 "+row.case_id);
      summary.append(node("strong",row.case_id+" · "+(row.source==="guest"?"匿名投稿":row.nickname??"—")),node("p",[row.campaign_name??row.campaign_id,row.vote_type,stamp(row.created_at)].filter(Boolean).join("｜")));
      player.append(node("strong",row.source==="guest"?"匿名投稿":row.player_id??"未提供"),node("p",row.source==="guest"?"投稿身份":"粉絲 ID"));
      const state=node("span",statusNames[row.status]??copy("admin-copy-038"),"status");if(Object.hasOwn(statusNames,row.status))state.classList.add(row.status);
      const allowed=reviewActions(row.status,access.actor.role);
      for(const [action,label] of [["approve","通過"],["reject","駁回"]])if(allowed.includes(action))actions.append(button(label,()=>void caseDetail(row.case_id,action)));
      actions.append(button(copy("admin-copy-039"),()=>void caseDetail(row.case_id)));
      card.dataset.caseId=row.case_id;
      let photo=null;
      if(reviewMode==="album"){
        card.classList.add("album-case");
        photo=node("div","","album-photo");photo.append(image);image.replaceChildren();
        summary.hidden=player.hidden=state.hidden=actions.hidden=true;
        if(row.status==="pending" && (row.review_stage??"initial")==="initial" && !row.review_risk_reason){
          const label=node("label","","album-select"),checkbox=node("input"),circle=node("span","","album-check");checkbox.type="checkbox";checkbox.dataset.reviewSelect="";checkbox.setAttribute("aria-label","選取案件 "+row.case_id);circle.setAttribute("aria-hidden","true");label.append(checkbox,circle);photo.append(label);
          selectable.set(row.case_id,{row,box:checkbox,card});checkbox.checked=selectionMode==='all'?inAllScope(row):selectedReviews.has(row.case_id);
          checkbox.addEventListener("change",()=>{const checked=checkbox.checked;if(selectionMode==='all')clearSelection();selectionMode='manual';if(checked && selectedReviews.size>=20 && !selectedReviews.has(row.case_id)){syncSelected();return;}if(checked)selectedReviews.set(row.case_id,{...row});else selectedReviews.delete(row.case_id);syncSelected();});
        }

      }
      thumbnails.observe(image,row);
      if(row.review_stage==="detailed")summary.append(node("span","詳細審核 · "+(riskNames[row.review_risk_reason]??"其他原因"),"tiny"));
      for(const b of [image,...actions.children]){b.setAttribute("aria-expanded","false");b.setAttribute("aria-controls","review-"+row.case_id);}
      card.dataset.search=[row.case_id,row.nickname,row.player_id].filter(Boolean).join(" ").toLocaleLowerCase();card.hidden=!matches(row);
      card.addEventListener("click",event=>{if(!event.target.closest("button,a,label,input,select,textarea,.inline-review"))void caseDetail(row.case_id);});
      card.append(photo??image,summary,player,state,actions);return card;
    };
    const loadFiltered = async () => {
      // Lists are attached to the panel; remove only the prior list/page button.
      collapseReview();clearAlbumImages();clearSelection();selectable.clear();while (batchBox.nextSibling) batchBox.nextSibling.remove();
      const born=sequence;thumbnails=proofThumbnails({session,signal:controller.signal,isCurrent:()=>visible&&sequence===born,onAuthError:()=>access.clear()});
      await paged("cases", "cases", render, params);
    };
    const syncTabs=()=>{for(const tab of statusTabs.children){const active=tab.dataset.status===status.value;tab.classList.toggle("active",active);tab.setAttribute("aria-pressed",String(active));}};
    for(const key of ["","pending","duplicate","approved","completed","rejected","revoked"]){const tab=button(key?statusNames[key]:"全部",()=>{if(busy)return;status.value=key;filters.requestSubmit();},"tab");tab.dataset.status=key;statusTabs.append(tab);}syncTabs();
    filters.addEventListener("submit", event => { event.preventDefault(); if (busy) return; params.delete("status"); params.delete("campaign_id"); params.delete("vote_type");
      if (status.value) params.set("status", status.value); if (campaign.value.trim()) params.set("campaign_id", campaign.value.trim()); if (vote.value) params.set("vote_type", vote.value);
      caseFilterState={status:status.value,campaign:campaign.value.trim(),vote:vote.value,search:search.value};syncTabs();
      void run(loadFiltered);
    }); await loadFiltered();
  }
  async function backupOverview() {
    const box = node('section', '', 'member-case'); $('admin-panel').append(box);
    box.append(node('h3', copy('backup-title')));
    try {
      const data = await request('backups');
      renderStorage(box,data.storage,{node,button:(label,action)=>button(label,()=>void run(action)),mutate,reload:load,request,message:adminMessage,dialogActive:()=>busy||backupDialog?.open,onDialog:d=>{backupDialog=d;},onDialogClosed:d=>{if(backupDialog===d)backupDialog=null;}});
      box.append(node('p','未建立備份工作：'+data.missing+' · 已排入等待執行：'+data.counts.pending+' · 備份中：'+data.counts.processing+' · 成功：'+data.counts.confirmed+' · 失敗：'+data.counts.failed));
      const jobs=node('details');jobs.append(node('summary','備份工作清單（已排入）'));
      for(const [key,label] of Object.entries(backupLabels)){const open=button(label+'：'+data.counts[key],()=>{
        if(busy||backupDialog?.open)return;backupDialog=missingBackupDialog({request,node,button,opener:open,message:adminMessage,jobStatus:key,onClose:()=>{backupDialog=null;}});
      });jobs.append(open);}box.append(jobs);
      if (!data.ready) box.append(node('p', copy(data.enabled ? 'backup-unconfigured' : 'backup-off'), 'tiny'));
      if (data.transport === 'apps_script_pull') box.append(node('p', copy('backup-relay'), 'tiny'));
      if (data.transport === 'apps_script_pull' && data.ready) box.append(node('p', copy('backup-ready'), 'tiny'));
      if (data.blocked_error_code) box.append(node('p', backupErrors[data.blocked_error_code] ?? backupErrors.INTERNAL, 'notice warn'));
      const missing = node('details');
      missing.append(node('summary', copy('backup-missing') + '：' + data.missing));
      const showMissing = button('查看未排入備份清單', () => {
        if (busy || backupDialog?.open) return;
        const dialog = missingBackupDialog({request, node, button, opener:showMissing, message:adminMessage, onClose:() => { if(backupDialog===dialog)backupDialog=null; }});
        backupDialog=dialog;
      });
      missing.append(showMissing);box.append(missing);
      // A bounded dry run first; enqueue requires a separate explicit confirmation.
      if (data.missing) missing.append(button(copy('backup-check'), () => void run(async () => {
        const preview = await mutate('backups/backfill', { dry_run: true, limit: 25 });
        missing.append(node('p', copy('backup-check-summary').replaceAll('{scanned}',preview.scanned).replaceAll('{ready}',preview.ready.length).replaceAll('{missing}',preview.missing.length).replaceAll('{changed}',preview.changed.length)));
        if (data.ready === true && preview.ready.length) missing.append(button(copy('backup-enqueue'), () => void run(async () => {
          if (!window.confirm(copy('backup-enqueue-confirm'))) return;
          await mutate('backups/backfill', { dry_run: false, file_ids: preview.ready }); await load();
        })));
      })));
      const auditHistory=node('details');auditHistory.append(node('summary','排入／重試操作歷史（不代表目前待執行）'));missing.append(auditHistory);
      for (const audit of data.audit ?? []) auditHistory.append(node('p', copy(audit.target_id?.startsWith('process:') ? 'backup-process' : audit.action === 'retry' ? 'backup-retry' : 'backup-enqueue') + ` · ${audit.affected_count} · ` + stamp(audit.created_at * 1000), 'tiny'));
    } catch (error) {
      if (['ADMIN_FORBIDDEN','ADMIN_STEP_UP_REQUIRED','AUTH_REQUIRED','MEMBER_SUSPENDED','REQUEST_CANCELLED'].includes(error.code)) throw error;
      box.append(node('p', copy('backup-unavailable'), 'tiny'));
    }
  }
  async function caseDetail(id, preferredAction = null) {
    if (busy) return;
    if(expanded?.id===id && !preferredAction){collapseReview();return;}
    collapseReview();
    const card=[...$("admin-panel").querySelectorAll(".admin-case-row")].find(c=>c.dataset.caseId===id);if(!card)return;
    const panel=node("section","","inline-review");panel.id="review-"+id;panel.setAttribute("aria-label","案件審核 "+id);card.append(panel);expanded={id,panel,card};
    for(const b of card.querySelectorAll("[aria-controls]"))b.setAttribute("aria-expanded","true");
    panel.append(button("收合",()=>collapseReview(),"btn btn-white review-collapse"));
    await run(async current => {
      const data = await request("cases/" + encodeURIComponent(id)); if (!current()) return;
      panel.append(detailFields(data, [[copy("admin-copy-041"), data.case_id], [copy("admin-copy-042"), data.source==="guest"?"匿名投稿":data.nickname], [copy("admin-copy-043"), data.source==="guest"?"匿名投稿，沒有粉絲 ID":data.player_id], [copy("admin-copy-044"), data.campaign_id], [copy("admin-copy-045"), data.vote_date], [copy("admin-copy-046"), data.vote_type], [copy("admin-copy-047"), stamp(data.created_at)], [copy("admin-copy-048"), statusNames[data.status]], [copy("admin-copy-049"), data.status_reason], [copy("admin-copy-050"), data.note], [copy("admin-copy-051"), data.points_awarded]]));
      const backupBox = node('section', '', 'member-case'); backupBox.append(node('h3', copy('backup-title'))); $('admin-panel').append(backupBox);
      try {
        const backups = await request('cases/' + encodeURIComponent(id) + '/backups');
        if (!backups.ready) backupBox.append(node('p', copy(backups.enabled ? 'backup-unconfigured' : 'backup-off'), 'tiny'));
        if (!backups.backups.length) backupBox.append(node('p', copy('backup-missing')));
        for (const item of backups.backups) {
          backupBox.append(node('p', backupLabels[item.status] ?? copy('backup-unknown')));
           if(item.archive_state==='cold')backupBox.append(node('p','已封存至 Google Drive；此圖片不再提供網站預覽或下載。','notice'));
          if (item.status === 'confirmed') {
            backupBox.append(node('p', stamp(item.completed_at * 1000)));
            const href = backupLink(item.drive_file_id);
            if (href) { const a = node('a', copy('backup-open')); a.href = href; a.target = '_blank'; a.rel = 'noopener noreferrer'; backupBox.append(a); }
          }
          if (item.status === 'failed') {
            backupBox.append(node('p', backupErrors[item.last_error_code] ?? backupErrors.INTERNAL));
            if (backups.ready === true && management(access.actor)) backupBox.append(button(copy('backup-retry'), () => void run(async () => {
              if (!window.confirm(copy('backup-retry-confirm'))) return;
              await mutate('backups/' + item.id + '/retry', { expected_version: item.version }); await load();
            })));
          }
          if (backups.transport === 'deprecated_worker_oauth' && backups.ready === true && management(access.actor) && (item.status === 'pending' || (item.status === 'failed' && item.next_attempt_at != null))) {
            backupBox.append(button(copy('backup-process'), () => void run(async () => {
              if (!window.confirm(copy('backup-process-confirm'))) return;
              const result = await mutate('backups/' + item.id + '/process', {});
              if (result.state === 'failed' || result.state === 'unavailable') throw { code: 'BACKUP_PROCESS_FAILED' };
              await load();
            })));
          }
        }
      } catch (error) {
        if (['ADMIN_FORBIDDEN','ADMIN_STEP_UP_REQUIRED','AUTH_REQUIRED','MEMBER_SUSPENDED','REQUEST_CANCELLED'].includes(error.code)) throw error;
        backupBox.append(node('p', copy('backup-proof-unavailable')));
      }
      panel.append(node("p",data.source==="guest"?"匿名投稿：審核不產生會員積分。":"通過後才依活動規則發點；駁回不計分，撤銷以正式 ledger 沖回。","notice info"));
      if(data.duplicate_evidence!==null)panel.append(renderDuplicateEvidence(data.duplicate_evidence));
      const preview = node("div", "", "admin-proof-grid"); panel.append(preview);
      for (const [index,file] of data.files.entries()) {
        const imageCard=node("article","正在載入證明…","member-case");preview.append(imageCard);
        try {
          await access.check(controller.signal);
          const blob=await session.adminProof("/api/admin/cases/"+data.case_id+"/files/"+file.file_id,controller.signal);
          if(!current() || expanded?.panel!==panel)return;
          const url=URL.createObjectURL(blob),img=node("img");urls.push(url);img.src=url;img.alt=copy("admin-copy-053")+(index+1);imageCard.replaceChildren(img);
        } catch(error) {
          if(["ADMIN_FORBIDDEN","ADMIN_STEP_UP_REQUIRED","AUTH_REQUIRED","MEMBER_SUSPENDED"].includes(error.code))throw error;
          if(error.code==='PROOF_ARCHIVED_IN_DRIVE')imageCard.replaceChildren(node('p',adminMessage(error),'notice'));
          else imageCard.replaceChildren(node("p",adminMessage(error)),button("重試載入案件",()=>{collapseReview();void caseDetail(id);}));
        }
      }
      const choices = reviewActions(data.status, access.actor.role);if(data.status==="pending" && (data.review_stage??"initial")==="initial")choices.push("flag_detailed"); if (!choices.length) { panel.append(node("p", copy("admin-copy-054"))); return; }
      const form = formCard(copy("admin-copy-055"),panel);form.dataset.previewReview="";
      const action = field(form, "action", copy("admin-copy-056"), "select", choices.includes(preferredAction) ? preferredAction : choices[0], { choices: choices.map(key => [key, reviewNames[key]]) });
      const risk=field(form,"review_risk_reason","詳細審核原因","select",data.review_risk_reason??"manual_flag",{choices:Object.entries(riskNames)});
      const reason = field(form, "reason", copy("admin-copy-049"), "textarea", "", { maxLength: 500 });
      const duplicate = field(form, "duplicate", copy("admin-copy-057"), "text", "", { maxLength: 28 });
      const sync = () => {risk.closest(".field").hidden=action.value!=="flag_detailed";risk.disabled=action.value!=="flag_detailed";reason.required = action.value==="flag_detailed" && risk.value==="other" || ["reject", "mark_duplicate", "revoke"].includes(action.value); duplicate.disabled = action.value !== "mark_duplicate"; duplicate.required = !duplicate.disabled; };
      risk.addEventListener("change",sync);action.addEventListener("change", sync); sync(); submitButton(form, copy("admin-copy-058"));
      const errorText=node("p","","notice warn");errorText.setAttribute("role","alert");form.append(errorText);
      form.addEventListener("submit",event=>{event.preventDefault();if(form.inert || !form.reportValidity())return;
        void run(async stillCurrent=>{
          if(!window.confirm(copy("admin-copy-026")))return;
          try {
            const working=node('progress');working.setAttribute('aria-label','案件審核處理中');panel.append(working);
            const position=scrollY;const result=await mutate("cases/"+data.case_id+"/review",{action:action.value,expected_version:data.version,reason:reason.value.trim()||null,...(action.value==="flag_detailed"?{review_risk_reason:risk.value}:{}),...(action.value==="mark_duplicate"?{duplicate_of_case_id:duplicate.value.trim()}:{})});
            if(!stillCurrent())return;
            await request("overview").catch(()=>{});
            const state=card.querySelector(":scope > .status");if(state){state.className="status "+result.status;state.textContent=statusNames[result.status]??"已更新";}
            collapseReview();selectedReviews.delete(data.case_id);const check=card.querySelector("[data-review-select]");if(check){check.checked=false;check.disabled=true;check.dataset.reviewCommitted="true";}if($("admin-batch-approve"))$("admin-batch-approve").disabled=!selectedReviews.size;
            if(result.review_stage==="detailed" && reviewMode==="album")card.hidden=true;
            const filter=$("admin-field-filter-status");if(filter?.value && result.status!==filter.value)card.hidden=true;
            if(card.hidden)thumbnails?.release(data.case_id);
            scrollTo({top:Math.min(position,Math.max(0,document.documentElement.scrollHeight-innerHeight)),behavior:"instant"});
          } catch(error){
            errorText.textContent=adminMessage(error);
            if(error.status===409){form.inert=true;for(const el of form.elements)el.disabled=true;panel.append(button("重新載入案件",()=>{collapseReview();void caseDetail(id);}));}
            throw error;
          }finally{panel.querySelector("progress")?.remove();}
        },sequence,{review:true});
      });
    });
  }
  async function campaigns() {
    heading(copy("admin-copy-018"), copy("admin-copy-059"));
    $("admin-panel").append(button(copy("admin-copy-060"), () => campaignEditor(null), "btn btn-primary"));
    await paged("campaigns", "campaigns", row => {
      // Classification is Admin metadata; historical unknown IDs stay visible.
      const c = node("article", "", "member-case"), badge=node("span","","status");
      campaignWatches.push(watchCampaignStatus(row,status=>{badge.textContent=statusNames[status];}));
      c.append(node("h3", row.name), badge, node("p",'活動分類：'+row.category+(row.solo_target?' · '+row.solo_target:'')), node("p", stamp(row.start_at) + " ～ " + stamp(row.end_at) + copy("admin-copy-061")), node("p", `每次通過 ${row.points_per_proof} 點 · ` + (row.daily_limit === null ? copy("admin-copy-062") : row.daily_limit === 0 ? copy("admin-copy-063") : `每日最多 ${row.daily_limit} 次計分`)), button(row.status === "archived" ? copy("admin-copy-064") : copy("admin-copy-065"), () => campaignEditor(row))); return c;
    });
  }
  async function campaignEditor(row) {
    if (busy) return; clearPanel(); heading(copy("admin-copy-018"), copy("admin-copy-066"));
    const born=sequence;let targets,content={submission_instructions:'',example_asset_id:null};
    try { const data=await request('solo-targets'); if(born!==sequence || !visible)return;
      if(!Array.isArray(data.targets))throw new PublicError('SERVICE_UNAVAILABLE');targets=data.targets;
      if(row){content=await request('campaigns/'+row.campaign_id+'/guidance');if(born!==sequence||!visible)return;}
    } catch(error) {if(born===sequence)$('admin-status').textContent=adminMessage(error);return;}
    const f = formCard(row ? copy("admin-copy-065") : copy("admin-copy-060")), locked = row && row.status !== "draft";
    f.dataset.campaignEditor='';
    if (!row) field(f, "campaign_id", copy("admin-copy-067"), "text", "", { required: true, placeholder: "英文、數字、連字號或底線", pattern: "[A-Za-z0-9][A-Za-z0-9_-]{0,99}", maxLength: 100 });
    field(f, "name", copy("admin-copy-068"), "text", row?.name, { required: true, maxLength: 100 }); const category=field(f, "category", copy("admin-copy-069"), "select", row?.category??"Solo", { required: true, choices:[["Solo","Solo"],["團體","團體"]],disabled:Boolean(locked || row?.solo_target) });
    const choices=[['','請選擇 Solo 對象'],...targets.filter(t=>t.active).map(t=>[t.target_id,t.display_name])];
    if(row?.solo_target && !targets.some(t=>t.target_id===row.solo_target && t.active)) choices.push([row.solo_target,row.solo_target+'（歷史／已停用，僅供檢視）']);
    const target=field(f,"solo_target","Solo 對象","select",row?.solo_target??"",{choices,disabled:Boolean(row?.solo_target)});
    f.append(node("p","活動分類由管理員設定；投稿者只選活動。Solo 對象用於活動藝人識別，建立後無法修改；所有 Solo 積分統一累計至 Solo 總排行。","tiny"));
    const syncCategory=()=>{target.closest(".field").hidden=category.value!=="Solo";target.required=category.value==="Solo";target.disabled=category.value!=="Solo" || Boolean(row?.solo_target);};category.addEventListener("change",syncCategory);syncCategory();
    field(f, "start_at", copy("admin-copy-070"), "datetime-local", taipeiInput(row?.start_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "end_at", copy("admin-copy-071"), "datetime-local", taipeiInput(row?.end_at), { required: true, step: 1, disabled: Boolean(locked) });
    field(f, "campaign_timezone", copy("admin-copy-072"), "text", row?.campaign_timezone ?? "Asia/Taipei", { required: true, maxLength: 100, disabled: Boolean(locked) });
    field(f, "points_per_proof", copy("admin-copy-073"), "number", row?.points_per_proof ?? 10, { required: true, min: 0, max: 1000000, step: 1 });
    const mode = field(f, "daily_mode", copy("admin-copy-074"), "select", !row || row.daily_limit === null ? "unlimited" : row.daily_limit === 0 ? "zero" : "limited", { choices: [["unlimited", copy("admin-copy-075")], ["zero", copy("admin-copy-076")], ["limited", copy("admin-copy-077")]] });
    const cap = field(f, "daily_limit", copy("admin-copy-078"), "number", row?.daily_limit ?? "", { min: 1, max: 1000, step: 1 });
    const sync = () => { cap.disabled = mode.value !== "limited"; cap.required = !cap.disabled; }; mode.addEventListener("change", sync); sync();
    const statuses = row ? ({ draft: ["draft", "active", "archived"], active: ["active", "closed"], closed: ["closed", "archived"], archived: ["archived"] }[row.status]) : ["draft", "active"];
    const statusControl=field(f, "status", copy("admin-copy-079"), "select", row?.status ?? "active", { choices: statuses.map(key => [key, statusNames[key]]) });
    if(row){
      const effective=node('p','','tiny'),notice=node('p','活動已超過結束時間，投稿已自動停止。一般編輯不會改變原始狀態；如要正式結束，請選擇「已結束（手動）」並保存。','notice');
      effective.dataset.campaignEffective='';f.append(effective,notice);
      campaignWatches.push(watchCampaignStatus(row,status=>{
        effective.textContent='目前顯示：'+statusNames[status]+' · 原始狀態：'+statusNames[row.status];
        const expired=row.status==='active'&&status==='closed';notice.hidden=!expired;
        if(row.status==='active'){
          statusControl.querySelector('[value="active"]').textContent=expired?'已結束（依時間；原始狀態：'+statusNames.active+'）':statusNames.active;
          statusControl.querySelector('[value="closed"]').textContent='已結束（手動）';
        }
      }));
    }
    field(f, "note", copy("admin-copy-080"), "textarea", row?.note, { maxLength: 1000 });
    field(f,'submission_instructions','投稿說明（公開顯示）','textarea',content.submission_instructions,{maxLength:5000});
    const example=field(f,'example_image','投稿範例圖片','file','',{accept:'image/png,image/jpeg,image/webp'}),preview=node('img'),remove=button('移除範例圖片',()=>{assetId=null;example.value='';preview.hidden=true;preview.removeAttribute('src');});
    preview.alt='投稿範例預覽';preview.className='campaign-example-preview';preview.hidden=true;f.append(preview,remove,node('p','圖片選填，支援 PNG／JPEG／WEBP，最多 5 MB。儲存後套用至此活動。','tiny'));
    let assetId=content.example_asset_id,uploaded=null;
    const showPreview=blob=>{const url=URL.createObjectURL(blob);urls.push(url);preview.src=url;preview.hidden=false;};
    if(assetId){try{const blob=await access.asset(assetId,null,controller.signal);if(born!==sequence||!visible)return;showPreview(blob);}catch{f.append(node('p','既有範例圖片暫時無法預覽；原圖設定仍保留。','tiny'));}}
    example.addEventListener('change',()=>{const file=example.files[0];if(!file)return;if(!['image/png','image/jpeg','image/webp'].includes(file.type)||file.size>5242880){example.value='';$('admin-status').textContent='範例圖片僅支援 PNG／JPEG／WEBP，最多 5 MB。';return;}showPreview(file);uploaded=null;});
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", copy("admin-copy-081"))); }
    else { submitButton(f, copy("admin-copy-082"));
    const saveError=node('p','','notice warn');saveError.id='campaign-save-error';saveError.setAttribute('role','alert');f.append(saveError);
    bindForm(f, async () => {const file=example.files[0],campaignId=row?.campaign_id??value(f,'campaign_id');
      if(file&&(uploaded?.file!==file||uploaded?.campaignId!==campaignId)){const data=await access.asset(campaignId,file,controller.signal);assetId=data.asset_id;uploaded={file,campaignId};}
      return mutate(row ? "campaigns/" + row.campaign_id + "/update" : "campaigns", {
      ...(row ? { expected_version: row.version } : { campaign_id: value(f, "campaign_id") }), name: value(f, "name"), category: value(f, "category"),solo_target:value(f,"category")==="Solo"?(row?.solo_target??value(f,"solo_target")):null,
      start_at: locked ? row.start_at : utcFromTaipei(value(f, "start_at")), end_at: locked ? row.end_at : utcFromTaipei(value(f, "end_at")), campaign_timezone: row?.campaign_timezone && locked ? row.campaign_timezone : value(f, "campaign_timezone"),
      points_per_proof: integer(f, "points_per_proof", 0, 1000000), daily_limit: dailyLimit(mode.value, cap.value), status: value(f, "status"), note: value(f, "note") || null,
      submission_instructions:value(f,'submission_instructions'),example_asset_id:assetId,
    });},saveError); } f.append(button(copy("admin-copy-083"), () => void load()));
  }
  async function boards() {
    heading(copy("admin-copy-019"), copy("admin-copy-084"));
    const actions = node("div", "", "tabs review-modes");
    const archived = button("已封存", () => { if(busy)return; boardsArchived = !boardsArchived; void load(); }, "tab");
    archived.setAttribute("aria-pressed", String(boardsArchived));
    actions.append(button(copy("admin-copy-085"), () => { boardsArchived = false; void boardEditor(null); }, "btn btn-primary"), archived);
    $("admin-panel").append(actions);
    await paged("leaderboards", "leaderboards", row => {
      const c = node("article", "", "member-case"); c.append(node("h3", row.name), node("span", statusNames[row.status], "status"), node("p", row.is_public ? copy("admin-copy-086") : copy("admin-copy-087")));
      if(row.system_fixed || row.type==="all_time"){c.append(node("span","系統固定榜","status neutral"),node("p",row.rule??"由正式歷史積分即時統計，無需重建。"));return c;}
      if(row.is_current_comeback)c.append(node("span","本次回歸","status comeback"));
      c.append(button(copy("admin-copy-088"), () => boardEditor(row)), button(copy("admin-copy-089"), () => void boardResults(row)));
      if (row.status !== "archived") c.append(button(copy("admin-copy-090"), () => { if (window.confirm(copy("admin-copy-091"))) void run(async current => { await mutate("leaderboards/" + row.leaderboard_id + "/rebuild", { expected_version: row.version }); if (current()) await load(); }); },'btn status rejected')); return c;
    }, boardsArchived ? new URLSearchParams({status:"archived"}) : new URLSearchParams(), {
      accept: row => (row.status === "archived") === boardsArchived,
      emptyMessage: boardsArchived ? "尚無已封存的排行榜。" : undefined,
    });
  }
  async function boardResults(row) {
    if (busy) return; clearPanel(); await run(async current => {
      const data = await request("leaderboards/" + row.leaderboard_id + "/results"); if (!current()) return;
      heading(row.name); const board = data.leaderboards?.find(b => b.leaderboard_id === row.leaderboard_id);
      $("admin-panel").append(board?.rankings?.length ? rowsTable(board.rankings, [["rank", copy("admin-copy-092")], ["nickname", copy("admin-copy-093")], ["points", copy("admin-copy-094")], ["proof_count", copy("admin-copy-095")]]) : node("p", copy("admin-copy-096")), button(copy("admin-copy-097"), () => void load()));
    });
  }
  async function boardEditor(row) {
    if (busy) return; clearPanel(); heading(copy("admin-copy-019"));
    const born=sequence, campaigns=[];let cursor=null;
    try {do {const data=await request('campaigns?limit=50'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
      if(born!==sequence || !visible)return;if(!Array.isArray(data.campaigns))throw new PublicError('SERVICE_UNAVAILABLE');
      campaigns.push(...data.campaigns);cursor=data.next_cursor;
    }while(cursor);}catch(error){if(born===sequence)$('admin-status').textContent=adminMessage(error);return;}
    const f = formCard(row ? copy("admin-copy-098") : copy("admin-copy-085"));
    f.dataset.boardEditor='';
    if(row)field(f,"leaderboard_id",copy("admin-copy-099"),"text",row.leaderboard_id,{readOnly:true});
    else f.append(node('p','排行榜代號由系統產生，建立後固定不變。','tiny'));
    field(f, "name", copy("admin-copy-100") + " / 按鈕顯示名稱", "text", row?.name, { required: true, maxLength: 100 });
    const type = field(f, "type", copy("admin-copy-101"), "select", row?.type ?? "custom", { choices: [ ["campaign", copy("admin-copy-103")], ["custom", copy("admin-copy-104")]] });
    const choices=[['','不指定活動'],...campaigns.filter(c=>c.status!=='archived'||c.campaign_id===row?.campaign_id).map(c=>[c.campaign_id,c.name+' · '+c.campaign_id+(c.status==='archived'?'（已封存）':c.status==='closed'?'（已結束）':'')])];
    if(row?.campaign_id&&!choices.some(([id])=>id===row.campaign_id))choices.push([row.campaign_id,row.campaign_id+'（歷史參照）']);
    const campaign = field(f, "campaign_id", copy("admin-copy-105"), "select", row?.campaign_id, { choices });
    const comeback=field(f,'is_current_comeback','設為本次回歸','checkbox');comeback.checked=Boolean(row?.is_current_comeback);
    const start = field(f, "start_date", copy("admin-copy-106"), "date", row?.start_date), end = field(f, "end_date", copy("admin-copy-107"), "date", row?.end_date);
    const sync = () => { campaign.disabled = type.value === "all_time"; campaign.required = type.value === "campaign"; start.disabled = end.disabled = type.value !== "custom"; start.required = end.required = !start.disabled; comeback.disabled=type.value!=='campaign'||f.elements.namedItem('status')?.value==='archived';if(comeback.disabled)comeback.checked=false; };
    type.addEventListener("change", sync); sync();
    field(f, "vote_type", copy("admin-copy-036"), "select", row?.vote_type ?? "", { choices: [["", copy("admin-copy-034")], ["Solo", "Solo"], ["團體", "團體"]] });
    field(f, "top_n", copy("admin-copy-108"), "number", row?.top_n ?? 10, { required: true, min: 1, max: 100, step: 1 });
    const visibility=field(f, "is_public", copy("admin-copy-109"), "select", !row || row.is_public ? "true" : "false", { choices: [["false", copy("admin-copy-087")], ["true", copy("admin-copy-086")]] });
    const lifecycle=field(f, "status", copy("admin-copy-110"), "select", row?.status ?? "active", { choices: (row?.status === "archived" ? ["archived"] : row?.status === "active" ? ["active", "archived"] : ["draft", "active", ...(row ? ["archived"] : [])]).map(k => [k, statusNames[k]]) });
    const display=field(f,"display_button","開啟顯示該排行按鈕","checkbox");display.setAttribute("role","switch");display.classList.add("display-switch");
    const syncDisplay=()=>{display.checked=visibility.value==="true"&&lifecycle.value==="active";display.setAttribute("aria-checked",String(display.checked));};
    display.addEventListener("change",()=>{visibility.value=display.checked?"true":"false";if(display.checked)lifecycle.value="active";syncDisplay();});
    visibility.addEventListener("change",syncDisplay);lifecycle.addEventListener("change",()=>{if(lifecycle.value==='archived')comeback.checked=false;comeback.disabled=type.value!=='campaign'||lifecycle.value==='archived';syncDisplay();});syncDisplay();
    f.append(node("p","自訂類型會使用上方名稱顯示第 5、6、7… 顆按鈕。開關啟用後保存設定即可顯示；成績仍需使用原有重建功能公布。","tiny"));
    if (row?.status === "archived") { for (const el of f.elements) el.disabled = true; f.append(node("p", copy("admin-copy-111"))); }
    else { submitButton(f, copy("admin-copy-112")); bindForm(f, () => mutate(row ? "leaderboards/" + row.leaderboard_id + "/update" : "leaderboards", {
      ...(row ? { expected_version: row.version } : {}), name: value(f, "name"), type: type.value, is_current_comeback:comeback.checked && type.value==='campaign' && lifecycle.value!=='archived',
      campaign_id: type.value === "all_time" ? null : campaign.value.trim() || null, start_date: type.value === "custom" ? start.value : null, end_date: type.value === "custom" ? end.value : null,
      vote_type: value(f, "vote_type") || null, top_n: integer(f, "top_n", 1, 100), is_public: value(f, "is_public") === "true", status: value(f, "status"),
    })); } f.append(button(copy("admin-copy-113"), () => void load()));
  }
  async function tiers() {
    heading(copy("admin-copy-020"), copy("admin-copy-114"));
    const data = await request("member-tiers");
    for (const row of data.tiers) {
      const card = node("article", "", "member-case tier-card");
      const artwork = node("div", "", "tier-artwork"); renderTierArtwork(artwork, row.tier_id);
      card.append(artwork, node("h3", row.name), node("span", row.status === "active" ? copy("admin-copy-115") : copy("admin-copy-011"), "status"), node("p", row.min_points === null ? copy("admin-copy-116") : `門檻：${row.min_points} 點`));
      if (row.tier_id !== "normal") card.append(button(copy("admin-copy-117"), () => {
        if (busy) return; clearPanel(); heading(copy("admin-copy-020")); const f = formCard(row.name);
        field(f, "min_points", copy("admin-copy-118"), "number", row.min_points ?? "", { required: true, min: 1, max: 1000000000, step: 1 });
        field(f, "status", copy("admin-copy-048"), "select", row.status, { choices: [["disabled", copy("admin-copy-011")], ["active", copy("admin-copy-115")]] });
        field(f, "reason", copy("admin-copy-119"), "textarea", "", { required: true, maxLength: 500 }); submitButton(f, copy("admin-copy-120"));
        bindForm(f, () => mutate("member-tiers/" + row.tier_id + "/update", { min_points: integer(f, "min_points", 1, 1000000000), status: value(f, "status"), reason: value(f, "reason"), expected_version: row.version })); f.append(button(copy("admin-copy-121"), () => void load()));
      })); $("admin-panel").append(card);
    }
  }
  async function submissions() {
    heading(copy("admin-copy-021"), copy("admin-copy-122"));
    const data = await request("submissions"), f = formCard(copy("admin-copy-123"));
    const enabled = field(f, "submissions_enabled", copy("admin-copy-123"), "select", String(data.submissions_enabled), { choices: [["false", copy("admin-copy-124")], ["true", copy("admin-copy-125")]] });
    const message = field(f, "submissions_message", copy("admin-copy-126"), "textarea", data.submissions_message ?? "", { maxLength: 500 });
    const syncMessage = () => { message.closest(".field").hidden = enabled.value === "true"; };
    enabled.addEventListener("change", syncMessage); syncMessage();
    submitButton(f, copy("admin-copy-127"));
    const born = sequence;
    f.addEventListener("submit", event => { event.preventDefault(); if (!f.reportValidity()) return;
      if (!window.confirm(enabled.value === "true" && !data.submissions_enabled ? copy("admin-copy-128") : copy("admin-copy-129"))) return;
      void run(async current => { await mutate("submissions/update", { submissions_enabled: enabled.value === "true", submissions_message: value(f, "submissions_message") || null, expected_version: data.version });
        if (current()) { document.dispatchEvent(new Event("voteproof-submissions-updated")); await load(); }
      }, born);
    });
  }
  async function audit() {
    const born=sequence,signal=controller.signal;
    const {renderAdminAudit}=await import('./admin-audit.js');
    if(born!==sequence||signal.aborted||!visible)return;
    await renderAdminAudit({container:$('admin-panel'),request,signal,message:adminMessage});
  }
  async function overview(){
    heading('工作總覽','全站案件統計：已通過包含已完成，未通過包含重複投稿，撤銷獨立計算。會員包含停權會員。');
    const totals=await request('overview'),grid=node('div','','grid grid-4');
    const members=node('article','','activity-card');members.dataset.memberTotal='';members.append(node('span','會員總數','tiny'),node('strong',String(totals.member_count)));
    if(management(access.actor)){const lookup=button('會員查詢',()=>memberContact.open(),'btn btn-white');members.classList.add('member-total-contact');members.append(lookup);memberContact=memberContactUI({request,opener:lookup});}
    grid.append(members);
    for(const [state,label] of [['pending','待審核'],['approved','已通過'],['rejected','未通過'],['revoked','已撤銷']]){
      const card=node('article','','activity-card');card.append(node('span',label,'tiny'),node('strong',String(totals.case_totals?.[state]??'尚未取得全站統計')));grid.append(card);
    }
    $('admin-panel').append(grid,button('前往案件審核',()=>{tab='cases';void load();},'btn btn-primary'));
    if(management(access.actor)){const gate=await request('submissions');$('admin-panel').append(node('p',gate.submissions_enabled?'收件：開放投稿':'收件：目前暫停投稿','notice info'));}
  }
  async function staff(){
    heading('管理員管理','對方需先以 Google 帳號登入並完成會員資料；取得權限後仍須完成 MFA 才能使用後台。');
    const data=await request('staff');
    $('admin-panel').append(rowsTable(data.memberships,[['nickname','暱稱'],['fan_id','粉絲 ID'],['role','角色'],['status','狀態']]));
    const f=formCard('新增管理員／審核員');
    f.dataset.staffEditor='';
    field(f,'staff_email','對方的 Google 帳號','email','',{required:true,maxLength:254,autocomplete:'off'});
    field(f,'staff_role','授予角色','select','reviewer',{choices:[['reviewer','審核員（工作總覽、案件審核、圖片批次匯出）'],['admin','管理員（管理功能，不含管理員管理）']]});
    submitButton(f,'確認新增權限');bindForm(f,()=>mutate('staff',{email:value(f,'staff_email'),role:value(f,'staff_role')}));
  }
  async function announcements(){
    heading('彈窗公告','公告支援純文字與換行；開放後依設定時間顯示。');const data=await request('announcements');
    $('admin-panel').append(button('新增公告',()=>announcementEditor(null),'btn btn-primary'));
    for(const row of data.announcements){const card=node('article','','card');card.append(node('h3',row.title),node('p',row.enabled?'開放':'關閉','status neutral'),node('p','版本 '+row.version+' · '+stamp(row.updated_at),'tiny'),button('編輯公告',()=>announcementEditor(row)));$('admin-panel').append(card);}
  }
  function announcementEditor(row){
    if(busy)return;clearPanel();heading('彈窗公告');const f=formCard(row?'編輯公告':'新增公告');f.dataset.announcementEditor='';
    const title=field(f,'announcement_title','公告標題','text',row?.title,{required:true,maxLength:100}),body=field(f,'announcement_body','公告內容','textarea',row?.body,{required:true,maxLength:5000});
    field(f,'announcement_enabled','公告狀態','select',row?.enabled?'true':'false',{choices:[['false','關閉'],['true','開放']]});
    field(f,'announcement_start','開始顯示時間（台灣時間，選填）','datetime-local',row?.starts_at?taipeiInput(row.starts_at):'');field(f,'announcement_end','結束顯示時間（台灣時間，選填）','datetime-local',row?.ends_at?taipeiInput(row.ends_at):'');
    field(f,'announcement_dismissible','是否允許關閉','select',row?.dismissible===false?'false':'true',{choices:[['true','是'],['false','否']]});
    const enabled=field(f,'announcement_button_enabled','顯示連結按鈕','select',(row?.button_enabled??Boolean(row?.button_url))?'true':'false',{choices:[['false','關閉'],['true','顯示']]});
    const label=field(f,'announcement_button_label','按鈕文字（選填）','text',row?.button_label,{maxLength:60}),url=field(f,'announcement_button_url','按鈕連結（http／https，選填）','url',row?.button_url,{maxLength:2048});
    const preview=node('section','','card announcement-editor-preview');preview.hidden=true;preview.setAttribute('aria-label','公告預覽');f.append(button('預覽公告',()=>{preview.replaceChildren(node('h3',title.value),node('p',body.value,'content-lines'));preview.hidden=false;}),preview);
    const sync=()=>{const on=enabled.value==='true';label.disabled=url.disabled=!on;label.required=on;url.required=on;};enabled.addEventListener('change',sync);sync();
    submitButton(f,'儲存公告');bindForm(f,()=>mutate('announcements'+(row?'/'+row.announcement_id+'/update':''),{...(row?{expected_version:row.version}:{}),title:title.value,body:body.value,enabled:value(f,'announcement_enabled')==='true',dismissible:value(f,'announcement_dismissible')==='true',starts_at:value(f,'announcement_start')?utcFromTaipei(value(f,'announcement_start')):null,ends_at:value(f,'announcement_end')?utcFromTaipei(value(f,'announcement_end')):null,button_enabled:enabled.value==='true',button_label:label.value,button_url:url.value}));
    f.append(button('返回公告列表',()=>void load()));
  }
  async function blocks(){
    heading('會員封鎖','請確認粉絲 ID 與封鎖原因。封鎖與恢復都會留下操作紀錄。');
    const f=formCard('封鎖會員');f.dataset.blockEditor='';field(f,'block_fan_id','粉絲 ID','text','',{required:true,maxLength:100});field(f,'block_reason','封鎖原因','textarea','',{required:true,maxLength:500});
    const submit=node('button','封鎖會員','btn btn-danger');submit.type='submit';f.append(submit);
    f.addEventListener('submit',e=>{e.preventDefault();if(!f.reportValidity()||busy)return;const fan=value(f,'block_fan_id'),reason=value(f,'block_reason');if(!fan||!reason)return;confirmMemberStatus({fan_id:fan,reason,action:'block'},submit);});
    $('admin-panel').append(node('h3','已封鎖會員名單'));
    await paged('member-blocks','members',row=>{const c=node('article','','member-case blocked-member-row');c.append(node('h3',row.nickname),node('p','粉絲 ID：'+(row.fan_id??'尚未設定')),node('span','已被封鎖','status rejected'),node('p',row.reason,'content-lines'),node('p',stamp(row.blocked_at),'tiny'));const restore=button('恢復會員',()=>confirmMemberStatus({fan_id:row.fan_id,reason:'管理員恢復會員',action:'restore'},restore),'btn btn-white');restore.disabled=!row.fan_id;c.append(restore);return c;});
  }
  function confirmMemberStatus(input,opener){
    if(busy||blockDialog?.open)return;const blocking=input.action==='block',d=node('dialog','','case-dialog');blockDialog=d;d.setAttribute('aria-label',blocking?'確認封鎖會員':'確認恢復會員');
    d.append(node('h2',blocking?'確認封鎖會員':'確認恢復會員'),node('p','粉絲 ID：'+input.fan_id),node('p',input.reason,'content-lines'),node('p',blocking?'確認後此會員將顯示已被封鎖，無法使用會員功能。':'確認後此會員可重新使用會員功能。'));
    const status=node('p','','notice error');status.setAttribute('role','status');const cancel=button('取消',()=>d.close()),confirm=button(blocking?'確認封鎖':'確認恢復',()=>{if(busy)return;confirm.disabled=cancel.disabled=true;void run(async current=>{try{await mutate('member-blocks',{...input,confirmed_fan_id:input.fan_id});if(current()){d.close();await load();$('admin-status').textContent=blocking?'會員已被封鎖。':'會員已恢復。';}}catch(e){status.textContent=adminMessage(e);throw e;}}).finally(()=>{if(confirm.isConnected)confirm.disabled=cancel.disabled=false;});},blocking?'btn btn-block-confirm':'btn btn-primary');
    d.append(status,cancel,confirm);d.addEventListener('close',()=>{d.remove();if(blockDialog===d)blockDialog=null;if(opener?.isConnected)opener.focus();});
    d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});d.addEventListener('keydown',e=>{if(e.key!=='Tab')return;if(busy){e.preventDefault();return;}if(e.shiftKey&&document.activeElement===cancel){e.preventDefault();confirm.focus();}else if(!e.shiftKey&&document.activeElement===confirm){e.preventDefault();cancel.focus();}});document.body.append(d);d.showModal();cancel.focus();
  }
  const loaders = { overview,
    members:async()=>{const born=sequence,stop=await renderMemberOverview({container:$('admin-panel'),request,signal:controller.signal});if(born===sequence)adminInsightsStop=stop;else stop();},
    healthMonitor:async()=>{const born=sequence,stop=await renderHealthMonitor({container:$('admin-panel'),request,signal:controller.signal});if(born===sequence)adminInsightsStop=stop;else stop();},
    cases, backups:()=>{heading('Google Drive 備份');return backupOverview();}, announcements, exports:()=>renderImageExports({container:$('admin-panel'),request,session,signal:controller.signal}), campaigns, leaderboards: boards, tiers, blocks, submissions, audit, staff };
  async function load() {
    if (!visible) return; clearPanel(); const born = sequence;
    await run(async current => {
      const actor = await access.check(controller.signal); if (!current()) return;
      if (!canUseTab(actor,tab)) tab = "cases";
      $("admin-tabs").replaceChildren();
      for (const [key, label] of Object.entries(tabs)) if (canUseTab(actor,key)) {
        const b = button(label, () => { if (!busy) { tab = key; void load(); } }, "btn " + (tab === key ? "btn-primary" : "btn-white")); b.setAttribute("aria-pressed", String(tab === key)); $("admin-tabs").append(b);
      }
      $("admin-panel").append(button(copy("admin-copy-144"), () => void load())); await loaders[tab]();
    }, born);
  }
  $("admin-retry").addEventListener("click", () => void load());
  document.addEventListener("voteproof-security-verified", () => { void access.check().catch(() => {}); });
  // Revalidate on return without erasing an editor, or restarting any write.
  const recheck = () => { if (access.actor && !busy) void access.check().catch(() => {}); };
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") recheck(); });
  window.addEventListener("focus", recheck);
  window.addEventListener("pagehide", () => access.clear());
  return { identity(member) { const previous = access.owner; access.identity(member); if (visible && member && previous !== member.member_id) void load(); }, enter(view) { const next = view === "admin"; if (next === visible) return; visible = next; if (visible) void load(); else clearPanel(); } };
}
