import {createHash} from 'node:crypto';
import {KEEP_TABLES,tablePolicy,retainedRows} from './prelaunch-reset-policy.mjs';
export const stable=x=>JSON.stringify(x,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)&&!(v instanceof Uint8Array)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);
export const digest=x=>createHash('sha256').update(typeof x==='string'||x instanceof Uint8Array?x:stable(x)).digest('hex');
export const ident=s=>{if(!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s))throw Error('INVALID_IDENTIFIER');return '"'+s+'"';};
export function capture(db){
 const schema=db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(x=>({...x}));
 const tables={};
 for(const {name}of schema.filter(x=>x.type==='table')){
  tablePolicy(name);
  tables[name]=db.prepare('SELECT * FROM '+ident(name)).all().map(x=>({...x})).sort((a,b)=>stable(a).localeCompare(stable(b)));
 }
 const sequence=db.prepare("SELECT name FROM sqlite_master WHERE name='sqlite_sequence'").get()?db.prepare('SELECT name,seq FROM sqlite_sequence ORDER BY name').all().map(x=>({...x})):[];
 const value={schema,tables,sequence};return{...value,hash:digest(value)};
}
export function retainedDigests(snapshot){return Object.fromEntries(Object.entries(snapshot.tables).filter(([n])=>KEEP_TABLES.has(n)||n==='admin_audit_logs').map(([n,rows])=>[n,{count:retainedRows(n,rows).length,hash:digest(retainedRows(n,rows))}]));}
export function dependencyMatrix(db,snapshot){return Object.keys(snapshot.tables).sort().map(table=>({table,policy:tablePolicy(table),rows:snapshot.tables[table].length,
  foreign_keys:db.prepare('PRAGMA foreign_key_list('+ident(table)+')').all().map(x=>({table:x.table,from:x.from,to:x.to})),
  triggers:snapshot.schema.filter(x=>x.type==='trigger'&&x.tbl_name===table).map(x=>x.name)}));}
export function assertReady(s,window){
 const one=n=>s.tables[n]?.[0],any=(n,f)=>s.tables[n]?.some(f);
 if(!window||window.environment!=='local-synthetic'||window.identityFrozen!==true||window.allImageWritersStopped!==true||window.backupTriggersStopped!==true||window.oldDeleteTerminal!==true||window.dispatch9Untouched!==true)throw Error('RESET_WINDOW_HOLD');
 if(one('submission_settings')?.submissions_enabled!==0||one('image_maintenance_control')?.mode!=='closed'||one('image_maintenance_control')?.legacy_status!=='operator_attested'||one('storage_archive_control')?.mode!=='paused')throw Error('MAINTENANCE_NOT_READY');
 const c=one('storage_capacity');if(!c||c.inventory_id!==null||c.inventory_phase!==null||c.reserved_bytes!==0||c.anomaly!==null)throw Error('CAPACITY_PENDING');
 if(any('storage_reservations',r=>r.state==='reserved')||any('proof_upload_intents',r=>r.write_token!==null)||any('cold_proofs',r=>r.state==='deleting'||r.lease_token!==null)||any('storage_archive_dispatches',r=>r.state!=='completed')||any('image_mutation_operations',r=>['active','unknown'].includes(r.state)))throw Error('MUTATION_PENDING');
 if(any('proof_backups',r=>r.status==='processing'||r.lease_token!==null||r.lease_until!==null)||s.tables.backup_processor_lock?.length)throw Error('BACKUP_PENDING');
 if(any('export_packages',r=>r.status==='in_progress')||s.tables.export_file_claims?.length)throw Error('EXPORT_PENDING');
}
