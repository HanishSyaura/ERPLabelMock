# CLAUDE.md – Label MES

Label printing Manufacturing ERP. Scope is fixed: **BOM, Planning, Shopfloor,
QC** (TBS ERP structure) plus minimum supporting functions. Don't add other
ERP modules. Plan, open questions, assumptions: `docs/DEVELOPMENT_PLAN.md`.
Database conventions: `docs/DATABASE_DESIGN.md`.

## Commands

```bash
npm run dev:server   # API http://127.0.0.1:3000/api/v1 (server/.env)
npm run dev          # UI  http://127.0.0.1:5173 (proxies /api)
npm run typecheck    # server + web, strict
npm test             # server Vitest suites (TEST_DATABASE_URL, *_test DB, truncated per test)
npm run build
npm --workspace server run db:migrate:dev   # create/apply migrations (commit them)
npm --workspace server run db:seed          # reference data (idempotent, any environment)
npm --workspace server run db:seed:dev      # DEV ONLY role test accounts
npm --workspace server run db:seed:demo     # DEV ONLY demo data for every module (through the API; safe to rerun)
npm --workspace server run bootstrap:admin -- --username … --name "…"
```

Run typecheck, test and build before declaring work done.

## Rules

- **Menu names are TBS names.** `web/src/config/navigation.ts` is the single
  menu source (routes, sidebar, breadcrumbs). Don't rename or reorder items.
  A page not built yet renders `NotBuiltPage`; set `built: true` and register
  the component in `PAGE_REGISTRY` (`web/src/app/router.tsx`) when done.
  Detail/create routes go in `MODULE_ROUTES`. All master data lists sit in
  the **Master Data** module (`/master-data/*`, user request 2026-11-23):
  Part Master, Part Group Master, Part Category Master, Die Cut Master,
  Process, Machine Category, Machine, Routine Master, Reason Code, Defect
  Master. Part Master is the `materials` table (Son Codes / MRS use it);
  a part's category kind decides its spec fields (`PART_KIND_FIELDS`,
  web/src/modules/master-data/api.ts). Die rules (repeat from 1/8" CP gear
  teeth, labels around fit the repeat) live in `die-cuts.routes.ts`. Old paths redirect in the router.
  The routine is set only on the Master Card (no Production Routine Master).
  Orders are completed from the PJO detail page; the four material registers
  are tabs of one Material Movement register; the BOM page is one Father Code
  list with its product.
- **Part Master / Master Card (2026-11-24):** Part Master (`materials`) is the
  only item list – raw materials, packaging and finished goods (`partType`).
  A finished-good part's Artwork No. = its Father Code (`materials.bom_id`,
  unique); giving it one creates the hidden `products` row that owns the
  Master Card revisions (code / name / unit / status follow the part via
  `syncProductFromPart`). The Master Card is its own BOM sub-module (BOM › Master Card,
  `/bom/master-card/:productId`); the BOM sub-module is named Bill of Material.
  The draft form is split into steps (Header, AFRF-CS, Label & delivery,
  Material Spec, Process Detail, Review & release – `SECTIONS`). One menu item per
  page: the four material registers are tabs of Planning › Material Movement
  (`?type=`); orders are completed from the PJO page (no utility menu).
  Card sections live in the revisioned `spec` JSON (header, AFRF-CS, die cut
  spec, `bomDetail`, `processDetail`, `printingMachines`). QPA is computed only
  in `server/src/modules/bom/qpa.ts` and returned with its formula text – never
  re-implement it in the web. Location Qty / reorder / DO hold are manual until
  the WMS integration. `requireIqc` blocks issuing lots without a passed IQC.
- **QC (Phase 5, `server/src/modules/qc`):** rules live in
  `inspection.service.ts` (Check In = QC hold, Check Out = results; FAIL when a
  check fails, any reject, or a CRITICAL defect; dispositions by
  `qc.*.disposition` only; one reinspection after REWORK; OQC total ≤ last
  process good output). Inspections copy template checks at Check In; labels
  freeze printed values; reprints need `qc.label.reprint` + reason.
- **Printed documents (2026-11-24, `server/src/modules/documents`, `web/src/modules/documents`):**
  every printable record (PJO, Job Order traveller, MRS, Master Card, IQC / OQC
  report) prints through `PrintDocumentButton` with a **document template**
  (System › Document Templates, `system.documents.manage`): page, header with
  the shared company letterhead (`document_settings`, logo as a small data URL),
  content sections (order, titles, table columns), notes, signatures, footer
  with `{docNo} {printedBy} {printedAt} {page} {pages} {company}`. One active
  default per document; nothing printed is stored. Sections / columns per
  document are declared in `web/src/modules/documents/config.ts` and filled by
  `data.ts` from the normal detail endpoints. `render.tsx` measures and paginates
  (tables split by row with repeated headings); print and PDF (html-to-image +
  jsPDF, loaded on demand) use the same pages. Paper colours are the fixed
  `.doc-paper` tokens (always light). Shipping labels keep their own label templates.
