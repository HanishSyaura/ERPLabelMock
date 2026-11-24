import { lazy, Suspense, type ComponentType, type ReactNode } from "react";
import { createBrowserRouter, Navigate, Outlet, useLocation, type RouteObject } from "react-router";
import { LoadingState } from "@/components/common";
import { AppShell } from "@/components/layout";
import { NAV_MODULES } from "@/config/navigation";
import { ChangePasswordPage, LoginPage } from "@/pages/auth-pages";
import { ForbiddenPage, NotBuiltPage, NotFoundPage } from "@/pages/general-pages";
import { DashboardPage } from "@/pages/dashboard";
import { useAuth } from "@/stores/auth";

/** Code-split page: each module's pages load when first opened. */
function lazyNamed<M extends Record<string, unknown>>(load: () => Promise<M>, name: keyof M): ComponentType {
  const Lazy = lazy(async () => ({ default: (await load())[name] as ComponentType }));
  return function LazyPage() {
    return (
      <Suspense fallback={<LoadingState />}>
        <Lazy />
      </Suspense>
    );
  };
}

const bom = () => import("@/modules/bom/bom-page");
const bomDetail = () => import("@/modules/bom/bom-detail-page");
const masters = () => import("@/modules/planning/masters-pages");
const orders = () => import("@/modules/planning/order-pages");
const daily = () => import("@/modules/planning/daily-page");
const material = () => import("@/modules/planning/material-pages");
const completion = () => import("@/modules/planning/completion-pages");
const monitor = () => import("@/modules/shopfloor/monitor-pages");
const routines = () => import("@/modules/shopfloor/routine-pages");
const handheld = () => import("@/modules/handheld/handheld-app");
const audit = () => import("@/modules/system/audit-page");
const roles = () => import("@/modules/system/roles-pages");
const users = () => import("@/modules/system/users-page");

const BomPage = lazyNamed(bom, "BomPage");
const BomDetailPage = lazyNamed(bomDetail, "BomDetailPage");
const ProductDetailPage = lazyNamed(() => import("@/modules/bom/product-detail-page"), "ProductDetailPage");
const MasterCardListPage = lazyNamed(() => import("@/modules/bom/master-card-pages"), "MasterCardListPage");
const MasterCardPage = lazyNamed(() => import("@/modules/bom/master-card-pages"), "MasterCardPage");
const ProductOnboardingPage = lazyNamed(() => import("@/modules/bom/onboarding-journey"), "ProductOnboardingPage");
const MachinePage = lazyNamed(masters, "MachinePage");
const MachineCategoryPage = lazyNamed(masters, "MachineCategoryPage");
const ProcessPage = lazyNamed(masters, "ProcessPage");
const PjoListPage = lazyNamed(orders, "PjoListPage");
const PjoDetailPage = lazyNamed(orders, "PjoDetailPage");
const FinishOrderJourney = lazyNamed(() => import("@/modules/planning/finish-journey"), "FinishOrderJourney");
const IssueMaterialJourney = lazyNamed(() => import("@/modules/planning/issue-journey"), "IssueMaterialJourney");
const IqcReceivingJourney = lazyNamed(() => import("@/modules/qc/iqc-journey"), "IqcReceivingJourney");
const NewPjoJourneyPage = lazyNamed(() => import("@/modules/planning/new-pjo-journey"), "NewPjoJourneyPage");
const JobOrderListPage = lazyNamed(orders, "JobOrderListPage");
const JobOrderDetailPage = lazyNamed(orders, "JobOrderDetailPage");
const DailyJobInformationPage = lazyNamed(daily, "DailyJobInformationPage");
const MrsListPage = lazyNamed(material, "MrsListPage");
const MrsDetailPage = lazyNamed(material, "MrsDetailPage");
const MaterialMovementPage = lazyNamed(material, "MaterialMovementPage");
const CompletionDetailPage = lazyNamed(completion, "CompletionDetailPage");
const MachineOutputControlPage = lazyNamed(monitor, "MachineOutputControlPage");
const CheckInOutHistoryPage = lazyNamed(monitor, "CheckInOutHistoryPage");
const RoutineMasterPage = lazyNamed(routines, "RoutineMasterPage");
const HandheldShell = lazyNamed(handheld, "HandheldShell");
const HandheldHome = lazyNamed(() => import("@/modules/handheld/handheld-home"), "HandheldHome");
const HandheldModule = lazyNamed(() => import("@/modules/handheld/handheld-home"), "HandheldModule");
const HandheldIqc = lazyNamed(() => import("@/modules/handheld/handheld-quality"), "HandheldIqc");
const HandheldOqc = lazyNamed(() => import("@/modules/handheld/handheld-quality"), "HandheldOqc");
const HandheldMachine = lazyNamed(handheld, "HandheldMachine");
const HandheldWorkOrder = lazyNamed(handheld, "HandheldWorkOrder");
const HandheldChangeMachine = lazyNamed(handheld, "HandheldChangeMachine");
const HandheldMaterial = lazyNamed(() => import("@/modules/handheld/handheld-material"), "HandheldMaterial");
const AuditPage = lazyNamed(audit, "AuditPage");
const DocumentTemplatesPage = lazyNamed(() => import("@/modules/documents/templates-page"), "DocumentTemplatesPage");
const RolesPage = lazyNamed(roles, "RolesPage");
const RoleDetailPage = lazyNamed(roles, "RoleDetailPage");
const UsersPage = lazyNamed(users, "UsersPage");
const partPages = () => import("@/modules/master-data/part-pages");
const PartMasterPage = lazyNamed(partPages, "PartMasterPage");
const PartGroupPage = lazyNamed(partPages, "PartGroupPage");
const PartCategoryPage = lazyNamed(partPages, "PartCategoryPage");
const PartDetailPage = lazyNamed(partPages, "PartDetailPage");
const NewPartJourney = lazyNamed(() => import("@/modules/master-data/part-journey"), "NewPartJourney");
const qcInsp = () => import("@/modules/qc/inspection-pages");
const qcMasters = () => import("@/modules/qc/master-pages");
const IqcPage = lazyNamed(qcInsp, "IqcPage");
const OqcPage = lazyNamed(qcInsp, "OqcPage");
const IqcDetailPage = lazyNamed(qcInsp, "IqcDetailPage");
const OqcDetailPage = lazyNamed(qcInsp, "OqcDetailPage");
const DefectMasterPage = lazyNamed(qcMasters, "DefectMasterPage");
const InspectionTemplatePage = lazyNamed(qcMasters, "InspectionTemplatePage");
const ShippingLabelPage = lazyNamed(() => import("@/modules/qc/label-pages"), "ShippingLabelPage");
const DieCutPage = lazyNamed(() => import("@/modules/master-data/die-cut-page"), "DieCutPage");
const ReasonCodePage = lazyNamed(() => import("@/modules/master-data/master-data-pages"), "ReasonCodePage");

