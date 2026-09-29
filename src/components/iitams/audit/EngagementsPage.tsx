import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import {
  FolderOpen,
  Plus,
  UserPlus,
  Trash2,
  CheckCircle2,
  Circle,
  XCircle,
} from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import {
  ENGAGEMENT_ORDER,
  ENGAGEMENT_LABELS,
  ENGAGEMENT_TRANSITIONS,
  AUDIT_TEAM_ROLES,
  AUDIT_TEAM_ROLE_LABELS,
  engagementTransitionAllowed,
  type EngagementStatus,
  type AuditTeamRole,
} from "@/lib/auditWorkflow";
import {
  ListPageShell,
  SearchFilterBar,
  DataTable,
  ListSkeleton,
  EmptyState,
} from "./ListPageShell";
import type { Column } from "./ListPageShell";

/**
 * Modules 3 + 4 — Audit engagements and team assignment. The seven-stage
 * lifecycle is driven by role-guarded transition buttons mirrored from the
 * server-side state machine; the server remains authoritative.
 */

interface EngagementRow {
  _id: string;
  code: string;
  name: string;
  status: string;
  progressPct: number;
  auditManagerName?: string;
  startDate?: number;
  targetEndDate?: number;
  planId?: string;
  universeItemId?: string;
  objective?: string;
  scope?: string;
  criteria?: string;
}

export function EngagementsPage({ path }: { path: string }) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;

  const rows = useQuery(api.auditEngagements.list, {
    search: search || undefined,
    status: statusFilter === "all" ? undefined : statusFilter,
  });
  const selected = rows?.find((r) => r._id === selectedId) ?? null;

  const columns: Column<EngagementRow>[] = useMemo(
    () => [
      {
        header: "Number",
        className: "w-36 font-mono text-xs",
        render: (r) => r.code,
      },
      {
        header: "Title",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{r.name}</p>
            {r.auditManagerName && (
              <p className="truncate text-xs text-muted-foreground">
                Manager: {r.auditManagerName}
              </p>
            )}
          </div>
        ),
      },
      {
        header: "Stage",
        render: (r) => <StatusChip status={r.status} />,
      },
      {
        header: "Progress",
        className: "w-24 tabular-nums",
        render: (r) => `${r.progressPct}%`,
      },
      {
        header: "Target end",
        render: (r) =>
          r.targetEndDate ? formatRelative(r.targetEndDate) : "—",
      },
    ],
    [],
  );

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Audit Engagements"
      description="Individual audit assignments moving through the Draft → Planning → Approved → Fieldwork → Review → Report Issued → Closed lifecycle."
      actions={
        canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New engagement
          </Button>
        )
      }
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by number or title…"
        filters={[
          {
            label: "Stage",
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: "all", label: "All stages" },
              ...ENGAGEMENT_ORDER.map((s) => ({
                value: s,
                label: ENGAGEMENT_LABELS[s],
              })),
              { value: "cancelled", label: "Cancelled" },
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FolderOpen}
          title="No engagements"
          description="Create an engagement from an approved plan item, or directly, to begin managing an audit assignment."
          action={
            canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus className="size-4" aria-hidden /> Create engagement
              </Button>
            )
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(r) => r._id}
            onRowClick={(r) =>
              setSelectedId((cur) => (cur === r._id ? null : r._id))
            }
          />
          {selected && <EngagementDetail engagement={selected} />}
        </>
      )}

      <CreateEngagementDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Detail panel: stepper + transitions + team
// ---------------------------------------------------------------------------

