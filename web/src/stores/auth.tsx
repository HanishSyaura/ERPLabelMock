import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useContext, useEffect, useMemo, type ReactNode } from "react";
import { api, ApiError, setCsrfToken, setUnauthenticatedHandler } from "@/lib/api";
import { AuthContext, type AuthValue, type SessionInfo } from "./auth-context";

export type { SessionInfo } from "./auth-context";

const ME_KEY = ["auth", "me"] as const;

/** Auth state lives only here (memory). Nothing about the session is persisted in the browser. */
export function AuthProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      try {
        return await api.get<SessionInfo>("/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
    retry: false,
  });

  const session = me.data ?? null;
  useEffect(() => setCsrfToken(session?.csrfToken ?? null), [session?.csrfToken]);
  useEffect(() => setUnauthenticatedHandler(() => qc.setQueryData(ME_KEY, null)), [qc]);

  const permissions = useMemo(() => new Set(session?.permissions ?? []), [session]);
  const can = useCallback((key: string) => permissions.has(key), [permissions]);
  const canAny = useCallback((...keys: string[]) => keys.some((k) => permissions.has(k)), [permissions]);

  // Drop every cached record from the previous user, but keep the session
  // query itself: clear() would detach its live observer and the UI would
  // never see the new session.
  const dropOtherQueries = useCallback(() => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] }), [qc]);

  const signIn = useCallback(
    async (username: string, password: string) => {
      const s = await api.post<SessionInfo>("/auth/login", { username, password });
      setCsrfToken(s.csrfToken);
      dropOtherQueries();
      qc.setQueryData(ME_KEY, s);
      return s;
    },
    [qc, dropOtherQueries],
  );
  const signOut = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      setCsrfToken(null);
      qc.setQueryData(ME_KEY, null);
      dropOtherQueries();
    }
  }, [qc, dropOtherQueries]);

  const value: AuthValue = {
    session,
    loading: me.isPending,
    can,
    canAny,
    signIn,
    signOut,
    refresh: () => qc.invalidateQueries({ queryKey: ME_KEY }),
  };
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
