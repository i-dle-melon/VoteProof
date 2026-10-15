import { BatchSubmission as RealBatchSubmission } from "./submission-core.js";
import { previewState } from "./pages-preview-state.js";
import { submissionFixture } from "./pages-preview-submission.js";
export { validateBatchImages, queryInformation, directIntentPocEnabled } from "./submission-core.js";
export class BatchSubmission extends RealBatchSubmission {
  #active = false;
  activatePreview() {
    this.#active = true;
  }
  get summary() {
    return this.#active ? submissionFixture() : super.summary;
  }
  get pending() {
    return (
      this.#active &&
      previewState.gate === "on" &&
      ["uploading", "failed"].includes(previewState.submission)
    );
  }
  get busy() {
    return this.#active && previewState.gate === "on" && previewState.submission === "uploading";
  }
}
