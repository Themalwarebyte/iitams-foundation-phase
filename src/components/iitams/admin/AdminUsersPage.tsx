import { useMemo, useState } from "react";
import { PauseCircle, PlayCircle, UserMinus, Users } from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { AdminPageShell } from "./AdminShell";
import {
  DataTable,
  EmptyState,
  ListSkeleton,
  SearchFilterBar,
} from "@/components/iitams/audit/ListPageShell";
import type { Column } from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import { StatusChip, statusLabel } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import {
  MEMBERSHIP_STATUS_LABELS,
  type MembershipStatus,
} from "@/lib/membership";

interface DirectoryRow {
  _id: string;
  name: string;
  email: string | null;
  isAnonymous: boolean;
  role: string;
  provisioned: boolean;
  membershipStatus: MembershipStatus;
  jobTitle?: string;
  lastSeenAt?: number;
}

const ROLE_META: Record<string, string> = {
  admin: "Administrator",
  user: "Assurance User",
  member: "Member",
  audit_director: "Audit Director",
  audit_manager: "Audit Manager",
  auditor: "Auditor",
  audit_reviewer: "Audit Reviewer",
  management_user: "Management User",
  executive_viewer: "Executive Viewer",
};

function roleLabel(role: string): string {
  return ROLE_META[role] ?? statusLabel(role);
}

/**
 * User directory (Phase 3A — Batch 2A).
 * Displays name, email, organization membership, role and the real
 * organization-membership lifecycle status for every provisioned profile in
 * the caller's organization. Administrators holding `admin.manage` may
 * suspend, deactivate and reactivate memberships; every control is
 * server-enforced (tenant match, no self-change, no last-admin lockout) and
 * audited. Role changes, deletion and invitations remain out of scope.
 */
export function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const session = useQuery(api.session.getSession);
  const rows = useQuery(api.admin.listUsers, {});
  const setStatus = useMutation(api.admin.setMembershipStatus);

  // Server-side permission decides whether lifecycle controls render; the
  // mutation independently re-checks `admin.manage` (UX gate only).
  const canManage = session?.permissions?.adminManage === true;

  // Role options derive from the live directory (real data, no invented tiers).
  const roleOptions = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((r) => r.role))].sort().map((r) => ({
      value: r,
      label: roleLabel(r),
    }));
  }, [rows]);

  const statusOptions = useMemo(
    () =>
      (Object.keys(MEMBERSHIP_STATUS_LABELS) as MembershipStatus[]).map(
        (s) => ({ value: s, label: MEMBERSHIP_STATUS_LABELS[s] }),
      ),
    [],
  );

  async function changeMembership(row: DirectoryRow, next: MembershipStatus) {
    setPendingId(row._id);
    try {
      await setStatus({ profileId: row._id as never, status: next });
      toast.success(
        `${row.name} — membership ${next === "active" ? "reactivated" : next}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Membership change was refused.",
      );
    } finally {
      setPendingId(null);
    }
  }

  const columns: Column<DirectoryRow>[] = useMemo(() => {
    const cols: Column<DirectoryRow>[] = [
      {
        header: "User",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">
              {r.name}
              {r.isAnonymous && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Guest
                </span>
              )}
            </p>
            {r.jobTitle && (
              <p className="truncate text-xs text-muted-foreground">{r.jobTitle}</p>
            )}
          </div>
        ),
      },
      {
        header: "Email",
        render: (r) => (
          <span className="text-sm text-muted-foreground">{r.email ?? "—"}</span>
        ),
      },
      {
        header: "Organization",
        render: () => (
          <span className="text-sm text-muted-foreground">Current organization</span>
        ),
      },
      {
        header: "Role",
        render: (r) => (
          <span className="text-sm font-medium">{roleLabel(r.role)}</span>
        ),
      },
      {
        // Batch 2A: the real organization-membership lifecycle state —
        // suspended/deactivated members lose server-side org access unless
        // reactivated by an administrator holding admin.manage.
        header: "Membership",
        render: (r) => (
          <StatusChip status={r.provisioned ? r.membershipStatus : "not_started"} />
        ),
      },
      {
        header: "Last seen",
        render: (r) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {r.lastSeenAt ? formatRelative(r.lastSeenAt) : "—"}
          </span>
        ),
      },
    ];

    if (canManage) {
      cols.push({
        header: "Manage",
        render: (r) => {
          if (!r.provisioned) return null;
          const busy = pendingId === r._id;
          return (
            <div className="flex items-center gap-1.5">
              {r.membershipStatus === "active" ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Temporarily suspend this membership (server-enforced, audited)"
                    onClick={() => void changeMembership(r, "suspended")}
                  >
                    <PauseCircle className="size-3.5" aria-hidden />
                    Suspend
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Deactivate this membership (server-enforced, audited)"
                    onClick={() => void changeMembership(r, "deactivated")}
                  >
                    <UserMinus className="size-3.5" aria-hidden />
                    Deactivate
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Reactivate this membership (server-enforced, audited)"
                  onClick={() => void changeMembership(r, "active")}
                >
                  <PlayCircle className="size-3.5" aria-hidden />
                  Reactivate
                </Button>
              )}
            </div>
          );
        },
      });
    }

    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, pendingId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    let out = rows;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.jobTitle ?? "").toLowerCase().includes(q),
      );
    }
    if (roleFilter) out = out.filter((r) => r.role === roleFilter);
    if (statusFilter) out = out.filter((r) => r.membershipStatus === statusFilter);
    return out;
  }, [rows, search, roleFilter, statusFilter]);

  return (
    <AdminPageShell
      path="/admin/users"
      title="Users"
      description="Directory of provisioned members in your organization — name, email, membership, role and organization-membership status. Administrators can suspend, deactivate and reactivate memberships; every change is authorization-checked server-side and logged in the audit trail."
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by name, email or job title…"
        filters={[
          {
            label: "Role",
            value: roleFilter,
            onChange: setRoleFilter,
            options: [{ value: "", label: "All roles" }, ...roleOptions],
          },
          {
            label: "Membership",
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: "", label: "All memberships" },
              ...statusOptions,
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            search || roleFilter || statusFilter
              ? "No matching users"
              : "No directory members yet"
          }
          description={
            search || roleFilter || statusFilter
              ? "Adjust the search or filters to find directory members."
              : "Users appear here once they are provisioned into your organization with a role assignment."
          }
        />
      ) : (
        <DataTable columns={columns} rows={filtered} rowKey={(r) => r._id} />
      )}
    </AdminPageShell>
  );
}