function EngagementDetail({ engagement }: { engagement: EngagementRow }) {
  const role = useQuery(api.auditEngagements.myEngagementRole, {
    engagementId: engagement._id as never,
  });
  const transition = useMutation(api.auditEngagements.transition);

  const current = engagement.status as EngagementStatus;
  const stageIdx = ENGAGEMENT_ORDER.indexOf(current);
  const isCancelled = current === "cancelled";

  const legalTargets = (ENGAGEMENT_TRANSITIONS[current] ?? []).filter((to) =>
    engagementTransitionAllowed(
      current,
      to,
      (role?.teamRole ?? undefined) as AuditTeamRole | undefined,
    ),
  );

  return (
    <Card className="mt-4 shadow-none">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-3 text-lg">
          <span className="font-mono text-sm text-muted-foreground">
            {engagement.code}
          </span>
          {engagement.name}
          <StatusChip status={engagement.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Stage stepper */}
        <ol className="flex flex-wrap items-center gap-1.5 text-xs" aria-label="Lifecycle stages">
          {ENGAGEMENT_ORDER.map((stage, i) => {
            const done = !isCancelled && stageIdx >= 0 && i < stageIdx;
            const active = current === stage;
            return (
              <li key={stage} className="flex items-center gap-1.5">
                {done ? (
                  <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                ) : active ? (
                  <span
                    className="inline-block size-2.5 rounded-full bg-primary ring-2 ring-primary/30"
                    aria-hidden
                  />
                ) : (
                  <Circle className="size-3 text-muted-foreground/40" aria-hidden />
                )}
                <span
                  className={
                    active
                      ? "font-semibold text-foreground"
                      : done
                        ? "text-foreground/80"
                        : "text-muted-foreground"
                  }
                >
                  {ENGAGEMENT_LABELS[stage]}
                </span>
                {i < ENGAGEMENT_ORDER.length - 1 && (
                  <span className="text-muted-foreground/40" aria-hidden>
                    →
                  </span>
                )}
              </li>
            );
          })}
          {isCancelled && (
            <li className="flex items-center gap-1.5 text-critical">
              <XCircle className="size-3.5" aria-hidden /> Cancelled
            </li>
          )}
        </ol>

        <div className="grid gap-4 sm:grid-cols-3">
          <DetailField label="Objective" value={engagement.objective} />
          <DetailField label="Scope" value={engagement.scope} />
          <DetailField label="Criteria" value={engagement.criteria} />
        </div>

        {/* Transitions */}
        {legalTargets.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Move to:
            </span>
            {legalTargets.map((to) => (
              <Button
                key={to}
                size="sm"
                variant={to === "cancelled" ? "destructive" : "outline"}
                onClick={async () => {
                  try {
                    await transition({ id: engagement._id as never, to });
                    toast.success(
                      `${engagement.code} → ${ENGAGEMENT_LABELS[to as EngagementStatus]}`,
                    );
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Transition failed",
                    );
                  }
                }}
              >
                {ENGAGEMENT_LABELS[to as EngagementStatus]}
              </Button>
            ))}
            {role?.teamRole === null && !role?.isManagerLike && (
              <span className="text-xs text-muted-foreground">
                (assignment-based actions hidden)
              </span>
            )}
          </div>
        )}

        <TeamSection engagementId={engagement._id} canSee={true} />
      </CardContent>
    </Card>
  );
}

