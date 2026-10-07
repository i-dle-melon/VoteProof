import { jsonSuccess } from "./response.js";

export function getHealth() {
  return jsonSuccess({ service: "VoteProof API", status: "ok", version: "b1" });
}
