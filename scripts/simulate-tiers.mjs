import { readFile,writeFile,mkdir } from 'node:fs/promises';
import path from 'node:path';
import {simulateTiers,proposal} from './lib/tier-simulator.mjs';
try {
  const args=process.argv.slice(2),option=name=>args.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
  if(args.some(a=>!/^--(input|proposal|score|output)=/.test(a)))throw new Error('INVALID_ARGUMENT');
  const source=option('input')?JSON.parse(await readFile(option('input'),'utf8')):proposal(option('proposal')??'balanced',Number(option('score')??10));
  const result=simulateTiers(source),text=JSON.stringify(result,null,2)+'\n';
  if(option('output')){const target=path.resolve(option('output'));await mkdir(path.dirname(target),{recursive:true});await writeFile(target,text);}else process.stdout.write(text);
}catch{console.error('TIER_SIMULATION_FAILED');process.exitCode=1;}
