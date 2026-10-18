// Public/Guest API adapter. Responses and credential-bearing URLs never log.
import { PREVIEW, previewFetch } from "./preview.js";
export class PublicError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await (PREVIEW ? previewFetch : fetch)(path, { method, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30000), headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  } catch { throw new PublicError("NETWORK_ERROR"); }
  let result;
  try { result = await response.json(); } catch { throw new PublicError("SERVICE_UNAVAILABLE", response.status); }
  if (!response.ok || result?.ok !== true) throw new PublicError(result?.error?.code ?? "SERVICE_UNAVAILABLE", response.status);
  return result.data;
}
export async function campaignExample(path,signal){
  if(!/^\/api\/campaigns\/[A-Za-z0-9_-]{1,100}\/example$/.test(path))throw new PublicError('INVALID_CONTENT_REQUEST');
  const r=await(PREVIEW?previewFetch:fetch)(path,{credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal});
  if(!r.ok||!['image/png','image/jpeg','image/webp'].includes(r.headers.get('Content-Type')))throw new PublicError('CONTENT_NOT_FOUND');
  const blob=await r.blob();if(blob.size<=0||blob.size>5242880)throw new PublicError('INVALID_IMAGE_TYPE');return blob;
}
export function putImage(upload, file, onProgress) {
  if (PREVIEW) return Promise.reject(new PublicError("UI_PREVIEW_ONLY", 403));
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", upload.upload_url);
    xhr.withCredentials = false;
    xhr.timeout = 120000;
    // Same-origin capability header, never placed in a query string or logged.
    xhr.setRequestHeader("Content-Type", upload.headers["Content-Type"]);
    xhr.setRequestHeader('X-Upload-Grant', upload.headers['X-Upload-Grant']);
    xhr.upload.onprogress = (event) => onProgress(event.lengthComputable ? event.loaded / event.total : 0);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); }
      else {
        let code;try{code=JSON.parse(xhr.responseText)?.error?.code;}catch{/* Sanitized fallback. */}
        // Create-only replay does not attest to the retried body. Legacy
        // Complete or direct Case HEAD verifies the original provider checksum.
        if(xhr.status===409&&code==='UPLOAD_ALREADY_UPLOADED'){onProgress(1);resolve();}
        else reject(new PublicError(['UPLOAD_REPREPARE_REQUIRED','R2_STORAGE_CAPACITY_EXCEEDED'].includes(code)?code:'PUT_FAILED',xhr.status));
      }
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new PublicError("PUT_FAILED"));
    xhr.send(file);
  });
}

const messages = {
  DIRECT_INTENT_DISABLED: "投稿服務尚未完成啟用，請稍後重試；已送出的案件不會重複建立。",
  R2_STORAGE_CAPACITY_EXCEEDED: "目前儲存空間不足，暫時停止圖片上傳，請稍後再試。",
  UPLOAD_REPREPARE_REQUIRED: "上傳結果尚未確認，請按重試以重新準備安全上傳。",
  SUBMISSIONS_IMMUTABLE_DISABLED: "安全上傳目前暫停開放，請稍後重試。",
  UI_PREVIEW_ONLY: "這是 UI 預覽，無法登入、投稿或保存變更。",
  SUBMISSIONS_DISABLED: "投稿目前暫停開放，請稍後再試。",
  SUBMISSIONS_UNAVAILABLE: "投稿服務暫時無法使用，請稍後再試。",
  NETWORK_ERROR: "網路連線中斷或等待逾時。請檢查連線後重試，投稿資料會保留。",
  PUT_FAILED: "圖片未能上傳。請檢查網路後重試；若持續失敗，請稍後再試。",
  TURNSTILE_REQUIRED: "請先完成人機驗證。",
  TURNSTILE_INVALID: "人機驗證已失效，請重新驗證後重試。",
  TURNSTILE_UPSTREAM_ERROR: "驗證服務暫時無法連線，請重新驗證後重試。",
  TURNSTILE_NOT_CONFIGURED: "投稿驗證服務尚未就緒，請稍後再試。",
  R2_UPLOAD_NOT_CONFIGURED: "圖片上傳服務尚未就緒，請稍後再試。",
  UPLOAD_INCOMPLETE: "部分圖片尚未完成上傳，請重試。",
  UPLOAD_VALIDATION_FAILED: "圖片未通過檢查。請放棄本次投稿，重新選擇有效圖片。",
  UPLOAD_SESSION_EXPIRED: "本次上傳已過期。請放棄本次投稿後重新開始。",
  UPLOAD_ALREADY_USED: "這批圖片已用於另一案件，請先確認原案件的查詢資訊。",
  IDEMPOTENCY_CONFLICT: "本次投稿資料與先前提交不一致，請保留查詢資訊並稍後再試。",
  IDEMPOTENCY_NOT_CONFIGURED: "投稿重試服務尚未就緒，請稍後再試。",
  CAMPAIGN_TYPE_INVALID: "活動投稿類型或 Solo 對象尚未設定，暫時無法投稿。",
  CAMPAIGN_TYPE_MISMATCH: "投稿類型必須與活動設定一致，請重新選擇活動。",
  CAMPAIGN_NOT_OPEN: "此活動目前不接受投稿，請放棄本次投稿後重新選擇活動。",
  CAMPAIGN_NOT_FOUND: "此活動已無法使用，請重新載入活動。",
  VOTE_DATE_OUTSIDE_CAMPAIGN: "投票日期不在活動期間內，請檢查日期。",
  INVALID_CASE_REQUEST: "投稿資料未通過檢查，請確認活動、日期與備註。",
  TOO_MANY_FILES: "每次最多選擇 5 張圖片。",
  BATCH_TOO_MANY_FILES: "每批最多選擇 20 張圖片；每張會建立獨立案件。",
  BATCH_INCOMPLETE: "部分圖片尚未送出；已成功的案件會保留，重試只處理未成功項目。",
  FILE_TOO_LARGE: "每張圖片必須大於 0 bytes，且不超過 5 MiB。",
  UNSUPPORTED_FILE_TYPE: "只接受 PNG、JPEG 或 WebP 圖片。",
};
export const errorMessage = (error) => messages[error?.code] ?? "服務暫時無法完成操作，請稍後重試。";
