-- New content models only. No changes to historical Campaign/Case/ledger rows.
CREATE TABLE campaign_example_assets (
  asset_id TEXT PRIMARY KEY NOT NULL,
  campaign_id TEXT NOT NULL,
  object_key TEXT NOT NULL UNIQUE CHECK(object_key LIKE 'campaign-assets/%/example/%'),
  content_type TEXT NOT NULL CHECK(content_type IN ('image/png','image/jpeg','image/webp')),
  size INTEGER NOT NULL CHECK(size BETWEEN 1 AND 5242880),
  etag TEXT NOT NULL,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES members(member_id)
);
CREATE TABLE campaign_content (
  campaign_id TEXT PRIMARY KEY NOT NULL REFERENCES campaigns(campaign_id),
  submission_instructions TEXT NOT NULL DEFAULT '' CHECK(length(submission_instructions)<=5000),
  example_asset_id TEXT REFERENCES campaign_example_assets(asset_id),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES members(member_id)
);
CREATE TABLE site_announcements (
  announcement_id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 100),
  body TEXT NOT NULL CHECK(length(body) BETWEEN 1 AND 5000),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
  dismissible INTEGER NOT NULL DEFAULT 1 CHECK(dismissible IN (0,1)),
  starts_at TEXT,
  ends_at TEXT,
  button_label TEXT NOT NULL DEFAULT '' CHECK(length(button_label)<=60),
  button_url TEXT NOT NULL DEFAULT '' CHECK(button_url='' OR button_url LIKE 'http://%' OR button_url LIKE 'https://%'),
  version INTEGER NOT NULL DEFAULT 0 CHECK(version>=0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL REFERENCES members(member_id),
  last_mutation_id TEXT NOT NULL UNIQUE,
  CHECK(starts_at IS NULL OR ends_at IS NULL OR starts_at<ends_at)
);
CREATE INDEX idx_site_announcements_public ON site_announcements(enabled,updated_at DESC,announcement_id);
CREATE TABLE admin_content_audit (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  admin_member_id TEXT NOT NULL REFERENCES members(member_id),
  admin_role TEXT NOT NULL CHECK(admin_role IN ('admin','super_admin')),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK(target_type IN ('campaign_content','campaign_asset','announcement')),
  target_id TEXT NOT NULL,
  target_version INTEGER,
  before_json TEXT NOT NULL CHECK(json_valid(before_json)),
  after_json TEXT NOT NULL CHECK(json_valid(after_json)),
  reason TEXT
);
CREATE INDEX idx_admin_content_audit_cursor ON admin_content_audit(created_at DESC,id DESC);
CREATE TRIGGER admin_content_audit_no_update BEFORE UPDATE ON admin_content_audit
BEGIN SELECT RAISE(ABORT,'Content audit is immutable'); END;
CREATE TRIGGER admin_content_audit_no_delete BEFORE DELETE ON admin_content_audit
BEGIN SELECT RAISE(ABORT,'Content audit is immutable'); END;
CREATE TRIGGER admin_content_audit_no_replace BEFORE INSERT ON admin_content_audit
WHEN EXISTS(SELECT 1 FROM admin_content_audit WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'Content audit is immutable'); END;
