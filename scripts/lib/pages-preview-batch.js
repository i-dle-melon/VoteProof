import { BatchSubmission as RealBatchSubmission } from "./submission-core.js";
import { previewState } from "./pages-preview-state.js";
import { submissionFixture } from "./pages-preview-submission.js";
export { validateBatchImages, queryInformation, directIntentPocEnabled, uploadDiagnosticText } from "./submission-core.js";
export class BatchSubmission extends RealBatchSubmission {
  #active = false;
  #stopped = false;
  activatePreview() {
    this.#active = true;
  }
  get summary() {
    return this.#active ? submissionFixture(this.#stopped) : super.summary;
  }
  get pending() {
    return (
      this.#active &&
      previewState.gate === "on" &&
      ["uploading", "failed"].includes(previewState.submission)
    );
  }
  get busy() {
    return this.#active && !this.#stopped && previewState.gate === "on" && previewState.submission === "uploading";
  }
  requestStop() {
    if (!this.busy) return false;
    this.#stopped = true;
    this.changed(this.summary);
    return true;
  }
}
