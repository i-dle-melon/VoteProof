import {authHandler,authContext,credentials,totpGuard,advanceTotp,issueSession,recoverySet,consumeTransaction} from './auth.js';
import {readAuthJson,onlyFields,invalidVerification,AuthError,AUTH_LIMITS} from './auth-validation.js';
import {googleProof,activeIdentity} from './auth-google.js';
import {memberSession,memberCsrf,cookie,LOGIN_COOKIE,withCookies} from '../lib/auth-session.js';
import {authNow,authAtomic,activeSessionGuard,transactionGuard,credentialGuard,throttle} from '../lib/auth-store.js';
import {totpStep,recoveryHash,newTotp,encryptTotp} from '../lib/auth-crypto.js';
import {googleMfaPolicy,googleMfaGuard,googleMfaEvent,googleMfaAvailable} from '../lib/google-login-mfa.js';
import {jsonSuccess} from './response.js';
const identityGuard = tx => ({sql:'EXISTS(SELECT 1 FROM auth_identities WHERE member_id=? AND provider_subject=? AND google_identity_id=?)',args:[tx.member_id,tx.data.provider_subject,tx.data.google_identity_id]});
const payloadGuard = tx => ({sql:'EXISTS(SELECT 1 FROM auth_transactions WHERE id=? AND payload=?)',args:[tx.id,tx.payload]});
const available = env => {if(!googleMfaAvailable(env))throw new AuthError(503,'AUTH_GOOGLE_MFA_UNAVAILABLE','Google MFA opt-in is not available');};

async function factor(db,env,tx,body,allowRecovery) {
  const record=await credentials(db,tx.member_id);
  if(!record || record.status!=='active')throw invalidVerification();
  if(Object.hasOwn(body,'recovery_code')){
    if(!allowRecovery || Object.hasOwn(body,'code') || typeof body.recovery_code!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(body.recovery_code))throw invalidVerification();
    const hash=await recoveryHash(tx.member_id,body.recovery_code);
    return {record,recovery:true,guards:[credentialGuard(tx.member_id,record.version),{
      sql:'EXISTS(SELECT 1 FROM recovery_codes WHERE member_id=? AND generation=? AND code_hash=? AND used_at IS NULL)',
      args:[tx.member_id,record.recovery_generation,hash],
    }],statements:[db.prepare('UPDATE recovery_codes SET used_at=? WHERE member_id=? AND generation=? AND code_hash=? AND used_at IS NULL').bind(authNow(),tx.member_id,record.recovery_generation,hash)]};
  }
  const step=await totpStep(record,tx.member_id,body.code,env);
  return {record,recovery:false,guards:[totpGuard(tx.member_id,record.version,step)],statements:[advanceTotp(db,tx.member_id,step)]};
}

function loginFactor(recovery) {return authHandler(async(env,_url,request)=>{
  const db=await authContext(request,env),body=await readAuthJson(request);
  onlyFields(body,['transaction_id',recovery?'recovery_code':'code',...(recovery?['disable_mfa','confirmed']:[])]);
  const recoverPolicy=recovery && body.disable_mfa===true;
  if(recovery && ((body.disable_mfa!==undefined && body.disable_mfa!==true) || (recoverPolicy ? body.confirmed!==true : body.confirmed!==undefined)))throw invalidVerification();
  const tx=await googleProof(request,env,body);
  if(!tx.member_id || tx.data.purpose==='security' || tx.data.mfa_stage!=='login')throw invalidVerification();
  if(!tx.data.session_hash && await memberSession(request,env,false))throw invalidVerification();
  await throttle(request,env,'google-mfa-login',tx.member_id);
  const policy=await googleMfaPolicy(db,tx.member_id);
  if(!policy.enabled || policy.generation!==tx.data.google_mfa_generation)throw invalidVerification();
  const proof=await factor(db,env,tx,body,recovery);
  const generation=policy.generation+Number(recoverPolicy),statements=[...proof.statements];
  if(recoverPolicy)statements.push(db.prepare('UPDATE google_login_mfa SET enabled=0,generation=?,updated_at=? WHERE member_id=?').bind(generation,authNow(),tx.member_id),googleMfaEvent(db,tx.member_id,tx.id,'disable',generation));
  // mfa:false is deliberate: ordinary Google MFA never grants admin elevation.
  return issueSession(request,env,tx.member_id,{method:'google',googleMfa:{generation,verified:true},
    remember:tx.data.remember_me===true,tx,
    guards:[googleMfaGuard(tx.member_id,policy),identityGuard(tx),...proof.guards],
    statements:[...statements,googleMfaEvent(db,tx.member_id,tx.id,recovery?'login_recovery':'login_totp',generation)]});
});}
export const googleMfaVerify=loginFactor(false),googleMfaRecovery=loginFactor(true);

