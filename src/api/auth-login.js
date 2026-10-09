import { jsonSuccess } from "./response.js";
import {
  AUTH_LIMITS,
  AuthError,
  readAuthJson,
  onlyFields,
  normalizeLogin,
  passwordInput,
  booleanInput,
  profileInput,
  invalidVerification,
} from "./auth-validation.js";
import { UploadError, UPLOAD_LIMITS } from "./upload-validation.js";
import { verifyTurnstile } from "./turnstile.js";
import {
  withCookies,
  readCookie,
  DEVICE_COOKIE,
  authDatabase,
} from "../lib/auth-session.js";
import {
  newTotp,
  encryptTotp,
  passwordRecord,
  verifyPassword,
  dummyPasswordCheck,
  totpStep,
  deviceHash,
} from "../lib/auth-crypto.js";
import { authNow, throttle, credentialGuard } from "../lib/auth-store.js";
import {
  authHandler,
  authContext,
  createTransaction,
  readTransaction,
  issueSession,
  recoverySet,
  credentials,
  totpGuard,
  advanceTotp,
} from "./auth.js";
export const registrationStart = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, [
    "login_name",
    "password",
    "nickname",
    "player_id",
    "turnstile_token",
  ]);
  const name = normalizeLogin(body.login_name),
    password = passwordInput(body.password),
    profile = profileInput({
      nickname: body.nickname,
      ...(body.player_id === undefined ? {} : { player_id: body.player_id }),
    });
  await throttle(
    request,
    env,
    "register",
    name,
    AUTH_LIMITS.registrationStarts,
    true,
  );
  if (typeof body.turnstile_token !== "string" || !body.turnstile_token.trim())
    throw new UploadError(
      400,
      "TURNSTILE_REQUIRED",
      "Turnstile verification is required",
    );
  if (body.turnstile_token.length > UPLOAD_LIMITS.maxTokenLength)
    throw new AuthError(
      400,
      "INVALID_AUTH_REQUEST",
      "Invalid authentication request",
    );
  await verifyTurnstile(request, env, body.turnstile_token.trim());
  const memberId = "M-" + crypto.randomUUID(),
    setup = newTotp(name);
  const data = {
    login_name: name,
    member_id: memberId,
    ...profile,
    password_record: await passwordRecord(password, env),
    ...(await encryptTotp(setup.secret, memberId, env)),
  };
  const tx = await createTransaction(db, "register", data);
  // Identical enrollment shape even if the login name is already registered.
  return withCookies(
    jsonSuccess(
      {
        transaction_id: tx.id,
        expires_in: AUTH_LIMITS.transactionSeconds,
        otpauth_uri: setup.otpauth_uri,
      },
      "no-store",
      202,
    ),
    tx.cookies,
  );
});
export const registrationVerify = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, [
    "transaction_id",
    "code",
    "trust_this_device",
    "remember_me",
  ]);
  const trust = booleanInput(body.trust_this_device),
    remember = booleanInput(body.remember_me),
    tx = await readTransaction(request, env, body, "register"),
    data = tx.data;
  const step = await totpStep(data, data.member_id, body.code, env),
    now = authNow(),
    timestamp = new Date().toISOString();
  const recovery = await recoverySet(db, data.member_id, 1);
  return issueSession(request, env, data.member_id, {
    remember,
    mfa: true,
    trust,
    tx,
    recoveryCodes: recovery.codes,
    guards: [
      {
        sql: "NOT EXISTS(SELECT 1 FROM members WHERE login_name=?)",
        args: [data.login_name],
      },
    ],
    statements: [
      db
        .prepare(
          "INSERT INTO members(id,member_id,login_name,nickname,player_id,created_at,updated_at,last_login_at) VALUES(?,?,?,?,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          data.member_id,
          data.login_name,
          data.nickname,
          data.player_id ?? null,
          timestamp,
          timestamp,
          timestamp,
        ),
      db
        .prepare(
          `INSERT INTO member_credentials(member_id,password_record,totp_ciphertext,totp_iv,totp_key_version,last_used_time_step,updated_at) VALUES(?,?,?,?,?,?,?)`,
        )
        .bind(
          data.member_id,
          data.password_record,
          data.totp_ciphertext,
          data.totp_iv,
          data.totp_key_version,
          step,
          now,
        ),
      ...recovery.statements,
    ],
  });
});
const loginFailure = () =>
  new AuthError(
    401,
    "AUTH_LOGIN_FAILED",
    "Account or authentication is invalid",
  );
export const passwordLogin = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["login_name", "password", "remember_me"]);
  const name = normalizeLogin(body.login_name),
    password = passwordInput(body.password),
    remember = booleanInput(body.remember_me);
  await throttle(
    request,
    env,
    "password-login",
    name,
    AUTH_LIMITS.accountAttempts,
    true,
  );
  const member = await db
    .prepare("SELECT member_id FROM members WHERE login_name=?")
    .bind(name)
    .first();
  const record = member ? await credentials(db, member.member_id) : null;
  const valid = record
    ? await verifyPassword(password, record.password_record, env)
    : await dummyPasswordCheck(password, env);
  if (!valid || record.status !== "active") throw loginFailure();
  let token;
  try {
    token = readCookie(request, DEVICE_COOKIE);
  } catch {
    /* Invalid trust cannot grant authentication. */
  }
  const hash = token ? await deviceHash(token) : null;
  const device = hash
    ? await db
        .prepare(
          `SELECT id FROM trusted_devices WHERE token_hash=? AND member_id=? AND revoked_at IS NULL AND expires_at>?`,
        )
        .bind(hash, member.member_id, authNow())
        .first()
    : null;
  if (device)
    return issueSession(request, env, member.member_id, {
      remember,
      guards: [
        credentialGuard(member.member_id, record.version),
        {
          sql: `EXISTS(SELECT 1 FROM trusted_devices WHERE id=? AND member_id=? AND token_hash=? AND revoked_at IS NULL AND expires_at>CAST(strftime('%s','now') AS INTEGER))`,
          args: [device.id, member.member_id, hash],
        },
      ],
      statements: [
        db
          .prepare("UPDATE trusted_devices SET last_used_at=? WHERE id=?")
          .bind(authNow(), device.id),
      ],
    });
  const tx = await createTransaction(
    db,
    "login",
    { version: record.version, remember_me: remember },
    member.member_id,
  );
  return withCookies(
    jsonSuccess(
      {
        status: "MFA_REQUIRED",
        transaction_id: tx.id,
        expires_in: AUTH_LIMITS.transactionSeconds,
      },
      "no-store",
      202,
    ),
    tx.cookies,
  );
});
export const loginTotp = authHandler(async (env, _url, request) => {
  const db = await authContext(request, env),
    body = await readAuthJson(request);
  onlyFields(body, ["transaction_id", "code", "trust_this_device"]);
  const trust = booleanInput(body.trust_this_device),
    tx = await readTransaction(request, env, body, "login"),
    record = await credentials(db, tx.member_id);
  if (
    !record ||
    record.status !== "active" ||
    record.version !== tx.data.version
  )
    throw invalidVerification();
  const step = await totpStep(record, tx.member_id, body.code, env);
  return issueSession(request, env, tx.member_id, {
    remember: tx.data.remember_me,
    mfa: true,
    trust,
    tx,
    guards: [totpGuard(tx.member_id, record.version, step)],
    statements: [advanceTotp(db, tx.member_id, step)],
  });
});
