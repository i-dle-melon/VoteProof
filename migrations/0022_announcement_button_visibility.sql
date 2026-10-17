-- Preserve saved links when hiding the announcement button. Existing buttons stay visible.
ALTER TABLE site_announcements ADD COLUMN button_enabled INTEGER NOT NULL DEFAULT 1 CHECK(button_enabled IN (0,1));
