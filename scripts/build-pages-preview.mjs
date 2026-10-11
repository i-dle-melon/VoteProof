// Disposable artifact, always generated from the same public/ source.
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function buildPagesPreview(output) {
  const allowed = resolve(".wrangler/pages-preview");
  if (resolve(output) !== allowed) throw new Error("Preview output must be the isolated generated artifact");
  await mkdir(allowed, { recursive: true });
  await cp(resolve("public"), allowed, { recursive: true });
  let html = await readFile(resolve(allowed, "index.html"), "utf8");
  html = html.replace("<head>", '<head>\n<meta name="voteproof-preview" content="isolated">\n<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\'; img-src \'self\' blob:; connect-src \'none\'; object-src \'none\'; base-uri \'none\'; form-action \'none\'">');
  html = html.replaceAll('href="/css/', 'href="./css/').replaceAll('src="/js/', 'src="./js/');
  // Banner is present before JavaScript runs; a failed module cannot disguise it.
  html = html.replace(/id="ui-preview-banner"\s+hidden/, 'id="ui-preview-banner"');
  await writeFile(resolve(allowed, "index.html"), html);
  await writeFile(resolve(allowed, ".nojekyll"), "");
  return allowed;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await buildPagesPreview(resolve(".wrangler/pages-preview"));
  process.stdout.write("Pages preview artifact ready; Production source unchanged\n");
}
