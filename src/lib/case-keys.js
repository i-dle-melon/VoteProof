const CASE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CASE_ID_PATTERN = /^VP-\d{8}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{16}$/;
export const QUERY_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function newCaseId(now = new Date()) {
  const random = crypto.getRandomValues(new Uint8Array(16));
  return `VP-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${Array.from(random, byte => CASE_ALPHABET[byte & 31]).join("")}`;
}

export function newQueryKey() {
  const random = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...random)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export async function sha256(value) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

export function equalQueryHash(candidate, expected) {
  // Workers' documented constant-time Web Crypto extension. Both hashes are
  // fixed-length SHA-256 hex; a missing case uses a dummy hash of the same length.
  return crypto.subtle.timingSafeEqual(new TextEncoder().encode(candidate), new TextEncoder().encode(expected));
}
