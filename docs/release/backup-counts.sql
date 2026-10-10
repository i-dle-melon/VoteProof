-- B1-B3 backup manifest; only schema names and counts, no personal/credential data.
SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name;
SELECT json_object('tables',json_object(
 'd1_migrations',(SELECT COUNT(*) FROM d1_migrations),
 'cases',(SELECT COUNT(*) FROM cases),
 'case_files',(SELECT COUNT(*) FROM case_files),
 'completed_uploads',(SELECT COUNT(*) FROM completed_uploads),
 'completed_upload_files',(SELECT COUNT(*) FROM completed_upload_files),
 'case_idempotency',(SELECT COUNT(*) FROM case_idempotency))) AS manifest_json;
