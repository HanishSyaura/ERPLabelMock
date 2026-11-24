# Database design

MySQL 8.4, utf8mb4, InnoDB, all timestamps `DATETIME(3)` in UTC. Prisma schema:
`server/prisma/schema.prisma`; migrations in `server/prisma/migrations`
(committed, never edited after being applied).

## Conventions

- Primary keys: `CHAR(36)` UUID for business records; `BIGINT` auto-increment
  for high-volume append-only tables (audit, transactions).
- Every table: `created_at`, `updated_at`; `created_by` / `updated_by` where a
  user edits it.
- Master data is deactivated (`is_active` / status), never deleted once
  referenced. Codes are immutable.
- Transaction rows (issues, returns, rejects, WIP moves, output, inspections)
  are append-only: corrections are new reversing rows, not edits.
- Quantities: `DECIMAL(18,4)` with a unit of measure on the row; measurements
  `DECIMAL(18,4)`.
- Files: metadata in the database, file bytes in `UPLOAD_DIR` under random
  keys; SHA-256 stored for integrity and duplicate detection.
- Document numbers come from `number_sequences` (`lib/numbering.ts`) inside the
  creating transaction.
- Multi-step operations run in one transaction, with the audit row written in
  that transaction.

## Phase 1 tables

| Table | Purpose |
| --- | --- |
| `users` | Accounts (username, employee no., status, lockout, forced password change) |
| `roles` | Role templates + custom roles (`code` immutable, `is_system` for templates) |
| `permissions` | Mirror of the code catalog (FK target for grants) |
| `role_permissions`, `user_roles` | Grants and assignments |
| `sessions` | Server-side sessions (SHA-256 of token, CSRF token, idle/absolute expiry, device id) |
| `audit_log` | Append-only trail (triggers block UPDATE/DELETE) |
| `number_sequences` | Document numbering |

## Phase 2 tables (BOM)

| Table | Purpose |
| --- | --- |
| `stored_files` | File metadata (name, type, size, SHA-256, storage key, thumbnail key, preview kind, attached_at) |
| `materials` | Material reference list for Son Codes (code immutable) |
| `boms` | Father Code: code, status, current label description (+ normalised key for duplicates), current artwork / component revision numbers, next Son Code sequence |
| `bom_artwork_revisions` | Immutable: revision no., label description, file, change type, note, restored-from |
| `bom_son_codes` | Son Code identity per Father Code (`<father>-NN`, never reused), status ACTIVE / REMOVED |
| `bom_component_revisions` | Immutable: revision no., change type, added / modified / removed diff (JSON), note |
| `bom_component_lines` | Immutable snapshot of every line in a component revision (material code / description copied, quantity DECIMAL(18,4), unit, remarks) |

Relationships: `boms 1─* bom_artwork_revisions *─1 stored_files`,
`boms 1─* bom_son_codes`, `boms 1─* bom_component_revisions 1─* bom_component_lines *─1 bom_son_codes`,
`bom_component_lines *─1 materials`. Triggers block UPDATE / DELETE on the three
revision tables and DELETE on `boms` / `bom_son_codes`.

A Production Job Order (Phase 3) will reference `bom_artwork_revisions.id` and
`bom_component_revisions.id` directly — that pair is the "Production Job Order
BOM reference", and the immutability triggers guarantee it can't drift.

## Planning masters, orders and shopfloor sessions

| Table | Purpose |
| --- | --- |
| `processes` | Process master (code immutable) |
| `machine_categories`, `machine_category_processes` | Category + processes it can perform |
| `operator_qualifications` | Users authorised to operate machines of a category |
| `machines` | Machine master: code (= barcode, immutable), category, `is_active`, operational `status` (+ `status_changed_at`) |
| `handheld_devices` | Device id from the handheld, optional pinned machine, last user / seen |
| `routines`, `routine_steps` | Routine Master (ordered processes) |
| `production_routines` | Production Routine Master: Father Code (unique) → routine |
| `production_job_orders` | PJO: Father Code + **frozen** `artwork_revision_id` / `component_revision_id`, order qty + unit, status |
| `work_orders` | Job Order (= Work Order): number (= barcode), PJO, quantity, status, hold reason, completion |
| `work_order_processes` | Route step: process, status, assigned machine, supervisor authorisations (partial transfer, split, extra qty), running good / reject totals |
| `production_sessions` | One Check In → Check Out cycle: Job Order step, machine, operator, times, status, Check Out type, session totals, devices |
| `production_outputs` | Append-only output entries (interim / at Check Out / at breakdown), per machine and operator |
| `machine_breakdowns` | Breakdown record, maintenance, release with safety confirmation |
| `machine_changes` | Machine change requests / approvals with previous machine output and outstanding quantity |
| `shopfloor_transactions` | Idempotency keys with the stored response |

Running totals on `work_order_processes` and `production_sessions` are updated
in the same transaction as the output rows; tests assert they equal the sums of
`production_outputs`. Triggers: `production_outputs` reject UPDATE / DELETE;
`production_sessions`, `machine_breakdowns`, `machine_changes` reject DELETE.

## Product Master and Master Card

