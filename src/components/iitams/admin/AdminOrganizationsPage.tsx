import { Building2 } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdminPageShell } from "./AdminShell";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { StatusChip } from "@/components/iitams/badges";
import { formatDate } from "@/lib/format";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Organization management foundation (Phase 3A — read-only).
 * Tenant rule: an administrator sees only their own organization. The
 * `listOrganizations` query resolves exactly one row (the caller's org);
 * a system-wide multi-org capability does not exist in the access model,
 * so the page deliberately has no cross-tenant picker.
 */
export function AdminOrganizationsPage() {
  const rows = useQuery(api.admin.listOrganizations, {});

  return (
    <AdminPageShell
      path="/admin/organizations"
      title="Organizations"
      description="Your organization (MDAC) record with directory and audit usage. Organization creation, editing and cross-tenant administration arrive in a later batch."
    >
      {rows === undefined ? (
        <ListSkeleton rows={3} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organization record"
          description="Your account is not provisioned into an organization yet. An administrator must assign you to an organization before this page can show anything."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((org) => (
            <Card key={org._id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="truncate">{org.name}</CardTitle>
                    <CardDescription className="mt-0.5 font-mono text-xs">
                      {org.code}
                    </CardDescription>
                  </div>
                  <StatusChip status={org.status} />
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {org.description && (
                  <p className="text-sm leading-6 text-muted-foreground">{org.description}</p>
                )}
                <dl className="grid grid-cols-2 gap-3 text-sm">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Type
                    </dt>
                    <dd className="mt-0.5 font-medium capitalize">
                      {org.type.replace(/_/g, " ")}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Created
                    </dt>
                    <dd className="mt-0.5 font-medium">{formatDate(org.createdAt)}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Directory members
                    </dt>
                    <dd className="mt-0.5 font-medium tabular-nums">{org.userCount}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      Audit engagements
                    </dt>
                    <dd className="mt-0.5 font-medium tabular-nums">{org.auditCount}</dd>
                  </div>
                </dl>
                {org.isDemo && (
                  <p className="rounded-md bg-warning/15 px-3 py-2 text-xs font-medium text-foreground/90">
                    Demonstration organization — data is synthetic and clearly flagged; not
                    production statistics.
                  </p>
                )}
                <p className="text-xs text-muted-foreground">
                  Scope note: administration is tenant-scoped. Other MDACs' records are not
                  visible from this account, by design.
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AdminPageShell>
  );
}
