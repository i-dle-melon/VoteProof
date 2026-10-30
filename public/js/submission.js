import { PublicError } from "./api.js";
// Client UX limits mirror the public contract; backend is authoritative.
export const FILE_LIMITS = Object.freeze({ count: 5, bytes: 5 * 1024 * 1024, batch: 25 * 1024 * 1024 });
export const IMAGE_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
export const BATCH_LIMIT = 20;
// Explicit local-only POC selector. Server issuance must independently opt in.
export function directIntentPocEnabled(location = globalThis.location) {
  return ['localhost','127.0.0.1','[::1]','voteproof.example'].includes(location?.hostname) &&
    new URLSearchParams(location.search).get('upload-flow') === 'direct';
}
export function validateBatchImages(files) {
  if (!files.length) throw new PublicError("IMAGES_REQUIRED");
  if (files.length > BATCH_LIMIT) throw new PublicError("BATCH_TOO_MANY_FILES");
  for (const file of files) validateImages([file]);
}
export function validateImages(files) {
  if (!files.length) throw new PublicError("IMAGES_REQUIRED");
  if (files.length > FILE_LIMITS.count) throw new PublicError("TOO_MANY_FILES");
  for (const file of files) {
    if (!Object.hasOwn(IMAGE_TYPES, file.type)) throw new PublicError("UNSUPPORTED_FILE_TYPE");
    if (!Number.isSafeInteger(file.size) || file.size <= 0 || file.size > FILE_LIMITS.bytes) throw new PublicError("FILE_TOO_LARGE");
  }
  if (files.reduce((n, f) => n + f.size, 0) > FILE_LIMITS.batch) throw new PublicError("FILE_TOO_LARGE");
}
export function normalizedMetadata(input) {
  const text = (key, max) => {
    if (typeof input[key] !== "string") throw new PublicError("INVALID_CASE_REQUEST");
    const value = input[key].trim();
    if (!value || [...value].length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new PublicError("INVALID_CASE_REQUEST");
    return value;
  };
  const campaign_id = text("campaign_id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(campaign_id) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.vote_date ?? "")) throw new PublicError("INVALID_CASE_REQUEST");
  const date = new Date(input.vote_date + "T00:00:00Z");
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input.vote_date) throw new PublicError("INVALID_CASE_REQUEST");
  const note = (input.note ?? "").trim();
  if ([...note].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new PublicError("INVALID_CASE_REQUEST");
  return Object.freeze({ campaign_id, vote_date: input.vote_date, note: note || null });
}
function newIdempotencyKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}
function checkedPrepare(data, files) {
  if (!data || typeof data.session_id !== "string" || !Array.isArray(data.uploads) || data.uploads.length !== files.length ||
      !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 300) throw new PublicError("SERVICE_UNAVAILABLE");
  for (const [i, upload] of data.uploads.entries()) {
    let url;
    try { url = new URL(upload.upload_url); } catch { throw new PublicError("SERVICE_UNAVAILABLE"); }
    if (url.origin !== globalThis.location?.origin || url.username || url.password || url.search || url.hash ||
        !/^\/api\/uploads\/put\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(url.pathname) ||
        upload.method !== "PUT" || typeof upload.key !== "string" || upload.headers?.["Content-Type"] !== files[i].type ||
        !/^[A-Za-z0-9_-]{40,2048}$/.test(upload.headers?.['X-Upload-Grant']??''))
      throw new PublicError("SERVICE_UNAVAILABLE");
  }
  return data;
}
export function queryInformation(result) {
  return `VoteProof\n案件編號：${result.case_id}\n查詢碼：${result.query_key}`;
}

const INVENTORY_WAIT_MS = 5000, INVENTORY_WAIT_LIMIT = 12, INVENTORY_WAIT_BUDGET_MS = 60000;
export function canWaitForInventory(error) {
  // Only the server's acknowledged zero-row admission can authorize another
  // HTTP attempt. A stale snapshot or any ambiguous/native PUT is not retryable.
  return error?.code==='R2_STORAGE_INVENTORY_BUSY'&&error.status===503&&
    error.putRejected===true&&error.uploadStage==='capacity_admission'&&error.putState==='not_started';
}

export class Submission {
  #context = null;
  #running = null;
  constructor({ api, put, token, progress = () => {}, now = () => Date.now(),
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), retryGate = async () => {}, directIntent = false }) {
    this.api = api; this.put = put; this.token = token; this.progress = progress; this.now = now;
    this.sleep = sleep; this.retryGate = retryGate;
    // Snapshot the server-advertised mode for this logical item. A later gate
    // refresh must never change the payload/endpoint of an in-flight retry.
    this.directIntent = typeof directIntent==='function'?Boolean(directIntent()):Boolean(directIntent);
  }
  async batchFile() {
    const c=this.#context;
    c.digests ??= await Promise.all(c.files.map(async file => Array.from(new Uint8Array(
      await crypto.subtle.digest('SHA-256',await file.arrayBuffer())),b=>b.toString(16).padStart(2,'0')).join('')));
    return {name:`proof.${IMAGE_TYPES[c.files[0].type]}`,type:c.files[0].type,size:c.files[0].size,algorithm:'sha256',sha256:c.digests[0]};
  }
  needsBatchTicket() {
    const c=this.#context;
    if(!c || c.payload || c.completed || c.uploaded.size || c.uncertainPuts.size || c.putHold)return false;
    if(c.batchTicket && this.now()>=c.batchExpiresAt){c.batchTicket=null;c.prepared=null;}
    return !c.batchTicket;
  }
  setBatchTicket(ticket,expiresAt) {
    if(!this.needsBatchTicket() || this.#context.prepared)throw new PublicError('SUBMISSION_PENDING');
    this.#context.batchTicket=ticket;this.#context.batchExpiresAt=expiresAt;
  }
  get pending() { return this.#context !== null; }
  get busy() { return this.#running !== null; }
  start(metadata, files, { caseApi } = {}) {
    if (this.pending) throw new PublicError("SUBMISSION_PENDING");
    validateImages(files);
    if(this.directIntent && files.length!==1)throw new PublicError('INVALID_UPLOAD_REFERENCE');
    this.#context = { metadata: normalizedMetadata(metadata), files: [...files], idempotency: newIdempotencyKey(),
      prepared: null, digests:null, uploaded: new Set(), uncertainPuts:new Set(),putHold:false, completed: false, payload: null, caseApi };
  }
  abandon() {
    if (this.busy) throw new PublicError("SUBMISSION_BUSY");
    this.#context = null;
  }
  attempt() {
    if (this.#running) return this.#running;
    if (!this.#context) return Promise.reject(new PublicError("SUBMISSION_MISSING"));
    this.#running = this.#attempt().finally(() => { this.#running = null; });
    return this.#running;
  }
  async #attempt() {
    const c = this.#context;
    if(c.putHold)throw new PublicError('PUT_RESULT_UNCONFIRMED');
    // Before case creation is attempted, expired PUT grants can safely be
    // replaced. Once payload exists, it is immutable, including upload refs.
    if (!c.payload && !c.completed && !c.uploaded.size && !c.uncertainPuts.size && c.prepared && this.now() >= c.expiresAt) {
      c.prepared = null; c.uploaded.clear();
    }
    if (!c.prepared) {
      this.progress({ phase: "verify", fraction: 0 });
      const token = c.batchTicket ? null : await this.token();
      if (!c.batchTicket && !token) throw new PublicError("TURNSTILE_REQUIRED");
      this.progress({ phase: "prepare", fraction: 0 });
      // Browser claims are cached across technical retries. R2 is responsible
      // for verifying these against actual bytes; a browser claim is not proof.
      if(!c.digests)await this.batchFile();
      const started = this.now();
      try{c.prepared = checkedPrepare(await (c.caseApi??this.api)("/api/uploads/prepare", { method: "POST", body: {
        ...(c.files.length===1?{storage_version:2,campaign_id:c.metadata.campaign_id}:{}),
        ...(this.directIntent?{completion_mode:'direct'}:{}),
        ...(c.batchTicket?{batch_ticket:c.batchTicket}:{turnstile_token:token}), files: c.files.map((f, i) => ({ name: `proof-${i + 1}.${IMAGE_TYPES[f.type]}`, type: f.type, size: f.size, algorithm:'sha256',sha256:c.digests[i] })) } }), c.files);}
      catch(error){if(error.code==='BATCH_AUTH_INVALID'&&!c.uploaded.size&&!c.uncertainPuts.size&&!c.payload)c.batchTicket=null;throw error;}
      c.expiresAt = started + c.prepared.expires_in * 1000;
    }
    if(this.directIntent && c.prepared.completion_mode!=='direct')throw new PublicError('SERVICE_UNAVAILABLE');
    for (let i = 0; i < c.files.length && !c.completed; i++) {
      if (c.uploaded.has(i)||c.uncertainPuts.has(i)) continue;
      const update = (fraction) => this.progress({ phase: "put", file: i + 1, count: c.files.length,
        fraction: (c.uploaded.size + fraction) / c.files.length });
      update(0);
      let retryGateFailed = false;
      try {
        let waits=0,deadline=null;
        for (;;) {
          try { await this.put(c.prepared.uploads[i], c.files[i], update); break; }
          catch (error) {
            const at=this.now();
            if(!canWaitForInventory(error)||waits>=INVENTORY_WAIT_LIMIT||
              at+INVENTORY_WAIT_MS>=c.expiresAt||deadline!==null&&at+INVENTORY_WAIT_MS>deadline)throw error;
            deadline??=at+INVENTORY_WAIT_BUDGET_MS;
            waits++;
            this.progress({phase:'capacity_wait',file:i+1,count:c.files.length,fraction:c.uploaded.size/c.files.length});
            retryGateFailed=true;
            await this.sleep(INVENTORY_WAIT_MS);
            if(this.now()>=c.expiresAt||this.now()>deadline)throw error;
            // The application gate also revalidates the captured member/guest
            // identity. Gate failures happened before PUT, not an unknown PUT.
            await this.retryGate();
            if(this.now()>=c.expiresAt||this.now()>deadline)throw error;
            retryGateFailed=false;
          }
        }
      }
      catch(error) {
        if(retryGateFailed){error.pauseBatch=true;throw error;}
        // A rejected Grant cannot have reached native R2. Never turn a 403 into
        // a successful upload flag or a speculative Direct Case submission.
        if(error.code==='UPLOAD_GRANT_INVALID'&&error.status===403){
          if(!c.payload&&!c.uncertainPuts.size){c.prepared=null;c.uploaded.clear();}
          else {c.putHold=true;error.pauseBatch=true;}
          throw error;
        }
        const ambiguous=['PUT_ACK_UNKNOWN','PUT_FAILED','NETWORK_ERROR'].includes(error.code)&&!error.status||
          ['unknown','acknowledged'].includes(error.putState)||
          error.code==='UPLOAD_REPREPARE_REQUIRED'&&error.putState!=='not_started';
        if(ambiguous){
          c.uncertainPuts.add(i);
          // This is verification, not success. Keep this exact intent and never
          // send PUT again, even when a later HEAD still reports missing bytes.
          if(this.directIntent)continue;
          throw error;
        }
        const rejected=error.putRejected||['UPLOAD_VALIDATION_FAILED','UPLOAD_INTENT_INVALID','UPLOAD_OWNER_MISMATCH','UPLOAD_SESSION_EXPIRED','SUBMISSIONS_DISABLED','SUBMISSIONS_UNAVAILABLE','AUTH_REQUIRED','AUTH_IDENTITY_CHANGED','MEMBER_BLOCKED','CSRF_INVALID','PRELAUNCH_MAINTENANCE','PRELAUNCH_EPOCH_CHANGED','PRELAUNCH_UPLOAD_RETIRED','PRELAUNCH_PROOF_RETIRED','PRELAUNCH_PROOF_GENERATION_RETIRED'].includes(error.code);
        if(!rejected){c.putHold=true;error.pauseBatch=true;}
        throw error;
      }
      c.uploaded.add(i);
    }
    const reference = { session_id: c.prepared.session_id, keys: c.prepared.uploads.map((u) => u.key),
      ...(c.prepared.capability?{capability:c.prepared.capability}:{}) };
    if (!c.completed && !this.directIntent) {
      this.progress({ phase: "complete", fraction: 1 });
      try { await (c.caseApi??this.api)("/api/uploads/complete", { method: "POST", body: reference }); }
      catch (e) { if (e.code === "UPLOAD_INCOMPLETE"&&!c.uncertainPuts.size) c.uploaded.clear(); throw e; }
      c.completed = true;
    }
    if(this.directIntent)c.completed=true;
    // Store the serialized body ONCE before POST. Lost success responses must
    // replay this exact body/key, even if the upload is already consumed.
    c.payload ??= JSON.stringify({ ...c.metadata, upload_session: reference });
    this.progress({ phase: "case", fraction: 1 });
    const result = await (c.caseApi ?? this.api)(this.directIntent?"/api/cases/direct":"/api/cases", { method: "POST", headers: { "Idempotency-Key": c.idempotency }, body: c.payload });
    if (!/^VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(result?.case_id ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(result?.query_key ?? "")) throw new PublicError("SERVICE_UNAVAILABLE");
    this.#context = null;
    return result;
  }
}

// Every item owns a single-file upload, immutable case payload and retry key.
// Keep successful receipts in memory; never send them again on partial retry.
export class BatchSubmission {
  #items = [];
  #running = null;
  #error = null;
  #metadata = null;
  #caseApi = null;
  #mode = false;
  #authorizationExpiresAt = null;
  constructor({ api, put, token, progress = () => {}, changed = () => {}, gate, now, sleep, directIntent = false }) {
    this.dependencies = { api, put, token, now, sleep, directIntent };
    this.progress = progress; this.changed = changed;
    this.gate = gate ?? (async () => {
      const status = await api("/api/submissions/status");
      if (status?.submissions_enabled !== true) throw new PublicError("SUBMISSIONS_DISABLED");
    });
  }
  get pending() { return this.#items.some(item => !item.result); }
  get busy() { return this.#running !== null; }
  get error() { return this.#error; }
  get summary() {
    const items = this.#items.map(({ file, status, result, error }) => ({ name: file.name, status,
      result: result ? { ...result } : null, error: error?.code ?? null }));
    const succeeded = items.filter(item => item.result).length;
    return { items, total: items.length, succeeded, failed: items.filter(item => item.status === "failed").length,
      queued: items.filter(item => item.status === "queued").length, complete: items.length > 0 && succeeded === items.length };
  }
  start(metadata, files, options = {}) {
    if (this.#items.length) throw new PublicError("SUBMISSION_PENDING");
    validateBatchImages(files);
    const input = normalizedMetadata(metadata);
    this.#error = null; this.#metadata=input;this.#caseApi=options.caseApi??this.dependencies.api;
    this.#mode=typeof this.dependencies.directIntent==='function'?Boolean(this.dependencies.directIntent()):Boolean(this.dependencies.directIntent);
    this.#authorizationExpiresAt=null;
    this.#items = files.map((file, index) => {
      const item = { file, status: "queued", result: null, error: null };
      item.flow = new Submission({ ...this.dependencies,directIntent:this.#mode,retryGate:()=>this.gate(), progress: state => {
        item.status = state.phase; this.changed(this.summary);
        this.progress({ ...state, file: index + 1, count: files.length,
          fraction: (this.summary.succeeded + state.fraction) / files.length });
      } });
      item.flow.start(input, [file], options);
      return item;
    });
    this.changed(this.summary);
  }
  abandon() {
    if (this.busy) throw new PublicError("SUBMISSION_BUSY");
    this.#items = []; this.#error = null; this.#metadata = null;this.#caseApi=null;this.#authorizationExpiresAt=null; this.changed(this.summary);
  }
  attempt() {
    if (this.#running) return this.#running;
    if (!this.pending) return this.#items.length ? Promise.resolve(this.summary) : Promise.reject(new PublicError("SUBMISSION_MISSING"));
    this.#running = this.#attempt().catch(error=>{
      this.#error=error;
      const pending=this.#items.filter(item=>!item.result);
      const verifying=pending.some(item=>item.status==='verify');
      for(const item of pending)if(item.status==='verify')item.status='queued';
      if(verifying&&pending[0]){pending[0].status='failed';pending[0].error=error;}
      this.changed(this.summary);throw error;
    }).finally(() => { this.#running = null; });
    return this.#running;
  }
  async #attempt() {
    // No prepare/PUT/complete/case happens before a fresh, fail-closed gate.
    await this.gate(); this.#error = null;
    const needs=this.#items.filter(item=>!item.result&&item.flow.needsBatchTicket());
    if(this.#items.length>1&&needs.length){
      // An expired ticket cannot silently become a fresh authorization. The UI
      // shows the reason; a later explicit retry obtains a new challenge only
      // for items that have never reached an ambiguous write or Case request.
      const now=this.dependencies.now??Date.now;
      if(this.#authorizationExpiresAt!==null&&now()>=this.#authorizationExpiresAt){
        this.#authorizationExpiresAt=null;this.#error=new PublicError('BATCH_AUTH_EXPIRED',403);throw this.#error;
      }
      for(const item of needs)item.status='verify';this.changed(this.summary);
      const files=[];
      for(const item of needs)files.push(await item.flow.batchFile());
      const challenge=await this.dependencies.token();
      if(!challenge)throw new PublicError('TURNSTILE_REQUIRED');
      await this.gate();
      const started=now();
      const data=await this.#caseApi('/api/uploads/batch/authorize',{method:'POST',body:{
        turnstile_token:challenge,campaign_id:this.#metadata.campaign_id,
        ...(this.#mode?{completion_mode:'direct'}:{}),files}});
      if(!Array.isArray(data?.tickets)||data.tickets.length!==needs.length||
        !Number.isInteger(data.expires_in)||data.expires_in<1||data.expires_in>300||
        data.tickets.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{40,2048}$/.test(x)))
        throw new PublicError('SERVICE_UNAVAILABLE');
      this.#authorizationExpiresAt=started+data.expires_in*1000;
      for(let i=0;i<needs.length;i++){needs[i].flow.setBatchTicket(data.tickets[i],this.#authorizationExpiresAt);needs[i].status='queued';}
    }
    for (const item of this.#items.filter(item => !item.result)) {
      try {
        await this.gate();
        item.error = null; item.result = await item.flow.attempt(); item.status = "success";
      } catch (error) {
        item.error = error; item.status = "failed"; this.#error = error;
        // Global auth, campaign, gate or challenge failures pause the queue.
        if (error.pauseBatch||error.code==='PUT_RESULT_UNCONFIRMED'||error.code==='UPLOAD_OWNER_MISMATCH'||
            /^R2_STORAGE_(?:CAPACITY_EXCEEDED|INVENTORY_BUSY|SNAPSHOT_STALE)$/.test(error.code??'')||
            /^(AUTH_|MEMBER_|CSRF_|SUBMISSIONS_|CAMPAIGN_|TURNSTILE_|BATCH_AUTH_|DIRECT_INTENT_)/.test(error.code ?? "")) {
          this.changed(this.summary); break;
        }
      }
      this.changed(this.summary);
    }
    return this.summary;
  }
}
