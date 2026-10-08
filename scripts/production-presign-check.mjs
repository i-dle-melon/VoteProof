// URL input is stdin, never an argument, fixture, environment variable or log.
// Live test writes only the supplied server staging key. No Worker secrets needed.
import { validateComplete, UPLOAD_LIMITS } from "../src/api/upload-validation.js";

const origin = "https://voteproof.i-dle-melon.workers.dev";
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5V8AAAAASUVORK5CYII=", "base64");
const rows = [];
const record = (test, pass, detail) => { rows.push({ test, result: pass ? "PASS" : "FAIL", ...detail }); };
let input = "";
for await (const chunk of process.stdin) input += chunk;
let url, key, session;
try {
  url = new URL(input.trim()); input = "";
  if (url.protocol !== "https:" || !/^[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/.test(url.hostname)) throw new Error();
  if (!url.pathname.startsWith("/voteproof-proofs/proofs/staging/")) throw new Error();
  key = url.pathname.slice("/voteproof-proofs/".length);
  session = key.split("/")[5];
  validateComplete({ session_id: session, keys: [key] });
  if (url.searchParams.get("X-Amz-Expires") !== String(UPLOAD_LIMITS.expiresSeconds) ||
      url.searchParams.get("X-Amz-SignedHeaders") !== "content-type;host") throw new Error();
} catch {
  console.log("Invalid 300-second PNG staging upload URL; no input details logged.");
  process.exit(1);
}
async function r2(method, type = "image/png", anonymous = false) {
  const target = new URL(url);
  if (anonymous) target.search = "";
  const headers = method === "OPTIONS" ? {
    Origin: origin, "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type",
  } : { Origin: origin, "Content-Type": type };
  try {
    const response = await fetch(target, {
      method, headers, ...(method === "PUT" ? { body: png } : {}), signal: AbortSignal.timeout(15000),
    });
    const text = await response.text();
    return {
      status: response.status, code: text.match(/<Code>([A-Za-z0-9]+)<\/Code>/)?.[1],
      originAllowed: response.headers.get("access-control-allow-origin") === origin,
      etagExposed: /(^|,)\s*etag\s*(,|$)/i.test(response.headers.get("access-control-expose-headers") ?? ""),
      etagPresent: Boolean(response.headers.get("etag")),
    };
  } catch { return { status: 0, code: "NETWORK_ERROR" }; }
}
async function expiredCheck() {
  const response = await r2("PUT");
  record("expired PUT rejected", response.status === 403 && response.code === "ExpiredRequest", response);
}
if (process.argv.includes("--expired")) {
  await expiredCheck();
} else {
  const cors = await r2("OPTIONS");
  record("CORS preflight", [200, 204].includes(cors.status) && cors.originAllowed, cors);
  const put = await r2("PUT");
  const uploaded = put.status >= 200 && put.status < 300;
  record("fresh correct PNG PUT", uploaded, put);
  if (uploaded) {
    record("successful PUT CORS + ETag", put.originAllowed && put.etagExposed && put.etagPresent, {});
    const wrongType = await r2("PUT", "image/jpeg");
    record("changed MIME signature rejected", wrongType.status === 403 && wrongType.code === "SignatureDoesNotMatch", wrongType);
    const signedGet = await r2("GET");
    record("PUT URL cannot authorize GET", signedGet.status === 403 && signedGet.code === "SignatureDoesNotMatch", signedGet);
    const anonymous = await r2("GET", "image/png", true);
    record("uploaded private object cannot be read anonymously", [401, 403].includes(anonymous.status), anonymous);
    try {
      const complete = await fetch(origin + "/api/uploads/complete", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, keys: [key] }), signal: AbortSignal.timeout(15000),
      });
      const payload = await complete.json(), file = payload.data?.files?.[0];
      const valid = complete.status === 200 && payload.ok === true && file?.key === key &&
        file.size === png.length && file.type === "image/png" && typeof file.etag === "string" &&
        Object.keys(file).sort().join(",") === "etag,key,size,type";
      record("real uploaded object complete / exact safe metadata", valid, { status: complete.status, code: payload.error?.code });
    } catch { record("real uploaded object complete", false, { code: "NETWORK_ERROR" }); }
  } else {
    rows.push({ test: "MIME / GET / complete checks", result: "BLOCKED: successful PUT baseline required" });
  }
  if (process.argv.includes("--wait-expiry") && uploaded) {
    console.table(rows);
    const date = url.searchParams.get("X-Amz-Date") ?? "";
    if (!/^\d{8}T\d{6}Z$/.test(date)) throw new Error("Invalid signing timestamp");
    const issued = Date.UTC(+date.slice(0, 4), +date.slice(4, 6) - 1, +date.slice(6, 8), +date.slice(9, 11), +date.slice(11, 13), +date.slice(13, 15));
    console.log("Waiting for the 300-second URL to expire; no URL or credentials logged.");
    await new Promise(resolve => setTimeout(resolve, Math.max(0, issued + (UPLOAD_LIMITS.expiresSeconds + 6) * 1000 - Date.now())));
    await expiredCheck();
  }
}
console.table(rows);
if (rows.some(row => row.result !== "PASS")) process.exitCode = 1;
