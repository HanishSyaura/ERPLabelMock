import { useState } from "react";
import { useToast } from "@/stores/toast";
import { ApiError } from "./api";

/** Field errors go to the form; anything else to a toast. */
export function useFormError() {
  const toast = useToast();
  const [error, setError] = useState<ApiError | null>(null);
  const handle = (e: unknown) => {
    if (e instanceof ApiError && e.issues.length) setError(e);
    else toast.error(e);
  };
  return { error, setError, handle, field: (path: string) => error?.field(path) };
}

/** Random id for idempotent shopfloor requests (one per user action, reused on retry). */
export const newTxnId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
