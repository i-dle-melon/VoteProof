// Fixtures feed shared render callbacks; no submission, query key or transport.
import { previewState as state } from "./pages-preview-state.js";
import { previewPicture } from "./preview-fixtures.js";
export function submissionFixture() {
  const active = ["uploading", "success", "failed"].includes(state.submission);
  const items = active
    ? Array.from({ length: 3 }, (_, i) => ({
        name: "PREVIEW-" + (i + 1) + ".png",
        status:
          state.submission === "success"
            ? "success"
            : state.submission === "failed" && i === 1
              ? "failed"
              : state.submission === "uploading" && i === 1
                ? "put"
                : i === 0
                  ? "success"
                  : "queued",
        error: state.submission === "failed" && i === 1 ? "PUT_FAILED" : null,
        result:
          state.submission === "success" || i === 0
            ? { case_id: "VP-PREVIEW-00" + (i + 1), status: "pending" }
            : null,
      }))
    : [];
  return {
    items,
    total: items.length,
    succeeded: items.filter((i) => i.result).length,
    failed: state.submission === "failed" ? 1 : 0,
    unknown: 0,
    processing: state.submission === "uploading" ? 1 : 0,
    retryable: state.submission === "failed" ? 2 : 0,
    queued: state.submission === "uploading" ? 1 : 0,
    complete: active && state.submission === "success",
  };
}
export async function mountSubmissionScene(render) {
  if (state.submission === "zero") return;
  const count = state.submission === "twenty" ? 20 : 3,
    files = [];
  for (let i = 0; i < count; i++)
    files.push(
      new File([await previewPicture(i + 1)], "PREVIEW-" + (i + 1) + ".png", { type: "image/png" }),
    );
  render.images(files);
  if (["multi", "twenty"].includes(state.submission)) return;
  const summary = submissionFixture();
  render.batch(summary);
  if (state.submission === "success") render.receipt(summary);
  if (state.submission === "uploading")
    render.progress({ phase: "put", file: 2, count: 3, fraction: 0.47 });
  if (state.submission === "failed") render.failure();
}
