// The only production mapping from authoritative backend tier IDs to artwork.
// These lossless assets are cropped from the operator-approved composite.
const definitions = {
  normal: ["普通", 241], bronze: ["青銅", 241], silver: ["白銀", 254], gold: ["黃金", 254],
  platinum: ["白金", 264], emerald: ["翡翠", 264], diamond: ["鑽石", 300], stellar: ["星耀", 300],
};
export const TIER_ARTWORK = Object.freeze(Object.fromEntries(Object.entries(definitions).map(([id, [name, height]]) =>
  [id, Object.freeze({ name, src: `/assets/tiers/${id}.webp`, width: 462, height })])));
export function tierArtwork(id) {
  return typeof id === "string" && Object.hasOwn(TIER_ARTWORK, id) ? TIER_ARTWORK[id] : null;
}
export function renderTierArtwork(host, id, { adjacentText = true } = {}) {
  host.replaceChildren();
  const art = tierArtwork(id);
  if (!art) return;
  const image = document.createElement("img");
  image.src = art.src; image.width = art.width; image.height = art.height;
  image.className = "approved-tier-artwork"; image.decoding = "async";
  image.alt = adjacentText ? "" : art.name + "等級";
  if (adjacentText) image.setAttribute("aria-hidden", "true");
  // Keep the adjacent real tier name when an asset is unavailable; no substitute.
  image.addEventListener("error", () => image.remove(), { once: true });
  host.append(image);
}
