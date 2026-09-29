import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { Flame, Plus, Send, MessageSquareWarning } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { SeverityBadge, StatusChip, statusLabel } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import type { Severity } from "@/lib/severity";
import {
  FINDING_LABELS,
  FINDING_TRANSITIONS,
  findingTransitionAllowed,
  type FindingStatus,
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
 * Module 8 — Findings lifecycle: identified → draft → reviewed →
 * management_response → corrective_action → closed, with severity ratings,
 * the full finding attribute set, and role-guarded transitions.
 */

interface FindingRow {
  _id: string;
  engagementId?: string;
  code: string;
  title: string;
  description?: string;
  condition?: string;
  criteria?: string;
  rootCause?: string;
  impact?: string;
  recommendation?: string;
  severity: string;
  status: string;
  ownerName?: string;
  dueDate?: number;
  managementResponse?: string;
}

const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;

export function FindingsPage({ path }: { path: string }) {
  const [search, setSearch] = useState("");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;

  const rows = useQuery(api.auditFindings.list, {
    search: search || undefined,
    severity: severityFilter === "all" ? undefined : (severityFilter as never),
    status: statusFilter === "all" ? undefined : statusFilter,
  });

  const columns: Column<FindingRow>[] = [
    {
      header: "Ref",
      className: "w-20 font-mono text-xs",
      render: (r) => r.code,
    },
    {
      header: "Finding",
      render: (r) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{r.title}</p>
          <p className="truncate text-xs text-muted-foreground">
            {r.ownerName ? `Owner: ${r.ownerName}` : "No owner recorded"}
          </p>
        </div>
      ),
    },
    {
      header: "Severity",
      render: (r) => <SeverityBadge severity={r.severity as Severity} />,
    },
    {
      header: "Status",
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      header: "Due",
      render: (r) => (r.dueDate ? formatRelative(r.dueDate) : "—"),
    },
  ];

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Findings"
      description="Weaknesses identified during audits, tracked through review, management response and corrective action to closure."
      actions={
        canManage && (
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" aria-hidden /> New finding
          </Button>
        )
      }
    >
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search findings…"
        filters={[
          {
            label: "Severity",
            value: severityFilter,
            onChange: setSeverityFilter,
            options: [
              { value: "all", label: "All severities" },
              ...SEVERITIES.map((s) => ({ value: s, label: statusLabel(s) })),
            ],
          },
          {
            label: "Stage",
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: "all", label: "All stages" },
              ...Object.entries(FINDING_LABELS).map(([k, v]) => ({
                value: k,
                label: v,
              })),
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Flame}
          title="No findings"
          description="Findings are raised from engagements by assigned auditors. Filter by severity or lifecycle stage."
        />
      ) : (
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(r) => r._id}
          onRowClick={(r) => setOpenId(r._id)}
        />
      )}

      {canManage && <CreateFindingDialog open={createOpen} onClose={() => setCreateOpen(false)} />}
      <FindingDetailDialog id={openId} onClose={() => setOpenId(null)} />
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Detail dialog
// ---------------------------------------------------------------------------

