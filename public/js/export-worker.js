import { ZipStore } from "./zip-store.js";
import { EXPORT_LIMITS, entryFilename, manifestCSV } from "./export-format.js";
let controller,
  acknowledgement,
  running = false;
self.onmessage = (event) => {
  if (event.data.type === "ack") {
    acknowledgement?.();
    acknowledgement = null;
    return;
  }
  if (event.data.type === "cancel") {
    controller?.abort();
    return;
  }
  if (event.data.type === "start" && !running) {
    running = true;
    void generate(event.data);
  }
};
async function generate({ items, proofBase, sample }) {
  controller = new AbortController();
  let processed = 0,
    downloaded = 0;
  const progress = (phase) =>
    self.postMessage({
      type: "progress",
      phase,
      processed,
      downloaded,
      total: items.length,
      totalBytes: items.reduce((sum, i) => sum + i.file_size, 0),
    });
  const check = () => {
    if (controller.signal.aborted) throw Error("EXPORT_CANCELLED");
  };
  try {
    if (
      !Array.isArray(items) ||
      !items.length ||
      items.length > EXPORT_LIMITS.maxFiles ||
      items.reduce((n, i) => n + i.file_size, 0) > EXPORT_LIMITS.maxBytes
    )
      throw Error("EXPORT_INVALID_METADATA");
    if (!sample) {
      const url = new URL(proofBase, self.location.href);
      if (
        url.origin !== self.location.origin ||
        url.search ||
        url.hash ||
        !/^\/api\/admin\/image-exports\/jobs\/[a-f0-9-]{36}\/packages\/[1-9]\d*\/attempts\/[a-f0-9-]{36}\/files\/$/.test(
          url.pathname,
        )
      )
        throw Error("EXPORT_INVALID_METADATA");
    }
    const zip = new ZipStore(async (bytes) => {
      check();
      await new Promise((resolve) => {
        acknowledgement = resolve;
        const chunk = bytes.slice();
        self.postMessage({ type: "chunk", bytes: chunk }, [chunk.buffer]);
      });
      check();
    });
    for (const item of items) {
      check();
      const filename = entryFilename(item);
      progress("下載圖片");
      if (sample) await new Promise((resolve) => setTimeout(resolve, 150));
      check();
      const response = sample
        ? new Response(sample, {
            headers: { "Content-Type": "image/png", "Content-Length": String(sample.byteLength) },
          })
        : await fetch(proofBase + item.file_id, {
            credentials: "same-origin",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            redirect: "error",
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60000)]),
          });
      if (
        !response.ok ||
        !response.body ||
        response.headers.get("Content-Type") !== item.content_type ||
        Number(response.headers.get("Content-Length")) !== item.file_size
      ) {
        await response.body?.cancel();
        throw Error("EXPORT_PROOF_UNAVAILABLE");
      }
      const counted = response.body.pipeThrough(
        new TransformStream({
          transform(chunk, c) {
            check();
            downloaded += chunk.byteLength;
            c.enqueue(chunk);
            progress("下載圖片");
          },
        }),
      );
      await zip.add(filename, counted, item.file_size);
      processed++;
      progress("建立 ZIP");
    }
    const manifest = new TextEncoder().encode(manifestCSV(items));
    await zip.add("manifest.csv", new Blob([manifest]).stream(), manifest.length);
    await zip.close();
    check();
    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({
      type: "error",
      code: error.message === "EXPORT_CANCELLED" ? "EXPORT_CANCELLED" : "EXPORT_PROOF_UNAVAILABLE",
    });
  }
}
