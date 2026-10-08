export function jsonSuccess(data, cacheControl = "no-store", status = 200) {
  return jsonResponse({ ok: true, data }, status, { "cache-control": cacheControl });
}

export function jsonError(status, code, message, headers = {}) {
  return jsonResponse({ ok: false, error: { code, message } }, status, headers);
}

function jsonResponse(body, status, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
