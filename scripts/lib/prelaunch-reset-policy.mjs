// Offline reset policy. No Worker import, network client or Production adapter.
export const RESET_SOURCE_SHA='a2b229351face524a8fba36a16ca34532f822542';
export const KEEP_TABLES=new Set([
 'members','member_credentials','auth_transactions','auth_sessions','trusted_devices','recovery_codes',
 'auth_rate_limits','auth_atomic_guards','auth_identities','auth_email_challenges','auth_email_sends',
 'auth_enrollments','auth_password_operations','auth_google_flows','auth_method_setups','auth_identity_events',
 'admin_memberships','member_status_events','admin_member_contact_audit','admin_member_mail_requests',
 'campaigns','campaign_content','campaign_example_assets','site_announcements','solo_targets','member_tiers',
 'submission_settings','submission_settings_audit','admin_content_audit','d1_migrations',
]);
export const CLEAR_TABLES=new Set([
 'backup_admin_audit','backup_processor_lock','case_files','case_idempotency','cases',
 'cold_proofs','completed_upload_files','completed_uploads','drive_backup_folders','drive_quota_snapshots',
 'export_completed_files','export_file_claims','export_job_items','export_jobs','export_operation_audit',
 'export_packages','export_scope_locks','image_mutation_operations','leaderboard_results','leaderboard_runs',
 'point_transactions','proof_backups','proof_duplicate_groups','proof_duplicate_jobs','proof_duplicate_requests',
 'proof_exact_hashes','proof_upload_checksums','proof_upload_intents','storage_alert_deliveries','storage_alerts',
 'storage_archive_dispatches','storage_audit','storage_history','storage_reservations',
]);
export const REBUILD_TABLES=new Set(['leaderboards','image_maintenance_control','storage_archive_control','storage_capacity']);
// Mixed audit stream: retain configuration/role/rules history, remove only
// case and points history from the new active database. Original stays sealed.
export function retainedRows(name,rows){
 if(KEEP_TABLES.has(name))return rows;
 if(name==='admin_audit_logs')return rows.filter(r=>!['case','point_transaction'].includes(r.target_type));
 return [];
}
export function tablePolicy(name){
 if(KEEP_TABLES.has(name))return 'KEEP_EXACT';
 if(name==='admin_audit_logs')return 'KEEP_CONFIG_AUDIT_ONLY_ARCHIVE_SOURCE';
 if(CLEAR_TABLES.has(name))return 'EMPTY_NEW_DATABASE_ARCHIVE_SOURCE';
 if(REBUILD_TABLES.has(name))return 'REBUILD_SAFE_STATE';
 throw Error('UNCLASSIFIED_TABLE');
}
export const SUBMISSION_PREFIXES=['proofs/staging/','proofs/final/','proofs/cases/'];
