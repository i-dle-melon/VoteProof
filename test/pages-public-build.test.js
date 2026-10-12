import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { buildPagesPreview, removeElement, removeMatchingElements } from '../scripts/build-pages-preview.mjs';
test('Pages exclusions remove nested elements and fail closed on missing boundary', () => {
  assert.equal(removeElement('<main><section id="private"><section>private</section></section><p>public</p></main>', 'private'), '<main><p>public</p></main>');
  assert.throws(() => removeElement('<main></main>', 'private'));
});
test('formatted closing tags cannot consume adjacent navigation or layout containers', () => {
  const html = '<aside><nav><a href="#home">home</a\n ><a href="#security"><span>private</span></a\n >\n</nav><div class="sidebar-footer"><a href="#about">about</a></div></aside><div class="main">public</div>';
  assert.equal(removeMatchingElements(html, /^<a\b[^>]*href="#security"/), html.replace('<a href="#security"><span>private</span></a\n >', ''));
});
test('Pages artifact contains public source only, no operational runtime or identity fixture', async () => {
  const before = await readFile('public/index.html', 'utf8');
  const out = await buildPagesPreview(resolve('.wrangler/pages-preview'));
  const html = await readFile(resolve(out,'index.html'), 'utf8');
  assert.doesNotMatch(html, /id="(?:view-(?:admin|security|member|register|recover|google)|admin-ui-copy|login-totp-form)"|data-preview-scene="(?:admin|member)"/);
  assert.doesNotMatch(html, /preview-tier-artwork|approved-tier-artwork|assets\/tiers\//);
  await assert.rejects(readFile(resolve(out, 'js/tier-artwork.js')));
  await assert.rejects(readFile(resolve(out, 'assets/tiers/normal.webp')));
  assert.match(html, /UI PREVIEW · 非正式網站/);
  assert.match(html, /connect-src 'none'/);
  const js = await readdir(resolve(out,'js'));
  for (const name of ['admin.js','admin-api.js','member.js','member-api.js','member-tier-progress.js','qr.js']) assert.ok(!js.includes(name));
  assert.doesNotMatch(await readFile(resolve(out,'js/preview-fixtures.js'),'utf8'), /\/api\/admin\/|csrf_token|elevated_until|super_admin|UI-PREVIEW-MEMBER/);
  assert.equal(await readFile('public/index.html','utf8'), before);
});
