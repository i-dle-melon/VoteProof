import { pathToFileURL } from 'node:url';
import { appendFile } from 'node:fs/promises';
const shaPattern = /^[a-f0-9]{40}$/;
const releaseRef = "codex/leaderboard-v1-release-20261022";
export function trustedRun(run, repository = process.env.GITHUB_REPOSITORY) {
  return shaPattern.test(run.head_sha??'') && run.head_repository?.full_name === repository &&
    ['push','workflow_dispatch'].includes(run.event) && (run.head_branch === 'main' || run.head_branch?.startsWith('codex/'));
}
export function githubClient({ token=process.env.GITHUB_TOKEN, repository=process.env.GITHUB_REPOSITORY, fetcher=fetch }={}) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository??'')) throw Error('GitHub validation configuration missing');
  return async (path, body) => {
    const r = await fetcher(`https://api.github.com/repos/${repository}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)});
    if (!r.ok) throw Error(`GitHub validation API failed (${r.status})`);
    return r.status === 204 ? {} : r.json();
  };
}
export async function ensureValidation({api,sha,repository,ref='main',sleep=ms=>new Promise(r=>setTimeout(r,ms)),now=Date.now,timeout=45*60000}) {
  if (!shaPattern.test(sha??'') || !['main',releaseRef].includes(ref)) throw Error('Exact approved SHA and allowed release ref required');
  const started = now();
  const candidates = async () => (await api(`/actions/workflows/branch-validation.yml/runs?head_sha=${sha}&per_page=100`)).workflow_runs.filter(r=>trustedRun(r,repository)&&r.head_sha===sha&&(ref==='main'||r.head_branch===ref)).sort((a,b)=>b.id-a.id);
  let runs = await candidates(), run = runs[0];
  if (run?.status==='completed' && run.conclusion!=='success') throw Error('Validation failed or cancelled for this SHA; inspect and repair before deployment');
  if (!run) {
    // Allow an already-triggered push validation to appear before dispatching.
    await sleep(15000); runs=await candidates();
    run=runs[0];
    if (run?.status==='completed' && run.conclusion!=='success') throw Error('Validation failed for this SHA');
    if (!run) {
      const current=await api('/git/ref/heads/'+ref); if(current.object.sha!==sha)throw Error(ref+' changed before validation dispatch');
      await api('/actions/workflows/branch-validation.yml/dispatches',{ref,inputs:{approved_sha:sha}});
    }
  }
  while (now()-started < timeout) {
    if (!run) { await sleep(30000); runs=await candidates(); run=runs[0]; continue; }
    if (!Number.isSafeInteger(run.id)) throw Error('Invalid validation run ID');
    run=await api(`/actions/runs/${run.id}`);
    if (!trustedRun(run,repository)||run.head_sha!==sha||(ref!=="main"&&run.head_branch!==ref)) throw Error('Validation provenance mismatch');
    if (run.status==='completed') {
      if (run.conclusion!=='success') throw Error('Validation did not pass; deployment blocked');
      return {run_id:run.id,sha,url:run.html_url};
    }
    await sleep(30000); // CI waits without repeatedly invoking the coding model.
  }
  throw Error('Validation wait timed out; deployment blocked');
}
async function main() {
  const result=await ensureValidation({api:githubClient(),sha:process.env.APPROVED_SHA,repository:process.env.GITHUB_REPOSITORY,ref:process.env.VALIDATION_REF??'main'});
  console.log(`Exact SHA validated by run ${result.run_id}`);
  if(process.env.GITHUB_STEP_SUMMARY)await appendFile(process.env.GITHUB_STEP_SUMMARY,`Reused validation: ${result.url}\nCommit: ${result.sha}\n`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)await main();
