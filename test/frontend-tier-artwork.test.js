import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TIER_ARTWORK, tierArtwork } from "../public/js/tier-artwork.js";

test("approved artwork mapping matches the eight immutable backend tier identities", async () => {
  const schema = await readFile(new URL("../migrations/0007_member_tiers.sql", import.meta.url), "utf8");
  const ids = [...schema.match(/CHECK\(tier_id IN \(([^)]+)\)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  assert.deepEqual(Object.keys(TIER_ARTWORK), ids);
  for (const id of ids) {
    assert.equal(tierArtwork(id).src, `/assets/tiers/${id}.webp`);
    assert.ok(Object.isFrozen(tierArtwork(id)));
    assert.ok(schema.includes(`THEN '${tierArtwork(id).name}'`));
  }
});
test("all approved tier files are native-size lossless WebP, not upscaled placeholders", async () => {
  for (const art of Object.values(TIER_ARTWORK)) {
    const buffer = await readFile(new URL("../public" + art.src, import.meta.url));
    assert.equal(buffer.subarray(0, 4).toString(), "RIFF"); assert.equal(buffer.subarray(8, 12).toString(), "WEBP");
    assert.equal(buffer.readUInt32LE(4), buffer.length - 8);
    assert.equal(buffer.subarray(12, 16).toString(), "VP8L"); assert.equal(buffer[20], 0x2f);
    const dimensions = buffer.readUInt32LE(21);
    assert.equal((dimensions & 0x3fff) + 1, art.width); assert.equal(((dimensions >>> 14) & 0x3fff) + 1, art.height);
    assert.ok(buffer.length > 50000);
  }
});
test("unknown or prototype-shaped tier IDs never select another member tier", () => {
  for (const value of [null, undefined, {}, "", "NORMAL", "unconfigured", "__proto__", "constructor", "toString"]) assert.equal(tierArtwork(value), null);
});

test("tier display is confined to admin UI while members retain real points", async () => {
  const html = await readFile("public/index.html", "utf8");
  const member = await readFile("public/js/member.js", "utf8");
  const admin = await readFile("public/js/admin.js", "utf8");
  assert.doesNotMatch(html, /id="(?:member-tier(?:-artwork)?|tier-message|tier-next|tier-gap|tier-progress)"/);
  assert.doesNotMatch(member, /renderTierArtwork|data\.tier|data\.next_tier|points_to_next_tier/);
  assert.match(member, /String\(data\.total_points\)/);
  assert.match(admin, /renderTierArtwork\(artwork, row\.tier_id\)/);
});
