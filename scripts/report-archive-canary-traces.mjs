// Offline stdin consumer: pipe raw native tail output directly; do not save headers.
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {jsonFrames} from './lib/inventory-tail.mjs';
import {nativeTrace,cpuReport} from './lib/archive-canary-harness.mjs';
const [ledgerPath,out]=process.argv.slice(2);if(!ledgerPath||!out)throw Error('Usage: node scripts/report-archive-canary-traces.mjs requests.json <new-output-directory>');
const events=[];const diagnostics={frames:0,parse_errors:0,non_invocations:0};
const parse=jsonFrames(v=>{diagnostics.frames++;const event=nativeTrace(v);if(event)events.push(event);else diagnostics.non_invocations++;},()=>diagnostics.parse_errors++);
for await(const chunk of process.stdin)parse(chunk.toString());
const ledger=JSON.parse(await readFile(ledgerPath,'utf8'));
if(ledger.some(r=>r.profile!=='native'))throw Error('NATIVE_PROFILE_ONLY');
const report=cpuReport(ledger,events);if(diagnostics.parse_errors&&report.readiness==='PASS')report.readiness='UNKNOWN';
const dest=resolve(out);await mkdir(dest);
await writeFile(resolve(dest,'native-traces.sanitized.json'),JSON.stringify(events,null,2));
await writeFile(resolve(dest,'cpu-report.json'),JSON.stringify({...report,diagnostics},null,2));
const cols=['mib','phase','expected','valid','missing','conflicts','p50','p95','p99','max','above_10ms','successes','failures','exceededCpu','http1102','readiness'];
await writeFile(resolve(dest,'cpu-report.csv'),cols.join(',')+'\n'+report.groups.map(g=>cols.map(k=>g[k]??'UNKNOWN').join(',')).join('\n')+'\n');
console.log(JSON.stringify({readiness:report.readiness,groups:report.groups.length,...diagnostics}));
