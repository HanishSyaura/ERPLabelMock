import { useQuery } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { PjoStatus, Priority, WoStatus } from "./api";

/** Daily Job Information, MRS movements, Production Order Complete Utility. */

export type MaterialState = "NONE" | "PARTIAL" | "ISSUED";
export type MrsStatus = "OPEN" | "PARTIALLY_ISSUED" | "ISSUED" | "CLOSED" | "CANCELLED";
export type MovementType = "ISSUE" | "ADDITIONAL_ISSUE" | "RETURN" | "REJECT" | "SCRAP";
export type ReasonCategory = "ADDITIONAL_ISSUE" | "REJECT" | "SCRAP";

export interface DailyJob {
  stage: "PLANNED" | "IN_PROGRESS" | "COMPLETED";
  id: string;
  woNo: string;
  status: WoStatus;
  holdReason: string | null;
  quantity: string;
  uom: string;
  plannedDate: string | null;
  priority: Priority;
  completedAt: string | null;
  pjo: { id: string; pjoNo: string; customerRef: string | null; requiredDate: string | null };
  fatherCode: string;
  labelDescription: string;
  steps: { done: number; total: number };
  current: { seq: number; name: string; status: string; goodQty: string; rejectQty: string } | null;
  machine: { code: string; name: string } | null;
  running: boolean;
  finishedQty: string;
  outputToday: { good: string; reject: string };
  material: MaterialState;
}
export interface DailyData {
  date: string;
  previous: string;
  next: string;
  summary: { planned: number; inProgress: number; running: number; onHold: number; completed: number };
  planned: DailyJob[];
  inProgress: DailyJob[];
  completed: DailyJob[];
}

export interface MrsLineView {
  id: string;
  lineNo: number;
  sonCode: string | null;
  materialId: string;
  materialCode: string;
  materialDescription: string;
  uom: string;
  requested: string;
  issued: string;
  additional: string;
  returned: string;
  rejected: string;
  scrapped: string;
  remainingToIssue: string;
  onHand: string;
}
export interface MrsRow {
  id: string;
  mrsNo: string;
  status: MrsStatus;
  workOrder: { id: string; woNo: string; status: WoStatus };
  pjoNo: string;
  fatherCode: string;
  lineCount: number;
  linesFullyIssued: number;
  linesWithOnHand: number;
  createdAt: string;
}
export interface MovementRow {
  id: string;
  txnNo: string;
  type: MovementType;
  mrsId?: string;
  mrsNo?: string;
  woNo?: string;
  materialCode: string | null;
  materialDescription?: string;
  qty: string;
  uom: string;
  lotRef: string | null;
  reason: string | null;
  machine: string | null;
  process: string | null;
  remarks: string | null;
  by: string | null;
  at: string;
}
export interface MrsDetail {
  id: string;
  mrsNo: string;
  status: MrsStatus;
  remarks: string | null;
  createdAt: string;
  createdBy: string | null;
  closedAt: string | null;
  workOrder: { id: string; woNo: string; status: WoStatus; holdReason: string | null; quantity: string; uom: string; processes: { id: string; seq: number; name: string }[] };
  pjo: { id: string; pjoNo: string; status: PjoStatus; fatherCode: string; labelDescription: string; componentRevision: number | null };
  lines: MrsLineView[];
  transactions: MovementRow[];
}
export interface MrsTemplate {
  workOrder: { id: string; woNo: string; status: WoStatus; quantity: string; uom: string };
  pjo: { id: string; pjoNo: string; status: PjoStatus; componentRevision: number | null };
  lines: { sonCodeId: string; sonCode: string; materialId: string; materialCode: string; materialDescription: string; bomQty: string | null; uom: string; alreadyRequested: string }[];
}
export interface Reason {
  id: string;
  category: ReasonCategory;
  code: string;
  description: string;
  status: "ACTIVE" | "INACTIVE";
}
export interface CompletionRow {
  id: string;
  pjoNo: string;
  status: PjoStatus;
  fatherCode: string;
  labelDescription: string;
  customerRef: string | null;
  orderQty: string;
  uom: string;
  requiredDate: string | null;
  jobOrders: number;
  completedJobOrders: number;
  ready: boolean;
  closedAt: string | null;
  closureOverride: boolean;
}
export interface CompletionCheck {
  pjo: { id: string; pjoNo: string; status: PjoStatus; orderQty: string; uom: string; customerRef: string | null; fatherCode: string; labelDescription: string };
  blockers: string[];
  warnings: string[];
  goodOutput: string;
  jobOrders: { id: string; woNo: string; status: WoStatus; quantity: string; finalGood: string }[];
  materials: { mrsId: string; mrsNo: string; status: MrsStatus; woNo: string; lines: Omit<MrsLineView, "id" | "lineNo" | "sonCode" | "materialId">[] }[];
  closure: { closedAt: string; closedBy: string | null; note: string | null; override: boolean } | null;
}

export const MOVEMENT_PATH: Record<MovementType, string> = { ISSUE: "issue", ADDITIONAL_ISSUE: "additional-issue", RETURN: "return", REJECT: "reject", SCRAP: "scrap" };
export const MOVEMENT_LABEL: Record<MovementType, string> = { ISSUE: "Issue", ADDITIONAL_ISSUE: "Additional issue", RETURN: "Return", REJECT: "Reject", SCRAP: "Scrap" };
export const MOVEMENT_PERMISSION: Record<MovementType, string> = {
  ISSUE: "planning.mrs.issue",
  ADDITIONAL_ISSUE: "planning.mrs.additional",
  RETURN: "shopfloor.mrs.return",
  REJECT: "shopfloor.mrs.reject",
  SCRAP: "shopfloor.scrap.record",
};

export const useDaily = (date: string) => useQuery({ queryKey: ["planning", "daily", date], queryFn: () => api.get<DailyData>(`/planning/daily${qs({ date })}`), placeholderData: (p) => p });
export const useMrsList = (p: { page: number; q?: string; status?: string; withOnHand?: string; activeJob?: string }) =>
  useQuery({ queryKey: ["planning", "mrs", p], queryFn: () => api.list<MrsRow>(`/material/requisitions${qs(p)}`), placeholderData: (prev) => prev });
export const useMrs = (id: string | null) => useQuery({ queryKey: ["planning", "mrs", "detail", id], queryFn: () => api.get<MrsDetail>(`/material/requisitions/${id}`), enabled: !!id });
export const useMovements = (p: { page: number; type?: MovementType; q?: string; from?: string; to?: string }) =>
  useQuery({ queryKey: ["planning", "movements", p], queryFn: () => api.list<MovementRow>(`/material/transactions${qs(p)}`), placeholderData: (prev) => prev });
export const useReasons = (category: ReasonCategory, status?: "ACTIVE") =>
  useQuery({ queryKey: ["planning", "reasons", category, status], queryFn: () => api.get<Reason[]>(`/material/reasons${qs({ category, status })}`) });
export const useCompletion = (id: string) => useQuery({ queryKey: ["planning", "completion", "detail", id], queryFn: () => api.get<CompletionCheck>(`/planning/completion/${id}`) });

/** Local calendar day "YYYY-MM-DD" (plant time = browser time on the plant network). */
export const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const shiftDay = (key: string, n: number) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return localDay(new Date(y, m - 1, d + n));
};
export const dayLabel = (key: string) => {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d).toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short" });
};
