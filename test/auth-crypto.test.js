import test from "node:test";
import assert from "node:assert/strict";
import {
  randomBytes,
  createHmac,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { Secret } from "otpauth";
import {
  passwordRecord,
  verifyPassword,
  newTotp,
  encryptTotp,
  decryptTotp,
  totpStep,
} from "../src/lib/auth-crypto.js";
crypto.subtle.timingSafeEqual ??= (a, b) =>
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const env = () => ({
  AUTH_PASSWORD_PEPPER: randomBytes(32).toString("hex"),
  AUTH_TOTP_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
});
test("Workers-compatible scrypt equals independent Node crypto with pepper and declared parameters", async () => {
  const config = env(),
    password = randomBytes(24).toString("base64url"),
    record = JSON.parse(await passwordRecord(password, config));
  const material = createHmac(
    "sha256",
    Buffer.from(config.AUTH_PASSWORD_PEPPER, "hex"),
  )
    .update("VoteProof/password/v1:" + password)
    .digest();
  const independent = scryptSync(
    material,
    Buffer.from(record.salt, "hex"),
    32,
    { N: 32768, r: 8, p: 3, maxmem: 34 * 1024 * 1024 },
  );
  assert.ok(timingSafeEqual(Buffer.from(record.hash, "hex"), independent));
  assert.equal(
    await verifyPassword(password, JSON.stringify(record), config),
    true,
  );
  assert.equal(
    await verifyPassword(
      randomBytes(24).toString("base64url"),
      JSON.stringify(record),
      config,
    ),
    false,
  );
});
test("salt uniqueness and password whitespace are preserved", async () => {
  const config = env(),
    password = randomBytes(24).toString("base64url"),
    a = await passwordRecord(password, config),
    b = await passwordRecord(password, config);
  assert.notEqual(JSON.parse(a).salt, JSON.parse(b).salt);
  assert.equal(await verifyPassword(" " + password, a, config), false);
});
test("TOTP RFC6238 SHA1 vector, drift and persistent replay counter", async () => {
  const config = env(),
    member = "M-" + crypto.randomUUID();
  // Public RFC6238 test vector, not an account fixture credential.
  const secret = new Secret({
    buffer: new TextEncoder().encode("12345678901234567890").buffer,
  });
  const record = await encryptTotp(secret.base32, member, config);
  assert.equal(await totpStep(record, member, "287082", config, 59000), 1);
  for (const timestamp of [29000, 89000])
    assert.equal(
      await totpStep(record, member, "287082", config, timestamp),
      1,
    );
  await assert.rejects(
    totpStep(
      { ...record, last_used_time_step: 1 },
      member,
      "287082",
      config,
      59000,
    ),
    (e) => e.code === "AUTH_VERIFICATION_FAILED",
  );
  await assert.rejects(
    totpStep(record, member, "287082", config, 119000),
    (e) => e.code === "AUTH_VERIFICATION_FAILED",
  );
});
test("AES-GCM uses independent random nonce, authenticated member/version binding, rotation fails closed", async () => {
  const config = env(),
    member = "M-" + crypto.randomUUID(),
    secret = newTotp("local-account").secret;
  const a = await encryptTotp(secret, member, config),
    b = await encryptTotp(secret, member, config);
  assert.notEqual(a.totp_iv, b.totp_iv);
  assert.notEqual(a.totp_ciphertext, b.totp_ciphertext);
  assert.equal(await decryptTotp(a, member, config), secret);
  await assert.rejects(decryptTotp(a, "M-" + crypto.randomUUID(), config));
  await assert.rejects(
    decryptTotp({ ...a, totp_key_version: 2 }, member, config),
    (e) => e.code === "AUTH_NOT_CONFIGURED",
  );
});
