import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { ClipboardList, Plus, Trash2, ShieldCheck, Gauge } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { StatusChip, statusLabel } from "@/components/iitams/badges";
import {
  ListPageShell,
  DataTable,
  ListSkeleton,
  EmptyState,
} from "./ListPageShell";
import type { Column } from "./ListPageShell";

/**
 * Module 2 — Risk-based Audit Planning page. Plans with universe-item line
 * items; the audit priority score is computed server-side and banded
 * Low / Medium / High / Critical.
 */

interface PlanItemRow {
  _id: string;
  auditUniverseItemId: string;
  priorityScore: number;
  priorityBand: string;
  plannedStartDate?: number | null;
  plannedEndDate?: number | null;
  estimatedEffortDays?: number | null;
  assignedManagerName?: string | null;
  status: string;
  universeName: string;
  universeCode: string;
  universeCategory?: string | null;
  universeCriticality?: string | null;
}

const BAND_STYLES: Record<string, string> = {
  low: "bg-success/10 text-success border-success/25",
  medium: "bg-info/10 text-info border-info/25",
  high: "bg-warning/15 text-foreground/90 border-warning/40",
  critical: "bg-critical/10 text-critical border-critical/25",
};

function BandChip({ band }: { band: string }) {
  return (
    <Badge
      variant="outline"
      className={`gap-1 font-medium capitalize ${BAND_STYLES[band] ?? "bg-muted text-muted-foreground border-border"}`}
    >
      {band}
    </Badge>
  );
}

export function PlansPage({ path }: { path: string }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [planDialog, setPlanDialog] = useState(false);
  const [itemDialog, setItemDialog] = useState(false);

  const session = useQuery(api.session.getSession);
  const canManage = session?.permissions?.auditManage === true;

  const plans = useQuery(api.auditPlans.listPlans, {});
  const selected = plans?.find((p) => p._id === selectedId) ?? plans?.[0] ?? null;
  const planItems = useQuery(
    api.auditPlans.listPlanItems,
    selected ? { planId: selected._id as never } : "skip",
  );

  return (
    <ListPageShell
      path={path}
      eyebrow="Audit Management"
      title="Audit Plans"
      description="Risk-based annual and multi-year audit plans with universe coverage and priority scoring."
      actions={
        canManage && (
          <Button onClick={() => setPlanDialog(true)}>
            <Plus className="size-4" aria-hidden /> New plan
          </Button>
        )
      }
    >
      {plans === undefined ? (
        <ListSkeleton />
      ) : plans.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No audit plans"
          description="Create an audit plan, then schedule audit universe items into it with risk-based priority scoring."
          action={
            canManage && (
              <Button onClick={() => setPlanDialog(true)}>
                <Plus className="size-4" aria-hidden /> Create plan
              </Button>
            )
          }
        />
      ) : (
        <div className="space-y-4">
          {/* Plan selector cards */}
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {plans.map((p) => (
              <Card
                key={p._id}
                role="button"
                tabIndex={0}
                onClick={() => setSelectedId(p._id)}
                onKeyDown={(e) => e.key === "Enter" && setSelectedId(p._id)}
                className={`cursor-pointer transition-colors shadow-none ${
                  selected?._id === p._id
                    ? "border-primary/60 ring-1 ring-primary/30"
                    : "hover:border-border"
                }`}
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between gap-2 text-base">
                    <span className="truncate">{p.name}</span>
                    <StatusChip status={p.status} />
                  </CardTitle>
                </CardHeader>
                <CardContent className="text-sm text-muted-foreground">
                  <p>
                    FY {p.fiscalYear}
                    {p.period ? ` · ${p.period}` : ""}
                  </p>
                  <p className="mt-1 tabular-nums">
                    {p.completedEngagements}/{p.totalEngagements} engagements
                    completed
                  </p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Selected plan detail */}
          {selected && (
            <Card className="shadow-none">
              <CardHeader className="flex-row items-start justify-between space-y-0">
                <div>
                  <CardTitle className="text-lg">{selected.name}</CardTitle>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {selected.description ?? "No description recorded."}
                  </p>
                  {selected.coverageObjective && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Coverage objective: {selected.coverageObjective}
                    </p>
                  )}
                </div>
                {canManage && selected.status === "draft" && (
                  <ApproveButton planId={selected._id} />
                )}
              </CardHeader>
              <CardContent>
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-semibold">
                    Scheduled universe items
                  </h3>
                  {canManage && selected.status !== "closed" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setItemDialog(true)}
                    >
                      <Plus className="size-4" aria-hidden /> Add universe item
                    </Button>
                  )}
                </div>
                {planItems === undefined ? (
                  <ListSkeleton rows={3} />
                ) : planItems.length === 0 ? (
                  <p className="rounded-lg border border-dashed border-border/70 px-4 py-6 text-center text-sm text-muted-foreground">
                    No universe items scheduled into this plan yet.
                  </p>
                ) : (
                  <PlanItemsTable
                    rows={planItems}
                    canManage={canManage && selected.status !== "closed"}
                  />
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <CreatePlanDialog open={planDialog} onClose={() => setPlanDialog(false)} />
      {selected && (
        <AddItemDialog
          open={itemDialog}
          onClose={() => setItemDialog(false)}
          planId={selected._id}
          excludeIds={new Set((planItems ?? []).map((i) => i.auditUniverseItemId))}
        />
      )}
    </ListPageShell>
  );
}

function ApproveButton({ planId }: { planId: string }) {
  const approve = useMutation(api.auditPlans.approvePlan);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await approve({ id: planId as never });
          toast.success("Plan approved");
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Failed");
        } finally {
          setBusy(false);
        }
      }}
    >
      <ShieldCheck className="size-4" aria-hidden /> Approve
    </Button>
  );
}

