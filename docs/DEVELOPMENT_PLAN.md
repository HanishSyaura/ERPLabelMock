# Development plan – Label printing Manufacturing ERP

Scope is fixed by the master brief: **BOM → Planning → Shopfloor → QC**, following
the TBS ERP Manufacturing menu structure, plus the minimum supporting
functions (sign-in, users, roles, audit). No sales, purchasing, finance,
general inventory, warehouse, costing or dispatch modules.

## Stack

As specified in the brief, because the project folder was empty (no existing
architecture to preserve):

| Layer | Choice |
| --- | --- |
| Frontend | React 19, TypeScript 5.9, Vite 8, Tailwind CSS 4, React Router 7, TanStack Query 5, lucide-react (Recharts added in Phase 6) |
| Backend | Node.js 24, Express 5, TypeScript, zod 4, pino |
| Database | MySQL 8.4 LTS, Prisma 7 (`prisma-client` generator + `@prisma/adapter-mariadb`) |
| Auth | Server-side sessions (httpOnly cookie, token stored as SHA-256), CSRF header, argon2id + pepper |

## Phase status

| Phase | Content | Status |
| --- | --- | --- |
| 1 – System Foundation | Architecture, auth, users, roles & permissions, audit trail, navigation, shared UI, API conventions, number sequences | **Done** (see "Phase 1 delivered") |
| 2 – BOM | Father Code (artwork + label description) → Son Codes (components), independent artwork and component revisions, duplicate detection, material reference list | **Done** (see "Phase 2 delivered") |
| 3 – Planning | Production Job Order, Job Order, Daily Job Information, MRS, MRS Additional Issued, Production Order Complete Utility, Machine, Machine Category, Process | **Done** – all menu pages built; Pre-Plan removed on 2026-11-23 at the user's request (see "Phase 3 / 4 completion delivered") |
| 4 – Shopfloor | Routine masters, Machine Output Control, WIP Check In/Out, MRS Return/Reject, Scrap, handheld scanning UI | **Done** – all seven menu pages built; material movements are desktop screens for now (handheld screens for them not built) |
| 5 – QC | IQC, OQC, inspection templates, Shipping Label, Defect Master | **Done** (2026-11-23) – built on the assumptions under C |
| 6 – Integration & Reporting | Dashboards and reports from transaction data | – |
| 7 – Testing & Optimisation | UAT, scanner/device testing, performance | – |

## Phase 1 delivered

Backend (`server/`)
- `createApp()` builds the Express app for server and tests; all routes under `/api/v1`.
- Responses `{ data }` / `{ data, meta }`; errors thrown as `AppError`, rendered once as problem+json with field `issues`.
- zod validation for every body/query/param (`lib/http.ts`).
- Sessions: 12 h absolute, 120 min idle (configurable); CSRF token required on unsafe requests; per-IP sign-in limiter; account lock after 5 failures for 15 min; same message for unknown user and wrong password.
- Forced password change (new users, admin resets) blocks every other route until done; changing the password signs out other sessions.
- Permission catalog (`modules/access/catalog.ts`, 51 keys covering all four modules) – routes check keys, never role names.
- 8 suggested role templates (Administrator, Production Planner, Production Supervisor, Production Operator, Material Controller, QC Inspector, QC Supervisor, Management). Grants applied once; admins own them afterwards. Administrator always holds every key.
- Guards: never grant permissions you don't hold, last-active-administrator, no self-deactivation, no self-demotion.
- Audit log: append-only (MySQL triggers block UPDATE/DELETE), written inside the same transaction as the change, secrets scrubbed, previous/next values as diffs, device id captured from `X-Device-Id`.
- Document number sequences (BOM, PJO, JO, MRS, WIP, IQC, OQC, LBL) with row locking; yearly sequences restart each year.
- CLIs: `db:seed` (reference data, idempotent), `bootstrap:admin` (first admin only, one-time password), `db:seed:dev` (dev-only role test accounts).
- 28 backend tests (auth, CSRF, lockout, idle expiry, RBAC, guards, audit immutability, numbering, logging redaction, production config rules).

