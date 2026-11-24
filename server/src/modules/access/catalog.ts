/**
 * Permission catalog - the single list of capabilities. Every route checks a
 * key from here; nothing checks role names. The seed mirrors this list into
 * the `permissions` table and creates the suggested role templates, which
 * administrators may then change (except the Administrator role, which always
 * holds every key).
 *
 * Keys are added per phase. A key for a function that is not built yet is
 * still listed so roles can be prepared, and its menu says "not built yet".
 */
export type ModuleKey = "system" | "bom" | "planning" | "shopfloor" | "qc" | "reports";

export interface PermissionDef {
  key: string;
  module: ModuleKey;
  area: string;
  description: string;
}

const p = (module: ModuleKey, area: string, key: string, description: string): PermissionDef => ({
  key,
  module,
  area,
  description,
});

export const PERMISSIONS: readonly PermissionDef[] = [
  // System administration (supporting function, not a business module)
  p("system", "Users", "system.users.view", "View user accounts"),
  p("system", "Users", "system.users.manage", "Create, edit, deactivate users and reset passwords"),
  p("system", "Roles", "system.roles.view", "View roles and their permissions"),
  p("system", "Roles", "system.roles.manage", "Create and edit roles and assign permissions"),
  p("system", "Audit", "system.audit.view", "View the audit trail"),
  p("system", "Documents", "system.documents.manage", "Design printed document templates (header, content, footer) and the company letterhead"),

  // A. BOM (Father Code -> Son Codes)
  p("bom", "Father Code", "bom.view", "View Father Codes, artwork, Son Codes and revision history"),
  p("bom", "Father Code", "bom.create", "Create Father Codes"),
  p("bom", "Father Code", "bom.edit", "Edit the label description (creates an artwork revision)"),
  p("bom", "Father Code", "bom.status", "Activate / deactivate Father Codes"),
  p("bom", "Artwork", "bom.artwork.upload", "Upload and replace artwork (creates an artwork revision)"),
  p("bom", "Artwork", "bom.artwork.revise", "Manage artwork revisions (restore a previous artwork revision)"),
  p("bom", "Son Code", "bom.son.add", "Add Son Codes"),
  p("bom", "Son Code", "bom.son.edit", "Edit Son Codes"),
  p("bom", "Son Code", "bom.son.remove", "Remove Son Codes"),
  p("bom", "Son Code", "bom.revision.manage", "Manage BOM component revisions (restore a previous component list)"),
  p("bom", "Product", "bom.product.manage", "Create and edit products and Master Card drafts"),
  p("bom", "Product", "bom.mastercard.release", "Release Master Card revisions (production uses them)"),
  p("bom", "Material", "bom.material.manage", "Maintain the material reference list used by Son Codes"),

  // B. Planning
  p("planning", "Production Job Order", "planning.pjo.view", "View Production Job Orders"),
  p("planning", "Production Job Order", "planning.pjo.create", "Create and edit Production Job Orders"),
  p("planning", "Production Job Order", "planning.pjo.release", "Release Production Job Orders"),
  p("planning", "Job Order", "planning.jo.view", "View Job Orders"),
  p("planning", "Job Order", "planning.jo.create", "Create and edit Job Orders"),
  p("planning", "Job Order", "planning.jo.release", "Release, hold and cancel Job Orders"),
  p("planning", "Job Order", "planning.jo.complete", "Confirm Job Order (Work Order) completion"),
  p("planning", "Daily Job Information", "planning.daily.view", "View Daily Job Information"),
  p("planning", "Material Requisition Sheet", "planning.mrs.view", "View Material Requisition Sheets"),
  p("planning", "Material Requisition Sheet", "planning.mrs.issue", "Create MRS and issue material"),
  p("planning", "MRS Additional Issued", "planning.mrs.additional", "Issue additional material"),
  p("planning", "Production Order Complete Utility", "planning.completion.complete", "Complete production orders"),
  p("planning", "Production Order Complete Utility", "planning.completion.override", "Complete with authorised exceptions (override)"),
  p("planning", "Reason Codes", "planning.reason.manage", "Maintain reasons for additional issue, reject and scrap"),
  p("planning", "Masters", "planning.master.view", "View Machine, Machine Category and Process"),
  p("planning", "Masters", "planning.master.manage", "Maintain Machine, Machine Category and Process"),

  // C. Shopfloor
  p("shopfloor", "Routines", "shopfloor.routine.view", "View Routine and Production Routine Masters"),
  p("shopfloor", "Routines", "shopfloor.routine.manage", "Maintain Routine and Production Routine Masters"),
  p("shopfloor", "Machine Output Control", "shopfloor.output.view", "View machine dashboards, output, utilisation and downtime"),
  p("shopfloor", "Check In / Check Out", "shopfloor.output.record", "Check In (start work), record output and Check Out (end work)"),
  p("shopfloor", "Check In / Check Out", "shopfloor.wip.view", "View Check In / Check Out history and Work Order journeys"),
  p("shopfloor", "Check In / Check Out", "shopfloor.session.supervise", "Record output or Check Out on another operator's session"),
  p("shopfloor", "Check In / Check Out", "shopfloor.machine.any", "Operate any machine without a category qualification"),
  p("shopfloor", "Check In / Check Out", "shopfloor.process.authorize", "Authorise partial transfer, split production and extra quantity"),
  p("shopfloor", "Machine Breakdown", "shopfloor.breakdown.report", "Report machine breakdown"),
  p("shopfloor", "Machine Breakdown", "shopfloor.breakdown.release", "Set maintenance / release machines after breakdown or maintenance"),
  p("shopfloor", "Machine Change", "shopfloor.machine.change", "Request a machine change"),
  p("shopfloor", "Machine Change", "shopfloor.machine.change.approve", "Approve machine changes (own requests apply immediately)"),
  p("shopfloor", "Handheld", "shopfloor.device.manage", "Assign handheld devices to machines"),
  p("shopfloor", "Material", "shopfloor.mrs.return", "MRS Return"),
  p("shopfloor", "Material", "shopfloor.mrs.reject", "MRS Reject"),
  p("shopfloor", "Material", "shopfloor.scrap.record", "Scrap Bad Material"),
  p("shopfloor", "Handheld", "shopfloor.handheld", "Use the handheld scanning screens"),

  // D. QC
  p("qc", "IQC", "qc.iqc.view", "View IQC inspections"),
  p("qc", "IQC", "qc.iqc.inspect", "Record IQC inspections"),
  p("qc", "IQC", "qc.iqc.disposition", "Approve IQC dispositions (release held / rejected material)"),
  p("qc", "OQC", "qc.oqc.view", "View OQC inspections"),
  p("qc", "OQC", "qc.oqc.inspect", "Record OQC inspections"),
  p("qc", "OQC", "qc.oqc.disposition", "Approve OQC dispositions"),
  p("qc", "Inspection Templates", "qc.template.manage", "Maintain inspection templates"),
  p("qc", "Shipping Label", "qc.label.view", "View labels and label templates"),
  p("qc", "Shipping Label", "qc.label.generate", "Generate and print labels"),
  p("qc", "Shipping Label", "qc.label.reprint", "Reprint labels"),
  p("qc", "Shipping Label", "qc.label.template.manage", "Maintain label templates"),
  p("qc", "Defect Master", "qc.defect.view", "View the Defect Master"),
  p("qc", "Defect Master", "qc.defect.manage", "Maintain the Defect Master"),

  // Reports & dashboards (Phase 6)
  p("reports", "Reports", "reports.view", "View dashboards and reports"),
  p("reports", "Reports", "reports.export", "Export reports (Excel / CSV / PDF)"),
];

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((x) => x.key));

