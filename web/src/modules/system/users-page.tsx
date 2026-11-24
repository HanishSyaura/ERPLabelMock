import { KeyRound, Pencil, Plus, UserCheck, UserX } from "lucide-react";
import { useCallback, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { ConfirmDialog, DataTable, PageHeader, SearchInput, type Column, type SortState } from "@/components/common";
import { Badge, Button, Checkbox, Dialog, Field, Input, Select } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useApiMutation, useRoles, useUsers, type RoleRow, type UserRow } from "./api";

const CRUMBS = [{ label: "System" }, { label: "Users" }];

export function UsersPage() {
  const { can, session } = useAuth();
  const canManage = can("system.users.manage");
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") ?? 1);
  const q = params.get("q") ?? "";
  const status = params.get("status") ?? "";
  const roleId = params.get("roleId") ?? "";
  const sortParam = params.get("sort") ?? "username:asc";
  const [sf, sd] = sortParam.split(":");
  const sort: SortState = { field: sf ?? "username", dir: sd === "desc" ? "desc" : "asc" };

  const setParam = useCallback(
    (patch: Record<string, string>) =>
      setParams((prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) v ? next.set(k, v) : next.delete(k);
        if (!("page" in patch)) next.delete("page");
        return next;
      }),
    [setParams],
  );

  const users = useUsers({ page, q, status, roleId, sort: sortParam });
  const roles = useRoles();
  const [editing, setEditing] = useState<UserRow | "new" | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [toggling, setToggling] = useState<UserRow | null>(null);

  const columns: Column<UserRow>[] = [
    {
      key: "user",
      header: "User",
      sortKey: "username",
      cell: (u) => (
        <div className="min-w-0">
          <p className="font-medium">{u.fullName}</p>
          <p className="text-xs text-muted">
            {u.username}
            {u.employeeNo ? ` · ${u.employeeNo}` : ""}
          </p>
        </div>
      ),
    },
    {
      key: "roles",
      header: "Roles",
      cell: (u) =>
        u.roles.length ? (
          <div className="flex flex-wrap gap-1">
            {u.roles.map((r) => (
              <Badge key={r.id} tone={r.isActive ? "primary" : "neutral"}>
                {r.name}
                {!r.isActive && " (inactive)"}
              </Badge>
            ))}
          </div>
        ) : (
          <span className="text-xs text-muted">No role</span>
        ),
    },
    {
      key: "status",
      header: "Status",
      cell: (u) => (
        <div className="flex flex-wrap gap-1">
          <Badge tone={u.status === "ACTIVE" ? "success" : "neutral"}>{u.status === "ACTIVE" ? "Active" : "Inactive"}</Badge>
          {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge tone="danger">Locked</Badge>}
          {u.mustChangePassword && <Badge tone="warning">Must change password</Badge>}
        </div>
      ),
    },
    { key: "lastLogin", header: "Last sign-in", sortKey: "lastLoginAt", hideOnMobile: true, cell: (u) => <span className="text-muted">{formatDateTime(u.lastLoginAt)}</span> },
    ...(canManage
      ? [
          {
            key: "actions",
            header: "",
            className: "text-right",
            cell: (u: UserRow) => (
              <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(u)} aria-label={`Edit ${u.username}`} />
                <Button size="sm" variant="ghost" icon={<KeyRound className="size-4" />} onClick={() => setResetting(u)} aria-label={`Reset password for ${u.username}`} />
                {u.id !== session?.user.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={u.status === "ACTIVE" ? <UserX className="size-4 text-danger" /> : <UserCheck className="size-4 text-success" />}
                    onClick={() => setToggling(u)}
                    aria-label={u.status === "ACTIVE" ? `Deactivate ${u.username}` : `Activate ${u.username}`}
                  />
                )}
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Users"
        description="Sign-in accounts and their roles. Users are deactivated, never deleted, so history stays traceable."
        crumbs={CRUMBS}
        actions={
          canManage && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing("new")}>
              New user
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={users.data?.data}
        rowKey={(u) => u.id}
        loading={users.isPending}
        error={users.error}
        onRetry={() => void users.refetch()}
        sort={sort}
        onSort={(s) => setParam({ sort: `${s.field}:${s.dir}` })}
        page={page}
        pageCount={users.data?.meta.pageCount}
        total={users.data?.meta.total}
        onPage={(p) => setParam({ page: String(p) })}
        onRowClick={canManage ? (u) => setEditing(u) : undefined}
        toolbar={
          <>
            <SearchInput value={q} onChange={(v) => setParam({ q: v })} placeholder="Search name, username, employee no." />
            <Select value={status} onChange={(e) => setParam({ status: e.target.value })} className="sm:w-40" aria-label="Status filter">
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
            </Select>
            <Select value={roleId} onChange={(e) => setParam({ roleId: e.target.value })} className="sm:w-56" aria-label="Role filter">
              <option value="">All roles</option>
              {roles.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
          </>
        }
      />
      {editing && <UserDialog user={editing === "new" ? null : editing} roles={roles.data ?? []} onClose={() => setEditing(null)} />}
      {resetting && <ResetPasswordDialog user={resetting} onClose={() => setResetting(null)} />}
      {toggling && <ToggleStatusDialog user={toggling} onClose={() => setToggling(null)} />}
    </>
  );
}

function UserDialog({ user, roles, onClose }: { user: UserRow | null; roles: RoleRow[]; onClose: () => void }) {
  const toast = useToast();
  const { can, session } = useAuth();
  const [form, setForm] = useState({
    username: user?.username ?? "",
    fullName: user?.fullName ?? "",
    email: user?.email ?? "",
    employeeNo: user?.employeeNo ?? "",
    password: "",
    mustChangePassword: true,
  });
  const [roleIds, setRoleIds] = useState<string[]>(user?.roles.map((r) => r.id) ?? []);
  const [error, setError] = useState<ApiError | null>(null);
  const save = useApiMutation(
    async () => {
      if (!user) {
        return api.post("/users", { ...form, roleIds });
      }
      await api.patch(`/users/${user.id}`, { fullName: form.fullName, email: form.email, employeeNo: form.employeeNo });
      const before = user.roles.map((r) => r.id).sort().join();
      if (before !== [...roleIds].sort().join()) await api.put(`/users/${user.id}/roles`, { roleIds });
    },
    [["users"], ["roles"]],
  );
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    save.mutate(undefined, {
      onSuccess: () => {
        toast.success(user ? `Saved ${form.username}.` : `User ${form.username} created.`);
        onClose();
      },
      onError: (err) => (err instanceof ApiError && err.issues.length ? setError(err) : toast.error(err)),
    });
  };

  const selectable = roles.filter((r) => r.isActive || roleIds.includes(r.id));
  return (
    <Dialog
      open
      onClose={onClose}
      title={user ? `Edit ${user.username}` : "New user"}
      description={user ? undefined : "The user signs in with the username and must choose their own password at first sign-in."}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="user-form" loading={save.isPending}>
            {user ? "Save changes" : "Create user"}
          </Button>
        </>
      }
    >
      <form id="user-form" onSubmit={submit} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="Username" required error={error?.field("username")} hint={user ? "Usernames can't be changed." : "Often the employee number."}>
          {(p) => <Input {...p} value={form.username} onChange={set("username")} disabled={!!user} autoComplete="off" />}
        </Field>
        <Field label="Full name" required error={error?.field("fullName")}>
          {(p) => <Input {...p} value={form.fullName} onChange={set("fullName")} />}
        </Field>
        <Field label="Employee no." error={error?.field("employeeNo")}>
          {(p) => <Input {...p} value={form.employeeNo} onChange={set("employeeNo")} />}
        </Field>
        <Field label="E-mail" error={error?.field("email")}>
          {(p) => <Input {...p} type="email" value={form.email} onChange={set("email")} />}
        </Field>
        {!user && (
          <>
            <Field label="Initial password" required className="sm:col-span-2" hint="At least 10 characters, with letters and numbers. Give it to the user in person." error={error?.field("password")}>
              {(p) => <Input {...p} type="password" autoComplete="new-password" value={form.password} onChange={set("password")} />}
            </Field>
            <div className="sm:col-span-2">
              <Checkbox
                label="Must change password at first sign-in"
                checked={form.mustChangePassword}
                onChange={(e) => setForm((f) => ({ ...f, mustChangePassword: e.target.checked }))}
              />
            </div>
          </>
        )}
        <fieldset className="sm:col-span-2">
          <legend className="mb-2 text-sm font-medium">Roles</legend>
          {error?.field("roleIds") && <p className="mb-2 text-xs text-danger">{error.field("roleIds")}</p>}
          <div className="grid gap-2 sm:grid-cols-2">
            {selectable.map((r) => {
              const self = user?.id === session?.user.id && r.code === "ADMINISTRATOR";
              return (
                <Checkbox
                  key={r.id}
                  label={r.name}
                  description={self ? "You can't remove your own Administrator role." : (r.description ?? undefined)}
                  checked={roleIds.includes(r.id)}
                  disabled={self || !can("system.users.manage")}
                  onChange={(e) => setRoleIds((ids) => (e.target.checked ? [...ids, r.id] : ids.filter((x) => x !== r.id)))}
                />
              );
            })}
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}

function ResetPasswordDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<ApiError | null>(null);
  const reset = useApiMutation(() => api.post(`/users/${user.id}/reset-password`, { password }), [["users"]]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    reset.mutate(undefined, {
      onSuccess: () => {
        toast.success(`Password reset for ${user.username}. They must change it at next sign-in.`);
        onClose();
      },
      onError: (err) => (err instanceof ApiError && err.issues.length ? setError(err) : toast.error(err)),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Reset password – ${user.username}`}
      description="Signs the user out everywhere, unlocks the account and requires a new password at next sign-in."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="reset-form" loading={reset.isPending}>
            Reset password
          </Button>
        </>
      }
    >
      <form id="reset-form" onSubmit={submit} noValidate>
        <Field label="Temporary password" required hint="At least 10 characters, with letters and numbers." error={error?.field("password")}>
          {(p) => <Input {...p} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />}
        </Field>
      </form>
    </Dialog>
  );
}

function ToggleStatusDialog({ user, onClose }: { user: UserRow; onClose: () => void }) {
  const toast = useToast();
  const activate = user.status !== "ACTIVE";
  const m = useApiMutation(() => api.put(`/users/${user.id}/status`, { status: activate ? "ACTIVE" : "INACTIVE" }), [["users"]]);
  return (
    <ConfirmDialog
      open
      onClose={onClose}
      title={activate ? `Activate ${user.username}?` : `Deactivate ${user.username}?`}
      message={
        activate
          ? "The user can sign in again with their current password."
          : "The user is signed out everywhere and can no longer sign in. Their history is kept."
      }
      confirmLabel={activate ? "Activate" : "Deactivate"}
      tone={activate ? "primary" : "danger"}
      busy={m.isPending}
      onConfirm={() =>
        m.mutate(undefined, {
          onSuccess: () => {
            toast.success(activate ? `${user.username} activated.` : `${user.username} deactivated.`);
            onClose();
          },
          onError: (err) => toast.error(err),
        })
      }
    />
  );
}