- **Dashboard (2026-11-24):** an operational page, not module navigation (no
  module shortcuts; the sidebar is the only menu). `GET /dashboard?period=today|7d|30d&processId=`
  (`server/src/modules/documents/dashboard.routes.ts`) counts everything live per
  module the user may view: KPIs, Job Order progress (finished = good of the LAST
  route step, grouped by unit), schedule by the PJO required date (plant day via
  `lib/day.ts` – DATE columns are UTC midnight), machines with current session,
  WIP from `processQuantities` (waiting only when Check In would allow the step:
  previous step completed or partial transfer approved), material, quality by
  period, one alert list (severity, role, next action, link) and activity from
  transaction tables. KPIs open lists filtered the same way: Job Order list
  `status=A,B`, `due=overdue|today|week`, `completedFrom=YYYY-MM-DD`; MRS
  `status=OPEN,PARTIALLY_ISSUED` (statuses validated – unknown = 422). Add figures
  on the server, never in the page; covered by `server/tests/dashboard.test.ts`.
- **Cancellation and closure (audit 2026-11-24):** cancelling a Job Order (or an
  order, which cancels and audits each Job Order) cancels its MRS that never
  moved material; an MRS with material out stays open for returns (dashboard
  alert until returned). Order completion is blocked while an OQC lot of its
  Job Orders is in inspection or on hold; rework not reinspected is a warning.
  `server/tests/workflow-gaps.test.ts`.
- **Don't invent business rules** listed under "needs confirmation" in the
  plan. Build configurable structures and record the assumption.
- **No fake functionality.** No hard-coded figures, no buttons that do nothing,
  no mock data in production paths. Dev seed creates accounts only.
- **Config:** read `process.env` only in `server/src/config/env.ts` (zod). New
  variables go there and in `server/.env.example` (placeholders only).
- **Routes:** feature routers in `FEATURE_ROUTES` (`server/src/app.ts`).
  Validate with `body/query/params(req, zodSchema)`; throw `errors.*`
  (`lib/errors.ts`), never build error responses in routes. Success = `ok()`.
- **Permissions:** every route uses `requirePermission(key)` with a key from
  `server/src/modules/access/catalog.ts`. Never check role names. New key →
  catalog + role templates; `db:seed` grants new keys to template roles once.
  Never let an actor grant permissions they lack (`missingForGrant`).
- **Audit:** `recordAudit(tx, req.ctx, …)` inside the same transaction as the
  change. `audit_log` is append-only (DB triggers). Never put passwords,
  tokens or secrets in audit rows or logs (`REDACT_PATHS`).
- **Transactions:** multi-step writes use `db.$transaction(async (tx) => …)`.
  Document numbers via `nextNumber(tx, key, now)`.
- **Data:** master data deactivated, never deleted once referenced; transaction
  rows append-only (corrections = reversing rows); quantities `DECIMAL` with a
  unit per row; historical PJOs keep their exact BOM revision.
- **BOM (Phase 2, `server/src/modules/bom`):** Father Code → Son Codes. All
  writes go through `bom.service.ts` (lock row → expected revision → new
  immutable revision → audit). Artwork and component revisions are
  independent; never edit an old revision, never reuse a Son Code. Pure
  rules (description normalisation, quantity, diffs) in `bom.rules.ts`.
  Production Job Orders must store the ids from `productionSnapshot()`, or,
  when the Father Code belongs to a product, from its released Master Card
  (`cardSnapshot()` in `product.service.ts`; one Father Code per product).
  Master Card writes go through `product.service.ts` (one draft; release
  validates the spec and supersedes the previous; released rows are frozen
  by triggers).
  Files: `lib/file-store.ts` (type from magic bytes, random keys, thumbnails
  via sharp); never serve an unattached upload to anyone but its uploader.
- **Shopfloor (`server/src/modules/shopfloor`):** Job Order (= Work Order) is
  the production reference; Check In = start work, Check Out = end work. All
  session writes go through `session.service.ts`: wrap handheld writes in
  `idempotent()` (client transaction id), use `SHOPFLOOR_TX` (READ COMMITTED),
  lock machine row then route-step row. Eligibility rules live in
  `workOrderEligibility()` (used by scans and Check In – keep them one).
  Status families are separate (`state.ts`): machine, session, Job Order –
  never mix them; Job Orders are never completed automatically. Quantity rules
  only in `processQuantities()` / `checkAddition()`. Output rows are
  append-only; never move historical output between machines.
- **Planning ops & material (`server/src/modules/planning/{daily,material,completion}.service.ts`):**
  No Pre-Plan (removed 2026-11-23): Daily Job Information reads Job Orders
  directly (Planned = released PJO, no session yet; In Progress = has a
  session, not completed; Completed = completed that day). PJO list stages:
  planned / in_progress / completed (`PJO_STAGE`, orders.routes.ts). MRS lines come only from the PJO's frozen BOM
  revision. Every material movement goes through `recordMovement()` inside
  `idempotent()`; limits live there (issue ≤ requested; additional only
  after full issue + reason; return / reject / scrap ≤ out on line).
  `material_transactions` are append-only. Completing a PJO goes through
  `completePjo()` (blockers, override + reason for warnings, closes MRS).
- **Same rules for desktop and handheld:** one backend service per action;
  handheld screens are separate mobile-first UI over the same API.
- **Frontend:** call the API only through `api` (`web/src/lib/api.ts`, adds
  CSRF + device id). Auth state only in `useAuth()` (memory, not persisted).
  Permission checks in the UI are hints (`can(key)`); the server decides.
  Colours are tokens from `web/src/index.css` (no raw palette classes or hex).
  Use `PageHeader`, `DataTable`, `Dialog`, `Field` from `web/src/components`.
  Flex/grid children holding tables or long text need `min-w-0`.
- **Tests:** backend suites use `tests/db-helpers.ts` (`setupDb`, `createUser`,
  `login`, controllable clock). Add a test with every business rule.
