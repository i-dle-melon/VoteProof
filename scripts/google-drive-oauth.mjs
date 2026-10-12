// Local operator tool. Importing this module performs no I/O or authorization.
import { createServer } from 'node:http';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DRIVE_SCOPE, DriveClient, FOLDER_MIME } from '../src/lib/google-drive.js';
export const oauthUrl = (clientId, redirect, state, verifier) => {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: 'code', scope: DRIVE_SCOPE,
    access_type: 'offline', prompt: 'consent', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
  return url.href;
};
const secureEqual = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function authorizeLocal({ clientId, clientSecret, port = 53682, fetcher = fetch, onUrl, save, timeoutMs = 300000 }) {
  const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
  const redirect = `http://127.0.0.1:${port}/oauth/callback`;
  let busy = false, finished = false, timer;
  const cancel = new AbortController();
  return new Promise((resolveResult, reject) => {
    const finish = (error, result) => { if (finished) return; finished = true; clearTimeout(timer); cancel.abort(); server.close(); if (error) reject(new Error('OAUTH_SETUP_FAILED')); else resolveResult(result); };
    const server = createServer(async (request, response) => {
      response.setHeader('Cache-Control', 'no-store'); response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'"); response.setHeader('Referrer-Policy', 'no-referrer');
      let url; try { url = new URL(request.url, redirect); } catch { response.writeHead(400); response.end('Authorization rejected.'); return; }
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || url.pathname !== '/oauth/callback' ||
          url.searchParams.getAll('state').length !== 1 || !secureEqual(url.searchParams.get('state'), state) || busy) {
        response.writeHead(400); response.end('Authorization rejected.'); return;
      }
      busy = true;
      try {
        const code = url.searchParams.get('code'); if (!code || url.searchParams.getAll('code').length !== 1 || url.searchParams.has('error')) throw new Error();
        const r = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(20000)]),
          body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, client_secret: clientSecret, redirect_uri: redirect, code, code_verifier: verifier }) });
        const tokens = await r.json();
        if (finished || !r.ok || typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || !tokens.scope?.split(' ').includes(DRIVE_SCOPE)) throw new Error();
        // Drop access token immediately; only private save callback receives refresh.
        await save({ GOOGLE_DRIVE_CLIENT_ID: clientId, GOOGLE_DRIVE_CLIENT_SECRET: clientSecret, GOOGLE_DRIVE_REFRESH_TOKEN: tokens.refresh_token });
        response.end('VoteProof 備份授權完成。可關閉此分頁。'); finish(null, { authorized: true });
      } catch { response.writeHead(400); response.end('Authorization failed. Check local setup.'); finish(new Error()); }
    });
    server.on('error', () => finish(new Error()));
    server.listen(port, '127.0.0.1', () => { try { Promise.resolve(onUrl(oauthUrl(clientId, redirect, state, verifier))).catch(() => finish(new Error())); } catch { finish(new Error()); } });
    timer = setTimeout(() => finish(new Error()), timeoutMs); timer.unref();
  });
}
export async function createBackupRoot(env, { fetcher = fetch, id, saveId } = {}) {
  const drive = new DriveClient(env, fetcher);
  if (!id) { id = await drive.generateId(); await saveId(id); }
  let meta = await drive.metadata(id);
  if (!meta) {
    const r = await drive.request('/drive/v3/files?fields=id,mimeType,trashed,appProperties', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: 'VoteProof Backup', mimeType: FOLDER_MIME, appProperties: { source: 'voteproof', backup_root: 'v1' } }) });
    await r.body?.cancel(); meta = await drive.metadata(id);
  }
  if (meta?.id !== id || meta.trashed || meta.mimeType !== FOLDER_MIME || meta.appProperties?.backup_root !== 'v1' || meta.appProperties?.source !== 'voteproof') throw new Error('ROOT_SETUP_FAILED');
  return id;
}
async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', identity + ':(OI)(CI)F'], { stdio: 'ignore', windowsHide: true });
  }
}
async function main() {
  const dir = resolve('.wrangler/google-drive-oauth');
  if (execFileSync('git', ['check-ignore', '.wrangler/google-drive-oauth/client.json'], { encoding: 'utf8', windowsHide: true }).trim() !== '.wrangler/google-drive-oauth/client.json') throw new Error('PRIVATE_PATH_REQUIRED');
  await privateDirectory(dir);
  const write = (name, body) => writeFile(resolve(dir, name), JSON.stringify(body), { mode: 0o600, flag: 'wx' });
  if (process.argv[2] === 'authorize') {
    const client = JSON.parse(await readFile(resolve(dir, 'client.json'), 'utf8'));
    await authorizeLocal({ clientId: client.client_id, clientSecret: client.client_secret,
      onUrl: url => process.stdout.write('請在專用 Google 帳號的瀏覽器開啟：\n' + url + '\n'), save: body => write('credentials.json', body) });
    console.log('授權完成；秘密僅存於 gitignored 私有 credentials.json，未輸出 token。');
  } else if (process.argv[2] === 'create-root') {
    const env = JSON.parse(await readFile(resolve(dir, 'credentials.json'), 'utf8'));
    let id; try { id = JSON.parse(await readFile(resolve(dir, 'root-id.json'), 'utf8')).id; } catch (e) { if (e.code !== 'ENOENT') throw e; }
    id = await createBackupRoot(env, { id, saveId: id => write('root-id.json', { id }) });
    console.log('GOOGLE_DRIVE_ROOT_FOLDER_ID=' + id);
  } else if (process.argv[2] === 'install-secrets') {
    if (!process.argv.includes('--operator-approved')) throw new Error('EXPLICIT_SECRET_INSTALL_REQUIRED');
    const env = JSON.parse(await readFile(resolve(dir, 'credentials.json'), 'utf8'));
    for (const name of ['GOOGLE_DRIVE_CLIENT_SECRET','GOOGLE_DRIVE_REFRESH_TOKEN']) {
      // stdin only, no command-line secret or stdout token. This is manual only.
      execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'secret', 'put', name],
        { input: env[name], stdio: ['pipe','ignore','ignore'], windowsHide: true });
    }
    console.log('Secret installation completed.');
  } else throw new Error('Use authorize | create-root | install-secrets --operator-approved');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(() => { console.error('Google Drive setup failed; no credentials were printed.'); process.exitCode = 1; });
