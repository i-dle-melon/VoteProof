-- Read-only after migration. Compare names, not merely command exit status.
SELECT name FROM d1_migrations ORDER BY id;
PRAGMA foreign_key_check;
PRAGMA quick_check;
SELECT name,type FROM sqlite_schema WHERE type IN('table','index','trigger') AND name NOT LIKE 'sqlite_%' ORDER BY type,name;
PRAGMA table_info(cases);
PRAGMA foreign_key_list(case_files);
PRAGMA foreign_key_list(point_transactions);
PRAGMA foreign_key_list(leaderboards);
SELECT 'missing table' AS defect,value AS name FROM json_each('["members","member_credentials","auth_transactions","auth_sessions","trusted_devices","recovery_codes","auth_rate_limits","auth_atomic_guards","auth_identities","auth_email_challenges","auth_email_sends","auth_enrollments","auth_password_operations","auth_google_flows","auth_method_setups","auth_identity_events","admin_memberships","admin_audit_logs","campaigns","point_transactions","leaderboards","leaderboard_runs","leaderboard_results","member_tiers","cases","case_files","completed_uploads","completed_upload_files","case_idempotency"]')
WHERE value NOT IN(SELECT name FROM sqlite_schema WHERE type='table');
SELECT 'missing index' AS defect,value AS name FROM json_each('["idx_cases_admin_queue","idx_cases_last_review","idx_cases_duplicate_target","idx_admin_audit_cursor","idx_campaigns_public","idx_points_case_award","idx_points_reversal","idx_leaderboards_public","idx_leaderboard_runs_history","idx_enrollment_email","idx_password_operation_pending","idx_google_flow_expiry"]')
WHERE value NOT IN(SELECT name FROM sqlite_schema WHERE type='index');
SELECT 'missing trigger' AS defect,value AS name FROM json_each('["identity_mapping_immutable","identity_events_no_delete","admin_audit_no_delete","points_no_update","points_no_delete","points_exact_reversal","cases_guest_points_update","leaderboards_publish","leaderboard_results_no_update","member_tiers_identity","member_tiers_order_update"]')
WHERE value NOT IN(SELECT name FROM sqlite_schema WHERE type='trigger');
SELECT tier_id,status,min_points FROM member_tiers ORDER BY rank_order;
SELECT COUNT(*) AS cases_count,COALESCE(SUM(points_awarded),0) AS case_points FROM cases;
SELECT COUNT(*) AS ledger_count FROM point_transactions;
