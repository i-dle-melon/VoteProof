// Scan only reviewable Git changes. Never open ignored local env/live configs,
// clipboard, databases, screenshots, mail or provider credentials.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
const git = args => execFileSync("git", args, { encoding: "utf8", windowsHide: true }).trim().split(/\r?\n/).filter(Boolean);
const files = [...new Set([...git(["diff", "--name-only", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])])];
const rules = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{20,}/,
  /\b(?:AIza[0-9A-Za-z_-]{30,}|ya29\.[0-9A-Za-z_-]{30,}|1\/\/[0-9A-Za-z_-]{30,})/,
  /https:\/\/script\.google\.com\/macros\/s\/[^\s"'`]+/,
  /X-Amz-(?:Signature|Credential)=[0-9a-fA-F]/,
  /otpauth:\/\/[^\s"'`]+[?&]secret=[A-Z2-7]{16,}/,
  /(?:C:\\Users\\|C:\/Users\/)/i,
  /(?:AUTH_SECRET|AUTH_TOTP_ENCRYPTION_KEY|R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|GMAIL_(?:CLIENT_SECRET|REFRESH_TOKEN)|SUPABASE_SECRET_KEY)\s*[=:]\s*["'][A-Za-z0-9_\/-]{20,}["']/,
  /(?:query_key|idempotency_key|recovery_code|turnstile_token|csrf_token)\s*[=:]\s*["'][A-Za-z0-9_-]{32,}["']/,
];
for (const file of files) {
  assert.equal(/^(?:\.wrangler\/|node_modules\/|\.dev\.vars|\.env)/.test(file), false, "Local data included in Git changes");
  const source = await readFile(file, "utf8");
  assert.equal(rules.some(rule => rule.test(source)), false, "Sensitive literal found in " + file);
}
const protectedPaths = git(["diff", "--name-only", "HEAD", "--", "src", "migrations", "wrangler.jsonc", "public/_headers"]);
assert.deepEqual(protectedPaths, [], "B6 must not modify backend/schema/bindings/security headers");
console.log(JSON.stringify({ reviewed_files: files.length, sensitive_findings: 0, backend_schema_bindings: "unchanged", ignored_credentials_read: false }));