Frontend (`web/`)
- Sign-in, forced and voluntary password change.
- App shell: left sidebar with the exact TBS module/submenu names, filtered by permission; breadcrumbs; dark mode; phone layout (drawer menu).
- Users (search, filters, paging, sorting, create/edit, roles, reset password, activate/deactivate), Roles & Permissions (template/custom roles, permission editor with review step), Audit Trail (filters, detail with previous/new values).
- Menu pages of later phases render a plain "Not built yet – Phase N" page (no fake screens).
- Shared components: `PageHeader`, `DataTable` (server paging/sorting), `Dialog`, `Field`, `ConfirmDialog`, toasts, empty/error/loading states; colour tokens with light/dark themes.

## Phase 2 delivered – BOM (Father Code → Son Codes)

Structure: **Father Code** (artwork, label description, artwork revision,
status) → many **Son Codes** (component / material code and description,
optional required quantity and unit, remarks, status).

- **Father Code** generated from the `BOM` number sequence (`BOM-000001`).
  User inputs: artwork file + label description only.
- **Artwork upload:** PDF, AI, EPS, SVG, PNG, JPG; drag and drop; streamed to
  disk with a size cap (`ARTWORK_MAX_MB`, default 50); file type checked from
  the file's own bytes (a renamed file is refused); SHA-256 stored. Preview:
  PNG / JPG / SVG thumbnails (server-side), PDF and PDF-based AI in the
  browser's PDF viewer, EPS / old AI as download only. SVG is served in a
  sandbox. Uploads are previewed with duplicate warnings before saving;
  unattached uploads are purged by `housekeeping` after 24 h.
- **Artwork revisions** (`Rev 01`, `Rev 02`…): a new revision only when the file
  content (checksum) or the label description really changes (whitespace-only
  edits and identical re-uploads are ignored). Previous files stay
  downloadable. "Restore" copies an old revision forward as a new one.
- **Son Codes** (`BOM-000001-01`, `-02`…): added from the material list, several
  at once; description and unit filled from the material; never reused after
  removal. Same material twice in one BOM needs explicit confirmation
  (recorded in the audit). Removing = status REMOVED + new revision.
- **BOM component revisions:** every add / edit / remove / restore creates one
  new revision holding the full component list (snapshot with the material
  code and description as they were) plus the added / modified / removed
  diff. No-op edits create nothing. Artwork and component revisions are
  independent: changing one never changes the other.
- **Optimistic concurrency:** writes carry the revision the user saw; a stale
  write gets 409 "changed by someone else".
- **Immutability:** revision tables and component lines reject UPDATE / DELETE
  (DB triggers); Father Codes and Son Codes reject DELETE (status only).
- **Production integration:** `GET /boms/:id/production-snapshot` returns the
  exact Father Code, artwork revision id and component revision id a
  Production Job Order will store at release (inactive Father Codes refused).
  The Production Usage tab lists jobs once Phase 3 exists; until then it says
  so plainly.
- **Material reference list** (BOM › Materials tab): code (immutable,
  upper-case), description, unit, category, remarks, status. Renaming a
  material doesn't rewrite saved BOM revisions. Inactive materials can't be
  added.
- **Permissions:** `bom.view`, `bom.create`, `bom.edit` (label description),
  `bom.status`, `bom.artwork.upload`, `bom.artwork.revise` (restore),
  `bom.son.add`, `bom.son.edit`, `bom.son.remove`, `bom.revision.manage`
  (restore component list), `bom.material.manage`.
- **Audit:** Father Code created, artwork replaced, label description changed,
  artwork restored, Son Codes added / modified / removed, component revision
  restored, status changes, material changes — each with before / after
  values; shown on the Father Code's History tab.
