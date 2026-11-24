import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, qs } from "@/lib/api";
import type { DocLayout, DocType } from "./config";

export interface DocumentTemplate {
  id: string;
  code: string;
  name: string;
  docType: DocType;
  isDefault: boolean;
  layout: DocLayout;
  status: "ACTIVE" | "INACTIVE";
  updatedAt: string;
}
export interface Letterhead {
  companyName: string;
  registrationNo: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  logo: string | null;
}

export const useDocumentTemplates = (p: { docType?: DocType; status?: "ACTIVE" | "INACTIVE" } = {}) =>
  useQuery({ queryKey: ["documents", "templates", p], queryFn: () => api.get<DocumentTemplate[]>(`/documents/templates${qs(p)}`) });
export const useLetterhead = () => useQuery({ queryKey: ["documents", "settings"], queryFn: () => api.get<Letterhead | null>("/documents/settings"), staleTime: 60_000 });

export function useDocumentMutation<V, R = unknown>(fn: (v: V) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: ["documents"] }) });
}
