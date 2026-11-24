import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { FileInfo } from "@/modules/bom/api";

export type RecordStatus = "ACTIVE" | "INACTIVE";
export type MachineStatus = "AVAILABLE" | "RUNNING" | "IDLE" | "BREAKDOWN" | "MAINTENANCE" | "OFFLINE";
export type WoStatus = "PLANNED" | "RELEASED" | "IN_PROGRESS" | "PARTIALLY_COMPLETED" | "COMPLETED" | "ON_HOLD" | "CANCELLED";
export type PjoStatus = "DRAFT" | "RELEASED" | "CLOSED" | "CANCELLED";
export type SessionStatus = "RUNNING" | "COMPLETED" | "PAUSED" | "BREAKDOWN" | "TRANSFERRED" | "CLOSED";
export type Priority = "LOW" | "NORMAL" | "HIGH" | "URGENT";

export interface ProcessRef {
  id: string;
  code: string;
  name: string;
  status?: RecordStatus;
}
export interface Process extends ProcessRef {
  description: string | null;
  sequence: number;
  status: RecordStatus;
  categoryCount: number;
}
export interface MachineCategory {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RecordStatus;
  processes: ProcessRef[];
  machineCount: number;
  qualifiedOperatorCount: number;
}
export interface Machine {
  id: string;
  code: string;
  name: string;
  categoryId: string;
  category: { id: string; code: string; name: string };
  description: string | null;
  location: string | null;
  remarks: string | null;
  isActive: boolean;
  status: MachineStatus;
  statusChangedAt: string;
  devices: { id: string; name: string | null }[];
}
export interface Device {
  id: string;
  name: string | null;
  assignedMachine: { id: string; code: string; name: string } | null;
  lastSeenAt: string;
  lastUserName: string | null;
}
export interface Routine {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: RecordStatus;
  steps: { seq: number; process: ProcessRef }[];
  /** Master Card revisions that use this routine. */
  masterCardCount: number;
}

export type PjoStage = "planned" | "in_progress" | "completed";
export interface PjoRow {
  id: string;
  pjoNo: string;
  status: PjoStatus;
  stage: PjoStage;
  fatherCode: string;
  labelDescription: string;
  artworkRevision: number;
  componentRevision: number | null;
  artworkFile: FileInfo;
  customerRef: string | null;
  orderQty: string;
  uom: string;
  allocatedQty: string;
  jobOrderCount: number;
  requiredDate: string | null;
  priority: Priority;
  createdAt: string;
}
export interface PjoDetail {
  id: string;
  pjoNo: string;
  status: PjoStatus;
  customerRef: string | null;
  productRef: string | null;
  orderQty: string;
  uom: string;
  requiredDate: string | null;
  priority: Priority;
  remarks: string | null;
  releasedAt: string | null;
  createdAt: string;
  allocatedQty: string;
  masterCard: { productCode: string; revisionNo: number; newerAvailable: boolean } | null;
  product: { id: string; productCode: string; name: string; currentCardRevNo: number } | null;
  bom: {
    id: string;
    fatherCode: string;
    status: string;
    labelDescription: string;
    artworkRevision: number;
    componentRevision: number | null;
    newerRevisionAvailable: boolean;
    artworkFile: FileInfo;
    components: { sonCode: string; materialCode: string; materialDescription: string; quantity: string | null; uom: string | null }[];
  };
  workOrders: { id: string; woNo: string; status: WoStatus; quantity: string; plannedDate: string | null; priority: Priority }[];
}
export interface WoRow {
  id: string;
  woNo: string;
  status: WoStatus;
  pjoNo: string;
  fatherCode: string;
  labelDescription: string;
  artworkFile: FileInfo;
  quantity: string;
  uom: string;
  plannedDate: string | null;
  requiredDate: string | null;
  customerRef: string | null;
  priority: Priority;
  currentProcess: { name: string; status: string; seq: number } | null;
  processCount: number;
  completedProcesses: number;
  finalGood: string;
}
export interface Quantities {
  target: string;
  authorized: string;
  good: string;
  reject: string;
  outstanding: string;
  available: string;
  acceptedByNext: string | null;
}
export interface WoProcess {
  id: string;
  seq: number;
  process: { id: string; code: string; name: string };
  status: "PENDING" | "RUNNING" | "PAUSED" | "COMPLETED";
  assignedMachine: { id: string; code: string; name: string; status: MachineStatus } | null;
  allowPartialTransfer: boolean;
  allowSplit: boolean;
  extraAllowedQty: string;
  startedAt: string | null;
  completedAt: string | null;
  completionNote: string | null;
  pendingMachineChange: { id: string; toMachineId: string } | null;
  quantities: Quantities;
}
export interface WoView {
  id: string;
  woNo: string;
  status: WoStatus;
  quantity: string;
  uom: string;
  plannedDate: string | null;
  priority: Priority;
  remarks: string | null;
  holdReason: string | null;
  releasedAt: string | null;
  completedAt: string | null;
  completionNote: string | null;
  pjo: {
    id: string;
    pjoNo: string;
    status: PjoStatus;
    customerRef: string | null;
    fatherCode: string;
    bomId: string;
    labelDescription: string;
    artworkRevision: number;
    componentRevision: number | null;
    artworkFile: FileInfo;
  };
  currentSeq: number | null;
  processes: WoProcess[];
}
export interface Journey {
  sessions: {
    id: string;
    sessionNo: string;
    woProcessId: string;
    machine: { code: string; name: string };
    operator: string | null;
    checkInAt: string;
    checkOutAt: string | null;
    status: SessionStatus;
    checkOutType: string | null;
    goodQty: string;
    rejectQty: string;
    remarks: string | null;
  }[];
  machineChanges: {
    id: string;
    woProcessId: string;
    from: { code: string; name: string } | null;
    to: { code: string; name: string } | null;
    prevMachineGood: string;
    prevMachineReject: string;
    outstandingQty: string;
    reason: string;
    status: "PENDING" | "APPROVED" | "REJECTED";
    requestedBy: string | null;
    requestedAt: string;
    decidedBy: string | null;
    decidedAt: string | null;
  }[];
  breakdowns: { id: string; breakdownNo: string; woProcessId: string | null; machine: { code: string; name: string }; reason: string; remarks: string | null; status: string; reportedAt: string; reportedBy: string | null; resolvedAt: string | null }[];
}