function DetailField({
  label,
  value,
}: {
  label: string;
  value?: string;
}) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm">
        {value || <span className="text-muted-foreground">Not recorded</span>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Team (Module 4)
// ---------------------------------------------------------------------------

function TeamSection({
  engagementId,
  canSee,
}: {
  engagementId: string;
  canSee: boolean;
}) {
  const team = useQuery(
    api.auditEngagements.listTeam,
    canSee ? { engagementId: engagementId as never } : "skip",
  );
  const role = useQuery(api.auditEngagements.myEngagementRole, {
    engagementId: engagementId as never,
  });
  const unassign = useMutation(api.auditEngagements.unassignMember);
  const [assignOpen, setAssignOpen] = useState(false);

  if (!canSee) return null;
  const canManageTeam = role?.isManagerLike === true;

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-semibold">Audit team</h3>
        {canManageTeam && (
          <Button size="sm" variant="outline" onClick={() => setAssignOpen(true)}>
            <UserPlus className="size-4" aria-hidden /> Assign member
          </Button>
        )}
      </div>
      {team === undefined ? (
        <p className="text-sm text-muted-foreground">Loading team…</p>
      ) : team.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No members assigned yet.
        </p>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2">
          {team.map((m) => (
            <li
              key={m._id}
              className="flex items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{m.userName}</p>
                <p className="text-xs text-muted-foreground">
                  {AUDIT_TEAM_ROLE_LABELS[m.teamRole as AuditTeamRole] ??
                    m.teamRole}
                </p>
              </div>
              {canManageTeam && (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${m.userName} from team`}
                  onClick={async () => {
                    try {
                      await unassign({ assignmentId: m._id as never });
                      toast.success("Team member removed");
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Failed",
                      );
                    }
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <AssignMemberDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        engagementId={engagementId}
      />
    </div>
  );
}

function AssignMemberDialog({
  open,
  onClose,
  engagementId,
}: {
  open: boolean;
  onClose: () => void;
  engagementId: string;
}) {
  const users = useQuery(api.auditEngagements.listOrgUsers, open ? {} : "skip");
  const assign = useMutation(api.auditEngagements.assignMember);
  const [userId, setUserId] = useState("");
  const [teamRole, setTeamRole] = useState<string>("auditor");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign team member</DialogTitle>
          <DialogDescription>
            Only assigned users can perform activities on this engagement.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>User *</Label>
            <Select value={userId} onValueChange={setUserId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select a user" />
              </SelectTrigger>
              <SelectContent>
                {(users ?? []).map((u) => (
                  <SelectItem key={u.userId} value={u.userId}>
                    {u.label}
                    {u.jobTitle ? ` — ${u.jobTitle}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>Team role *</Label>
            <Select value={teamRole} onValueChange={setTeamRole}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AUDIT_TEAM_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {AUDIT_TEAM_ROLE_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!userId || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await assign({
                  engagementId: engagementId as never,
                  userId: userId as never,
                  teamRole: teamRole as never,
                });
                toast.success("Member assigned");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateEngagementDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const create = useMutation(api.auditEngagements.create);
  const plans = useQuery(api.auditPlans.listPlans, open ? {} : "skip");
  const universe = useQuery(
    api.auditUniverse.list,
    open ? { status: "active" } : "skip",
  );

  const [title, setTitle] = useState("");
  const [planId, setPlanId] = useState("none");
  const [universeItemId, setUniverseItemId] = useState("none");
  const [objective, setObjective] = useState("");
  const [scope, setScope] = useState("");
  const [criteria, setCriteria] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New audit engagement</DialogTitle>
          <DialogDescription>
            Created in Draft; progress through the lifecycle with role-guarded
            stage transitions.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="e-title">Title *</Label>
            <Input
              id="e-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Core Banking Platform Access Review"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label>Audit plan</Label>
              <Select value={planId} onValueChange={setPlanId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(plans ?? []).map((p) => (
                    <SelectItem key={p._id} value={p._id}>
                      {p.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Universe item</Label>
              <Select value={universeItemId} onValueChange={setUniverseItemId}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None</SelectItem>
                  {(universe ?? []).map((u) => (
                    <SelectItem key={u._id} value={u._id}>
                      {u.code} — {u.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="e-obj">Objective</Label>
            <Textarea
              id="e-obj"
              rows={2}
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              placeholder="e.g. Verify effectiveness of access controls…"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="e-scope">Scope</Label>
              <Textarea
                id="e-scope"
                rows={2}
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="e-crit">Criteria</Label>
              <Textarea
                id="e-crit"
                rows={2}
                value={criteria}
                onChange={(e) => setCriteria(e.target.value)}
                placeholder="Policies, standards, regulations…"
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!title || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await create({
                  title,
                  planId: planId === "none" ? undefined : (planId as never),
                  universeItemId:
                    universeItemId === "none"
                      ? undefined
                      : (universeItemId as never),
                  objective: objective || undefined,
                  scope: scope || undefined,
                  criteria: criteria || undefined,
                });
                toast.success(`Engagement ${res.code} created`);
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create engagement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