- Tests: 21 BOM tests (upload validation, revisions, duplicates, diffs,
  concurrency, immutability, permissions, snapshot).

**Phase 2 assumptions to confirm**
- Son Code format `<Father Code>-NN` (system-generated). If TBS uses its own
  son item codes, tell us the format.
- Father Code format `BOM-000001`. The prefix is configurable
  (`number_sequences`) if the factory uses another pattern.
- Materials are kept in a local reference list until we know whether they
  should come from TBS (question below).
- Father Codes are deactivated, never deleted (even unused ones), so the
  numbering and audit stay continuous.

## Handheld shopfloor workflow delivered (Phase 3/4 slice)

Built from the "Revised handheld shopfloor workflow" brief. Decisions
confirmed by the business owner on 2026-11-20:
- **Work Order = TBS "Job Order"**: a Production Job Order (one Father Code,
  customer reference, order quantity) is split into Job Orders. Each Job
  Order has its own barcode (its number), quantity and process route.
- **Handheld = installable web app** at `/hh` (Android Chrome, home-screen
  install). Works with keyboard-wedge scanners; camera scanning as fallback
  (needs HTTPS). Can be wrapped as an APK later if scanner SDK intents are
  needed.

Operating principle: Job Order = production reference, machine barcode =
which machine, signed-in user = operator, **Check In = START WORK, Check Out =
END WORK**. WIP barcodes are not required.

Planning
- **Process**, **Machine Category** (which processes it can do + qualified
  operators), **Machine** (immutable code = barcode; printable Code 128 + QR
  label; operational status separate from active/inactive), **Handheld
  devices** (registered on first use, can be pinned to a machine by a
  supervisor).
- **Production Job Order**: Father Code picker; the current artwork and
  component revisions are re-snapshotted and frozen at release.
- **Job Order**: quantity limited to what's left on the PJO; route from a
  routine, chosen processes, or the Father Code's Production Routine (copied,
  so later routine edits don't change it); release / hold / cancel; explicit
  **completion confirmation** (never automatic; reason required when short of
  target); printable traveller with barcode; production journey view.

Shopfloor
- **Routine Master** (ordered process steps), **Production Routine Master**
  (Father Code → default routine).
- **Session engine** (`server/src/modules/shopfloor/session.service.ts`):
  Check In validates Job Order status, previous process (or authorised partial
  transfer), machine category supports the process, machine active and not in
  breakdown / maintenance / offline, no conflicting running session (machine
  or process, unless split authorised), operator qualified, quantity
  available, no pending machine change. Output entries and Check Out totals
  are checked against the authorised quantity; Check Out types Completed /
  Partial / Shift End / Machine Change / Machine Breakdown.
