-- BOM revision history is immutable: a change is always a new revision.
CREATE TRIGGER bom_artwork_revisions_no_update BEFORE UPDATE ON bom_artwork_revisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_artwork_revisions is immutable';

CREATE TRIGGER bom_artwork_revisions_no_delete BEFORE DELETE ON bom_artwork_revisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_artwork_revisions is immutable';

CREATE TRIGGER bom_component_revisions_no_update BEFORE UPDATE ON bom_component_revisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_component_revisions is immutable';

CREATE TRIGGER bom_component_revisions_no_delete BEFORE DELETE ON bom_component_revisions
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_component_revisions is immutable';

CREATE TRIGGER bom_component_lines_no_update BEFORE UPDATE ON bom_component_lines
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_component_lines is immutable';

CREATE TRIGGER bom_component_lines_no_delete BEFORE DELETE ON bom_component_lines
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'bom_component_lines is immutable';

-- Father Codes and Son Codes are never physically deleted (status instead).
CREATE TRIGGER boms_no_delete BEFORE DELETE ON boms
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Father Codes are deactivated, never deleted';

CREATE TRIGGER bom_son_codes_no_delete BEFORE DELETE ON bom_son_codes
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Son Codes are removed by status, never deleted';
