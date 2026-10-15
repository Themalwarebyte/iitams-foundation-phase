import { useMemo, useState } from "react";
import { History } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdminPageShell } from "./AdminShell";
import {
  DataTable,
  EmptyState,
  ListSkeleton,
  SearchFilterBar,
} from "@/components/iitams/audit/ListPageShell";
import type { Column } from "@/components/iitams/audit/ListPageShell";
import { formatDateTime } from "@/lib/format";

interface LogRow {
  _id: string;
  action: string;
  summary?: string;
  actorLabel?: string;
  userId?: string;
  entityType: string;
  createdAt: number;
}

const PAGE_SIZES = [50, 100, 200];

/**
 * Administrative audit log viewer (Phase 3A — read-only).
 * Reads the immutable auditLogs table through the admin.view-gated
 * `listAuditLogs` query with user/action/date filters. There is no edit,
 * delete or export affordance anywhere on this page — the log is append-only
 * by design (insert-only invariant guarded by unit tests).
 */
export function AdminAuditLogsPage() {
  const [search, setSearch] = useState("");
  const [action, setAction] = useState("all");
  const [userId, setUserId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(100);

  const facets = useQuery(api.admin.auditLogFacets, {});
  const logs = useQuery(api.admin.listAuditLogs, {
    search: search || undefined,
    action: action === "all" ? undefined : action,
    userId: userId === "all" ? undefined : (userId as never),
    from: from ? new Date(from).getTime() : undefined,
    to: to ? new Date(to).getTime() + 86_399_000 : undefined, // inclusive end-of-day
    limit,
  });

  const userLabel = (id: string | undefined): string | null => {
    if (!id) return null;
    return facets?.users.find((u) => u.id === id)?.label ?? null;
  };

  const columns: Column<LogRow>[] = useMemo(
    () => [
      {
        header: "Time",
        className: "w-40 whitespace-nowrap",
        render: (r) => (
          <time
            dateTime={new Date(r.createdAt).toISOString()}
            className="text-xs tabular-nums text-muted-foreground"
          >
            {formatDateTime(r.createdAt)}
          </time>
        ),
      },
      {
        header: "Action",
        className: "w-56",
        render: (r) => (
          <span className="font-mono text-xs">{r.action}</span>
        ),
      },
      {
        header: "Summary",
        render: (r) => (
          <span className="block max-w-md truncate text-sm" title={r.summary}>
            {r.summary ?? "—"}
          </span>
        ),
      },
      {
        header: "Actor",
        className: "w-44",
        render: (r) => (
          <span className="text-sm">{r.actorLabel ?? userLabel(r.userId) ?? "System"}</span>
        ),
      },
      {
        header: "Entity",
        className: "w-44",
        render: (r) => (
          <span className="text-xs text-muted-foreground">{r.entityType}</span>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [facets],
  );

  const activeFilters =
    search !== "" || action !== "all" || userId !== "all" || from !== "" || to !== "";

  return (
    <AdminPageShell
      path="/admin/audit-logs"
      title="Audit Logs"
      description="Immutable trail of significant actions recorded across your organization. Read-only: entries can never be edited or deleted."
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search summaries, actors, actions…"
        filters={[
          {
            label: "Action",
            value: action,
            onChange: setAction,
            options: [
              { value: "all", label: "All actions" },
              ...(facets?.actions ?? []).map((a) => ({ value: a, label: a })),
            ],
          },
          {
            label: "User",
            value: userId,
            onChange: setUserId,
            options: [
              { value: "all", label: "All users" },
              ...(facets?.users ?? []).map((u) => ({ value: u.id, label: u.label })),
            ],
          },
        ]}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div className="flex flex-col gap-1">
          <label htmlFor="log-from" className="text-xs font-medium text-muted-foreground">
            From date
          </label>
          <input
            id="log-from"
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="log-to" className="text-xs font-medium text-muted-foreground">
            To date
          </label>
          <input
            id="log-to"
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor="log-limit" className="text-xs font-medium text-muted-foreground">
            Rows
          </label>
          <select
            id="log-limit"
            value={limit}
            onChange={(e) => setLimit(Number(e.target.value))}
            className="rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        {activeFilters && (
          <button
            type="button"
            onClick={() => {
              setSearch("");
              setAction("all");
              setUserId("all");
              setFrom("");
              setTo("");
            }}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            Clear filters
          </button>
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {logs === undefined ? "Loading…" : `${logs.length} entries`}
        </span>
      </div>

      {logs === undefined ? (
        <ListSkeleton />
      ) : logs.length === 0 ? (
        <EmptyState
          icon={History}
          title={activeFilters ? "No entries match these filters" : "No audit entries yet"}
          description={
            activeFilters
              ? "Try widening the date range or clearing filters."
              : "Significant actions across the platform are recorded here automatically as they happen."
          }
        />
      ) : (
        <DataTable columns={columns} rows={logs} rowKey={(r) => r._id} />
      )}
    </AdminPageShell>
  );
}
