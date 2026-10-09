// Developer-only local static fixture server; never deployed/inside public.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, relative, extname } from "node:path";
const root = fileURLToPath(new URL("../../public/", import.meta.url));
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8" };
const policy = Object.fromEntries((await readFile(resolve(root, "_headers"), "utf8")).split(/\r?\n/)
  .filter((line) => /^  [^ ]/.test(line)).map((line) => { const at = line.indexOf(":"); return [line.slice(2, at), line.slice(at + 1).trim()]; }));
export async function frontendServer({ backend, port = 0 } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) {
        if (!backend) { response.writeHead(404).end(); return; }
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const method = request.method, body = Buffer.concat(chunks);
        const result = await backend.runtime.dispatchFetch("https://voteproof.example" + url.pathname + url.search,
          { method, headers: request.headers, ...(["GET", "HEAD"].includes(method) ? {} : { body }) });
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer())); return;
      }
      const file = resolve(root, "." + decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname));
      const path = relative(root, file);
      if (path.startsWith("..") || path === "_headers" || !mime[extname(file)]) { response.writeHead(404).end(); return; }
      response.writeHead(200, { ...policy, "Content-Type": mime[extname(file)] }); response.end(await readFile(file));
    } catch { if (!response.headersSent) response.writeHead(404); response.end(); }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }) };
}
