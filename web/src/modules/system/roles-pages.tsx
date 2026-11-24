import { Lock, Plus } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { DataTable, ErrorState, LoadingState, PageHeader, type Column } from "@/components/common";
import { Badge, Button, Card, Checkbox, Dialog, Field, Input, Textarea } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { useToast } from "@/stores/toast";
import { useApiMutation, usePermissionCatalog, useRole, useRoles, type PermissionDef, type RoleDetail, type RoleRow } from "./api";

const MODULE_LABELS: Record<string, string> = {
  system: "System",
  bom: "BOM",
  planning: "Planning",
  shopfloor: "Shopfloor",
  qc: "QC",
  reports: "Reports & Dashboards",
};
const ADMIN = "ADMINISTRATOR";

export function RolesPage() {
  const roles = useRoles();
  const { can } = useAuth();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const columns: Column<RoleRow>[] = [
    {
      key: "name",
      header: "Role",
      cell: (r) => (
        <div>
          <p className="font-medium">{r.name}</p>
          <p className="text-xs text-muted">{r.description}</p>
        </div>
      ),
    },
    { key: "type", header: "Type", hideOnMobile: true, cell: (r) => (r.isSystem ? <Badge tone="info">Template</Badge> : <Badge>Custom</Badge>) },
    { key: "perms", header: "Permissions", cell: (r) => r.permissionCount },
    { key: "users", header: "Users", cell: (r) => r.userCount },
    { key: "status", header: "Status", cell: (r) => <Badge tone={r.isActive ? "success" : "neutral"}>{r.isActive ? "Active" : "Inactive"}</Badge> },
    { key: "updated", header: "Updated", hideOnMobile: true, cell: (r) => <span className="text-muted">{formatDateTime(r.updatedAt)}</span> },
  ];
  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        description="Roles are configurable. The templates are the suggested operational roles; adjust their permissions to match how the factory works."
        crumbs={[{ label: "System" }, { label: "Roles & Permissions" }]}
        actions={
          can("system.roles.manage") && (
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              New role
            </Button>
          )
        }
      />
      <DataTable
        columns={columns}
        rows={roles.data}
        rowKey={(r) => r.id}
        loading={roles.isPending}
        error={roles.error}
        onRetry={() => void roles.refetch()}
        onRowClick={(r) => navigate(`/system/roles/${r.id}`)}
      />
      {creating && <CreateRoleDialog onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateRoleDialog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [form, setForm] = useState({ code: "", name: "", description: "" });
  const [error, setError] = useState<ApiError | null>(null);
  const m = useApiMutation((v: typeof form) => api.post<RoleDetail>("/roles", v), [["roles"]]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate(form, {
      onSuccess: (role) => {
        toast.success(`Role ${role.name} created. Now choose its permissions.`);
        navigate(`/system/roles/${role.id}`);
      },
      onError: (err) => (err instanceof ApiError && err.issues.length ? setError(err) : toast.error(err)),
    });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title="New role"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="role-form" loading={m.isPending}>
            Create role
          </Button>
        </>
      }
    >
      <form id="role-form" onSubmit={submit} className="space-y-4" noValidate>
        <Field label="Code" required hint="Upper-case, e.g. SHIFT_LEADER. Can't be changed later." error={error?.field("code")}>
          {(p) => <Input {...p} value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} />}
        </Field>
        <Field label="Name" required error={error?.field("name")}>
          {(p) => <Input {...p} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />}
        </Field>
        <Field label="Description" error={error?.field("description")}>
          {(p) => <Textarea {...p} value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))} />}
        </Field>
      </form>
    </Dialog>
  );
}

export function RoleDetailPage() {
  const { id = "" } = useParams();
  const role = useRole(id);
  const catalog = usePermissionCatalog();
  if (role.isPending || catalog.isPending) return <LoadingState />;
  if (role.error || catalog.error) return <ErrorState error={role.error ?? catalog.error} onRetry={() => void role.refetch()} />;
  return <RoleEditor key={role.data.id + role.dataUpdatedAt} role={role.data} catalog={catalog.data} />;
}

