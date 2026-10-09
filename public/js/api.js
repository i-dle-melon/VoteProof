// Public/Guest API adapter. Responses and credential-bearing URLs never log.
export class PublicError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export async function api(path, { method = "GET", body, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(path, { method, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(30000), headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }) });
  } catch { throw new PublicError("NETWORK_ERROR"); }
  let result;
  try { result = await response.json(); } catch { throw new PublicError("SERVICE_UNAVAILABLE", response.status); }
  if (!response.ok || result?.ok !== true) throw new PublicError(result?.error?.code ?? "SERVICE_UNAVAILABLE", response.status);
  return result.data;
}
export function putImage(upload, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", upload.upload_url);
    xhr.withCredentials = false;
    xhr.timeout = 120000;
    // Signed MIME must be exact; do not add auth headers to the R2 request.
    xhr.setRequestHeader("Content-Type", upload.headers["Content-Type"]);
    xhr.upload.onprogress = (event) => onProgress(event.lengthComputable ? event.loaded / event.total : 0);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress(1); resolve(); }
      else reject(new PublicError("PUT_FAILED", xhr.status));
    };
    xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new PublicError("PUT_FAILED"));
    xhr.send(file);
  });
}

const messages = {
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
  CAMPAIGN_NOT_OPEN: "此活動目前不接受投稿，請放棄本次投稿後重新選擇活動。",
  CAMPAIGN_NOT_FOUND: "此活動已無法使用，請重新載入活動。",
  VOTE_DATE_OUTSIDE_CAMPAIGN: "投票日期不在活動期間內，請檢查日期。",
  INVALID_CASE_REQUEST: "投稿資料未通過檢查，請確認暱稱、玩家 ID、日期與備註。",
  TOO_MANY_FILES: "每次最多選擇 5 張圖片。",
  FILE_TOO_LARGE: "每張圖片必須大於 0 bytes，且不超過 5 MiB。",
  UNSUPPORTED_FILE_TYPE: "只接受 PNG、JPEG 或 WebP 圖片。",
};
export const errorMessage = (error) => messages[error?.code] ?? "服務暫時無法完成操作，請稍後重試。";