- **Quantities per route step**: target, authorised (= target, or the previous
  step's good output, + supervisor-authorised extra), good, reject,
  outstanding, available, taken by next process. Machine-level output (per
  session / output entry) is kept apart from process and Job Order totals and
  is never re-counted or moved on resume / machine change.
- **Breakdown**: ends the running session with the operator's latest totals,
  blocks the machine; maintenance start; release only with the confirmation
  that physical inspection and safety clearance were done (the system records
  it, it doesn't replace the factory procedure).
- **Machine change**: operators request, supervisors approve (requests by a
  user holding the approve permission apply at once); only the remaining
  quantity moves; history keeps previous machine output.
- **Idempotency**: every handheld write carries a client transaction id; a
  retry after a network drop returns the stored result. Writes use READ
  COMMITTED + row locks (machine → process) so simultaneous Check Ins can't
  both win.
- **Monitoring** (Machine Output Control): live machine board, output by
  machine / Job Order / process / operator, utilisation and breakdown downtime
  (calendar hours – no shift calendar yet), breakdown list with maintenance /
  release, machine change approvals. **WIP Check In/Check Out**: session
  history.
- Status families kept separate: machine (Available, Running, Idle,
  Breakdown, Maintenance, Offline), session (Running, Completed, Paused,
  Breakdown, Transferred, Closed), Job Order (Planned, Released, In Progress,
  Partially Completed, Completed, On Hold, Cancelled).
- Tests: `server/tests/shopfloor.test.ts` covers the 15 required scenarios
  plus planning rules (18 tests). Production outputs are append-only;
  sessions, breakdowns and machine changes are never deleted (DB triggers).

**Assumptions to confirm (handheld workflow)**
- One unit of measure per Job Order across all its processes (e.g. PCS). If
  printing is measured in metres and slitting in pieces, we need conversion
  rules (open question D).
- An operator may run sessions on several machines at once (not blocked).
- Operator authorisation is per machine category (qualified operators), not
  per individual machine.
- Badge login = the badge barcode is scanned into the username field, then the
  password. A badge-only (PIN) login needs a decision on PIN rules.
- Offline: no local drafts. A transaction that fails for lack of network stays
  on screen with "Retry (safe)"; nothing counts until the server confirms.
- Utilisation uses calendar hours until a shift calendar is defined.

## Product Master and Master Card delivered (2026-11-20)

Agreed design (interface demo approved): a **Product** is the label item the
customer orders and owns exactly one Father Code; a **Master Card revision** is
the approved bundle production runs from: one specification + one artwork
revision + one BOM (component) revision + routing + tooling references.

- **Where:** BOM › Products tab (menu names stay TBS) and the product page
  `/bom/products/:id` with tabs Master Card, Specification, BOM, Orders, History.
- **Product** (`products`): product code (usually the ERP item code; upper-case,
  immutable), name, customer, customer part no., unit, Father Code (unique),
  status (deactivate with a reason; never deleted).
- **Master Card** (`master_card_revisions`): one draft at a time, prefilled from
  the latest released revision, the Father Code's current artwork + BOM
  revisions and its Production Routine. "Use latest artwork + BOM" pulls newer
  Father Code revisions into the draft. Release needs label width, height,
  across, core, labels per roll, winding (positions 1–8) and a component list;
  the previous released revision becomes Superseded. Released / superseded
  revisions are frozen by database triggers; drafts can be discarded.
  Permissions `bom.product.manage` and `bom.mastercard.release`.
- **Production Job Orders:** for a Father Code that belongs to a product, PJO
  create, edit and release freeze the product's released Master Card (its
  artwork and BOM revision ids plus `master_card_revision_id`); without a
  released card, or with an inactive product, the PJO is refused. Father Codes
  without a product keep the earlier rule (current Father Code revisions). The
  PJO page shows the Master Card revision, a product link and "newer Master
  Card released" when applicable.
- Tests: `server/tests/products.test.ts` (5 tests).

**Assumptions to confirm (Product / Master Card)**
- Every Father Code that has a product must run from a released Master Card;
  Father Codes without a product still work as before so existing orders and
  data are untouched.
- Dies and plates are free-text references on the Master Card until a tooling
  master exists.
- Spec fields beyond the six required ones are optional; which are mandatory
  for your factory can be tightened later.

## Phase 3 / 4 completion delivered (2026-11-20)

- **Workflow audit – cancellation and closure** (2026-11-24): (1) cancelling a Job Order or order now cancels its MRS that never moved material (before, they stayed Open forever and counted as waiting for material); an MRS with material out stays open so it can be returned, and the dashboard shows "Material out on a cancelled job" until it is; (2) cancelling an order cancels and audits each Job Order (before: one bulk update, no Job Order audit, MRS untouched); (3) order completion is blocked while finished output is still in OQC (in inspection / on hold), and warns for rework not yet reinspected; (4) MRS list filter `activeJob=1` (live Job Orders), used by the dashboard. Open decisions: Check In before material is issued (currently allowed, dashboard alert only); whether OQC is mandatory before an order can close (currently not); material variance vs the Master Card QPA at closure (not computed yet).
- **Operational dashboard** (2026-11-24, user request): the "All modules" shortcuts are gone (sidebar unchanged). Filters: period (today / 7 / 30 days) and process. KPIs (active orders, Job Orders ready / in progress / completed in the period / overdue, MRS waiting, active WIP steps, QC lots pending) open the matching filtered lists. Sections: alerts & pending actions (breakdowns, overdue or soon-due Job Orders not started, orders without Job Orders, production running without full material, failed lots on hold, pending machine changes, sessions open since a previous day, Job Orders with every step done but not confirmed), production progress by unit, production schedule (sortable), machines with current session / operator / last output / breakdown, good output per day, WIP (running / waiting / paused), material movements, IQC / OQC results for the period, recent activity, and "My work" for operators. Audit fixes: plant-day comparison of required dates (was off by a day in UTC+8); Job Order / PJO / MRS status filters validated (an invalid value used to be a server error). Not available as data (so not shown): pending additional-issue requests (additional issue is a direct transaction), WMS stock availability (Location Qty is manual).
- **Document templates + dashboard polish** (2026-11-24, user request): System › **Document Templates** lets users design every printed document – Production Job Order, Job Order traveller, Material Requisition Sheet, Master Card, IQC and OQC reports – with a live preview: paper size / orientation / margins / text size / colour, header (company letterhead with logo, title, subtitle, document no., date, barcode, every page or first page only), content sections (show / hide, order, titles, table columns and their order), notes / declaration, up to 4 signature boxes and a three-part footer with fill-ins and page x of y. Each detail page has **Print** (any printer or Save as PDF) and **Download PDF**; the template is chosen per print (default preselected). Tables `document_templates` (one default per document, audited) and `document_settings` (letterhead); permission `system.documents.manage`. The **Dashboard** now shows live figures from transactions (orders overdue / due, Job Orders running / on hold, machines, breakdowns, MRS to issue, IQC / OQC lots), a "Needs attention" list, orders by required date, good output for 7 days, machine status and 30-day first-pass rates, a quick find across PJO / Job Order / MRS / Father Code / Master Card / part / inspection, and compact guided flows and module links. Covered by `server/tests/documents.test.ts`.
- **Complete onboarding + handheld Quality** (2026-11-24, user request): the sidebar highlights only the most specific menu item (Master Card no longer lights up Bill of Material). **Product onboarding** now captures every field each record needs: Artwork → Son Codes (BOM qty + Manual QPA) → Part (code, NMI No., UOM, source, category / group, specification, cartons per pallet) → Customer (Master Card header + full AFRF-CS with the printing-direction picker) → Label (label, print & finishing, delivery, tooling) → Material & process (die + Die Cut Spec, routing + Process Detail per step: machine category, default machine, setup, output / press, no. of print, speed) → Review → Done. The part's engineering data (label W × H, pcs per roll, rolls per pack) is copied from the card. **Handheld Quality** runs in handheld format (`handheld-quality.tsx`): `/hh/qc/iqc` (scan part → lot → Check In → Pass/Fail and measure tiles, defect counters, reject qty → Check Out → PASS/FAIL + disposition → store into a location → done) and `/hh/qc/oqc` (offer a Job Order by scan / list, or open a waiting lot → inspect → decide). Handheld functions never open desktop pages.
- **More journeys + handheld modules** (2026-11-24): **IQC receiving** (`/qc/iqc-check-in-out/receive`: Lot → Check In → Inspect → Check Out → Decide/disposition → Store into Location Qty → Done), **Issue material** (`/planning/material-requisition-sheet/issue`: pick MRS → qty + lot per line, lots suggested from Location Qty → Done), **Finish order** (`/planning/production-job-order/:id/finish`: Job Orders → OQC → labels → close, each step green from live data), **New part** (`/master-data/part-master/new`: Type → General → Technical (by category kind) → Shipping & IQC → Review → Done). Handheld home is modules first (Production blue, Material amber, Quality green) with functions inside each module and a coloured module band on every screen (`handheld-home.tsx`).
- **Guided journeys** (2026-11-24, user request): a reusable step bar (`components/journey.tsx`) shows each create flow from start to end. **New Production Job Order** (`/planning/production-job-order/new`): Product → Order → Job Orders (split, route from the Master Card) → Material (MRS per Job Order = Master Card QPA × quantity, rounded up) → Review (release order / Job Orders / raise MRS, or keep draft) → Done (what was created + next steps on the floor). **Product onboarding** (`/bom/new-product`, from BOM › Master Card › New Master Card and Bill of Material › New product): Artwork (new Father Code or one without a part) → Son Codes → finished-good part → Master Card essentials (customer, size, across, core, labels per roll, printing direction, die, routing) → Review (release when complete) → Done. Records are created through the normal APIs in order; a failure part-way lists what was created. Covered by `server/tests/onboarding-flow.test.ts`.
- **Menu clean-up** (2026-11-24, user request – no two menu items open the same page): BOM module = Bill of Material + Master Card (own list and page; the Father Code page links to it). MRS Additional Issued, MRS Return, MRS Reject and Scrap Bad Material are one menu item, Planning › Material Movement, with the four as tabs (visible with any of their permissions; old URLs redirect). Production Order Complete Utility left the menu (orders complete from the PJO page; its check page stays). The Master Card draft form is split into six steps with error markers and a sticky Save / Next bar.
- **Part Master and Master Card per TBS** (2026-11-24, user confirmed): Part Master holds every item (raw material, packaging, finished good) with the TBS sections – General (part code, Artwork No., description, specification, group, category, UOM, source, NMI No., revision no. / date revised raised automatically by technical changes, ID / date update), Engineering (pcs per roll / sheet, roll / pcs per pack, carton per pallet, material type, H × W × L, decision cost, tariff code), Shipping (reorder level / qty, max qty, lead time, over-receive tolerance, custom code, obsolete + date + by, Require IQC, control point), UOM Conversion, Others (image, remark) and Location Qty (warehouse, location, shelf, lot, DO hold qty, qty). Stock fields are keyed in by hand until the WMS / sales / purchase integration (user decision). The former Product is now the finished-good part: its Artwork No. (Father Code) carries the Master Card, shown as a tab of the Father Code page. NMI No. is the same on the part and the card. Master Card sections: header (NMI, part code, artwork no., H × W, customer code, customer part code, end user, prepared / approved by), AFRF-CS, Material Spec (BOM detail with width / length / height / Manual QPA, Die Cut Spec with die code, feed length, sample count, feed / actual UPS) and Process Detail (per routine step: machine category, default machine, setup, output per press, no. of print, speed + UOM; printing machine list). **QPA is calculated and the formula is shown in the UI** (user request, to check with the client): m² parts = width × feed length ÷ actual UPS ÷ 1,000,000; m parts = feed length ÷ actual UPS ÷ 1,000; cores = 1 ÷ labels per roll; packaging = 1 ÷ (labels per roll × rolls per carton); other units = BOM quantity; Manual QPA overrides; no waste allowance yet. Release needs a QPA for every Son Code. Released cards copy customer code / part code to the part's card holder (used by labels).
- **Part and die masters** (2026-11-23, user request): Part Master = the former Material list (same `materials` table, so Son Codes and the MRS keep working) with Part Category (code, name, kind) and Part Group (inside one category) masters, and optional label-industry specs: stock form, width mm, roll length m, thickness µm, gsm, face / finish, adhesive, liner, core ID mm, colour / Pantone, ink-varnish-ribbon-plate system, supplier + supplier part no., shelf life days, certifications. Which specs show depends on the category kind (assumption, configurable in `PART_KIND_FIELDS`). The old free-text material category was migrated into Part Category rows (kind Other). Die Cut Master: die no., type (rotary solid / flexible / flatbed), cut (kiss / through / perforation), shape, label width × height, corner radius, across × around, gaps, gear teeth + repeat (1/8" circular pitch = 3.175 mm per tooth; repeat derived from the teeth when not given; labels around must fit the repeat; rotary dies need teeth or repeat), condition, location, supplier; retired with a reason, never deleted. No stock, cost or die-impression counting. Not yet linked: Master Card ↔ die (follow-up).
- **Module merges** (2026-11-23, user approved): (1) Production Routine Master retired — the routine is set only on the Master Card; a new Job Order with no route given uses the routine on its PJO's frozen Master Card (Father Codes without a product pick a routine or processes). The `production_routines` table is kept, unused. (2) Orders are completed from the Production Job Order detail page (Completion card: checks, override, note); the Production Order Complete Utility menu opens the In Progress orders, and its check page stays at `/planning/production-order-complete-utility/:id`. (3) BOM page: one Father Code list with the owning product and Master Card status (filter with / without product, search by product or customer); the Products tab is gone. (4) MRS Additional Issued, MRS Return, MRS Reject and Scrap Bad Material are tabs of one Material Movement register (shared search and date range, plus "All movements").
- **Master Data module** (2026-11-23, user request): Material (moved from the BOM page tab), Process, Machine Category, Machine (+ handheld devices), Routine Master, Production Routine Master, Reason Code (new page; replaces the Reasons tab on MRS Additional Issued / MRS Reject / Scrap Bad Material) and Defect Master (Phase 5) are grouped under one menu. TBS menu names unchanged; old URLs redirect.
- **Pre-Plan**: removed on 2026-11-23 at the user's request. Jobs go straight from the Production Job Order to Daily Job Information. The `schedule_entries` table stays in the database (unused) so no history is lost.
- **Daily Job Information**: Job Orders pulled straight from released Production Job Orders, in three sections. Planned: Job Order of a released PJO with no production session yet (planned date, late / today flag, material readiness). In Progress: has a session and is not completed (current step and machine, steps done, output recorded on the selected day, running / paused / on hold). Completed: Job Orders confirmed complete on the selected day (finished vs ordered). The Production Job Order list uses the same three sections: Planned = draft, or released with no production yet; In Progress = released with production started; Completed = closed or cancelled.
- **Material Requisition Sheet** (`material_requisitions` + `mrs_lines`): per Job Order; lines only from the BOM revision frozen on its released PJO; the planner enters the requested quantity (BOM quantity basis not confirmed). Statuses Open → Partly issued → Issued, Closed (by order completion), Cancelled (only before any movement, reason required).
- **Material movements** (`material_transactions`, append-only triggers, own number per type: ISS, MAI, MRR, MRJ, SCR): issue limited to the requested quantity; **MRS Additional Issued** only after the request is fully issued, reason required; **MRS Return**, **MRS Reject** (reason) and **Scrap Bad Material** (reason, optional machine and process of that Job Order) never exceed what is still out on the line. Issue refused while the Job Order is on hold. Every movement carries a client transaction id: a retried scan returns the stored result instead of counting twice. Running totals on the MRS line are updated in the same transaction.
- **Reason codes** (`reason_codes`, per movement type, code immutable, deactivate only): maintained on the Reasons tab of each register; none are shipped (new permission `planning.reason.manage`).
- **Production Order Complete Utility**: closes a released PJO. Blockers: Job Orders not completed / cancelled, running sessions, no completed Job Order. Warnings: output short of the order quantity, MRS not (fully) issued; completing with warnings needs `planning.completion.override` and a reason. Completion closes the order's open MRS (no more material moves) and is audited.
- Tests: `server/tests/planning-material.test.ts` (8 tests).

**Assumptions to confirm (Phase 3 / 4 completion)**
- Additional issue needs no separate approval step: holding `planning.mrs.additional` is the authority, and the reason is recorded. If the factory wants request → approve, it can be added.
- Return / reject / scrap are recorded against an MRS line (material that was issued). Scrap of material that was never issued is not supported.
- Actual consumption per roll is not recorded; "net to production" = issued + additional − returned − rejected − scrapped.
- Material movements are desktop screens; handheld scanning screens for issue / return can follow once scanner use at the store is confirmed.
- Corrections of a wrong movement: not built yet (append-only means a reversing movement type is needed).

## Business rules that need confirmation

The brief says not to invent these. Until answered, later phases are designed
to be configurable and the assumption is recorded here.

**Product ↔ Father Code** – **answered 2026-11-20**: one Father Code belongs to
exactly one product. The same artwork is never shared by two products; a
different product (e.g. another roll format) gets its own Father Code. So the
product specification can live with the product / Master Card without a
separate many-to-many link. Product Master / Master Card is built (see below).

**A. Production Job Order vs Job Order** – **answered 2026-11-20**: the Job
Order is the Work Order, a child of the Production Job Order.

**B. WIP identification** – the handheld brief makes the Job Order the
production reference and WIP barcodes optional. Still open: whether any
process needs roll / batch identification (then it becomes an optional scan).

**C. IQC / OQC on handheld or desktop** (shapes Phase 5 screens)
Which inspections happen at the machine or receiving bay with a handheld,
and which at a desk? Do "Check In / Check Out" mean physical movement into and
out of a QC area, or the start and end of an inspection?
*Built on these assumptions (2026-11-23, change if TBS differs):* Check In =
the lot goes on QC hold (IQC: a received part lot; OQC: finished output of a
Job Order); Check Out = results recorded, the lot is released (PASS) or held
for a QC supervisor's disposition (FAIL). Screens are responsive desktop
pages that also work on a phone / tablet; no separate handheld flow yet.
Result = FAIL when any check fails, any reject quantity is recorded, or a
CRITICAL defect is found. IQC dispositions: use as is / reject / return to
supplier; OQC: use as is / reject / rework (then one reinspection). Material
issue does not yet check the lot's IQC status (follow-up). Shipping labels
print through the browser (PDF / any printer) until the printer language is
known.

**D. Units and quantity rules** (blocks Phase 3 and 4)
Units actually used per process (pieces, rolls, metres, running metres,
sheets, kg)? Conversion rules (e.g. labels per metre from the artwork
repeat)? *Design:* unit of measure per transaction line, no single global unit.

**Also needed before Phase 3 / 4**
- **Material master source.** Son Codes (and later MRS) need material codes and
  descriptions, but general inventory is out of scope. Phase 2 added a minimal
  local list (BOM › Materials). Keep maintaining it here, import it once from
  TBS (CSV), or sync it from TBS regularly (database view / API)?
- **Customer / product reference** on the PJO: typed in, or taken from an
  existing source?
- **MRS issue limits:** may issued quantity exceed requested quantity? By how
  much, and who may approve it?
- **Shifts:** shift names and times, if output is reported per shift.
- **Handheld hardware:** scanner model / OS (Android keyboard-wedge scanners
  such as Zebra or Honeywell, or phones with camera scanning), and whether the
  floor Wi-Fi is reliable enough to skip offline mode.
- **Label printers:** printer model and language (ZPL, TSPL, or normal PDF
  printing), label sizes.
- **TBS reference material:** any screenshots, user manual or report samples of
  the current TBS Manufacturing screens, so names and field order can match.

## Assumptions made in Phase 1

- Single company, single site, no multi-tenancy.
- Users sign in with a username (often the employee number); e-mail optional.
  No e-mail delivery: forgotten passwords are reset by an administrator.
- Timestamps stored in UTC; shown in the browser's locale (en-MY format).
- Local development uses a native MySQL 8.4 Windows service
  (`LabelMES-MySQL`); `docker-compose.yml` is kept as an alternative.