async function policyContext(request,env,body,action) {
  const db=await authContext(request,env),tx=await googleProof(request,env,body);
  if(tx.data.purpose!=='security' || tx.data.mfa_policy_action!==action || !tx.member_id || !tx.data.session_hash)throw invalidVerification();
  const member=await memberSession(request,env);await memberCsrf(request,env,member);
  await throttle(request,env,'google-mfa-policy',member.member_id);
  const policy=await googleMfaPolicy(db,member.member_id);
  if(policy.generation!==tx.data.google_mfa_generation || policy.enabled===(action==='enable'))throw invalidVerification();
  return {db,tx,member,policy,guards:[transactionGuard(tx),payloadGuard(tx),activeSessionGuard(member),identityGuard(tx),googleMfaGuard(member.member_id,policy)]};
}

export const googleMfaEnrollStart=authHandler(async(env,_url,request)=>{
  available(env);const body=await readAuthJson(request);onlyFields(body,['transaction_id']);
  const {db,tx,guards}=await policyContext(request,env,body,'enable');
  if(await credentials(db,tx.member_id) || tx.data.policy_totp_setup)throw invalidVerification();
  const setup=newTotp(tx.member_id),encrypted=await encryptTotp(setup.secret,tx.member_id,env);
  const payload=JSON.stringify({...tx.data,policy_totp_setup:encrypted});
  await authAtomic(db,[...guards,{sql:'NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=?)',args:[tx.member_id]}],
    [db.prepare('UPDATE auth_transactions SET payload=? WHERE id=?').bind(payload,tx.id)]);
  return jsonSuccess({otpauth_uri:setup.otpauth_uri});
});
export const googleMfaEnrollVerify=authHandler(async(env,_url,request)=>{
  available(env);const body=await readAuthJson(request);onlyFields(body,['transaction_id','code']);
  const {db,tx,policy,guards}=await policyContext(request,env,body,'enable');
  const setup=tx.data.policy_totp_setup;if(!setup)throw invalidVerification();
  const step=await totpStep(setup,tx.member_id,body.code,env),recovery=await recoverySet(db,tx.member_id,1);
  const {policy_totp_setup,...data}=tx.data;
  await authAtomic(db,[...guards,{sql:'NOT EXISTS(SELECT 1 FROM member_credentials WHERE member_id=?)',args:[tx.member_id]}],[
    db.prepare('INSERT INTO member_credentials(member_id,totp_ciphertext,totp_iv,totp_key_version,last_used_time_step,updated_at) VALUES(?,?,?,?,?,?)').bind(tx.member_id,setup.totp_ciphertext,setup.totp_iv,setup.totp_key_version,step,authNow()),
    ...recovery.statements,db.prepare('UPDATE auth_transactions SET payload=? WHERE id=?').bind(JSON.stringify({...data,mfa_enrolled:true}),tx.id),
    googleMfaEvent(db,tx.member_id,tx.id,'enroll',policy.generation),
  ]);
  return jsonSuccess({authenticator_configured:true,recovery_codes:recovery.codes,google_mfa_enabled:false});
});

function changePolicy(enabled){return authHandler(async(env,_url,request)=>{
  if(enabled)available(env);
  const body=await readAuthJson(request);onlyFields(body,['transaction_id','code',...(enabled?['recovery_confirmed']:['recovery_code'])]);
  if(enabled && body.recovery_confirmed!==true)throw invalidVerification();
  const {db,tx,member,policy,guards}=await policyContext(request,env,body,enabled?'enable':'disable');
  const proof=await factor(db,env,tx,body,!enabled),generation=policy.generation+1;
  if(enabled)guards.push({sql:'EXISTS(SELECT 1 FROM recovery_codes WHERE member_id=? AND generation=? AND used_at IS NULL)',args:[tx.member_id,proof.record.recovery_generation]});
  guards.push(...proof.guards);
  const statements=[...proof.statements,policy.exists
    ?db.prepare('UPDATE google_login_mfa SET enabled=?,generation=?,updated_at=? WHERE member_id=?').bind(Number(enabled),generation,authNow(),member.member_id)
    :db.prepare('INSERT INTO google_login_mfa(member_id,enabled,generation,updated_at) VALUES(?,?,?,?)').bind(member.member_id,Number(enabled),generation,authNow()),
    googleMfaEvent(db,member.member_id,tx.id,enabled?'enable':'disable',generation)];
  if(member.auth_method==='google')return issueSession(request,env,member.member_id,{method:'google',googleMfa:{generation,verified:true},
    remember:member.expires_at-authNow()>AUTH_LIMITS.sessionSeconds,expiresAt:member.expires_at,tx,guards,statements});
  // Password sessions retain their original method, expiry and elevation.
  await authAtomic(db,guards,[...statements,consumeTransaction(db,tx)]);
  return withCookies(jsonSuccess({google_mfa:{enabled,generation}}),[cookie(LOGIN_COOKIE,'',0)]);
});}
export const googleMfaEnable=changePolicy(true),googleMfaDisable=changePolicy(false);