const all = (prefix: string) => PERMISSIONS.filter((x) => x.key.startsWith(prefix)).map((x) => x.key);
const views = PERMISSIONS.filter((x) => /\.view$/.test(x.key) && x.module !== "system").map((x) => x.key);

export interface RoleTemplate {
  code: string;
  name: string;
  description: string;
  permissions: string[];
}

export const ADMIN_ROLE_CODE = "ADMINISTRATOR";

/**
 * Suggested role templates from the brief (section 12). Granted once when the
 * role is first created; after that administrators own the grants.
 */
export const ROLE_TEMPLATES: readonly RoleTemplate[] = [
  {
    code: ADMIN_ROLE_CODE,
    name: "Administrator",
    description: "Full access, including users, roles and audit.",
    permissions: PERMISSIONS.map((x) => x.key),
  },
  {
    code: "PRODUCTION_PLANNER",
    name: "Production Planner",
    description: "BOM and Planning: job orders, daily job information, MRS, planning masters.",
    permissions: [...views, ...all("bom."), ...all("planning."), "reports.export"].filter(
      (k) => k !== "planning.completion.override",
    ),
  },
  {
    code: "PRODUCTION_SUPERVISOR",
    name: "Production Supervisor",
    description: "Shopfloor supervision, routines, exceptions and order completion.",
    permissions: [
      ...views,
      ...all("shopfloor."),
      "planning.jo.release",
      "planning.jo.complete",
      "planning.reason.manage",
      "planning.completion.complete",
      "planning.completion.override",
      "reports.export",
    ],
  },
  {
    code: "PRODUCTION_OPERATOR",
    name: "Production Operator",
    description: "Handheld shopfloor transactions only.",
    permissions: [
      "shopfloor.handheld",
      "shopfloor.output.record",
      "shopfloor.breakdown.report",
      "shopfloor.machine.change",
      "shopfloor.scrap.record",
      "planning.jo.view",
      "bom.view",
    ],
  },
  {
    code: "MATERIAL_CONTROLLER",
    name: "Material Controller",
    description: "Material issue, additional issue, returns and rejects.",
    permissions: [
      "shopfloor.handheld",
      "planning.jo.view",
      "planning.pjo.view",
      "planning.mrs.view",
      "planning.mrs.issue",
      "planning.mrs.additional",
      "shopfloor.mrs.return",
      "shopfloor.mrs.reject",
      "qc.iqc.view",
      "qc.defect.view",
      "bom.view",
      "bom.material.manage",
    ],
  },
  {
    code: "QC_INSPECTOR",
    name: "QC Inspector",
    description: "Records IQC and OQC inspections and prints labels.",
    permissions: [
      "shopfloor.handheld",
      "bom.view",
      "planning.jo.view",
      "planning.pjo.view",
      "shopfloor.wip.view",
      "qc.iqc.view",
      "qc.iqc.inspect",
      "qc.oqc.view",
      "qc.oqc.inspect",
      "qc.label.view",
      "qc.label.generate",
      "qc.defect.view",
    ],
  },
  {
    code: "QC_SUPERVISOR",
    name: "QC Supervisor",
    description: "All QC functions including dispositions, templates and the Defect Master.",
    permissions: [...views, ...all("qc."), "shopfloor.handheld", "reports.export"],
  },
  {
    code: "MANAGEMENT",
    name: "Management",
    description: "Read-only access to every module, dashboards and reports.",
    permissions: [...views, "reports.export"],
  },
].map((r) => ({ ...r, permissions: [...new Set(r.permissions)] }));
