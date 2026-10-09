import { jsonSuccess } from "./response.js";
import {
  AUTH_LIMITS,
  readAuthJson,
  onlyFields,
  normalizeLogin,
  passwordInput,
  invalidVerification,
} from "./auth-validation.js";
import {
  authContext,
  authHandler,
  createTransaction,
  readTransaction,
  credentials,
  consumeTransaction,
  revokeSessions,
  revokeDevices,
  recoverySet,
} from "./auth.js";
import {
  withCookies,
  cookie,
  SESSION_COOKIE,
  LOGIN_COOKIE,
  DEVICE_COOKIE,
} from "../lib/auth-session.js";
import {
  authNow,
  throttle,
  authAtomic,
  credentialGuard,
  transactionGuard,
} from "../lib/auth-store.js";
import {
  recoveryHash,
  verifyPassword,
  dummyPasswordCheck,
  passwordRecord,
  newTotp,
  encryptTotp,
  totpStep,
} from "../lib/auth-crypto.js";
const recoveryGuard = (memberId, payload) => ({
  sql: `EXISTS(SELECT 1 FROM recovery_codes r JOIN member_credentials c USING(member_id)
 WHERE r.member_id=? AND r.generation=c.recovery_generation AND r.code_hash=? AND r.used_at IS NULL)`,
  args: [memberId, payload.code_hash],
});
const recoveryStart = (kind) =>
  authHandler(async (env, _url, request) => {
    const db = await authContext(request, env),
      body = await readAuthJson(request);
    onlyFields(
      body,
      kind === "totp_recovery"
        ? ["login_name", "recovery_code", "password"]
        : ["login_name", "recovery_code"],
    );
    const name = normalizeLogin(body.login_name);
    await throttle(
      request,
      env,
      kind + ":start",
      name,
      AUTH_LIMITS.accountAttempts,
      kind === "totp_recovery",
    );
    if (
      typeof body.recovery_code !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.recovery_code)
    )
      throw invalidVerification();
    const member = await db
        .prepare("SELECT member_id FROM members WHERE login_name=?")
        .bind(name)
        .first(),
      record = member ? await credentials(db, member.member_id) : null;
    const hash = await recoveryHash(
      member?.member_id ?? "missing",
      body.recovery_code,
    );
    const code = record
      ? await db
          .prepare(
            "SELECT code_hash FROM recovery_codes WHERE member_id=? AND generation=? AND code_hash=? AND used_at IS NULL",
          )
          .bind(member.member_id, record.recovery_generation, hash)
          .first()
      : null;
    if (kind === "totp_recovery") {
      const password = passwordInput(body.password),
        valid = record
          ? await verifyPassword(password, record.password_record, env)
          : await dummyPasswordCheck(password, env);
      if (!valid) throw invalidVerification();
    }
    if (!code || record.status !== "active") throw invalidVerification();
    const data = { version: record.version, code_hash: hash };
    let setup;
    if (kind === "totp_recovery") {
      setup = newTotp(name);
      Object.assign(
        data,
        await encryptTotp(setup.secret, member.member_id, env),
      );
    }
    const tx = await createTransaction(db, kind, data, member.member_id);
    return withCookies(
      jsonSuccess(
        {
          transaction_id: tx.id,
          expires_in: AUTH_LIMITS.transactionSeconds,
          ...(setup ? { otpauth_uri: setup.otpauth_uri } : {}),
        },
        "no-store",
        202,
      ),
      tx.cookies,
    );
  });
export const passwordRecoveryStart = recoveryStart("password_recovery"),
  totpRecoveryStart = recoveryStart("totp_recovery");
const recoveryFinish = (kind) =>
  authHandler(async (env, _url, request) => {
    const db = await authContext(request, env),
      body = await readAuthJson(request);
    onlyFields(
      body,
      kind === "password_recovery"
        ? ["transaction_id", "new_password"]
        : ["transaction_id", "code"],
    );
    const tx = await readTransaction(request, env, body, kind),
      statements = [],
      record = await credentials(db, tx.member_id);
    if (
      !record ||
      record.status !== "active" ||
      record.version !== tx.data.version
    )
      throw invalidVerification();
    let recovery;
    if (kind === "password_recovery") {
      const password = passwordInput(body.new_password);
      await throttle(
        request,
        env,
        "password-reset",
        tx.member_id,
        AUTH_LIMITS.accountAttempts,
        true,
      );
      statements.push(
        db
          .prepare(
            "UPDATE member_credentials SET password_record=?,version=version+1,updated_at=? WHERE member_id=?",
          )
          .bind(await passwordRecord(password, env), authNow(), tx.member_id),
      );
    } else {
      const step = await totpStep(tx.data, tx.member_id, body.code, env);
      recovery = await recoverySet(
        db,
        tx.member_id,
        record.recovery_generation + 1,
      );
      statements.push(
        db
          .prepare(
            `UPDATE member_credentials SET totp_ciphertext=?,totp_iv=?,totp_key_version=?,last_used_time_step=?,
   version=version+1,recovery_generation=recovery_generation+1,updated_at=? WHERE member_id=?`,
          )
          .bind(
            tx.data.totp_ciphertext,
            tx.data.totp_iv,
            tx.data.totp_key_version,
            step,
            authNow(),
            tx.member_id,
          ),
        ...recovery.statements,
      );
    }
    // Validate unconsumed recovery proof in the SAME batch as credentials/revocation.
    await authAtomic(
      db,
      [
        transactionGuard(tx),
        credentialGuard(tx.member_id, tx.data.version),
        recoveryGuard(tx.member_id, tx.data),
      ],
      [
        db
          .prepare(
            "UPDATE recovery_codes SET used_at=? WHERE member_id=? AND code_hash=? AND used_at IS NULL",
          )
          .bind(authNow(), tx.member_id, tx.data.code_hash),
        ...statements,
        consumeTransaction(db, tx),
        revokeSessions(db, tx.member_id),
        revokeDevices(db, tx.member_id),
      ],
    );
    return withCookies(
      jsonSuccess({
        recovered: true,
        login_required: true,
        ...(recovery ? { recovery_codes: recovery.codes } : {}),
      }),
      [
        cookie(SESSION_COOKIE, "", 0),
        cookie(DEVICE_COOKIE, "", 0),
        cookie(LOGIN_COOKIE, "", 0),
      ],
    );
  });
export const passwordRecoveryFinish = recoveryFinish("password_recovery"),
  totpRecoveryFinish = recoveryFinish("totp_recovery");
