import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  ProgressMeter,
  StatusChip,
  statusLabel,
} from "@/components/iitams/badges";
import { ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { formatDate } from "@/lib/format";
import {
  RISK_ACTION_REFERENCE_MAX,
  RISK_TEXT_MAX,
  TREATMENT_STRATEGIES,
  TREATMENT_STRATEGY_LABELS,
  TREATMENT_STATUS_LABELS,
  nextTreatmentStatuses,
  type TreatmentStatus,
  type TreatmentStrategy,
} from "@/lib/risk";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  LifeBuoy,
  Loader2,
  Plus,
  Target,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Risk treatment plans and actions (Phase 3B — Batch 2B).
 * =======================================================
 * Treatment is documented evidence, not an approval shortcut. Plans show the
 * register's CURRENT residual score read from the risk row; nothing in this
 * component can change it. Selecting the `accept` strategy records a proposal,
 * and completing every action never marks the risk treated — that requires a
 * new assessment on the server.
 */

const DAY = 24 * 60 * 60 * 1000;

type Owner = { userId: string; label: string; role: string };

type TreatmentAction = {
  _id: string;
  description: string;
  ownerName: string;
  dueDate: number;
  status: TreatmentStatus;
  completedAt?: number;
  completionNotes?: string;
  reference?: string;
  overdue: boolean;
  createdByLabel: string;
};

type TreatmentPlan = {
  _id: string;
  reference: string;
  strategy: TreatmentStrategy;
  strategyLabel: string;
  objective: string;
  justification: string;
  ownerName: string;
  targetDate: number;
  targetOverdue: boolean;
  status: TreatmentStatus;
  statusLabel: string;
  notes?: string;
  completedAt?: number;
  createdByLabel: string;
  createdAt: number;
  progress: {
    total: number;
    planned: number;
    inProgress: number;
    completed: number;
    cancelled: number;
    overdue: number;
    progressPct: number;
  };
  actions: TreatmentAction[];
};

type TreatmentHistory = {
  risk: {
    _id: string;
    code: string;
    title: string;
    residualScore: number;
    residualBand: string;
    reviewDue?: number;
    reviewOverdue: boolean;
  };
  plans: TreatmentPlan[];
  summary: {
    total: number;
    open: number;
    inProgress: number;
    completed: number;
    actionsTotal: number;
    actionsCompleted: number;
    actionsOverdue: number;
  };
};

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function parseDate(value: string): number | undefined {
  if (!value) return undefined;
  const ms = new Date(`${value}T12:00:00`).getTime();
  return Number.isFinite(ms) ? ms : undefined;
}

function OwnerSelect({
  id,
  owners,
  value,
  onChange,
}: {
  id: string;
  owners: Owner[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">
        Responsible owner
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} aria-label="Responsible owner">
          <SelectValue placeholder="Select an owner" />
        </SelectTrigger>
        <SelectContent>
          {owners.map((o) => (
            <SelectItem key={o.userId} value={o.userId}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function CreatePlanForm({
  riskId,
  owners,
  onDone,
  onCancel,
}: {
  riskId: Id<"risks">;
  owners: Owner[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const createPlan = useMutation(api.riskTreatment.createPlan);
  const [strategy, setStrategy] = useState<TreatmentStrategy>("mitigate");
  const [objective, setObjective] = useState("");
  const [justification, setJustification] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [targetDate, setTargetDate] = useState(() => isoDate(Date.now() + 90 * DAY));
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const target = parseDate(targetDate);
    if (target === undefined) {
      setError("Enter a valid target completion date.");
      return;
    }
    if (target <= Date.now()) {
      setError("Target completion date must be in the future.");
      return;
    }
    if (objective.trim().length < 10) {
      setError("Treatment objective must be at least 10 characters.");
      return;
    }
    if (justification.trim().length < 10) {
      setError("Treatment justification must be at least 10 characters.");
      return;
    }
    if (!ownerUserId) {
      setError("Select the responsible owner for this treatment plan.");
      return;
    }
    setBusy(true);
    try {
      await createPlan({
        riskId,
        strategy,
        objective: objective.trim(),
        justification: justification.trim(),
        ownerUserId: ownerUserId as Id<"users">,
        targetDate: target,
        notes: notes.trim() || undefined,
      });
      toast.success("Treatment plan created.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The treatment plan could not be created.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan-strategy" className="text-xs">
            Treatment strategy
          </Label>
          <Select
            value={strategy}
            onValueChange={(v) => setStrategy(v as TreatmentStrategy)}
          >
            <SelectTrigger id="plan-strategy" aria-label="Treatment strategy">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TREATMENT_STRATEGIES.map((s) => (
                <SelectItem key={s} value={s}>
                  {TREATMENT_STRATEGY_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <OwnerSelect
          id="plan-owner"
          owners={owners}
          value={ownerUserId}
          onChange={setOwnerUserId}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="plan-objective" className="text-xs">
          Treatment objective (required)
        </Label>
        <Textarea
          id="plan-objective"
          rows={2}
          maxLength={RISK_TEXT_MAX}
          value={objective}
          placeholder="What outcome will reduce the risk to an acceptable level?"
          onChange={(e) => setObjective(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="plan-justification" className="text-xs">
          Justification (required)
        </Label>
        <Textarea
          id="plan-justification"
          rows={2}
          maxLength={RISK_TEXT_MAX}
          value={justification}
          placeholder="Why is this strategy appropriate for the assessed risk?"
          onChange={(e) => setJustification(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="plan-target" className="text-xs">
            Target completion date
          </Label>
          <Input
            id="plan-target"
            type="date"
            value={targetDate}
            onChange={(e) => setTargetDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="plan-notes" className="text-xs">
            Notes
          </Label>
          <Input
            id="plan-notes"
            maxLength={RISK_TEXT_MAX}
            value={notes}
            placeholder="Optional review or resourcing notes"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      {strategy === "accept" && (
        <p className="rounded bg-warning/15 px-2 py-1 text-xs">
          Accepting a risk is recorded as a documented proposal only. It does not
          approve the risk or change its residual score.
        </p>
      )}

      {error && (
        <p role="alert" className="text-xs font-medium text-critical">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Create plan
        </Button>
      </div>
    </div>
  );
}

function AddActionForm({
  planId,
  owners,
  onDone,
  onCancel,
}: {
  planId: Id<"riskTreatmentPlans">;
  owners: Owner[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const addAction = useMutation(api.riskTreatment.addAction);
  const [description, setDescription] = useState("");
  const [ownerUserId, setOwnerUserId] = useState("");
  const [dueDate, setDueDate] = useState(() => isoDate(Date.now() + 30 * DAY));
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    const due = parseDate(dueDate);
    if (due === undefined) {
      setError("Enter a valid due date.");
      return;
    }
    if (description.trim().length < 5) {
      setError("Action description must be at least 5 characters.");
      return;
    }
    if (!ownerUserId) {
      setError("Select the owner accountable for this action.");
      return;
    }
    setBusy(true);
    try {
      await addAction({
        planId,
        description: description.trim(),
        ownerUserId: ownerUserId as Id<"users">,
        dueDate: due,
        reference: reference.trim() || undefined,
      });
      toast.success("Treatment action added.");
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The action could not be added.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-md border bg-muted/20 p-3">
      <div className="space-y-1.5">
        <Label htmlFor="action-description" className="text-xs">
          Action description
        </Label>
        <Textarea
          id="action-description"
          rows={2}
          maxLength={RISK_TEXT_MAX}
          value={description}
          placeholder="Describe the specific treatment activity…"
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <OwnerSelect
          id="action-owner"
          owners={owners}
          value={ownerUserId}
          onChange={setOwnerUserId}
        />
        <div className="space-y-1.5">
          <Label htmlFor="action-due" className="text-xs">
            Due date
          </Label>
          <Input
            id="action-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="action-reference" className="text-xs">
            Supporting reference
          </Label>
          <Input
            id="action-reference"
            maxLength={RISK_ACTION_REFERENCE_MAX}
            value={reference}
            placeholder="Ticket, policy clause…"
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-xs font-medium text-critical">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Save action
        </Button>
      </div>
    </div>
  );
}

function ActionStatusEditor({ action }: { action: TreatmentAction }) {
  const updateStatus = useMutation(api.riskTreatment.updateActionStatus);
  const next = nextTreatmentStatuses(action.status);
  const [status, setStatus] = useState<string>("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (next.length === 0) return null;

  async function submit() {
    setError(null);
    if (!status) {
      setError("Choose the new status.");
      return;
    }
    if (status === "completed" && notes.trim().length < 5) {
      setError("Completion notes of at least 5 characters are required.");
      return;
    }
    setBusy(true);
    try {
      await updateStatus({
        actionId: action._id as Id<"riskTreatmentActions">,
        status: status as TreatmentStatus,
        completionNotes: status === "completed" ? notes.trim() : undefined,
      });
      toast.success("Action status updated.");
      setStatus("");
      setNotes("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The status could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border bg-background p-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-40 flex-1 space-y-1">
          <Label htmlFor={`action-status-${action._id}`} className="text-xs">
            Update status
          </Label>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger
              id={`action-status-${action._id}`}
              aria-label={`Update status for ${action.description}`}
            >
              <SelectValue placeholder="Choose status" />
            </SelectTrigger>
            <SelectContent>
              {next.map((s) => (
                <SelectItem key={s} value={s}>
                  {TREATMENT_STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => void submit()} disabled={busy}>
          {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
          Save action status
        </Button>
      </div>
      {status === "completed" && (
        <div className="space-y-1">
          <Label htmlFor={`action-notes-${action._id}`} className="text-xs">
            Completion notes (required)
          </Label>
          <Textarea
            id={`action-notes-${action._id}`}
            aria-label="Completion notes"
            rows={2}
            maxLength={RISK_TEXT_MAX}
            value={notes}
            placeholder="What was done and what evidence exists?"
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="text-xs font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

function PlanStatusControl({ plan }: { plan: TreatmentPlan }) {
  const updatePlan = useMutation(api.riskTreatment.updatePlanStatus);
  const next = nextTreatmentStatuses(plan.status);
  const [status, setStatus] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (next.length === 0) return null;

  async function submit() {
    setError(null);
    if (!status) {
      setError("Choose the new plan status.");
      return;
    }
    setBusy(true);
    try {
      await updatePlan({
        planId: plan._id as Id<"riskTreatmentPlans">,
        status: status as TreatmentStatus,
      });
      toast.success("Treatment plan status updated.");
      setStatus("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The plan status could not be updated.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="min-w-36 space-y-1">
        <Label htmlFor={`plan-status-${plan._id}`} className="text-xs">
          Plan status
        </Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger
            id={`plan-status-${plan._id}`}
            aria-label={`Update plan status for ${plan.reference}`}
          >
            <SelectValue placeholder="Choose status" />
          </SelectTrigger>
          <SelectContent>
            {next.map((s) => (
              <SelectItem key={s} value={s}>
                {TREATMENT_STATUS_LABELS[s]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <Button size="sm" variant="outline" onClick={() => void submit()} disabled={busy}>
        {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
        Update plan
      </Button>
      {error && (
        <p role="alert" className="w-full text-xs font-medium text-critical">
          {error}
        </p>
      )}
    </div>
  );
}

function PlanCard({
  plan,
  owners,
  canManage,
}: {
  plan: TreatmentPlan;
  owners: Owner[];
  canManage: boolean;
}) {
  const [adding, setAdding] = useState(false);
  const completed = plan.status === "completed" || plan.status === "cancelled";

  return (
    <li className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">
              {plan.reference}
            </span>
            <StatusChip status={plan.status} />
            <span className="rounded-full border px-2 py-0.5 text-xs">
              {plan.strategyLabel}
            </span>
          </div>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>
              Owner <span className="font-medium text-foreground">{plan.ownerName}</span>
            </span>
            <span className={plan.targetOverdue ? "font-medium text-critical" : ""}>
              <Target className="mr-1 inline size-3" aria-hidden />
              Target {formatDate(plan.targetDate)}
              {plan.targetOverdue ? " (overdue)" : ""}
            </span>
            <span>
              Created by {plan.createdByLabel} · {formatDate(plan.createdAt)}
            </span>
          </p>
        </div>
        <div className="w-full max-w-52">
          <ProgressMeter
            value={plan.progress.progressPct}
            label={`${plan.progress.completed}/${plan.progress.total} actions`}
          />
          {plan.progress.overdue > 0 && (
            <p className="mt-1 text-xs font-medium text-critical">
              <AlertTriangle className="mr-1 inline size-3" aria-hidden />
              {plan.progress.overdue} overdue action
              {plan.progress.overdue === 1 ? "" : "s"}
            </p>
          )}
        </div>
      </div>

      <p className="text-sm font-medium">{plan.objective}</p>
      <p className="whitespace-pre-wrap text-sm text-muted-foreground">
        {plan.justification}
      </p>
      {plan.notes && (
        <p className="text-xs text-muted-foreground">Notes: {plan.notes}</p>
      )}
      {plan.strategy === "accept" && (
        <p className="rounded bg-warning/15 px-2 py-1 text-xs">
          Acceptance is a documented proposal. No approval was granted and the
          residual score is unchanged.
        </p>
      )}
      {plan.status === "completed" && (
        <p className="text-xs text-muted-foreground">
          <CheckCircle2 className="mr-1 inline size-3 text-success" aria-hidden />
          Plan completed{" "}
          {plan.completedAt ? formatDate(plan.completedAt) : ""} — this does not
          mean the risk is treated. Record a new risk assessment to evidence the
          residual score.
        </p>
      )}

      {canManage && <PlanStatusControl plan={plan} />}

      <div className="space-y-2">
        <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Actions ({plan.actions.length})
        </h4>
        {plan.actions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No actions recorded for this plan yet.
          </p>
        ) : (
          <ul className="space-y-2">
            {plan.actions.map((action) => (
              <li key={action._id} className="rounded-md border p-2.5 text-sm">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">{action.description}</p>
                  <StatusChip status={action.status} />
                </div>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>Owner {action.ownerName}</span>
                  <span className={action.overdue ? "font-medium text-critical" : ""}>
                    <CalendarClock className="mr-1 inline size-3" aria-hidden />
                    Due {formatDate(action.dueDate)}
                    {action.overdue ? " (overdue)" : ""}
                  </span>
                  {action.completedAt && (
                    <span>Completed {formatDate(action.completedAt)}</span>
                  )}
                  {action.reference && <span>Ref: {action.reference}</span>}
                </p>
                {action.completionNotes && (
                  <p className="mt-1 text-xs">
                    Completion notes: {action.completionNotes}
                  </p>
                )}
                {canManage && !completed && (
                  <ActionStatusEditor action={action} />
                )}
                {canManage && completed && action.status === "completed" && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Completed actions are terminal; add a new action to record
                    further work.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}

        {canManage && !completed && !adding && (
          <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus className="size-3.5" aria-hidden />
            Add action
          </Button>
        )}
        {canManage && !completed && adding && (
          <AddActionForm
            planId={plan._id as Id<"riskTreatmentPlans">}
            owners={owners}
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        )}
      </div>
    </li>
  );
}

export function RiskTreatmentPlans({
  riskId,
  canManage,
}: {
  riskId: Id<"risks">;
  canManage: boolean;
}) {
  const data = useQuery(api.riskTreatment.listForRisk, { riskId }) as
    | TreatmentHistory
    | null
    | undefined;
  const owners = useQuery(api.riskTreatment.listAssignableOwners, {}) as
    | Owner[]
    | undefined;
  const [formOpen, setFormOpen] = useState(false);

  if (data === undefined) return <ListSkeleton rows={2} />;
  if (data === null) {
    return (
      <p className="text-sm text-muted-foreground">
        Treatment plans are not available for this risk.
      </p>
    );
  }

  return (
    <section className="space-y-3 border-t pt-4" aria-label="Risk treatment plans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <LifeBuoy className="size-4 text-muted-foreground" aria-hidden />
          Treatment plans
          <span className="font-normal text-muted-foreground">
            ({data.plans.length})
          </span>
        </h3>
        {canManage && !formOpen && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setFormOpen(true)}
            disabled={(owners ?? []).length === 0}
          >
            <Plus className="size-3.5" aria-hidden />
            New treatment plan
          </Button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border bg-muted/30 px-3 py-2 text-xs">
        <span>
          Residual risk{" "}
          <span className="font-medium text-foreground">
            {data.risk.residualScore}/25
          </span>{" "}
          ({statusLabel(data.risk.residualBand)})
        </span>
        <span>
          Open plans{" "}
          <span className="font-medium text-foreground">{data.summary.open}</span>
        </span>
        <span>
          In progress{" "}
          <span className="font-medium text-foreground">
            {data.summary.inProgress}
          </span>
        </span>
        <span>
          Actions completed{" "}
          <span className="font-medium text-foreground">
            {data.summary.actionsCompleted}/{data.summary.actionsTotal}
          </span>
        </span>
        {data.summary.actionsOverdue > 0 && (
          <span className="font-medium text-critical">
            {data.summary.actionsOverdue} overdue
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Treatment actions do not change the residual score. Residual risk moves
        only through a recorded risk assessment.
      </p>

      {data.plans.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No treatment plans recorded yet. Document the strategy, owner and
          actions taken to address this risk.
        </p>
      ) : (
        <ul className="space-y-3">
          {data.plans.map((plan) => (
            <PlanCard
              key={plan._id}
              plan={plan}
              owners={owners ?? []}
              canManage={canManage}
            />
          ))}
        </ul>
      )}

      {formOpen && (
        <CreatePlanForm
          riskId={riskId}
          owners={owners ?? []}
          onDone={() => setFormOpen(false)}
          onCancel={() => setFormOpen(false)}
        />
      )}
    </section>
  );
}
