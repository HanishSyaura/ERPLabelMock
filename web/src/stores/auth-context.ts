import { createContext } from "react";

/**
 * Auth context in its own module so a hot reload of `auth.tsx` never creates a
 * second context (which made `useAuth` throw "outside AuthProvider" until a
 * full page reload).
 */
export interface SessionInfo {
  user: { id: string; username: string; fullName: string; email: string | null; employeeNo: string | null; mustChangePassword: boolean };
  roles: string[];
  permissions: string[];
  csrfToken: string;
}

export interface AuthValue {
  session: SessionInfo | null;
  loading: boolean;
  can: (key: string) => boolean;
  canAny: (...keys: string[]) => boolean;
  signIn: (username: string, password: string) => Promise<SessionInfo>;
  signOut: () => Promise<void>;
  refresh: () => Promise<unknown>;
}

export const AuthContext = createContext<AuthValue | null>(null);
