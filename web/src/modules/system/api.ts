import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";

export interface RoleRef {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
}
export interface UserRow {
  id: string;
  username: string;
  fullName: string;
  email: string | null;
  employeeNo: string | null;
  status: "ACTIVE" | "INACTIVE";
  mustChangePassword: boolean;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  roles: RoleRef[];
}
export interface RoleRow extends RoleRef {
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissionCount: number;
  updatedAt: string;
}
export interface RoleDetail extends RoleRef {
  description: string | null;
  isSystem: boolean;
  userCount: number;
  permissions: string[];
}
export interface PermissionDef {
  key: string;
  module: string;
  area: string;
  description: string;
}
export interface AuditRow {
  id: string;
  occurredAt: string;
  userId: string | null;
  userName: string | null;
  module: string;
  action: string;
  entityType: string;
  entityId: string | null;
  recordRef: string | null;
  previous: unknown;
  next: unknown;
  remarks: string | null;
  result: "SUCCESS" | "DENIED" | "FAILED";
  deviceId: string | null;
  ip: string | null;
}

export interface UserListParams {
  page: number;
  q?: string;
  status?: string;
  roleId?: string;
  sort?: string;
}

export const useUsers = (p: UserListParams) =>
  useQuery({ queryKey: ["users", p], queryFn: () => api.list<UserRow>(`/users${qs({ ...p, pageSize: 25 })}`), placeholderData: (prev) => prev });

export const useRoles = () => useQuery({ queryKey: ["roles"], queryFn: () => api.get<RoleRow[]>("/roles") });
export const useRole = (id: string) => useQuery({ queryKey: ["roles", id], queryFn: () => api.get<RoleDetail>(`/roles/${id}`) });
export const usePermissionCatalog = () =>
  useQuery({ queryKey: ["permission-catalog"], queryFn: () => api.get<PermissionDef[]>("/roles/catalog"), staleTime: Infinity });

/** Mutation that refreshes the listed query keys on success. */
export function useApiMutation<TVars, TResult = unknown>(fn: (v: TVars) => Promise<TResult>, invalidate: string[][]) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => Promise.all(invalidate.map((key) => qc.invalidateQueries({ queryKey: key }))),
  });
}
