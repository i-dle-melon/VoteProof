// Shared deterministic format; no image decoding, hashing or compression.
export const EXPORT_LIMITS = Object.freeze({
  maxFiles: 500,
  maxBytes: 512 * 1024 * 1024,
  blobMaxBytes: 64 * 1024 * 1024,
  maxJobFiles: 20000,
  lifetimeSeconds: 7 * 86400,
});
const extensions = Object.freeze({ "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" });
export function entryFilename(item) {
  if (
    !/^[A-Z0-9-]{1,60}$/.test(item.case_id ?? "") ||
    !/^[a-f0-9-]{36}$/.test(item.file_id ?? "") ||
    !extensions[item.content_type]
  )
    throw Error("EXPORT_INVALID_METADATA");
  return `${item.case_id}_${item.file_id}.${extensions[item.content_type]}`;
}
export function safeSlug(value, fallback = "voteproof") {
  const cleaned = String(value ?? "")
    .replace(/[^A-Za-z0-9_\-\u4e00-\u9fff]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "")
    .slice(0, 64);
  return !cleaned || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)
    ? safeSlugFallback(fallback)
    : cleaned;
}
const safeSlugFallback = (value) =>
  String(value)
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .slice(0, 64) || "voteproof";
export function packageFilename(job, number) {
  const filters = job.filters;
  const base = filters.entire_campaign
    ? safeSlug(job.campaign_name, "voteproof_" + filters.campaign_id)
    : `voteproof_${filters.from.slice(0, 10)}_${filters.from.slice(11, 16).replace(":", "")}-${filters.to.slice(0, 10)}_${filters.to.slice(11, 16).replace(":", "")}`;
  return `${base}_${String(number).padStart(3, "0")}.zip`;
}
export function planPackages(
  items,
  maxFiles = EXPORT_LIMITS.maxFiles,
  maxBytes = EXPORT_LIMITS.maxBytes,
) {
  const packages = [];
  for (const item of items) {
    if (!Number.isSafeInteger(item.file_size) || item.file_size <= 0 || item.file_size > maxBytes)
      throw Error("EXPORT_INVALID_METADATA");
    let p = packages.at(-1);
    if (!p || p.image_count >= maxFiles || p.total_bytes + item.file_size > maxBytes) {
      p = { number: packages.length + 1, image_count: 0, total_bytes: 0, items: [] };
      packages.push(p);
    }
    p.image_count++;
    p.total_bytes += item.file_size;
    p.items.push(item);
  }
  return packages;
}
export const CSV_COLUMNS = Object.freeze([
  "export_filename",
  "case_id",
  "file_id",
  "created_at",
  "campaign_id",
  "campaign_name",
  "vote_type",
  "source",
  "review_status",
  "review_stage",
  "content_type",
  "file_size",
  "etag",
  "sha256",
]);
// Quote every cell and neutralize spreadsheet formulas, including leading controls.
export function csvCell(value) {
  let s = String(value ?? "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
  if (/^[\s]*[=+@-]/.test(s)) s = "'" + s;
  return '"' + s.replaceAll('"', '""') + '"';
}
export function manifestCSV(items) {
  return (
    "\ufeff" +
    [
      CSV_COLUMNS.map(csvCell).join(","),
      ...items.map((item) =>
        CSV_COLUMNS.map((key) =>
          csvCell(key === "export_filename" ? entryFilename(item) : item[key]),
        ).join(","),
      ),
    ].join("\r\n") +
    "\r\n"
  );
}
