import {
  Boxes,
  ClipboardCheck,
  Database,
  Factory,
  FileImage,
  LayoutDashboard,
  ShieldCheck,
  type LucideIcon,
} from "lucide-react";

/**
 * Menu structure - follows the TBS ERP Manufacturing module exactly
 * (BOM -> Planning -> Shopfloor -> QC). Do not rename these menu items.
 * Master data lists live together in the Master Data module (user request,
 * 2026-11-23); their TBS menu names are unchanged.
 * Routes, breadcrumbs and the sidebar are generated from this list.
 *
 * `phase` = the development phase that builds the page. Until that phase is
 * done the page says plainly that it isn't built yet (no fake screens).
 * `permission` = the key needed to see the menu item.
 */
export interface NavPage {
  id: string;
  label: string;
  path: string;
  permission: string;
  /** Visible with any of these keys (overrides `permission` when set). */
  anyPermission?: string[];
  phase: number;
  /** Built and working in this release. */
  built?: boolean;
  summary: string;
}

export interface NavModule {
  id: string;
  label: string;
  icon: LucideIcon;
  pages: NavPage[];
  /** Supporting area, shown under the four business modules. */
  supporting?: boolean;
}

export const NAV_MODULES: NavModule[] = [
  {
    id: "bom",
    label: "BOM",
    icon: FileImage,
    pages: [
      { id: "bom", label: "Bill of Material", path: "/bom", permission: "bom.view", phase: 2, built: true, summary: "Father Code (artwork + label description) with its Son Code component list, revision controlled." },
      { id: "master-card", label: "Master Card", path: "/bom/master-card", permission: "bom.view", phase: 2, built: true, summary: "Engineering card of each finished-good part: header, AFRF-CS, specification, material spec with QPA, process detail; revisioned and released for production." },
    ],
  },
  {
    id: "planning",
    label: "Planning",
    icon: Boxes,
    pages: [
      { id: "production-job-order", label: "Production Job Order", path: "/planning/production-job-order", permission: "planning.pjo.view", phase: 3, built: true, summary: "Create, release and track Production Job Orders with their BOM revision." },
      { id: "job-order", label: "Job Order", path: "/planning/job-order", permission: "planning.jo.view", phase: 3, built: true, summary: "Job Orders (Work Orders): the shopfloor production reference with quantity, barcode and process route." },
      { id: "daily-job-information", label: "Daily Job Information", path: "/planning/daily-job-information", permission: "planning.daily.view", phase: 3, built: true, summary: "Job Orders from released Production Job Orders: planned, in progress and completed on the day." },
      { id: "material-requisition-sheet", label: "Material Requisition Sheet", path: "/planning/material-requisition-sheet", permission: "planning.mrs.view", phase: 3, built: true, summary: "Material issued to production jobs, with lot / roll references and balances." },
      { id: "material-movement", label: "Material Movement", path: "/planning/material-movement", permission: "planning.mrs.view", anyPermission: ["planning.mrs.view", "shopfloor.mrs.return", "shopfloor.mrs.reject", "shopfloor.scrap.record"], phase: 3, built: true, summary: "MRS Additional Issued, MRS Return, MRS Reject and Scrap Bad Material in one register (tabs)." },
    ],
  },
  {
    id: "shopfloor",
    label: "Shopfloor",
    icon: Factory,
    pages: [
      { id: "machine-output-control", label: "Machine Output Control", path: "/shopfloor/machine-output-control", permission: "shopfloor.output.view", phase: 4, built: true, summary: "Machine dashboards, machine-wise / Job Order-wise output, utilisation, breakdowns and machine changes." },
      { id: "wip-check-in-out", label: "WIP Check In/Check Out", path: "/shopfloor/wip-check-in-out", permission: "shopfloor.wip.view", phase: 4, built: true, summary: "Check In (start work) / Check Out (end work) history from the handheld." },
    ],
  },
  {
    id: "qc",
    label: "QC",
    icon: ClipboardCheck,
    pages: [
      { id: "iqc-check-in-out", label: "IQC Check In/Check Out", path: "/qc/iqc-check-in-out", permission: "qc.iqc.view", phase: 5, built: true, summary: "Incoming part lots on QC hold, inspected with templates and defects, released or held for a disposition." },
      { id: "oqc-check-in-out", label: "OQC Check In/Check Out", path: "/qc/oqc-check-in-out", permission: "qc.oqc.view", phase: 5, built: true, summary: "Finished output inspection, sampling or full, with dispositions and reinspection after rework." },
      { id: "shipping-label", label: "Shipping Label", path: "/qc/shipping-label", permission: "qc.label.view", phase: 5, built: true, summary: "Carton labels from released OQC lots: templates, print, audited reprint and void." },
    ],
  },
  {
    id: "master-data",
    label: "Master Data",
    icon: Database,
    supporting: true,
    pages: [
      { id: "part-master", label: "Part Master", path: "/master-data/part-master", permission: "bom.view", phase: 2, built: true, summary: "Parts production uses (label stock, film, ink, varnish, foil, ribbon, core…) with category, group and specifications. Son Codes pick from here." },
      { id: "part-group-master", label: "Part Group Master", path: "/master-data/part-group-master", permission: "bom.view", phase: 2, built: true, summary: "Groups inside a part category, e.g. PP white gloss under Label stock." },
      { id: "part-category-master", label: "Part Category Master", path: "/master-data/part-category-master", permission: "bom.view", phase: 2, built: true, summary: "Part categories and their kind, which decides the specification fields." },
      { id: "die-cut-master", label: "Die Cut Master", path: "/master-data/die-cut-master", permission: "planning.master.view", phase: 3, built: true, summary: "Cutting dies: label size and shape, across × around, rotary repeat, condition and location." },
      { id: "process", label: "Process", path: "/master-data/process", permission: "planning.master.view", phase: 3, built: true, summary: "Process master (printing, lamination, die cutting, slitting...)." },
      { id: "machine-category", label: "Machine Category", path: "/master-data/machine-category", permission: "planning.master.view", phase: 3, built: true, summary: "Machine category master and the processes each category can do." },
      { id: "machine", label: "Machine", path: "/master-data/machine", permission: "planning.master.view", phase: 3, built: true, summary: "Machine master and handheld devices." },
      { id: "routine-master", label: "Routine Master", path: "/master-data/routine-master", permission: "shopfloor.routine.view", phase: 4, built: true, summary: "Standard process routes. Each product's Master Card picks its routine from here." },
      { id: "reason-code", label: "Reason Code", path: "/master-data/reason-code", permission: "planning.mrs.view", phase: 3, built: true, summary: "Reasons for additional issue, material reject and scrap." },
      { id: "defect-master", label: "Defect Master", path: "/master-data/defect-master", permission: "qc.defect.view", phase: 5, built: true, summary: "Central defect codes shared by Shopfloor and QC." },
      { id: "inspection-template", label: "Inspection Template", path: "/master-data/inspection-template", permission: "qc.iqc.view", phase: 5, built: true, summary: "IQC / OQC checks: pass / fail and measurements with limits; IQC defaults per part category." },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: ShieldCheck,
    supporting: true,
    pages: [
      { id: "users", label: "Users", path: "/system/users", permission: "system.users.view", phase: 1, built: true, summary: "User accounts, role assignment and password resets." },
      { id: "roles", label: "Roles & Permissions", path: "/system/roles", permission: "system.roles.view", phase: 1, built: true, summary: "Role templates and configurable permissions." },
      { id: "document-templates", label: "Document Templates", path: "/system/document-templates", permission: "system.documents.manage", phase: 1, built: true, summary: "Design every printed document (Job Order, MRS, Master Card, QC reports…): letterhead, header, content sections, footer and signatures; print or PDF." },
      { id: "audit", label: "Audit Trail", path: "/system/audit", permission: "system.audit.view", phase: 1, built: true, summary: "Append-only record of sensitive actions." },
    ],
  },
];

/** Whether a page is visible to someone with these checks. */
export const canSeePage = (page: NavPage, can: (key: string) => boolean) => (page.anyPermission ? page.anyPermission.some(can) : can(page.permission));

export const DASHBOARD = { label: "Dashboard", path: "/", icon: LayoutDashboard };

export const PHASE_NAMES: Record<number, string> = {
  1: "Phase 1 – System Foundation",
  2: "Phase 2 – BOM",
  3: "Phase 3 – Planning",
  4: "Phase 4 – Shopfloor",
  5: "Phase 5 – QC",
  6: "Phase 6 – Integration and Reporting",
};

/** Module + page for a pathname (most specific match). */
export function locateNav(pathname: string) {
  let best: { module: NavModule; page: NavPage } | null = null;
  for (const module of NAV_MODULES) {
    for (const page of module.pages) {
      if (pathname === page.path || pathname.startsWith(page.path + "/")) {
        if (!best || page.path.length > best.page.path.length) best = { module, page };
      }
    }
  }
  return best;
}
