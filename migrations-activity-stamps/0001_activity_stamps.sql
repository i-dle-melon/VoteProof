CREATE TABLE activity_stamps (
  stamp_id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL REFERENCES campaigns(campaign_id),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 60),
  description TEXT NOT NULL CHECK(length(description) <= 160),
  min_proofs INTEGER NOT NULL CHECK(min_proofs BETWEEN 1 AND 10000),
  min_days INTEGER NOT NULL CHECK(min_days BETWEEN 1 AND 3650),
  opens_at TEXT NOT NULL,
  closes_at TEXT NOT NULL CHECK(closes_at > opens_at),
  icon TEXT NOT NULL CHECK(icon IN ('spark','music','heart','chart','star','globe','mama','custom')),
  color TEXT NOT NULL CHECK(color IN ('blue','purple','pink','teal','gold','green','custom')),
  custom_color TEXT,
  status TEXT NOT NULL CHECK(status IN ('draft','published','hidden','deleted')),
  sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 0 AND 9999),
  replaces_legacy INTEGER NOT NULL DEFAULT 0 CHECK(replaces_legacy IN (0,1)),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version >= 0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES members(member_id),
  last_mutation_id TEXT NOT NULL UNIQUE,
  custom_icon TEXT,
  CHECK((color = 'custom') = (custom_color IS NOT NULL)),
  CHECK((icon = 'custom' AND status <> 'deleted') = (custom_icon IS NOT NULL)),
  CHECK(custom_icon IS NULL OR length(custom_icon) <= 370000)
);

CREATE INDEX idx_activity_stamps_campaign ON activity_stamps(campaign_id);
CREATE INDEX idx_activity_stamps_display ON activity_stamps(status,sort_order,stamp_id);

CREATE TABLE activity_stamp_audit (
  mutation_id TEXT PRIMARY KEY NOT NULL,
  stamp_id TEXT NOT NULL REFERENCES activity_stamps(stamp_id),
  version INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('create','update','delete')),
  actor_member_id TEXT NOT NULL REFERENCES members(member_id),
  occurred_at TEXT NOT NULL
);
