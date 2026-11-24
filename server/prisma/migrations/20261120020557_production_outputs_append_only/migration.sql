-- Output entries are production records: corrections are new entries, never edits.
CREATE TRIGGER production_outputs_no_update BEFORE UPDATE ON production_outputs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_outputs is append-only';

CREATE TRIGGER production_outputs_no_delete BEFORE DELETE ON production_outputs
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_outputs is append-only';

-- Sessions, breakdowns and machine changes are history: never deleted.
CREATE TRIGGER production_sessions_no_delete BEFORE DELETE ON production_sessions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'production_sessions are never deleted';

CREATE TRIGGER machine_breakdowns_no_delete BEFORE DELETE ON machine_breakdowns
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'machine_breakdowns are never deleted';

CREATE TRIGGER machine_changes_no_delete BEFORE DELETE ON machine_changes
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'machine_changes are never deleted';
