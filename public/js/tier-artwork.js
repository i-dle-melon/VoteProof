// The only production mapping from authoritative backend tier IDs to artwork.
// These lossless assets preserve the operator-provided individual images.
import { assetURL } from "./preview.js";
const definitions = {
  normal: ["普通", 1576, 998], bronze: ["青銅", 1536, 1024], silver: ["白銀", 1536, 1024], gold: ["黃金", 1536, 1024],
  platinum: ["白金", 1536, 1024], emerald: ["翡翠", 1536, 1024], diamond: ["鑽石", 1536, 1024], stellar: ["星耀", 1536, 1024],
};
export const TIER_ARTWORK = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id, [name, width, height]]) =>
  [id, Object.freeze({ name, src: `/assets/tiers/${id}.webp`, width, height })])));
export function tierArtwork(id) {
  return typeof id === "string" && Object.hasOwn(TIER_ARTWORK, id) ? TIER_ARTWORK[id] : null;
}
export function renderTierArtwork(host, id, { adjacentText = true } = {}) {
  host.replaceChildren();
  const art = tierArtwork(id);
  if (!art) return;
  const image = document.createElement("img");
  image.src = assetURL(art.src); image.width = art.width; image.height = art.height;
  image.className = "approved-tier-artwork"; image.decoding = "async";
  image.alt = adjacentText ? "" : art.name + "等級";
  if (adjacentText) image.setAttribute("aria-hidden", "true");
  // Keep the adjacent real tier name when an asset is unavailable; no substitute.
  image.addEventListener("error", () => image.remove(), { once: true });
  host.append(image);
}