/**
 * Page id -> component for built menu pages. Every other menu page renders
 * NotBuiltPage until its phase is delivered.
 */
const PAGE_REGISTRY: Record<string, ComponentType> = {
  bom: BomPage,
  "master-card": MasterCardListPage,
  "production-job-order": PjoListPage,
  "job-order": JobOrderListPage,
  "daily-job-information": DailyJobInformationPage,
  "material-requisition-sheet": MrsListPage,
  "material-movement": MaterialMovementPage,
  "part-master": PartMasterPage,
  "part-group-master": PartGroupPage,
  "part-category-master": PartCategoryPage,
  "die-cut-master": DieCutPage,
  "defect-master": DefectMasterPage,
  "inspection-template": InspectionTemplatePage,
  "iqc-check-in-out": IqcPage,
  "oqc-check-in-out": OqcPage,
  "shipping-label": ShippingLabelPage,
  "reason-code": ReasonCodePage,
  machine: MachinePage,
  "machine-category": MachineCategoryPage,
  process: ProcessPage,
  "routine-master": RoutineMasterPage,
  "machine-output-control": MachineOutputControlPage,
  "wip-check-in-out": CheckInOutHistoryPage,
  users: UsersPage,
  roles: RolesPage,
  audit: AuditPage,
  "document-templates": DocumentTemplatesPage,
};

