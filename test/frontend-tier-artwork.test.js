import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TIER_ARTWORK, tierArtwork } from "../public/js/tier-artwork.js";
import { memberTierProgress } from "../public/js/member-tier-progress.js";

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

test("members render only the authoritative current tier without a gallery or invented progress", async () => {
  const html = await readFile("public/index.html", "utf8");
  const member = await readFile("public/js/member.js", "utf8");
  const admin = await readFile("public/js/admin.js", "utf8");
  assert.match(html, /id="member-tier"/);
  assert.match(html, /id="member-tier-artwork"/);
  assert.doesNotMatch(html, /id="preview-tier-artwork"/);
  assert.match(member, /tierArtwork\(data\.tier\?\.tier_id\)/);
  assert.doesNotMatch(member, /Object\.(?:values|entries)\(TIER_ARTWORK\)/);
  assert.match(member, /memberTierProgress\(data\)/);
  assert.match(member, /String\(data\.total_points\)/);
  assert.match(admin, /renderTierArtwork\(artwork, row\.tier_id\)/);
});

const configured = () => ({ total_points: 10, tier: { tier_id: "normal", min_points: 0, rank_order: 1 },
  next_tier: { tier_id: "bronze", min_points: 100, rank_order: 2 }, tier_configuration_ready: true });
test("member progress uses real configured thresholds and current points", () => {
  assert.deepEqual(memberTierProgress(configured()), { state: "next", nextName: "青銅", totalPoints: 10, requiredPoints: 100, remainingPoints: 90, percent: 10 });
  assert.equal(memberTierProgress({ ...configured(), total_points: -10 }).percent, 0);
  assert.equal(memberTierProgress({ ...configured(), total_points: -10 }).remainingPoints, 110);
});
test("member progress starts at the current tier threshold and can skip disabled ranks", () => {
  const data = { ...configured(), total_points: 123, tier: { tier_id: "bronze", min_points: 100, rank_order: 2 }, next_tier: { tier_id: "gold", min_points: 200, rank_order: 4 } };
  assert.equal(memberTierProgress(data).nextName, "黃金");
  assert.equal(memberTierProgress(data).percent, 23);
  assert.equal(memberTierProgress(data).remainingPoints, 77);
});
test("unconfigured thresholds never claim highest tier or show a meter", () => {
  assert.deepEqual(memberTierProgress({ ...configured(), tier_configuration_ready: false, next_tier: null }), { state: "unconfigured" });
  assert.deepEqual(memberTierProgress({ ...configured(), next_tier: null }), { state: "highest" });
  assert.deepEqual(memberTierProgress({ ...configured(), next_tier: undefined }), { state: "unavailable" });
});
test("invalid or disabled next tiers never produce progress", () => {
  for (const patch of [{ min_points: null }, { min_points: -1 }, { min_points: "100" }, { min_points: 0 }, { min_points: 1.5 }, { min_points: 1000000001 }, { status: "disabled" }, { rank_order: 1 }, { rank_order: 9 }, { tier_id: "unknown" }, { tier_id: "normal" }]) {
    const data = configured(); Object.assign(data.next_tier, patch);
    assert.equal(memberTierProgress(data).state, "unavailable");
  }
  assert.equal(memberTierProgress({ ...configured(), total_points: 100 }).state, "unavailable");
});
test("missing, unknown or malformed current tier cannot claim progress or highest tier", () => {
  for (const tier of [null, {}, { tier_id: "unknown" }, { tier_id: "normal", min_points: null, rank_order: 1 }, { tier_id: "normal", min_points: 0, rank_order: 1, status: "disabled" }]) {
    assert.equal(memberTierProgress({ ...configured(), tier, next_tier: null }).state, "unavailable");
  }
  assert.equal(memberTierProgress({ ...configured(), total_points: NaN }).state, "unavailable");
});
