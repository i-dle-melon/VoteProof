const leading='(?:\\s|--[^\\n]*(?:\\n|$)|/\\*[\\s\\S]*?\\*/)*';
const simple=new RegExp('^'+leading+'(SELECT|EXPLAIN)\\b','i');
const withStart=new RegExp('^'+leading+'WITH\\b','i');
const forbidden=new Set(['INSERT','UPDATE','DELETE','REPLACE','CREATE','ALTER','DROP','PRAGMA','ATTACH','DETACH','VACUUM','REINDEX','ANALYZE','BEGIN','COMMIT','ROLLBACK','SAVEPOINT','RELEASE','LOAD_EXTENSION','WRITEFILE']);

// This recognizes server-owned SELECT CTEs; it is not an arbitrary SQL API.
// Quote/comment contents never become executable tokens. Fail closed on any
// unsupported shape, unbalanced delimiters or data-changing keyword.
function tokens(sql){
 const out=[];let i=0;
 while(i<sql.length){
  const c=sql[i];if(/\s/.test(c)){i++;continue;}
  if(sql.startsWith('--',i)){const end=sql.indexOf('\n',i+2);i=end<0?sql.length:end+1;continue;}
  if(sql.startsWith('/*',i)){const end=sql.indexOf('*/',i+2);if(end<0)return null;i=end+2;continue;}
  if(["'",'"','`','['].includes(c)){
   const close=c==='['?']':c;let ended=false;i++;
   while(i<sql.length){if(sql[i]===close){if(c!=='['&&sql[i+1]===close){i+=2;continue;}i++;ended=true;break;}i++;}
   if(!ended)return null;out.push(c==="'"?'#literal':'#identifier');continue;
  }
  if(/[A-Za-z_]/.test(c)){
   const start=i++;while(i<sql.length&&/[A-Za-z0-9_$]/.test(sql[i]))i++;
   const word=sql.slice(start,i).toUpperCase();if(forbidden.has(word))return null;out.push(word);continue;
  }
  out.push(c);i++;
 }
 return out;
}
function selectCTE(t,start,end){
 if(t[start]==='SELECT')return true;
 if(t[start++]!=='WITH')return false;if(t[start]==='RECURSIVE')start++;
 const identifier=x=>x==='#identifier'||/^[A-Z_][A-Z0-9_$]*$/.test(x??'');
 function close(at){let depth=1;for(let n=at+1;n<end;n++){if(t[n]==='(')depth++;if(t[n]===')'&&!--depth)return n;}return -1;}
 while(start<end){
  if(!identifier(t[start++]))return false;
  if(t[start]==='('){const to=close(start);if(to<0)return false;for(let n=start+1;n<to;n++)if((n-start)%2? !identifier(t[n]):t[n]!==',')return false;start=to+1;}
  if(t[start++]!=='AS')return false;
  if(t[start]==='NOT'){start++;if(t[start++]!=='MATERIALIZED')return false;}
  else if(t[start]==='MATERIALIZED')start++;
  if(t[start]!=='(')return false;const to=close(start);if(to<0||!selectCTE(t,start+1,to))return false;start=to+1;
  if(t[start]===','){start++;continue;}
  return t[start]==='SELECT';
 }
 return false;
}
export function isReadOnlySQL(sql){
 if(simple.test(sql))return true;
 if(sql.length>65536||!withStart.test(sql))return false;
 const t=tokens(sql);if(!t?.length)return false;
 if(t.at(-1)===';')t.pop();if(t.includes(';'))return false;
 let depth=0;for(const x of t){if(x==='(')depth++;if(x===')'&&--depth<0)return false;}if(depth!==0)return false;
 return selectCTE(t,0,t.length);
}
