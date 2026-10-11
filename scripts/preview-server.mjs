import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
import { buildPagesPreview } from "./build-pages-preview.mjs";
const root = await buildPagesPreview(resolve(".wrangler/pages-preview"));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webp": "image/webp" };
const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    // Exercise the Pages project subdirectory as well as the root URL.
    const path = pathname.replace(/^\/VoteProof(?=\/)/, "");
    if (request.method !== "GET" || path.startsWith("/api/")) { response.writeHead(403).end(); return; }
    const file = resolve(root, "." + (path.endsWith("/") ? path + "index.html" : path));
    if (relative(root, file).startsWith("..") || !types[extname(file)]) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": types[extname(file)], "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    response.end(await readFile(file));
  } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
});
server.listen(4174, "127.0.0.1", () => process.stdout.write("UI PREVIEW · 非正式網站: http://127.0.0.1:4174/VoteProof/\n"));
process.on("SIGTERM", () => { server.close(); server.closeAllConnections(); });