function FindingDetailDialog({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  // Hooks first (unconditional), then early returns.
  const finding = useQuery(api.auditFindings.get, id ? { id: id as never } : "skip");
  const fEngagementId = (finding as FindingRow | null | undefined)?.engagementId;
  const myRole = useQuery(
    api.auditEngagements.myEngagementRole,
    fEngagementId ? { engagementId: fEngagementId as never } : "skip",
  );
  const transition = useMutation(api.auditFindings.transition);
  const respond = useMutation(api.auditFindings.recordManagementResponse);
  const [response, setResponse] = useState("");
  const [busy, setBusy] = useState(false);

  if (!id) return null;
  if (finding === undefined) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <ListSkeleton rows={3} />
        </DialogContent>
      </Dialog>
    );
  }
  if (finding === null) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="sm:max-w-2xl">
          <p className="text-sm text-muted-foreground">Finding not found.</p>
        </DialogContent>
      </Dialog>
    );
  }

  const f = finding as unknown as FindingRow;
  const teamRole = (myRole?.teamRole ?? undefined) as
    | import("@/lib/auditWorkflow").AuditTeamRole
    | undefined;
  const platformPrivileged =
    myRole?.isManagerLike === true;

  const legalTargets = (
    FINDING_TRANSITIONS[f.status as FindingStatus] ?? []
  ).filter(
    (to) =>
      platformPrivileged ||
      findingTransitionAllowed(f.status as FindingStatus, to, teamRole),
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">{f.code}</span>
            {f.title}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2">
            <SeverityBadge severity={f.severity as Severity} />
            <StatusChip status={f.status} />
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="grid gap-3 sm:grid-cols-2">
            <DetailField label="Condition" value={f.condition} />
            <DetailField label="Criteria" value={f.criteria} />
            <DetailField label="Root cause" value={f.rootCause} />
            <DetailField label="Impact" value={f.impact} />
            <DetailField label="Recommendation" value={f.recommendation} />
            <DetailField label="Owner" value={f.ownerName} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Due date
            </p>
            <p>{f.dueDate ? formatRelative(f.dueDate) : "—"}</p>
          </div>

          {f.managementResponse && (
            <div className="rounded-lg border border-info/30 bg-info/5 px-3 py-2">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-info">
                <MessageSquareWarning className="size-3.5" aria-hidden />
                Management response
              </p>
              <p className="mt-1 whitespace-pre-wrap">{f.managementResponse}</p>
            </div>
          )}

          {/* Management response form (reviewed stage) */}
          {f.status === "reviewed" && platformPrivileged && (
            <div className="space-y-1.5">
              <Label htmlFor="f-resp">Management response</Label>
              <Textarea
                id="f-resp"
                rows={3}
                value={response}
                onChange={(e) => setResponse(e.target.value)}
                placeholder="Management's agreed response and action plan…"
              />
              <Button
                size="sm"
                disabled={!response || busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await respond({ id: f._id as never, response });
                    toast.success("Management response recorded");
                    setResponse("");
                  } catch (err) {
                    toast.error(err instanceof Error ? err.message : "Failed");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <Send className="size-4" aria-hidden /> Record response
              </Button>
            </div>
          )}

          {/* Lifecycle transitions */}
          {legalTargets.length > 0 && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Move to:
              </span>
              {legalTargets.map((to) => (
                <Button
                  key={to}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await transition({ id: f._id as never, to });
                      toast.success(`Finding → ${FINDING_LABELS[to as FindingStatus]}`);
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed");
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  {FINDING_LABELS[to as FindingStatus]}
                </Button>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function DetailField({ label, value }: { label: string; value?: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <p className="mt-0.5">
        {value || <span className="text-muted-foreground">Not recorded</span>}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create dialog
// ---------------------------------------------------------------------------

function CreateFindingDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const engagements = useQuery(api.auditEngagements.listMine, open ? {} : "skip");
  const create = useMutation(api.auditFindings.create);
  const [engagementId, setEngagementId] = useState("");
  const [title, setTitle] = useState("");
  const [severity, setSeverity] = useState("medium");
  const [condition, setCondition] = useState("");
  const [criteria, setCriteria] = useState("");
  const [rootCause, setRootCause] = useState("");
  const [impact, setImpact] = useState("");
  const [recommendation, setRecommendation] = useState("");
  const [ownerName, setOwnerName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Raise finding</DialogTitle>
          <DialogDescription>
            Created in the Identified stage; moves through review and management
            response to closure.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Engagement *</Label>
            <Select value={engagementId} onValueChange={setEngagementId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select engagement" />
              </SelectTrigger>
              <SelectContent>
                {(engagements ?? []).map(({ engagement }) => (
                  <SelectItem key={engagement._id} value={engagement._id}>
                    {engagement.code} — {engagement.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-title">Title *</Label>
            <Input id="f-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Severity *</Label>
              <Select value={severity} onValueChange={setSeverity}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {statusLabel(s)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-owner">Owner</Label>
              <Input id="f-owner" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="f-cond">Condition</Label>
              <Textarea id="f-cond" rows={2} value={condition} onChange={(e) => setCondition(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-crit">Criteria</Label>
              <Textarea id="f-crit" rows={2} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-rc">Root cause</Label>
              <Textarea id="f-rc" rows={2} value={rootCause} onChange={(e) => setRootCause(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="f-imp">Impact</Label>
              <Textarea id="f-imp" rows={2} value={impact} onChange={(e) => setImpact(e.target.value)} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="f-rec">Recommendation</Label>
            <Textarea
              id="f-rec"
              rows={2}
              value={recommendation}
              onChange={(e) => setRecommendation(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!engagementId || !title || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await create({
                  engagementId: engagementId as never,
                  title,
                  severity: severity as never,
                  condition: condition || undefined,
                  criteria: criteria || undefined,
                  rootCause: rootCause || undefined,
                  impact: impact || undefined,
                  recommendation: recommendation || undefined,
                  ownerName: ownerName || undefined,
                });
                toast.success(`Finding ${res.code} created`);
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create finding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
