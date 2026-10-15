import { Loader2, ShieldAlert } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { RequireAuth } from "@/components/RequireAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "react-router";
import type { ReactNode } from "react";

/**
 * Administration wrapper: authentication plus the admin.view UX gate in one
 * reusable element (kept here, with the other admin-shell components, so the
 * router file stays free of component definitions).
 */
export function AdminRoute({ children }: { children: ReactNode }) {
  return (
    <RequireAuth
      title="Sign in to open Administration"
      description="Administrative pages are available to authorized administrators of your organization."
    >
      {children}
    </RequireAuth>
  );
}

/**
 * Administration route guard (Phase 3A).
 * =====================================
 * UX mirror of the server-side `admin.view` permission check. Every
 * /admin/* page renders inside this gate; the server never trusts it
 * (each admin query independently calls requirePermission(ctx, "admin.view")).
 *
 * Fail states are explicit rather than silent:
 *  - session still loading → spinner;
 *  - signed in without admin.view → "not authorized" panel (no nav, no data);
 *  - everything else → children.
 */
export function AdminGate({ path, children }: { path: string; children: ReactNode }) {
  const session = useQuery(api.session.getSession);

  if (session === undefined) {
    return (
      <AppLayout>
        <div className="flex min-h-[50vh] items-center justify-center" aria-busy="true">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        </div>
      </AppLayout>
    );
  }

  if (session?.permissions?.admin !== true) {
    return (
      <AppLayout>
        <Breadcrumbs path={path} />
        <Card className="mx-auto max-w-md border-dashed shadow-none">
          <CardHeader className="text-center">
            <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
              <ShieldAlert className="size-5 text-muted-foreground" aria-hidden />
            </div>
            <CardTitle>Administration is not available for your role</CardTitle>
            <CardDescription>
              Administrative pages require the <code>admin.view</code> permission.
              Ask your system administrator if you believe this is an error.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <Button variant="outline" asChild>
              <Link to="/dashboard">Back to dashboard</Link>
            </Button>
          </CardContent>
        </Card>
      </AppLayout>
    );
  }

  return <>{children}</>;
}

/**
 * Standard header for admin pages. Kept separate from ListPageShell (audit
 * module) so the Administration group keeps its own eyebrow styling without
 * coupling the two modules together.
 */
export function AdminPageShell({
  path,
  title,
  description,
  children,
}: {
  path: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <PageHeader eyebrow="Administration" title={title} description={description} />
      {children}
    </AppLayout>
  );
}