/** Non-menu routes (detail, create, edit): [path, required permission, component]. */
const MODULE_ROUTES: [string, string, ComponentType][] = [
  ["/bom/:id", "bom.view", BomDetailPage],
  ["/bom/products/:id", "bom.view", ProductDetailPage],
  ["/bom/master-card/:id", "bom.view", MasterCardPage],
  ["/bom/new-product", "bom.product.manage", ProductOnboardingPage],
  ["/master-data/part-master/new", "bom.material.manage", NewPartJourney],
  ["/master-data/part-master/:id", "bom.view", PartDetailPage],
  ["/planning/production-job-order/new", "planning.pjo.create", NewPjoJourneyPage],
  ["/planning/production-job-order/:id/finish", "planning.pjo.view", FinishOrderJourney],
  ["/planning/material-requisition-sheet/issue", "planning.mrs.issue", IssueMaterialJourney],
  ["/qc/iqc-check-in-out/receive", "qc.iqc.inspect", IqcReceivingJourney],
  ["/planning/production-job-order/:id", "planning.pjo.view", PjoDetailPage],
  ["/planning/job-order/:id", "planning.jo.view", JobOrderDetailPage],
  ["/planning/material-requisition-sheet/:id", "planning.mrs.view", MrsDetailPage],
  ["/planning/production-order-complete-utility/:id", "planning.pjo.view", CompletionDetailPage],
  ["/qc/iqc-check-in-out/:id", "qc.iqc.view", IqcDetailPage],
  ["/qc/oqc-check-in-out/:id", "qc.oqc.view", OqcDetailPage],
  ["/system/roles/:id", "system.roles.view", RoleDetailPage],
];

function RequireAuth() {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <LoadingState label="Checking your session…" />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  // Forced change: full-screen page, nothing else reachable until done.
  if (session.user.mustChangePassword) return <ChangePasswordPage />;
  return <Outlet />;
}

function RequirePermission({ permission, any, children }: { permission: string; any?: string[]; children: ReactNode }) {
  const { can } = useAuth();
  return (any ? any.some(can) : can(permission)) ? children : <ForbiddenPage />;
}

const menuRoutes: RouteObject[] = NAV_MODULES.flatMap((m) =>
  m.pages.map((page) => {
    const Page = PAGE_REGISTRY[page.id];
    return {
      path: page.path,
      element: <RequirePermission permission={page.permission} any={page.anyPermission}>{Page && page.built ? <Page /> : <NotBuiltPage page={page} />}</RequirePermission>,
    };
  }),
);

export const router = createBrowserRouter([
  { path: "/login", element: <LoginPage /> },
  // Handheld app: own mobile shell and sign-in, same API and rules.
  {
    path: "/hh",
    element: <HandheldShell />,
    children: [
      { index: true, element: <HandheldHome /> },
      { path: "module/:moduleId", element: <HandheldModule /> },
      { path: "qc/iqc", element: <HandheldIqc /> },
      { path: "qc/oqc", element: <HandheldOqc /> },
      { path: "m/:machineId", element: <HandheldMachine /> },
      { path: "m/:machineId/wo/:woNo", element: <HandheldWorkOrder /> },
      { path: "m/:machineId/change/:woProcessId", element: <HandheldChangeMachine /> },
      { path: "material/:type", element: <HandheldMaterial /> },
    ],
  },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppShell />,
        children: [
          { index: true, element: <DashboardPage /> },
          { path: "/account/password", element: <ChangePasswordPage /> },
          ...menuRoutes,
          ...MODULE_ROUTES.map(([path, permission, Page]) => ({
            path,
            element: (
              <RequirePermission permission={permission}>
                <Page />
              </RequirePermission>
            ),
          })),
          // Old menu paths (before the Master Data module).
          ...[
            ["/planning/machine", "/master-data/machine"],
            ["/planning/machine-category", "/master-data/machine-category"],
            ["/planning/process", "/master-data/process"],
            ["/shopfloor/routine-master", "/master-data/routine-master"],
            ["/shopfloor/production-routine-master", "/master-data/routine-master"],
            ["/master-data/production-routine-master", "/master-data/routine-master"],
            ["/qc/defect-master", "/master-data/defect-master"],
            ["/master-data/material", "/master-data/part-master"],
            ["/planning/pre-plan", "/planning/daily-job-information"],
            ["/planning/mrs-additional-issued", "/planning/material-movement?type=ADDITIONAL_ISSUE"],
            ["/shopfloor/mrs-return", "/planning/material-movement?type=RETURN"],
            ["/shopfloor/mrs-reject", "/planning/material-movement?type=REJECT"],
            ["/shopfloor/scrap-bad-material", "/planning/material-movement?type=SCRAP"],
            ["/planning/production-order-complete-utility", "/planning/production-job-order?stage=in_progress"],
          ].map(([from, to]) => ({ path: from, element: <Navigate to={to!} replace /> })),
          { path: "*", element: <NotFoundPage /> },
        ],
      },
    ],
  },
]);
