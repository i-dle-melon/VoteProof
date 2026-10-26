-- Scoped R2 maintenance only, not V4 A1/A2. Existing rows/Gate/archive policy unchanged.
CREATE TABLE image_maintenance_control (
 id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL DEFAULT 'open' CHECK(mode IN('open','draining','closed')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>0), generation INTEGER NOT NULL DEFAULT 0,
 legacy_status TEXT NOT NULL DEFAULT 'unknown' CHECK(legacy_status IN('unknown','operator_attested')),
 legacy_evidence_hash TEXT, updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT INTO image_maintenance_control(id) VALUES(1);
CREATE TABLE image_mutation_operations (
 id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN('admin_upload','admin_campaign','delete','inventory')),
 parent_id TEXT REFERENCES image_mutation_operations(id), actor_member_id TEXT REFERENCES members(member_id),
 object_key TEXT, generation INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN('active','unknown','completed','aborted')),
 created_at INTEGER NOT NULL, finished_at INTEGER, outcome TEXT
);
CREATE INDEX image_operations_pending ON image_mutation_operations(kind,state) WHERE state IN('active','unknown');
CREATE INDEX image_operations_parent ON image_mutation_operations(parent_id,state);
CREATE TRIGGER image_operation_admission BEFORE INSERT ON image_mutation_operations
WHEN NEW.state!='active' OR NEW.generation!=(SELECT generation FROM image_maintenance_control WHERE id=1)
 OR (NEW.parent_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM image_mutation_operations p
   WHERE p.id=NEW.parent_id AND p.kind IN('admin_upload','admin_campaign') AND p.state='active'))
 OR (NEW.kind!='inventory' AND (
   EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id IS NOT NULL)
   OR NOT EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND (mode='open' OR
     (mode='draining' AND NEW.kind='delete' AND EXISTS(SELECT 1 FROM image_mutation_operations p
       WHERE p.id=NEW.parent_id AND p.kind IN('admin_upload','admin_campaign') AND p.state='active'))))))
BEGIN SELECT RAISE(ABORT,'IMAGE_MUTATION_FENCED'); END;
CREATE TRIGGER image_delete_generation AFTER INSERT ON image_mutation_operations WHEN NEW.kind='delete'
BEGIN UPDATE image_maintenance_control SET generation=generation+1 WHERE id=1; END;
CREATE TRIGGER image_operation_identity BEFORE UPDATE ON image_mutation_operations
WHEN NEW.id IS NOT OLD.id OR NEW.kind IS NOT OLD.kind OR NEW.parent_id IS NOT OLD.parent_id
 OR NEW.actor_member_id IS NOT OLD.actor_member_id OR NEW.object_key IS NOT OLD.object_key
 OR NEW.generation IS NOT OLD.generation OR NEW.created_at IS NOT OLD.created_at
 OR OLD.state!='active' OR NEW.state NOT IN('unknown','completed','aborted')
