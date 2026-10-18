import { execFileSync } from 'node:child_process';
import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { githubClient, trustedRun } from './validation.mjs';

const auth = /^(auth|b4s|members|member-blocks|admin-session|admin-staff|admin\.test|rc-staff|product-rules|provider-adapters)/;
const groups = [
  [/^src\/(?:api\/auth-|lib\/(?:supabase-auth|password-operation))/, auth, ['member','google','login-ui','admin','product-rules']],
  [/^src\/.*(?:member-contact|admin-mail)/, /^(admin-member-contact|admin-mail|admin-session|rc-staff)/, ['admin-member-contact']],
  [/^src\/.*(?:leaderboard|campaign|point|tier|solo-target|current-comeback)/, /^(leaderboards|campaign|current-comeback|member-tiers|member-blocks|product-rules|tier-simulator|rc-staff)/, ['product-rules','campaign-category','tier-artwork']],
  [/^src\/.*(?:site-content|announcement)/, /^(site-content|ui-admin-overview|rc-staff)/, ['content']],
];
const ui = ['ci-smoke','brand','ui-iteration','redesign','login-ui'];
export function classify(files, inventory, forceFull = false) {
  const node = new Set(['test/ci-workflows.test.js','test/frontend-maintenance.test.js']);
  const browser = new Set();
  let full = forceFull, migrations = forceFull;
  const addBrowser = names => names.forEach(n => browser.add(`frontend-tests/${n}.spec.js`));
  const addNode = pattern => inventory.node.filter(p => pattern.test(p.slice(5))).forEach(p => node.add(p));
  for (const file of files) {
    if (/^(package(?:-lock)?\.json|wrangler\.jsonc)$/.test(file)) { full = migrations = true; continue; }
    if (/^(migrations\/|scripts\/check-.*schema|test\/.*migration|test\/fixtures\/production-schema)/.test(file)) { full = migrations = true; continue; }
    if (/^(\.github\/|scripts\/ci\/|playwright\.config|test\/ci-workflows)/.test(file)) { full = true; continue; }
    if (/^(docs\/|README|LICENSE|AGENTS\.md$|\.gitignore)/.test(file)) continue;
    if (inventory.node.includes(file)) { node.add(file); continue; }
    if (inventory.browser.includes(file)) { addBrowser(['ci-smoke']); browser.add(file); continue; }
    if (/^(test\/helpers\/|frontend-tests\/.*fixture)/.test(file)) { full = true; continue; }
    if (file.startsWith('src/')) {
      addBrowser(['ci-smoke']);
      const match = groups.find(([pattern]) => pattern.test(file));
      if (match) { addNode(match[1]); addBrowser(match[2]); } else full = true;
      continue;
    }
    if (file.startsWith('public/') || /^scripts\/(?:lib\/pages-|build-pages-preview)/.test(file)) {
      addBrowser(['ci-smoke']);
      addNode(/^frontend.*\.test\.js$/); node.add('test/pages-public-build.test.js');
      if (/^public\/(?:css\/|assets\/|index\.html$)/.test(file)) addBrowser([...ui,'member','admin']);
      else if (/admin-member-contact/.test(file)) addBrowser(['admin-member-contact']);
      else if (/member|qr\.js|ui-system/.test(file)) addBrowser(['member','google','login-ui','admin','product-rules']);
      else if (/admin/.test(file)) addBrowser(['admin','admin-member-contact','admin-review-workflow','admin-export','admin-export-transport','backup','duplicate-evidence','member-controls']);
      else if (/pages-|preview|tier-artwork|leaderboard|vote-date|announcements|campaign-guidance/.test(file)) addBrowser([...ui,'preview','content','product-rules','campaign-category','tier-artwork']);
      else full = true; // Shared transport/submission/app code has broad impact.
      continue;
    }
    full = true; // Deleted, renamed or unmapped files never silently skip coverage.
  }
  if (full) { inventory.node.forEach(p => node.add(p)); inventory.browser.forEach(p => browser.add(p)); }
  for (const p of [...node]) if (!inventory.node.includes(p)) throw Error(`Missing planned test: ${p}`);
  for (const p of [...browser]) if (!inventory.browser.includes(p)) throw Error(`Missing planned browser test: ${p}`);
  return { full, migrations, node: [...node].sort(), browser: [...browser].sort() };
}
export async function baseline(runs, head, isAncestor) {
  for (const run of runs) if (trustedRun(run) && run.conclusion === 'success' && run.head_sha !== head && await isAncestor(run.head_sha)) return run.head_sha;
  return null;
}
const git = args => execFileSync('git', args, { encoding:'utf8', windowsHide:true }).trim();
async function main() {
  const head = git(['rev-parse','HEAD']), approved = process.env.APPROVED_SHA;
  if (approved && approved !== head) throw Error('Approved SHA does not match checkout');
  const inventory = {
    node: (await readdir('test')).filter(f => f.endsWith('.test.js')).map(f => 'test/'+f),
    browser: (await readdir('frontend-tests')).filter(f => f.endsWith('.spec.js')).map(f => 'frontend-tests/'+f),
  };
  let base = null;
  if (process.env.GITHUB_TOKEN) {
    const api = githubClient();
    // Only successful ancestor runs count. A failed previous push cannot hide
    // its unvalidated source changes behind a later test-only fix.
    const runs = await api('/actions/workflows/branch-validation.yml/runs?status=success&per_page=100');
    base = await baseline(runs.workflow_runs, head, sha => {
      try { execFileSync('git',['merge-base','--is-ancestor',sha,head],{stdio:'ignore',windowsHide:true}); return true; } catch { return false; }
    });
  }
  const files = (base ? git(['diff','--name-only','--no-renames',base,head]) : git(['ls-tree','-r','--name-only',head])).split(/\r?\n/).filter(Boolean);
  const plan = { head, base, ...classify(files, inventory, process.env.FULL_REGRESSION === 'true' || !base) };
  await mkdir('.wrangler',{recursive:true}); await writeFile('.wrangler/ci-plan.json',JSON.stringify(plan,null,2));
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,`migrations=${plan.migrations}\nbrowser=${plan.browser.length>0}\n`);
  const summary = `CI plan: ${plan.full?'full':'affected'}; ${plan.node.length} Node files; ${plan.browser.length} browser files; migrations=${plan.migrations}; base=${base??'none (full fallback)'}`;
  console.log(summary);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,summary+'\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
