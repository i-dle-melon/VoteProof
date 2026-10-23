import test from "node:test";
import assert from "node:assert/strict";
import { imageExportDefaultRange } from "../public/js/admin-export.js";
import { exportFilters, exportScope, exportWhere } from "../src/lib/image-export.js";

for (const [name, instant, from, to] of [
  ["ordinary Taipei day", "2026-10-23T04:00:00Z", "2026-10-22T23:00", "2026-10-23T23:00"],
  ["month rollover", "2026-10-31T16:00:00Z", "2026-10-31T23:00", "2026-11-01T23:00"],
  ["year rollover", "2026-12-31T16:00:00Z", "2026-12-31T23:00", "2027-01-01T23:00"],
  ["leap day rollover", "2028-02-29T16:00:00Z", "2028-02-29T23:00", "2028-03-01T23:00"],
  ["Taipei day differs from UTC day", "2026-10-22T18:30:00Z", "2026-10-22T23:00", "2026-10-23T23:00"],
]) test("export default range: " + name, () => {
  const now = new Date(instant), before = now.toISOString();
  assert.deepEqual(imageExportDefaultRange(now), { from, to });
  for (const value of Object.values(imageExportDefaultRange(now)))
    assert.match(value, /^\d{4}-\d{2}-\d{2}T23:00$/);
  assert.equal(now.toISOString(), before);
});

test("default range preserves inclusive end minute and UTC half-open backend scope without D1", async () => {
  const range = imageExportDefaultRange(new Date("2026-10-23T04:00:00Z"));
  const raw = { ...range, campaign_id: null, entire_campaign: false,
    statuses: ["approved"], vote_types: ["團體"], sources: ["member"], end_inclusive: true };
  let queries = 0;
  const db = { prepare() { queries++; throw Error("No D1 call expected for date conversion"); } };
  const scope = await exportScope(db, exportFilters(raw));
  assert.equal(scope.from_utc, "2026-10-22T15:00:00.000Z");
  assert.equal(scope.to_utc, "2026-10-23T15:01:00.000Z");
  const where = exportWhere(scope);
  assert.match(where.sql, /c\.created_at >= \? AND c\.created_at < \?/);
  assert.deepEqual(where.values.slice(0, 2), [scope.from_utc, scope.to_utc]);
  assert.ok("2026-10-23T15:00:59.999Z" < scope.to_utc);
  assert.equal("2026-10-23T15:01:00.000Z" < scope.to_utc, false);
  assert.equal((await exportScope(db, exportFilters({ ...raw, end_inclusive: false }))).to_utc,
    "2026-10-23T15:00:00.000Z");
  assert.equal(queries, 0);
});
