import { AwsClient } from "aws4fetch";
import { UploadError, UPLOAD_LIMITS } from "../api/upload-validation.js";

const REQUIRED_R2_ENV = Object.freeze([
  "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY",
]);

export function readR2UploadConfig(env) {
  if (REQUIRED_R2_ENV.some(name => typeof env[name] !== "string" || !env[name].trim())) {
    throw new UploadError(503, "R2_UPLOAD_NOT_CONFIGURED", "Upload service is not configured");
  }
  const accountId = env.R2_ACCOUNT_ID.trim(), bucketName = env.R2_BUCKET_NAME.trim();
  // Prevent malformed config from changing the destination host or object path.
  if (!/^[a-f0-9]{32}$/i.test(accountId) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucketName)) {
    throw new UploadError(503, "R2_UPLOAD_NOT_CONFIGURED", "Upload service is not configured");
  }
  return { accountId, bucketName, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY };
}

export async function presignPut(config, key, type) {
  const client = new AwsClient({
    accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey,
    service: "s3", region: "auto",
  });
  const url = new URL(`https://${config.accountId}.r2.cloudflarestorage.com/`);
  url.pathname = "/" + config.bucketName + "/" + key.split("/").map(encodeURIComponent).join("/");
  url.searchParams.set("X-Amz-Expires", String(UPLOAD_LIMITS.expiresSeconds));
  const signed = await client.sign(url, {
    method: "PUT", headers: { "Content-Type": type },
    // aws4fetch excludes content-type by default. allHeaders is essential here.
    aws: { signQuery: true, allHeaders: true },
  });
  // Standard SigV4 URLs necessarily include the access-key identifier inside
  // X-Amz-Credential, as approved by the user. Never expose the secret signing key.
  return { key, method: "PUT", upload_url: signed.url, headers: { "Content-Type": type } };
}
