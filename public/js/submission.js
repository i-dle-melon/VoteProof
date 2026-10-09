import { PublicError } from "./api.js";
// Client UX limits mirror the public contract; backend is authoritative.
export const FILE_LIMITS = Object.freeze({ count: 5, bytes: 5 * 1024 * 1024, batch: 25 * 1024 * 1024 });
export const IMAGE_TYPES = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
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
  const nickname = text("nickname", 50), player_id = text("player_id", 100), campaign_id = text("campaign_id", 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(campaign_id) || !["Solo", "團體"].includes(input.vote_type) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.vote_date ?? "")) throw new PublicError("INVALID_CASE_REQUEST");
  const date = new Date(input.vote_date + "T00:00:00Z");
  if (!Number.isFinite(date.valueOf()) || date.toISOString().slice(0, 10) !== input.vote_date) throw new PublicError("INVALID_CASE_REQUEST");
  const note = (input.note ?? "").trim();
  if ([...note].length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note)) throw new PublicError("INVALID_CASE_REQUEST");
  return Object.freeze({ nickname, player_id, campaign_id, vote_type: input.vote_type, vote_date: input.vote_date, note: note || null });
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
    if (url.protocol !== "https:" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname) || url.username || url.password ||
        upload.method !== "PUT" || typeof upload.key !== "string" || upload.headers?.["Content-Type"] !== files[i].type)
      throw new PublicError("SERVICE_UNAVAILABLE");
  }
  return data;
}
export function queryInformation(result) {
  return `VoteProof\n案件編號：${result.case_id}\n查詢碼：${result.query_key}`;
}

export class Submission {
  #context = null;
  #running = null;
  constructor({ api, put, token, progress = () => {}, now = () => Date.now() }) {
    this.api = api; this.put = put; this.token = token; this.progress = progress; this.now = now;
  }
  get pending() { return this.#context !== null; }
  get busy() { return this.#running !== null; }
  start(metadata, files, { caseApi } = {}) {
    if (this.pending) throw new PublicError("SUBMISSION_PENDING");
    validateImages(files);
    this.#context = { metadata: normalizedMetadata(metadata), files: [...files], idempotency: newIdempotencyKey(),
      prepared: null, uploaded: new Set(), completed: false, payload: null, caseApi };
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
    // Before case creation is attempted, expired PUT grants can safely be
    // replaced. Once payload exists, it is immutable, including upload refs.
    if (!c.payload && !c.completed && c.prepared && this.now() >= c.expiresAt) {
      c.prepared = null; c.uploaded.clear();
    }
    if (!c.prepared) {
      this.progress({ phase: "verify", fraction: 0 });
      const token = await this.token();
      if (!token) throw new PublicError("TURNSTILE_REQUIRED");
      this.progress({ phase: "prepare", fraction: 0 });
      const started = this.now();
      c.prepared = checkedPrepare(await this.api("/api/uploads/prepare", { method: "POST", body: {
        turnstile_token: token, files: c.files.map((f, i) => ({ name: `proof-${i + 1}.${IMAGE_TYPES[f.type]}`, type: f.type, size: f.size })) } }), c.files);
      c.expiresAt = started + c.prepared.expires_in * 1000;
    }
    for (let i = 0; i < c.files.length && !c.completed; i++) {
      if (c.uploaded.has(i)) continue;
      const update = (fraction) => this.progress({ phase: "put", file: i + 1, count: c.files.length,
        fraction: (c.uploaded.size + fraction) / c.files.length });
      update(0);
      await this.put(c.prepared.uploads[i], c.files[i], update);
      c.uploaded.add(i);
    }
    const reference = { session_id: c.prepared.session_id, keys: c.prepared.uploads.map((u) => u.key) };
    if (!c.completed) {
      this.progress({ phase: "complete", fraction: 1 });
      try { await this.api("/api/uploads/complete", { method: "POST", body: reference }); }
      catch (e) { if (e.code === "UPLOAD_INCOMPLETE") c.uploaded.clear(); throw e; }
      c.completed = true;
    }
    // Store the serialized body ONCE before POST. Lost success responses must
    // replay this exact body/key, even if the upload is already consumed.
    c.payload ??= JSON.stringify({ ...c.metadata, upload_session: reference });
    this.progress({ phase: "case", fraction: 1 });
    const result = await (c.caseApi ?? this.api)("/api/cases", { method: "POST", headers: { "Idempotency-Key": c.idempotency }, body: c.payload });
    if (!/^VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/.test(result?.case_id ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/.test(result?.query_key ?? "")) throw new PublicError("SERVICE_UNAVAILABLE");
    this.#context = null;
    return result;
  }
}
