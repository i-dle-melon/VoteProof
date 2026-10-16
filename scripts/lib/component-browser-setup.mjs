import { resolve } from "node:path";
import { buildPagesPreview } from "../build-pages-preview.mjs";
export default async function setup() {
  await buildPagesPreview(resolve(".wrangler/pages-preview"));
}