| Table | Purpose |
| --- | --- |
| `products` | Label item the customer orders: product code (immutable), name, customer, part no., unit, Father Code (unique: one per product), status, current released card revision |
| `master_card_revisions` | Approved bundle per revision: status Draft / Released / Superseded, artwork revision, component revision, routine, `spec` JSON (size, across, gaps, core, labels per roll, winding 1–8, print, finishing, die / plate refs, customer requirements), change note, released by / at |
| `production_job_orders` + | `product_id`, `master_card_revision_id` (the card a PJO froze; null for Father Codes without a product) |

Triggers: `master_card_revisions` reject content changes and deletes once not
Draft (a Released row may only become Superseded); `products` reject DELETE.

## Part Master per TBS (2026-11-24)

| Table / column | Purpose |
| --- | --- |
| `materials` + `part_type`, `bom_id` (unique, Artwork No. of a finished good), `nmi_no` (unique), `specification`, `source`, `revision_no`, `revised_at`, engineering columns, shipping columns (`reorder_level`, `reorder_qty`, `max_qty`, `lead_time_days`, `over_receive_pct`, `custom_code`, `obsolete`, `obsolete_at`, `obsolete_by`, `require_iqc`, `control_point`), `image_file_id` | Part Master sections |
| `part_uom_conversions` | 1 uom = factor × the part's unit (unique per part + uom) |
| `part_locations` | Location Qty, manual: warehouse, location, shelf, lot, DO hold qty, qty |
| `products.part_id` (unique, required) | The finished-good part that owns the Master Card revisions; existing products were migrated to finished-good parts with the same code |

Master Card sections (header, AFRF-CS, die cut spec, BOM detail, process detail, printing machines) are fields of `master_card_revisions.spec` (JSON, validated by zod, frozen at release by the existing trigger).

## Part and die masters (2026-11-23)

| Table | Purpose |
| --- | --- |
| `part_categories` | Part Category Master: code (immutable), unique name, kind (label stock, film, paper, laminate, adhesive, ink, varnish, foil, ribbon, core, plate, packaging, other) |
| `part_groups` | Part Group Master: code (immutable), name unique within its category |
| `materials` | Part Master: + category_id, group_id (group must belong to the category, checked in the API) and optional spec columns (stock_form, width_mm, length_m, thickness_micron, gsm, face_finish, adhesive, liner, core_id_mm, colour, system, supplier_name, supplier_part_no, shelf_life_days, certifications). The old free-text category column was migrated to part_categories and dropped. |
| `die_cuts` | Die Cut Master: die no. (immutable), type, cut, shape, label width/height, corner radius, across/around, gaps (3 decimals), gear teeth, repeat, condition, location, supplier, status |

## Pre-Plan, material and order completion

| Table | Purpose |
| --- | --- |
| `schedule_entries` | Retired with Pre-Plan (2026-11-23), kept for history; no code reads or writes it. Was: Job Order step on a machine for a day, with sequence and planned quantity (unique step / machine / day) |
| `reason_codes` | Reasons per movement type (additional issue, reject, scrap); code immutable |
| `material_requisitions` | MRS per Job Order: number, status, closed when the PJO is completed |
| `mrs_lines` | MRS line from the frozen BOM revision: material snapshot, requested quantity and running totals (issued, additional, returned, rejected, scrapped) |
| `material_transactions` | Append-only movements: issue, additional issue, return, reject, scrap (lot ref, reason, machine / process for scrap) |
| `production_job_orders` + | `closed_at`, `closed_by`, `closure_note`, `closure_override` (Production Order Complete Utility) |

Triggers: `material_transactions` reject UPDATE / DELETE; `material_requisitions` and `mrs_lines` reject DELETE. Tests assert the line totals and the transaction rows agree.

## Planned tables by phase

Final design is fixed per phase once the open questions in
`DEVELOPMENT_PLAN.md` are answered.

- **Phase 3 Planning:** `machine_categories`, `machines`, `processes`,
  `production_job_orders` (FKs to the exact `bom_artwork_revisions` and
  `bom_component_revisions` rows), `job_orders`, `schedule_entries` (pre-plan), `mrs` + `mrs_lines` + `mrs_issues`, `mrs_additional_issues`,
  `production_completions` (+ override reason / approver).
- **Phase 4 Shopfloor:** `routines` + `routine_steps`, `production_routines`,
  `machine_outputs` (+ downtime), `wip_units` (kind roll | batch, parent links),
  `wip_movements` (check-out / check-in, from/to process), `mrs_returns`,
  `mrs_rejects`, `scrap_records`, `scrap_reasons`, `device_submissions`
  (idempotency keys for handheld / offline sync).
- **Phase 5 QC (built 2026-11-23):** `defect_codes` (Defect Master: category,
  severity, IQC / OQC scope), `inspection_templates` (items as JSON: pass /
  fail or measurement with min / max; IQC default per part category),
  `qc_inspections` (one table for IQC and OQC: checks copied at Check In with
  results, part lot or Job Order, qty / sample / good / reject, result,
  disposition, `reinspection_of_id` unique), `qc_defects`, `label_templates`
  (size, printed fields, barcode), `shipping_labels` (one per carton, frozen
  `data`, print count, void reason; reprints audited).
