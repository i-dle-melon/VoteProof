import test from "node:test";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { ZipStore, crcUpdate } from "../public/js/zip-store.js";
import {
  entryFilename,
  manifestCSV,
  planPackages,
  EXPORT_LIMITS,
  packageFilename,
  safeSlug,
} from "../public/js/export-format.js";
import { randomUUID } from "node:crypto";
const source = (type, i) => ({
  case_id: "VP-PREVIEW-001",
  file_id: randomUUID(),
  content_type: type,
  file_size: 3,
  created_at: "2026-10-14T00:00:00.000Z",
  campaign_id: "FAKE",
  campaign_name: '測試,"活動"\n名稱',
  source: "guest",
  review_status: "pending",
  etag: "fake",
  sha256: i === 0 ? "a".repeat(64) : null,
});
test("STORE ZIP extracted by independent fflate reader: PNG/JPEG/WEBP and valid UTF-8 CSV", async () => {
  const chunks = [],
    items = ["image/png", "image/jpeg", "image/webp"].map(source),
    zip = new ZipStore(async (bytes) => chunks.push(bytes.slice()));
  for (const item of items)
    await zip.add(entryFilename(item), new Blob([new Uint8Array([1, 2, 3])]).stream(), 3);
  const csv = new TextEncoder().encode(manifestCSV(items));
  await zip.add("manifest.csv", new Blob([csv]).stream(), csv.length);
  await zip.close();
  const output = new Uint8Array(Buffer.concat(chunks)),
    files = unzipSync(output);
  assert.equal(Object.keys(files).length, 4);
  for (const item of items) assert.deepEqual(files[entryFilename(item)], new Uint8Array([1, 2, 3]));
  assert.deepEqual(files["manifest.csv"].slice(0, 3), new Uint8Array([239, 187, 191]));
  assert.equal(strFromU8(files["manifest.csv"]), manifestCSV(items).slice(1));
  assert.match(strFromU8(files["manifest.csv"]), /測試,""活動""\n名稱/);
  const view = new DataView(output.buffer);
  for (let i = 0; i + 46 < output.length; i++)
    if (view.getUint32(i, true) === 0x02014b50) assert.equal(view.getUint16(i + 10, true), 0);
});
test("CRC-32 known reference vector", () =>
  assert.equal(
    (crcUpdate(0xffffffff, new TextEncoder().encode("123456789")) ^ 0xffffffff) >>> 0,
    0xcbf43926,
  ));
test("chunked writes apply backpressure and do not buffer an entire image", async () => {
  let wrote = 0,
    inflight = 0,
    peak = 0;
  const zip = new ZipStore(async (bytes) => {
    inflight++;
    peak = Math.max(inflight, peak);
    await new Promise((resolve) => setTimeout(resolve, 1));
    wrote += bytes.length;
    inflight--;
  });
  let n = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (n++ === 10) c.close();
      else c.enqueue(new Uint8Array(1024));
    },
  });
  await zip.add("proof.png", stream, 10240);
  await zip.close();
  assert.equal(peak, 1);
  assert.ok(wrote > 10240);
});
test("truncated or oversized proof never produces a valid completed ZIP", async () => {
  for (const size of [2, 4]) {
    const zip = new ZipStore(async () => {});
    await assert.rejects(
      zip.add("proof.jpg", new Blob([new Uint8Array(size)]).stream(), 3),
      /INTEGRITY/,
    );
  }
});
test("missing proof stream and cancellation reject generation", async () => {
  const zip = new ZipStore(async () => {
    throw Error("CANCELLED");
  });
  await assert.rejects(
    zip.add("proof.webp", new Blob([new Uint8Array(3)]).stream(), 3),
    /CANCELLED/,
  );
  const broken = new ReadableStream({
    start(c) {
      c.error(Error("MISSING"));
    },
  });
  await assert.rejects(new ZipStore(async () => {}).add("proof.png", broken, 3), /MISSING/);
});
test("unique filenames and ZIP Slip paths are rejected by writer", async () => {
  const zip = new ZipStore(async () => {});
  await zip.add("proof.png", new Blob([new Uint8Array(3)]).stream(), 3);
  await assert.rejects(zip.add("proof.png", new Blob([new Uint8Array(3)]).stream(), 3));
  for (const name of [
    "../../x.png",
    "..\\x.jpg",
    "/x.webp",
    "C:\\x.png",
    "x／y.png",
    "x\u0000.png",
  ])
    await assert.rejects(new ZipStore(async () => {}).add(name, new Blob([]).stream(), 0));
});
test("package boundaries and filename sanitization", () => {
  assert.deepEqual(
    planPackages(Array.from({ length: 1001 }, () => ({ file_size: 1 }))).map((p) => p.image_count),
    [500, 500, 1],
  );
  const p = planPackages(Array.from({ length: 205 }, () => ({ file_size: 5 * 1024 ** 2 })));
  assert.deepEqual(
    p.map((x) => x.image_count),
    [102, 102, 1],
  );
  assert.ok(p.every((x) => x.total_bytes <= EXPORT_LIMITS.maxBytes));
  for (const name of ["..\\a/../:x", "/x", "C:\\x", "nul", "\u0000"])
    assert.doesNotMatch(safeSlug(name), /[.\/:\\\u0000]/);
  assert.equal(
    packageFilename({ filters: { from: "2026-10-14T00:00", to: "2026-10-15T00:00" } }, 1),
    "voteproof_2026-10-14_0000-2026-10-15_0000_001.zip",
  );
});
