import { ChevronDown, KeyRound, LogOut, Menu, Moon, ScanLine, Sun, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { DASHBOARD, NAV_MODULES, canSeePage, type NavModule, locateNav } from "@/config/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/stores/auth";
import { Badge } from "./ui";

/** Modules and pages the signed-in user may see. */
export function useVisibleModules(): NavModule[] {
  const { can } = useAuth();
  return NAV_MODULES.map((m) => ({ ...m, pages: m.pages.filter((p) => canSeePage(p, can)) })).filter((m) => m.pages.length > 0);
}

const THEME_KEY = "mes.theme";
function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(() => {
    try {
      return (localStorage.getItem(THEME_KEY) as "light" | "dark" | null) ?? null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.dataset.theme = theme;
    else delete root.dataset.theme;
    try {
      if (theme) localStorage.setItem(THEME_KEY, theme);
      else localStorage.removeItem(THEME_KEY);
    } catch {
      /* storage unavailable: keep the in-memory choice */
    }
  }, [theme]);
  const isDark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { isDark, toggle: () => setTheme(isDark ? "light" : "dark") };
}

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const modules = useVisibleModules();
  const { can } = useAuth();
  const { pathname } = useLocation();
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const business = modules.filter((m) => !m.supporting);
  const supporting = modules.filter((m) => m.supporting);

  // Only the most specific menu item is active (e.g. /bom/master-card highlights Master Card, not Bill of Material too).
  const activeId = locateNav(pathname)?.page.id;
  const isOpen = (m: NavModule) => open[m.id] ?? m.pages.some((p) => pathname === p.path || pathname.startsWith(p.path + "/"));
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors",
      isActive ? "bg-nav-active font-medium text-on-primary" : "text-nav-text hover:bg-nav-hover",
    );

  const group = (m: NavModule) => (
    <div key={m.id}>
      <button
        onClick={() => setOpen((o) => ({ ...o, [m.id]: !isOpen(m) }))}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-nav-text hover:bg-nav-hover"
        aria-expanded={isOpen(m)}
      >
        <m.icon className="size-4 shrink-0" />
        <span className="flex-1 text-left">{m.label}</span>
        <ChevronDown className={cn("size-4 transition-transform", isOpen(m) ? "" : "-rotate-90")} />
      </button>
      {isOpen(m) && (
        <div className="mt-0.5 ml-4 flex flex-col gap-0.5 border-l border-nav-hover pl-2">
          {m.pages.map((p) => (
            <NavLink key={p.id} to={p.path} className={() => linkClass({ isActive: p.id === activeId })} onClick={onNavigate}>
              <span className="min-w-0 flex-1 truncate">{p.label}</span>
              {!p.built && <span className="text-[10px] text-nav-muted">P{p.phase}</span>}
            </NavLink>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <nav className="flex h-full flex-col bg-nav" aria-label="Main">
      <Link to="/" className="flex h-14 shrink-0 items-center gap-2 border-b border-nav-hover px-4" onClick={onNavigate}>
        <span className="grid size-8 place-items-center rounded-md bg-nav-active text-sm font-bold text-on-primary">L</span>
        <span className="leading-tight">
          <span className="block text-sm font-semibold text-on-primary">Label MES</span>
          <span className="block text-[11px] text-nav-muted">Manufacturing</span>
        </span>
      </Link>
      <div className="flex-1 space-y-1 overflow-y-auto p-3">
        <NavLink to={DASHBOARD.path} end className={linkClass} onClick={onNavigate}>
          <DASHBOARD.icon className="size-4" /> {DASHBOARD.label}
        </NavLink>
        {can("shopfloor.handheld") && (
          <a href="/hh" target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-3 py-1.5 text-sm text-nav-text hover:bg-nav-hover">
            <ScanLine className="size-4" /> Handheld app
          </a>
        )}
        <div className="pt-2">{business.map(group)}</div>
        {supporting.length > 0 && <div className="mt-3 border-t border-nav-hover pt-3">{supporting.map(group)}</div>}
      </div>
    </nav>
  );
}

function UserMenu() {
  const { session, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  if (!session) return null;
  const initials = session.user.fullName
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-soft" aria-haspopup="menu" aria-expanded={open}>
        <span className="grid size-8 place-items-center rounded-full bg-primary-soft text-xs font-semibold text-primary">{initials}</span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-sm font-medium">{session.user.fullName}</span>
          <span className="block text-xs text-muted">{session.user.username}</span>
        </span>
        <ChevronDown className="size-4 text-muted" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute right-0 z-40 mt-1 w-64 rounded-lg border border-line bg-surface p-1 shadow-lg">
            <div className="border-b border-line px-3 py-2">
              <p className="text-sm font-medium">{session.user.fullName}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {session.roles.length ? session.roles.map((r) => <Badge key={r}>{r.replace(/_/g, " ").toLowerCase()}</Badge>) : <span className="text-xs text-muted">No role assigned</span>}
              </div>
            </div>
            <Link role="menuitem" to="/account/password" onClick={() => setOpen(false)} className="flex items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-neutral-soft">
              <KeyRound className="size-4" /> Change password
            </Link>
            <button role="menuitem" onClick={() => void signOut()} className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-danger hover:bg-danger-soft">
              <LogOut className="size-4" /> Sign out
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const { pathname } = useLocation();
  const theme = useTheme();
  useEffect(() => setDrawer(false), [pathname]);

  return (
    <div className="flex h-full">
      <aside className="hidden w-64 shrink-0 lg:block">
        <Sidebar />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw]">
            <Sidebar onNavigate={() => setDrawer(false)} />
            <button className="absolute top-3 -right-11 rounded-md bg-surface p-2" onClick={() => setDrawer(false)} aria-label="Close menu">
              <X className="size-5" />
            </button>
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-surface px-2 sm:px-4">
          <button className="rounded-md p-2 hover:bg-neutral-soft lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold lg:invisible">{locateNav(pathname)?.page.label ?? "Dashboard"}</span>
          <button onClick={theme.toggle} className="rounded-md p-2 text-muted hover:bg-neutral-soft hover:text-text" aria-label="Toggle dark mode">
            {theme.isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <UserMenu />
        </header>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-3 pt-4 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6 sm:py-6">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
