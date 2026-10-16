import { test as base, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { resolve, relative, extname } from "node:path";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".webp": "image/webp",
};
export { expect };
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route(/^http:\/\/127\.0\.0\.1:417[34]\//, async (route) => {
      const url = new URL(route.request().url()),
        preview = url.port === "4174",
        root = resolve(preview ? ".wrangler/pages-preview" : "public");
      let pathname = decodeURIComponent(url.pathname);
      if (preview) pathname = pathname.replace(/^\/VoteProof(?=\/)/, "");
      if (pathname.startsWith("/api/")) return route.abort("blockedbyclient");
      if (["/", "/admin", "/admin/"].includes(pathname)) pathname = "/index.html";
      const file = resolve(root, "." + pathname),
        type = types[extname(file)];
      if (relative(root, file).startsWith("..") || !type)
        return route.fulfill({ status: 404, body: "" });
      const headers = {
        "Content-Type": type,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      };
      if (!preview) {
        for (const line of (await readFile("public/_headers", "utf8"))
          .split(/\r?\n/)
          .filter((l) => /^  [^ ]/.test(l))) {
          const at = line.indexOf(":");
          headers[line.slice(2, at)] = line.slice(at + 1).trim();
        }
      }
      try {
        return route.fulfill({ status: 200, headers, body: await readFile(file) });
      } catch {
        return route.fulfill({ status: 404, body: "" });
      }
    });
    await use(page);
  },
});
