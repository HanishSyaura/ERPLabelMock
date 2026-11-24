import { KeyRound, LogIn } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router";
import { PageHeader } from "@/components/common";
import { Button, Card, Field, Input } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";

export function LoginPage() {
  const { session, signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  if (session) return <Navigate to={session.user.mustChangePassword ? "/account/password" : from} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const s = await signIn(username.trim(), password);
      navigate(s.user.mustChangePassword ? "/account/password" : from, { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, "UNKNOWN", "Sign-in failed."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid min-h-full place-items-center bg-bg px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="grid size-10 place-items-center rounded-lg bg-primary text-lg font-bold text-on-primary">L</span>
          <div>
            <h1 className="text-lg font-semibold">Label MES</h1>
            <p className="text-sm text-muted">Manufacturing – BOM · Planning · Shopfloor · QC</p>
          </div>
        </div>
        <form onSubmit={submit} className="space-y-4 rounded-xl border border-line bg-surface p-6 shadow-sm" noValidate>
          <h2 className="text-base font-semibold">Sign in</h2>
          {error && error.issues.length === 0 && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {error.message}
            </p>
          )}
          <Field label="Username" error={error?.field("username")}>
            {(p) => <Input {...p} autoComplete="username" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />}
          </Field>
          <Field label="Password" error={error?.field("password")}>
            {(p) => <Input {...p} type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          </Field>
          <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy} icon={<LogIn className="size-4" />}>
            Sign in
          </Button>
          <p className="text-xs text-muted">Forgot your password? Ask a system administrator to reset it.</p>
        </form>
      </div>
    </div>
  );
}

export function ChangePasswordPage() {
  const { session, refresh } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const forced = !!session?.user.mustChangePassword;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (next !== confirm) {
      setError(new ApiError(422, "VALIDATION_FAILED", "", [{ path: "confirm", message: "The two passwords don't match" }]));
      return;
    }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { currentPassword: current, newPassword: next });
      await refresh();
      toast.success("Password changed. Your other sessions were signed out.");
      navigate("/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  };

  const form = (
    <form onSubmit={submit} className="max-w-md space-y-4" noValidate>
      {error && error.issues.length === 0 && error.message && (
        <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
          {error.message}
        </p>
      )}
      <Field label="Current password" required error={error?.field("currentPassword")}>
        {(p) => <Input {...p} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />}
      </Field>
      <Field label="New password" required hint="At least 10 characters, with letters and numbers." error={error?.field("newPassword")}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />}
      </Field>
      <Field label="Confirm new password" required error={error?.field("confirm")}>
        {(p) => <Input {...p} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />}
      </Field>
      <Button type="submit" variant="primary" loading={busy} icon={<KeyRound className="size-4" />}>
        Change password
      </Button>
    </form>
  );

  if (forced) {
    return (
      <div className="grid min-h-full place-items-center px-4 py-10">
        <div className="w-full max-w-md rounded-xl border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold">Choose a new password</h1>
          <p className="mt-1 mb-5 text-sm text-muted">Your password was set by an administrator. Choose your own before continuing.</p>
          {form}
        </div>
      </div>
    );
  }
  return (
    <>
      <PageHeader title="Change password" crumbs={[{ label: "Account" }, { label: "Change password" }]} />
      <Card>{form}</Card>
    </>
  );
}