function RoleEditor({ role, catalog }: { role: RoleDetail; catalog: PermissionDef[] }) {
  const { can, session } = useAuth();
  const toast = useToast();
  const isAdmin = role.code === ADMIN;
  const mine = useMemo(() => new Set(session?.permissions ?? []), [session]);
  const editable = can("system.roles.manage") && !isAdmin;
  const [selected, setSelected] = useState(() => new Set(role.permissions));
  const [meta, setMeta] = useState({ name: role.name, description: role.description ?? "" });
  const [reviewing, setReviewing] = useState(false);

  const original = useMemo(() => new Set(role.permissions), [role.permissions]);
  const added = [...selected].filter((k) => !original.has(k));
  const removed = [...original].filter((k) => !selected.has(k));
  const metaChanged = meta.name !== role.name || meta.description !== (role.description ?? "");
  const dirty = added.length > 0 || removed.length > 0 || metaChanged;

  const grouped = useMemo(() => {
    const out = new Map<string, Map<string, PermissionDef[]>>();
    for (const p of catalog) {
      const areas = out.get(p.module) ?? new Map<string, PermissionDef[]>();
      areas.set(p.area, [...(areas.get(p.area) ?? []), p]);
      out.set(p.module, areas);
    }
    return out;
  }, [catalog]);
  const byKey = useMemo(() => new Map(catalog.map((p) => [p.key, p])), [catalog]);

  const save = useApiMutation(
    () => api.patch(`/roles/${role.id}`, { name: meta.name, description: meta.description || null, permissions: [...selected] }),
    [["roles"], ["auth", "me"]],
  );
  const toggleActive = useApiMutation(() => api.patch(`/roles/${role.id}`, { isActive: !role.isActive }), [["roles"], ["auth", "me"]]);

  const toggle = (key: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(key);
      else n.delete(key);
      return n;
    });

  return (
    <>
      <PageHeader
        title={role.name}
        description={role.description ?? undefined}
        crumbs={[{ label: "System" }, { label: "Roles & Permissions", to: "/system/roles" }, { label: role.name }]}
        actions={
          editable && (
            <>
              <Button
                variant={role.isActive ? "secondary" : "primary"}
                loading={toggleActive.isPending}
                onClick={() =>
                  toggleActive.mutate(undefined, {
                    onSuccess: () => toast.success(role.isActive ? "Role deactivated: its permissions no longer apply." : "Role activated."),
                    onError: (e) => toast.error(e),
                  })
                }
              >
                {role.isActive ? "Deactivate role" : "Activate role"}
              </Button>
              <Button variant="primary" disabled={!dirty} onClick={() => setReviewing(true)}>
                Review & save
              </Button>
            </>
          )
        }
      />
      <div className="mb-4 flex flex-wrap gap-2">
        {role.isSystem ? <Badge tone="info">Template role</Badge> : <Badge>Custom role</Badge>}
        <Badge tone={role.isActive ? "success" : "neutral"}>{role.isActive ? "Active" : "Inactive"}</Badge>
        <Badge>{role.userCount} user{role.userCount === 1 ? "" : "s"}</Badge>
        <Link to={`/system/users?roleId=${role.id}`} className="text-xs text-primary hover:underline">
          Show users with this role
        </Link>
      </div>
      {isAdmin && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
          <Lock className="size-4" /> The Administrator role always holds every permission and can't be changed.
        </div>
      )}
      {editable && (
        <Card className="mb-4" title="Details">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">{(p) => <Input {...p} value={meta.name} onChange={(e) => setMeta((m) => ({ ...m, name: e.target.value }))} />}</Field>
            <Field label="Description">{(p) => <Input {...p} value={meta.description} onChange={(e) => setMeta((m) => ({ ...m, description: e.target.value }))} />}</Field>
          </div>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        {[...grouped.entries()].map(([module, areas]) => (
          <Card key={module} title={MODULE_LABELS[module] ?? module}>
            <div className="space-y-4">
              {[...areas.entries()].map(([area, perms]) => (
                <div key={area}>
                  <p className="mb-2 text-xs font-semibold tracking-wide text-muted uppercase">{area}</p>
                  <div className="space-y-2">
                    {perms.map((p) => {
                      const cannotGrant = !mine.has(p.key) && !selected.has(p.key);
                      return (
                        <Checkbox
                          key={p.key}
                          label={p.description}
                          description={cannotGrant && editable ? `${p.key} · you don't hold this permission, so you can't grant it` : p.key}
                          checked={selected.has(p.key)}
                          disabled={!editable || cannotGrant}
                          onChange={(e) => toggle(p.key, e.target.checked)}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        ))}
      </div>
      {reviewing && (
        <Dialog
          open
          onClose={() => setReviewing(false)}
          title={`Save changes to ${role.name}?`}
          description={`Applies immediately to ${role.userCount} user${role.userCount === 1 ? "" : "s"}.`}
          footer={
            <>
              <Button onClick={() => setReviewing(false)}>Back</Button>
              <Button
                variant="primary"
                loading={save.isPending}
                onClick={() =>
                  save.mutate(undefined, {
                    onSuccess: () => {
                      toast.success("Role saved.");
                      setReviewing(false);
                    },
                    onError: (e) => toast.error(e),
                  })
                }
              >
                Save
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            {metaChanged && <p>Name or description changed.</p>}
            {added.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-success">Grant ({added.length})</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {added.map((k) => (
                    <li key={k}>{byKey.get(k)?.description ?? k}</li>
                  ))}
                </ul>
              </div>
            )}
            {removed.length > 0 && (
              <div>
                <p className="mb-1 font-medium text-danger">Remove ({removed.length})</p>
                <ul className="list-disc space-y-0.5 pl-5">
                  {removed.map((k) => (
                    <li key={k}>{byKey.get(k)?.description ?? k}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
