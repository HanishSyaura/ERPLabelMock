# Label MES – Label printing Manufacturing ERP

Manufacturing module for a label printing plant, aligned with the TBS ERP
Manufacturing structure: **BOM → Planning → Shopfloor → QC**.

Status: **Phases 1–5 complete (System Foundation, BOM, Planning, Shopfloor,
QC)**; Phase 6 (integration and reporting) not started. QC covers IQC and OQC
Check In / Check Out, dispositions, reinspection and Shipping Label. Planning covers Production Job Order, Job Order,
Daily Job Information (Planned / In Progress / Completed), MRS, MRS Additional Issued and the Production
Order Complete Utility; Shopfloor covers routines, Check In / Check Out,
breakdown, machine change, monitoring, MRS Return, MRS Reject and Scrap Bad
Material.

Handheld app: `/hh` (open on the Android handheld in Chrome and use "Add to
Home screen"). Camera scanning needs HTTPS; keyboard-wedge scanners work over
plain HTTP on the LAN. Plan, open business
questions and assumptions: [docs/DEVELOPMENT_PLAN.md](docs/DEVELOPMENT_PLAN.md).

## Layout

```
server/   Express 5 + Prisma 7 + MySQL API  (/api/v1)
web/      React 19 + Vite + Tailwind 4 UI
docs/     Plan, database design
```

## First-time setup (Windows, local development)

1. **MySQL 8.4** on `127.0.0.1:3306` with databases `label_mes_dev` and
   `label_mes_test` and a `label_mes` user. On this machine it is the Windows
   service `LabelMES-MySQL` (data in `%LOCALAPPDATA%\label-mes-mysql`).
   Docker alternative: `npm run db:docker:up` (uses `docker-compose.yml`).
2. `npm install`
3. `copy server\.env.example server\.env` and fill in `DATABASE_URL`,
   `TEST_DATABASE_URL`, a random `PASSWORD_PEPPER` (32+ characters) and, for
   development, `DEV_ACCOUNT_PASSWORD`.
4. `npm --workspace server run db:migrate:dev` – creates the tables.
5. Either the first real administrator:
   `npm --workspace server run bootstrap:admin -- --username admin --name "System Administrator"`
   (prints a one-time password), or the development role accounts:
   `npm --workspace server run db:seed:dev` (`dev.admin`, `dev.planner`,
   `dev.supervisor`, `dev.operator`, `dev.material`, `dev.qc`,
   `dev.qcsupervisor`, `dev.management`; password = `DEV_ACCOUNT_PASSWORD`).
6. Optional demo data for every module: `npm --workspace server run db:seed:demo`
   (dev / test databases only; goes through the API, safe to run again).

## Running

```bash
npm run dev:server   # API on http://127.0.0.1:3000/api/v1
npm run dev          # UI on http://127.0.0.1:5173 (proxies /api)
```

## Checks (run before declaring work done)

```bash
npm run typecheck
npm test             # backend tests against label_mes_test
npm run build
```

## Production notes

- `NODE_ENV=production` refuses to start with `COOKIE_SECURE=false` or a
  placeholder pepper.
- Apply migrations with `npm --workspace server run db:migrate:deploy`, then
  `npm --workspace server run db:seed` (idempotent reference data).
- Serve `web/dist` and proxy `/api` to the API on the same origin.
- Back up the database and `UPLOAD_DIR` (artwork files) together.
- Schedule `npm --workspace server run housekeeping` daily (old sessions,
  abandoned uploads).
"# ERPLabelMock" 