function PlanItemsTable({
  rows,
  canManage,
}: {
  rows: PlanItemRow[];
  canManage: boolean;
}) {
  const removeItem = useMutation(api.auditPlans.removePlanItem);
  const columns: Column<PlanItemRow>[] = useMemo(
    () => [
      {
        header: "Priority",
        className: "w-24",
        render: (r) => (
          <span className="inline-flex items-center gap-1 font-semibold tabular-nums">
            <Gauge className="size-3.5 text-primary" aria-hidden />
            {r.priorityScore}
          </span>
        ),
      },
      {
        header: "Band",
        render: (r) => <BandChip band={r.priorityBand} />,
      },
      {
        header: "Universe item",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{r.universeName}</p>
            <p className="font-mono text-xs text-muted-foreground">
              {r.universeCode}
              {r.universeCategory ? ` · ${r.universeCategory}` : ""}
            </p>
          </div>
        ),
      },
      {
        header: "Manager",
        render: (r) => r.assignedManagerName ?? "—",
      },
      {
        header: "Effort",
        render: (r) =>
          r.estimatedEffortDays !== undefined ? `${r.estimatedEffortDays} d` : "—",
      },
      {
        header: "Status",
        render: (r) => <StatusChip status={r.status} />,
      },
      ...(canManage
        ? [
            {
              header: "",
              className: "w-10",
              render: (r: PlanItemRow) => (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Remove ${r.universeName} from plan`}
                  onClick={async () => {
                    try {
                      await removeItem({ id: r._id as never });
                      toast.success("Item removed from plan");
                    } catch (err) {
                      toast.error(
                        err instanceof Error ? err.message : "Failed",
                      );
                    }
                  }}
                >
                  <Trash2 className="size-4" aria-hidden />
                </Button>
              ),
            } satisfies Column<PlanItemRow>,
          ]
        : []),
    ],
    [canManage, removeItem],
  );
  return <DataTable columns={columns} rows={rows} rowKey={(r) => r._id} />;
}

function CreatePlanDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const createPlan = useMutation(api.auditPlans.createPlan);
  const [name, setName] = useState("");
  const [fiscalYear, setFiscalYear] = useState("2026/27");
  const [period, setPeriod] = useState("");
  const [coverageObjective, setCoverageObjective] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New audit plan</DialogTitle>
          <DialogDescription>
            Define the planning period and coverage objective. Universe items
            are scheduled into the plan afterwards with risk-based scoring.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="p-name">Plan name *</Label>
            <Input
              id="p-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. FY 2026/27 Risk-Based ICT Audit Plan"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-fy">Fiscal year *</Label>
              <Input
                id="p-fy"
                value={fiscalYear}
                onChange={(e) => setFiscalYear(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-period">Period</Label>
              <Input
                id="p-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value)}
                placeholder="e.g. 3-year rolling"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-cov">Coverage objective</Label>
            <Input
              id="p-cov"
              value={coverageObjective}
              onChange={(e) => setCoverageObjective(e.target.value)}
              placeholder="e.g. Cover all critical universe items annually"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-desc">Description</Label>
            <Textarea
              id="p-desc"
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!name || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await createPlan({
                  name,
                  fiscalYear,
                  period: period || undefined,
                  coverageObjective: coverageObjective || undefined,
                  description: description || undefined,
                });
                toast.success("Audit plan created");
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Create plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddItemDialog({
  open,
  onClose,
  planId,
  excludeIds,
}: {
  open: boolean;
  onClose: () => void;
  planId: string;
  excludeIds: Set<string>;
}) {
  const universe = useQuery(api.auditUniverse.list, { status: "active" });
  const addItem = useMutation(api.auditPlans.addPlanItem);
  const [universeItemId, setUniverseItemId] = useState("");
  const [previousFindings, setPreviousFindings] = useState(0);
  const [changeFrequency, setChangeFrequency] = useState(0);
  const [effort, setEffort] = useState("");
  const [busy, setBusy] = useState(false);

  const options = (universe ?? []).filter((u) => !excludeIds.has(u._id));
  const chosen = options.find((u) => u._id === universeItemId);

  const preview = useQuery(
    api.auditPlans.previewScore,
    universeItemId
      ? {
          auditUniverseItemId: universeItemId as never,
          previousFindings,
          changeFrequency,
        }
      : "skip",
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add universe item to plan</DialogTitle>
          <DialogDescription>
            The audit priority score is computed server-side from the item's
            criticality, data sensitivity, regulatory importance, security
            exposure, previous findings and change frequency.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Universe item *</Label>
            <Select value={universeItemId} onValueChange={setUniverseItemId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select an item" />
              </SelectTrigger>
              <SelectContent>
                {options.map((u) => (
                  <SelectItem key={u._id} value={u._id}>
                    {u.code} — {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="p-prev">Previous findings (0–5)</Label>
              <Input
                id="p-prev"
                type="number"
                min={0}
                max={5}
                value={previousFindings}
                onChange={(e) =>
                  setPreviousFindings(Math.max(0, Math.min(5, Number(e.target.value) || 0)))
                }
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="p-chg">Change frequency (0–5)</Label>
              <Input
                id="p-chg"
                type="number"
                min={0}
                max={5}
                value={changeFrequency}
                onChange={(e) =>
                  setChangeFrequency(Math.max(0, Math.min(5, Number(e.target.value) || 0)))
                }
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="p-effort">Estimated effort (days)</Label>
            <Input
              id="p-effort"
              type="number"
              min={1}
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
            />
          </div>
          {chosen && preview && (
            <div className="rounded-lg border bg-muted/40 px-4 py-3 text-sm">
              <p className="font-medium">
                Predicted priority:{" "}
                <span className="tabular-nums">{preview.score}/100</span>{" "}
                <BandChip band={preview.band} />
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {chosen.criticality
                  ? `Criticality ${statusLabel(chosen.criticality).toLowerCase()}`
                  : "Criticality not set"}
                {chosen.dataClassification
                  ? ` · ${statusLabel(chosen.dataClassification)} data`
                  : ""}
                {" · scored server-side at scheduling time"}
              </p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!universeItemId || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const res = await addItem({
                  auditPlanId: planId as never,
                  auditUniverseItemId: universeItemId as never,
                  previousFindings,
                  changeFrequency,
                  estimatedEffortDays: effort ? Number(effort) : undefined,
                });
                toast.success(
                  `Added with priority ${res.priorityScore} (${res.priorityBand})`,
                );
                onClose();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed");
              } finally {
                setBusy(false);
              }
            }}
          >
            Add to plan
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
