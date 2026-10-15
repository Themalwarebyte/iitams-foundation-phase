import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Activity,
  ClipboardList,
  Clock,
  FolderOpen,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react";
import { AdminPageShell } from "./AdminShell";
import { KpiCard } from "@/components/iitams/KpiCard";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { formatRelative } from "@/lib/format";

/**
 * Administration Dashboard (Phase 3A — read-only overview).
 * Every figure comes from the admin.view-gated `adminOverview` query:
 * directory size/actives, engagement counts, open corrective actions and the
 * most recent entries in the immutable audit log. No invented metrics.
 */
export function AdminDashboardPage() {
  const data = useQuery(api.admin.adminOverview, {});

  return (
    <AdminPageShell
      path="/admin/dashboard"
      title="Administration Dashboard"
      description="Directory, workspace and administrative activity for your organization. Administration is tenant-scoped: only your own organization's data is shown."
    >
      {data === undefined ? (
        <ListSkeleton rows={4} />
      ) : data === null ? (
        <EmptyState
          icon={ShieldCheck}
          title="No organization context"
          description="Your account is not provisioned into an organization yet, so there is no administrative data to show."
        />
      ) : (
        <div className="space-y-6">
          <section aria-label="Administrative key indicators">
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <KpiCard
                label="Directory members"
                value={data.directory.totalMembers}
                icon={Users}
                tone="primary"
                hint="Provisioned profiles in this organization"
              />
              <KpiCard
                label="Active in last 30 days"
                value={data.directory.activeMembers}
                icon={UserCheck}
                tone="success"
                hint="Members with recorded activity"
              />
              <KpiCard
                label="Engagements"
                value={data.audit.totalEngagements}
                icon={FolderOpen}
                tone="info"
                hint={`${data.audit.activeEngagements} currently active`}
              />
              <KpiCard
                label="Open corrective actions"
                value={data.pendingActions}
                icon={ClipboardList}
                tone={data.pendingActions > 0 ? "warning" : "neutral"}
                hint="Awaiting remediation or verification"
              />
            </div>
          </section>

          <section
            aria-label="Recent administrative activity"
            className="rounded-lg border border-border/70 bg-card"
          >
            <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
              <Activity className="size-4 text-muted-foreground" aria-hidden />
              <h2 className="text-sm font-semibold">Recent administrative activity</h2>
              <span className="ml-auto text-xs text-muted-foreground">
                Immutable audit log — newest first
              </span>
            </div>
            {data.recentAdministrativeActivity.length === 0 ? (
              <div className="px-4 py-8">
                <EmptyState
                  icon={Clock}
                  title="No recorded activity yet"
                  description="Significant actions across the platform are recorded in the immutable audit log. Entries will appear here as they happen."
                />
              </div>
            ) : (
              <ol className="divide-y divide-border/50">
                {data.recentAdministrativeActivity.map((entry) => (
                  <li key={entry.id} className="flex items-start gap-3 px-4 py-3">
                    <span
                      aria-hidden
                      className="mt-1.5 inline-block size-1.5 shrink-0 rounded-full bg-primary/70"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{entry.summary}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        <span className="font-mono">{entry.action}</span>
                        <span aria-hidden>·</span>
                        <span>{entry.actor}</span>
                      </p>
                    </div>
                    <time
                      dateTime={new Date(entry.createdAt).toISOString()}
                      className="shrink-0 text-xs tabular-nums text-muted-foreground"
                    >
                      {formatRelative(entry.createdAt)}
                    </time>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>
      )}
    </AdminPageShell>
  );
}