BEGIN SELECT RAISE(ABORT,'IMAGE_OPERATION_IMMUTABLE'); END;
CREATE TRIGGER image_operation_no_delete BEFORE DELETE ON image_mutation_operations
BEGIN SELECT RAISE(ABORT,'IMAGE_OPERATION_IMMUTABLE'); END;
CREATE TRIGGER image_operation_no_replace BEFORE INSERT ON image_mutation_operations
WHEN EXISTS(SELECT 1 FROM image_mutation_operations WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'IMAGE_OPERATION_IMMUTABLE'); END;
-- An admitted Admin may fail safely at reserve after pause; it is not allowed a new PUT.
CREATE TRIGGER image_put_maintenance_guard BEFORE INSERT ON storage_reservations
WHEN NOT EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode='open')
BEGIN SELECT RAISE(ABORT,'IMAGE_MUTATION_FENCED'); END;
-- Covers both legacy and phased inventory entrypoints atomically, not a JS-only check.
CREATE TRIGGER image_inventory_claim BEFORE UPDATE OF inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NULL AND NEW.inventory_id IS NOT NULL AND (
 NOT EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode IN('open','closed') AND legacy_status='operator_attested')
 OR EXISTS(SELECT 1 FROM image_mutation_operations WHERE state IN('active','unknown') AND kind!='inventory')
 OR EXISTS(SELECT 1 FROM proof_upload_intents WHERE write_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed')
 OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting') OR NEW.reserved_bytes!=0)
BEGIN SELECT RAISE(ABORT,'IMAGE_INVENTORY_BUSY'); END;
CREATE TRIGGER image_inventory_pin AFTER UPDATE OF inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NULL AND NEW.inventory_id IS NOT NULL
BEGIN
 INSERT INTO image_mutation_operations(id,kind,generation,state,created_at)
 SELECT NEW.inventory_id,'inventory',generation,'active',CAST(strftime('%s','now') AS INTEGER) FROM image_maintenance_control WHERE id=1;
 INSERT INTO storage_audit VALUES(NEW.inventory_id||':image-pin',CAST(strftime('%s','now') AS INTEGER),'inventory_image_pin',NEW.inventory_id,'{}');
END;
CREATE TRIGGER image_inventory_publish BEFORE UPDATE OF inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NOT NULL AND NEW.inventory_id IS NULL AND NEW.trusted_until>0 AND (
 NOT EXISTS(SELECT 1 FROM image_maintenance_control m JOIN image_mutation_operations o ON o.id=OLD.inventory_id
   WHERE m.id=1 AND m.mode IN('open','closed') AND m.legacy_status='operator_attested'
   AND o.kind='inventory' AND o.state='active' AND o.generation=m.generation)
 OR EXISTS(SELECT 1 FROM image_mutation_operations WHERE kind!='inventory' AND state IN('active','unknown'))
 OR EXISTS(SELECT 1 FROM proof_upload_intents WHERE write_token IS NOT NULL)
 OR EXISTS(SELECT 1 FROM storage_archive_dispatches WHERE state!='completed')
 OR EXISTS(SELECT 1 FROM cold_proofs WHERE state='deleting') OR NEW.reserved_bytes!=0)
BEGIN SELECT RAISE(ABORT,'IMAGE_INVENTORY_UNTRUSTED'); END;
CREATE TRIGGER image_inventory_abort_guard BEFORE UPDATE OF inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NOT NULL AND NEW.inventory_id IS NULL AND NEW.trusted_until=0
 AND (NEW.blocked!=1 OR NOT EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode IN('draining','closed')))
BEGIN SELECT RAISE(ABORT,'IMAGE_INVENTORY_ABORT_FENCED'); END;
CREATE TRIGGER image_inventory_terminal AFTER UPDATE OF inventory_id ON storage_capacity
WHEN OLD.inventory_id IS NOT NULL AND NEW.inventory_id IS NULL
BEGIN UPDATE image_mutation_operations SET state=CASE WHEN NEW.trusted_until>0 THEN 'completed' ELSE 'aborted' END,
 finished_at=CAST(strftime('%s','now') AS INTEGER),outcome=CASE WHEN NEW.trusted_until>0 THEN 'published' ELSE 'invalidated' END
 WHERE id=OLD.inventory_id AND kind='inventory' AND state='active'; END;
CREATE TRIGGER image_archive_dispatch_guard BEFORE INSERT ON storage_archive_dispatches
WHEN NOT EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=1 AND mode='open' AND legacy_status='operator_attested')
 OR EXISTS(SELECT 1 FROM storage_capacity WHERE id=1 AND inventory_id IS NOT NULL)
BEGIN SELECT RAISE(ABORT,'IMAGE_MUTATION_FENCED'); END;
CREATE TRIGGER image_control_identity BEFORE UPDATE ON image_maintenance_control
WHEN NEW.id!=OLD.id OR NEW.version<OLD.version OR NEW.generation<OLD.generation
 OR (NEW.mode!=OLD.mode AND NEW.version<=OLD.version)
BEGIN SELECT RAISE(ABORT,'IMAGE_CONTROL_CONFLICT'); END;
CREATE TRIGGER image_control_no_delete BEFORE DELETE ON image_maintenance_control
BEGIN SELECT RAISE(ABORT,'IMAGE_CONTROL_IMMUTABLE'); END;
CREATE TRIGGER image_control_no_replace BEFORE INSERT ON image_maintenance_control
WHEN EXISTS(SELECT 1 FROM image_maintenance_control WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT,'IMAGE_CONTROL_IMMUTABLE'); END;
