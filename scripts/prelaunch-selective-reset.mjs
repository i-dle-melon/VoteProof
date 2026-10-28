// Offline CLI. No remote mutation option; dry-run is the only default action.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync}from'node:sqlite';
import {dryRunFile,executeSelectiveResetLocal}from'./lib/prelaunch-selective-reset.mjs';
const args=process.argv.slice(2),take=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
if(args.some(x=>/--remote|--production|--cloud/.test(x)))throw Error('REMOTE_EXECUTION_NOT_IMPLEMENTED_OR_AUTHORIZED');
const database=take('--database'),out=take('--out');
if(!database||database.includes('://')||database.startsWith('\\\\'))throw Error('LOCAL_DATABASE_PATH_REQUIRED');
const execute=args.includes('--execute-local-synthetic');
if(!execute&&!out)throw Error('USAGE: --database <local.sqlite> --out <new-private-manifest.json> [--evidence <local-evidence.json>]');
if(execute&&(!database.includes('vp-reset-0028-')&&!database.includes('vp-selective-reset-')))throw Error('EXECUTION_ONLY_DISPOSABLE_SYNTHETIC_PATH');
const db=new DatabaseSync(path.resolve(database),{readOnly:!execute});
try{
 if(!execute){const evidence=take('--evidence')?JSON.parse(fs.readFileSync(take('--evidence'),'utf8')):{};console.log(JSON.stringify(dryRunFile(db,path.resolve(out),evidence,{approvedCutoverHash:take('--approved-cutover-sha256')})));}
 else{const manifestFile=take('--manifest'),hash=take('--approved-manifest-sha256');if(!manifestFile||!hash)throw Error('EXPLICIT_MANIFEST_AND_APPROVED_SHA_REQUIRED');const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));console.log(JSON.stringify(executeSelectiveResetLocal(db,manifest,{authority:'LOCAL_SYNTHETIC_ONLY',expectedManifestHash:hash})));}
}finally{db.close();}
