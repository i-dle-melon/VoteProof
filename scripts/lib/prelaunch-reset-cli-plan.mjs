// Offline assessment only. No credential resolver, remote transport or retry.
import {digest} from './prelaunch-reset-snapshot.mjs';
export function renderBoundStatement({sql,params}) {
  if(typeof sql!=='string'||!Array.isArray(params))throw Error('INVALID_BOUND_STATEMENT');
  const used=new Set();let i=0,last=0,out='';
  const literal=v=>{
    if(v===null)return'NULL';
    if(typeof v==='number'&&Number.isSafeInteger(v))return String(v);
    if(typeof v!=='string')throw Error('UNSUPPORTED_CLI_PARAMETER');
    return v.includes('\0')?"CAST(X'"+Buffer.from(v).toString('hex')+"' AS TEXT)":"'"+v.replaceAll("'","''")+"'";
  };
  while(i<sql.length){
    const c=sql[i],n=sql[i+1];
    if(c==='-'&&n==='-'){const end=sql.indexOf('\n',i);out+=sql.slice(i,end<0?sql.length:end);i=end<0?sql.length:end;continue;}
    if(c==='/'&&n==='*'){const end=sql.indexOf('*/',i+2);if(end<0)throw Error('UNTERMINATED_SQL_COMMENT');out+=sql.slice(i,end+2);i=end+2;continue;}
    if(c==="'"||c==='"'||c==='`'||c==='['){const endChar=c==='['?']':c;let j=i+1,closed=false;for(;j<sql.length;j++){if(sql[j]===endChar){if(endChar!==']'&&sql[j+1]===endChar){j++;continue;}j++;closed=true;break;}}if(!closed)throw Error('UNTERMINATED_SQL_QUOTE');out+=sql.slice(i,j);i=j;continue;}
    if(c==='?'){const match=/^\?(\d*)/.exec(sql.slice(i)),position=match[1]?Number(match[1]):last+1;if(!Number.isSafeInteger(position)||position<1||position>params.length)throw Error('CLI_PARAMETER_INDEX_MISMATCH');last=Math.max(last,position);used.add(position);out+=literal(params[position-1]);i+=match[0].length;continue;}
    // This compiler only emits anonymous or numbered parameters. Do not invent
    // substitution semantics for named parameters outside quoted SQL.
    if((c===':'||c==='@'||c==='$')&&/[A-Za-z_]/.test(n??''))throw Error('NAMED_PARAMETER_UNSUPPORTED');
    out+=c;i++;
  }
  if(used.size!==params.length)throw Error('UNUSED_CLI_PARAMETERS');return out;
}
export function assessResetCLI(prepared,{approvedPreparedHash,approvedManifestHash}={}) {
  const {sha256,...body}=prepared;
  if(sha256!==approvedPreparedHash||digest(body)!==sha256)throw Error('EXACT_PREPARED_HASH_REQUIRED');
  if(prepared.manifest_sha256!==approvedManifestHash)throw Error('EXACT_MANIFEST_HASH_REQUIRED');
  if(prepared.statement_count!==48||prepared.statements?.length!==48||prepared.transaction_count!==1||prepared.split_batches!==false)throw Error('EXACT_48_ATOMIC_STATEMENTS_REQUIRED');
  const rendered=prepared.statements.map(renderBoundStatement);
  const statements=prepared.statements.map((s,i)=>({index:i+1,bound_sql_bytes:Buffer.byteLength(s.sql),rendered_sql_bytes:Buffer.byteLength(rendered[i]),parameters:s.params.length}));
  const over=statements.filter(s=>s.rendered_sql_bytes>100000);
  if(statements.some(s=>s.bound_sql_bytes>100000||s.parameters>100))throw Error('ORIGINAL_BOUND_STATEMENT_EXCEEDS_D1_LIMIT');
  const rest={batch:prepared.statements.map(s=>({sql:s.sql,params:s.params}))};
  const report={status:'HOLD',mode:'DRY_RUN_ONLY',prepared_sha256:sha256,manifest_sha256:approvedManifestHash,statement_count:48,split_batches:false,statements,
    wrangler_file:{eligible:over.length===0?'UNVERIFIED':'NO_FOR_THIS_RENDERED_PAYLOAD',oversized_statement_indices:over.map(s=>s.index),max_rendered_sql_bytes:Math.max(...statements.map(s=>s.rendered_sql_bytes)),d1_statement_limit_bytes:100000,atomic_ddl_trigger_fk_rollback:'NOT_PROVEN_ON_IMPORT_PATH',sql_exported:false},
    rest:{single_request_shape:'{batch:[48 bound statements]}',body_bytes:Buffer.byteLength(JSON.stringify(rest)),body_sha256:digest(JSON.stringify(rest)),atomic_ddl_trigger_fk_rollback:'NOT_PROVEN_ON_REST_PATH',worker_http_invocations:0},
    journal:'Existing executor persists/fsyncs before dispatch and forbids all replay of UNKNOWN. No CLI dispatch adapter enabled until isolated transport proof and explicit authority.',
    recovery:'Existing exact Manifest, source/epoch CAS and fresh private restore proof remain mandatory; dry-run does not establish a fresh Production restore point.',
    receipt:'Require unique immutable reset_commit Audit matching Manifest/run/epoch plus full protected/postcondition/schema check; HTTP200/CLI exit0/import bookmark alone is insufficient.',
    next:'Isolated REST-specific rollback/DDL/FK/ACK proof required; preserve existing Worker option. No Production execution is installed.'};
  return {report,rest,rendered};
}
