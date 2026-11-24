import { Construction, Lock } from "lucide-react";
import { Link, useLocation } from "react-router";
import { PageHeader } from "@/components/common";
import { Button, Card } from "@/components/ui";
import { locateNav, PHASE_NAMES, type NavPage } from "@/config/navigation";

/** Menu page whose phase hasn't been built yet - says so plainly. */
export function NotBuiltPage({ page }: { page: NavPage }) {
  const loc = locateNav(page.path);
  return (
    <>
      <PageHeader title={page.label} crumbs={[{ label: loc?.module.label ?? "" }, { label: page.label }]} />
      <Card>
        <div className="flex flex-col items-start gap-3 py-4 sm:flex-row">
          <Construction className="size-8 shrink-0 text-warning" />
          <div>
            <p className="font-medium">Not built yet – scheduled for {PHASE_NAMES[page.phase]}.</p>
            <p className="mt-1 text-sm text-muted">{page.summary}</p>
            <p className="mt-3 text-sm text-muted">
              This menu item is in place so the TBS structure stays familiar. It has no working functions until its phase is delivered.
            </p>
          </div>
        </div>
      </Card>
    </>
  );
}

export function ForbiddenPage() {
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <Lock className="size-8 text-muted" />
        <p className="font-medium">You don't have access to this page.</p>
        <p className="text-sm text-muted">Ask a system administrator if you need it for your work.</p>
        <Link to="/">
          <Button size="sm">Go to Dashboard</Button>
        </Link>
      </div>
    </Card>
  );
}

export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <Card>
      <div className="flex flex-col items-center gap-3 py-10 text-center">
        <p className="font-medium">Page not found</p>
        <p className="text-sm break-all text-muted">{pathname}</p>
        <Link to="/">
          <Button size="sm">Go to Dashboard</Button>
        </Link>
      </div>
    </Card>
  );
}