export const useProcesses = (status?: RecordStatus) =>
  useQuery({ queryKey: ["planning", "processes", status], queryFn: () => api.get<Process[]>(`/planning/processes${qs({ status })}`) });
export const useMachineCategories = () => useQuery({ queryKey: ["planning", "categories"], queryFn: () => api.get<MachineCategory[]>("/planning/machine-categories") });
export const useMachines = (p: { q?: string; status?: string; categoryId?: string } = {}) =>
  useQuery({ queryKey: ["planning", "machines", p], queryFn: () => api.get<Machine[]>(`/planning/machines${qs(p)}`) });
export const useDevices = (enabled = true) => useQuery({ queryKey: ["planning", "devices"], queryFn: () => api.get<Device[]>("/planning/handheld-devices"), enabled });
export const useRoutines = () => useQuery({ queryKey: ["shopfloor", "routines"], queryFn: () => api.get<Routine[]>("/shopfloor/routines") });
export const usePjos = (p: { page: number; q?: string; status?: string; stage?: PjoStage }) =>
  useQuery({ queryKey: ["planning", "pjos", p], queryFn: () => api.list<PjoRow>(`/planning/production-job-orders${qs(p)}`), placeholderData: (prev) => prev });
export const usePjo = (id: string) => useQuery({ queryKey: ["planning", "pjos", "detail", id], queryFn: () => api.get<PjoDetail>(`/planning/production-job-orders/${id}`) });
export const useWorkOrders = (p: { page: number; q?: string; status?: string; pjoId?: string; due?: string; completedFrom?: string }) =>
  useQuery({ queryKey: ["planning", "wos", p], queryFn: () => api.list<WoRow>(`/planning/work-orders${qs(p)}`), placeholderData: (prev) => prev });
export const useWorkOrder = (id: string) => useQuery({ queryKey: ["planning", "wos", "detail", id], queryFn: () => api.get<WoView>(`/planning/work-orders/${id}`) });
export const useJourney = (id: string) => useQuery({ queryKey: ["planning", "wos", "detail", id, "journey"], queryFn: () => api.get<Journey>(`/planning/work-orders/${id}/journey`) });

/** Mutation that refreshes every Planning / Shopfloor query. */
export function usePlanningMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ["planning"] }), qc.invalidateQueries({ queryKey: ["shopfloor"] })]),
  });
}

export const PRIORITIES: Priority[] = ["LOW", "NORMAL", "HIGH", "URGENT"];
