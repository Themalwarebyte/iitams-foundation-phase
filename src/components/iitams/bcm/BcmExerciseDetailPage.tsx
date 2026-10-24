import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { formatDate, formatDateTime } from "@/lib/format";
import {
  BCM_EXERCISE_TYPE_DESCRIPTIONS,
  BCM_FINDING_SEVERITIES,
  BCM_FINDING_SEVERITY_LABELS,
  BCM_FINDING_STATUS_LABELS,
  BCM_FINDING_TRANSITIONS,
  BCM_MEASUREMENT_OBJECTIVES,
  BCM_MEASUREMENT_OBJECTIVE_LABELS,
  BCM_MEASUREMENT_OUTCOMES,
  BCM_MEASUREMENT_OUTCOME_LABELS,
  type BcmFindingSeverity,
  type BcmFindingStatus,
  type BcmMeasurementObjective,
  type BcmMeasurementOutcome,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmUnauthorized,
  ExerciseDisclaimer,
  ExerciseStatusPill,
  Field,
  FindingStatusPill,
  GapSeverityPill,
  Metric,
} from "./BcmPrimitives";
import { ExerciseFormDialog, valuesFromExercise } from "./BcmExerciseForm";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ChevronLeft,
  ClipboardCheck,
  FlaskConical,
  Loader2,
  Pencil,
  Play,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
  Timer,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /bcm/dr-tests/:exerciseId — Business Continuity Batch 4.3: exercise detail.
 * ======================================================================
 * Shows what was planned, what was reported performed, what an independent
 * verifier confirmed, what was measured against the approved baseline, which
 * strategies were covered, the findings raised and the review decision. The
 * page can record and review an exercise; it can never run one.
 */

function Section({
  title,
  description,
  action,
  children,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? (
            <p className="mt-1 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {action}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function NoteDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  submitLabel,
  busy,
  onSubmit,
  testId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (value: string) => void;
  testId?: string;
}) {
  const [value, setValue] = useState("");
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label={label}>
          <Textarea
            rows={4}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(value)}
            disabled={busy}
            data-testid={testId ?? "bcm-exercise-note-submit"}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActivityDialog({
  open,
  onOpenChange,
  exerciseId,
  canReport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exerciseId: Id<"recoveryExercises">;
  canReport: boolean;
}) {
  const addActivity = useMutation(api.recoveryExercises.addExerciseActivity);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    plannedActivity: "",
    expectedResponse: "",
    performed: false,
    actualObservation: "",
    deviation: "",
    evidenceReference: "",
    limitations: "",
  });

  async function submit() {
    setBusy(true);
    try {
      await addActivity({
        exerciseId,
        plannedActivity: form.plannedActivity,
        expectedResponse: form.expectedResponse,
        performed: form.performed,
        actualObservation: form.actualObservation || undefined,
        deviation: form.deviation || undefined,
        evidenceReference: form.evidenceReference || undefined,
        limitations: form.limitations || undefined,
      });
      toast.success(form.performed ? "Activity reported as performed." : "Planned activity added.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The activity was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add an exercise activity</DialogTitle>
          <DialogDescription>
            A planned activity describes what should happen. Reporting an
            activity as performed records what the team says happened — it is not
            verification.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Planned activity">
            <Textarea
              rows={2}
              value={form.plannedActivity}
              onChange={(event) =>
                setForm((current) => ({ ...current, plannedActivity: event.target.value }))
              }
              data-testid="bcm-activity-planned"
            />
          </Field>
          <Field label="Expected response">
            <Textarea
              rows={2}
              value={form.expectedResponse}
              onChange={(event) =>
                setForm((current) => ({ ...current, expectedResponse: event.target.value }))
              }
              data-testid="bcm-activity-expected"
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={form.performed}
              disabled={!canReport}
              onCheckedChange={(checked) =>
                setForm((current) => ({ ...current, performed: checked === true }))
              }
              data-testid="bcm-activity-performed"
            />
            Report this activity as performed during the exercise
          </label>
          {form.performed ? (
            <>
              <Field label="Actual observation">
                <Textarea
                  rows={3}
                  value={form.actualObservation}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      actualObservation: event.target.value,
                    }))
                  }
                  data-testid="bcm-activity-observation"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Deviation from the plan">
                  <Textarea
                    rows={2}
                    value={form.deviation}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, deviation: event.target.value }))
                    }
                  />
                </Field>
                <Field label="Limitations">
                  <Textarea
                    rows={2}
                    value={form.limitations}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, limitations: event.target.value }))
                    }
                  />
                </Field>
              </div>
              <Field label="Evidence reference">
                <Input
                  value={form.evidenceReference}
                  placeholder="Where the evidence is held"
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      evidenceReference: event.target.value,
                    }))
                  }
                />
              </Field>
            </>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="bcm-activity-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Save activity
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MeasurementDialog({
  open,
  onOpenChange,
  exerciseId,
  baseline,
  coveredStrategies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exerciseId: Id<"recoveryExercises">;
  coveredStrategies: { _id: string; reference: string | null; title: string | null }[];
  baseline: {
    approved: boolean;
    biaReference: string | null;
    biaVersion: number | null;
    rtoMinutes: number | null;
    rpoMinutes: number | null;
  };
}) {
  const recordMeasurement = useMutation(
    api.recoveryExercises.recordExerciseMeasurement,
  );
  const [busy, setBusy] = useState(false);
  const [strategyId, setStrategyId] = useState<string>(
    coveredStrategies.length === 1 ? String(coveredStrategies[0]._id) : "",
  );
  const [form, setForm] = useState({
    objective: "rto" as BcmMeasurementObjective,
    measuredMinutes: "",
    observedValue: "",
    outcome: "not_assessed" as BcmMeasurementOutcome,
    justification: "",
    evidenceReference: "",
    limitations: "",
  });

  const objectiveMinutes =
    form.objective === "rto"
      ? baseline.rtoMinutes
      : form.objective === "rpo"
        ? baseline.rpoMinutes
        : null;

  async function submit() {
    setBusy(true);
    try {
      await recordMeasurement({
        exerciseId,
        strategyId: strategyId
          ? (strategyId as Id<"recoveryStrategies">)
          : undefined,
        objective: form.objective,
        measuredMinutes:
          form.objective === "service_level" || form.measuredMinutes.trim() === ""
            ? undefined
            : Number(form.measuredMinutes),
        observedValue: form.observedValue,
        outcome: form.outcome,
        justification: form.justification,
        evidenceReference: form.evidenceReference,
        limitations: form.limitations,
      });
      toast.success("Measurement recorded against the exercise.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The measurement was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a recovery measurement</DialogTitle>
          <DialogDescription>
            Measurements are observations from this exercise. Without an approved
            objective the system only accepts &ldquo;not assessed&rdquo;.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field
            label="Strategy measured"
            hint="A measurement only supports the recovery strategy it was taken against. An exercise that covers several strategies must say which one this observation belongs to."
          >
            {coveredStrategies.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No strategy coverage recorded yet. Walk a strategy through the exercise
                first, or the measurement cannot support any capability claim.
              </p>
            ) : (
              <Select
                value={strategyId}
                onValueChange={(value) => setStrategyId(value)}
              >
                <SelectTrigger data-testid="bcm-measurement-strategy">
                  <SelectValue placeholder="Select the strategy measured" />
                </SelectTrigger>
                <SelectContent>
                  {coveredStrategies.map((strategy) => (
                    <SelectItem key={strategy._id} value={String(strategy._id)}>
                      {strategy.reference ?? "Strategy"}
                      {strategy.title ? ` — ${strategy.title}` : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </Field>

          <Field
            label="Objective measured"
            hint={
              baseline.approved && baseline.biaReference
                ? `Approved baseline on the tested plan: ${baseline.biaReference} v${baseline.biaVersion}`
                : "No approved objective is linked to the tested plan version"
            }
          >
            <Select
              value={form.objective}
              onValueChange={(value) =>
                setForm((current) => ({
                  ...current,
                  objective: value as BcmMeasurementObjective,
                }))
              }
            >
              <SelectTrigger data-testid="bcm-measurement-objective">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BCM_MEASUREMENT_OBJECTIVES.map((objective) => (
                  <SelectItem key={objective} value={objective}>
                    {BCM_MEASUREMENT_OBJECTIVE_LABELS[objective]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          {form.objective === "service_level" ? (
            <Field label="Observed service level achieved">
              <Textarea
                rows={2}
                value={form.observedValue}
                onChange={(event) =>
                  setForm((current) => ({ ...current, observedValue: event.target.value }))
                }
              />
            </Field>
          ) : (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Measured minutes"
                hint={
                  objectiveMinutes
                    ? `Approved objective: ${objectiveMinutes} min`
                    : "No approved objective recorded"
                }
              >
                <Input
                  inputMode="numeric"
                  value={form.measuredMinutes}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      measuredMinutes: event.target.value,
                    }))
                  }
                  data-testid="bcm-measurement-minutes"
                />
              </Field>
              <Field label="Observed capability">
                <Input
                  value={form.observedValue}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, observedValue: event.target.value }))
                  }
                  data-testid="bcm-measurement-observed"
                />
              </Field>
            </div>
          )}

          <Field
            label="Outcome"
            hint="The outcome must agree with the measured performance"
          >
            <Select
              value={form.outcome}
              onValueChange={(value) =>
                setForm((current) => ({
                  ...current,
                  outcome: value as BcmMeasurementOutcome,
                }))
              }
            >
              <SelectTrigger data-testid="bcm-measurement-outcome">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BCM_MEASUREMENT_OUTCOMES.map((outcome) => (
                  <SelectItem key={outcome} value={outcome}>
                    {BCM_MEASUREMENT_OUTCOME_LABELS[outcome]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <Field label="Justification">
            <Textarea
              rows={3}
              value={form.justification}
              onChange={(event) =>
                setForm((current) => ({ ...current, justification: event.target.value }))
              }
              data-testid="bcm-measurement-justification"
            />
          </Field>
          <Field label="Evidence reference">
            <Input
              value={form.evidenceReference}
              onChange={(event) =>
                setForm((current) => ({
                  ...current,
                  evidenceReference: event.target.value,
                }))
              }
              data-testid="bcm-measurement-evidence"
            />
          </Field>
          <Field label="Limitations and assumptions">
            <Textarea
              rows={2}
              value={form.limitations}
              onChange={(event) =>
                setForm((current) => ({ ...current, limitations: event.target.value }))
              }
              data-testid="bcm-measurement-limitations"
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="bcm-measurement-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Save measurement
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CoverageDialog({
  open,
  onOpenChange,
  exerciseId,
  strategies,
  recordedStrategyIds,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exerciseId: Id<"recoveryExercises">;
  strategies: Array<{ _id: string; reference: string; title: string }>;
  recordedStrategyIds: string[];
}) {
  const recordCoverage = useMutation(api.recoveryExercises.recordStrategyCoverage);
  const available = strategies.filter(
    (strategy) => !recordedStrategyIds.includes(strategy._id),
  );
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    strategyId: available[0]?._id ?? "",
    stepsRecorded: "",
    stepsPerformed: false,
    observation: "",
    limitations: "",
  }));

  async function submit() {
    setBusy(true);
    try {
      await recordCoverage({
        exerciseId,
        strategyId: form.strategyId as Id<"recoveryStrategies">,
        stepsRecorded: form.stepsRecorded,
        stepsPerformed: form.stepsPerformed,
        observation: form.observation,
        limitations: form.limitations || undefined,
      });
      toast.success("Strategy coverage recorded.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Coverage was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record strategy coverage</DialogTitle>
          <DialogDescription>
            Describe which documented recovery steps this exercise actually
            walked. Recording coverage never marks the strategy verified — that
            label requires a reviewed exercise with performed steps and a
            measurement.
          </DialogDescription>
        </DialogHeader>
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Every strategy on this plan already has coverage recorded for this
            exercise.
          </p>
        ) : (
          <div className="space-y-4">
            <Field label="Strategy">
              <Select
                value={form.strategyId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, strategyId: value }))
                }
              >
                <SelectTrigger data-testid="bcm-coverage-strategy">
                  <SelectValue placeholder="Select a strategy" />
                </SelectTrigger>
                <SelectContent>
                  {available.map((strategy) => (
                    <SelectItem key={strategy._id} value={strategy._id}>
                      {strategy.reference} — {strategy.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Recovery steps recorded">
              <Textarea
                rows={3}
                value={form.stepsRecorded}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    stepsRecorded: event.target.value,
                  }))
                }
                data-testid="bcm-coverage-steps"
              />
            </Field>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.stepsPerformed}
                onCheckedChange={(checked) =>
                  setForm((current) => ({
                    ...current,
                    stepsPerformed: checked === true,
                  }))
                }
                data-testid="bcm-coverage-performed"
              />
              The documented recovery steps were actually performed
            </label>
            <Field label="Observation">
              <Textarea
                rows={3}
                value={form.observation}
                onChange={(event) =>
                  setForm((current) => ({ ...current, observation: event.target.value }))
                }
                data-testid="bcm-coverage-observation"
              />
            </Field>
            <Field label="Limitations">
              <Textarea
                rows={2}
                value={form.limitations}
                onChange={(event) =>
                  setForm((current) => ({ ...current, limitations: event.target.value }))
                }
              />
            </Field>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || available.length === 0 || !form.strategyId}
            data-testid="bcm-coverage-save"
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Save coverage
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingDialog({
  open,
  onOpenChange,
  exerciseId,
  strategies,
  members,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  exerciseId: Id<"recoveryExercises">;
  strategies: Array<{ _id: string; reference: string; title: string }>;
  members: Array<{ userId: string; label: string }>;
  currentUserId: string;
}) {
  const createFinding = useMutation(api.recoveryExercises.createExerciseFinding);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    description: "",
    severity: "high" as BcmFindingSeverity,
    strategyId: "none",
    relatedObjective: "none",
    ownerUserId: members.some((member) => member.userId === currentUserId)
      ? currentUserId
      : (members[0]?.userId ?? ""),
    targetResolutionDate: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    correctiveAction: "",
  }));

  async function submit() {
    setBusy(true);
    try {
      await createFinding({
        exerciseId,
        description: form.description,
        severity: form.severity,
        ...(form.strategyId === "none"
          ? {}
          : { strategyId: form.strategyId as Id<"recoveryStrategies"> }),
        ...(form.relatedObjective === "none"
          ? {}
          : { relatedObjective: form.relatedObjective as BcmMeasurementObjective }),
        ownerUserId: form.ownerUserId as Id<"users">,
        targetResolutionDate: new Date(`${form.targetResolutionDate}T23:59:00`).getTime(),
        correctiveAction: form.correctiveAction,
      });
      toast.success("Exercise finding raised.");
      onOpenChange(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The finding was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Raise an exercise finding</DialogTitle>
          <DialogDescription>
            A deficiency, gap or lesson learned from this exercise. It does not
            close any recovery gap: those keep their own evidence and
            verification workflow.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Finding description">
            <Textarea
              rows={3}
              value={form.description}
              onChange={(event) =>
                setForm((current) => ({ ...current, description: event.target.value }))
              }
              data-testid="bcm-finding-description"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Severity">
              <Select
                value={form.severity}
                onValueChange={(value) =>
                  setForm((current) => ({
                    ...current,
                    severity: value as BcmFindingSeverity,
                  }))
                }
              >
                <SelectTrigger data-testid="bcm-finding-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_FINDING_SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {BCM_FINDING_SEVERITY_LABELS[severity]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, ownerUserId: value }))
                }
              >
                <SelectTrigger data-testid="bcm-finding-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={member.userId}>
                      {member.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Related strategy">
              <Select
                value={form.strategyId}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, strategyId: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific strategy</SelectItem>
                  {strategies.map((strategy) => (
                    <SelectItem key={strategy._id} value={strategy._id}>
                      {strategy.reference} — {strategy.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Related objective">
              <Select
                value={form.relatedObjective}
                onValueChange={(value) =>
                  setForm((current) => ({ ...current, relatedObjective: value }))
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific objective</SelectItem>
                  {BCM_MEASUREMENT_OBJECTIVES.map((objective) => (
                    <SelectItem key={objective} value={objective}>
                      {BCM_MEASUREMENT_OBJECTIVE_LABELS[objective]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Target resolution date">
              <Input
                type="date"
                value={form.targetResolutionDate}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    targetResolutionDate: event.target.value,
                  }))
                }
              />
            </Field>
            <Field label="Corrective action">
              <Textarea
                rows={2}
                value={form.correctiveAction}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    correctiveAction: event.target.value,
                  }))
                }
                data-testid="bcm-finding-action"
              />
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy} data-testid="bcm-finding-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Raise finding
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FindingStatusDialog({
  target,
  onOpenChange,
  busy,
  onSubmit,
}: {
  target: {
    id: Id<"recoveryExerciseFindings">;
    reference: string;
    status: BcmFindingStatus;
  } | null;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onSubmit: (input: {
    status: BcmFindingStatus;
    note: string;
    evidenceReference: string;
    acceptanceRationale: string;
  }) => void;
}) {
  const [note, setNote] = useState("");
  const [evidence, setEvidence] = useState("");
  const [rationale, setRationale] = useState("");
  if (!target) return null;
  const needsEvidence = target.status === "resolved";
  const needsRationale = target.status === "accepted";
  return (
    <Dialog open onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {target.reference} → {BCM_FINDING_STATUS_LABELS[target.status]}
          </DialogTitle>
          <DialogDescription>
            {target.status === "verified"
              ? "Independent verification must be performed by someone other than the person who resolved the finding."
              : target.status === "resolved"
                ? "Resolution requires notes and the evidence that supports them."
                : target.status === "accepted"
                  ? "Accepting records the deficiency as explicitly disclosed, with a rationale."
                  : "Status changes are attributed and appended to the exercise history."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Field
            label={
              target.status === "verified"
                ? "Verification notes"
                : target.status === "resolved"
                  ? "Resolution notes"
                  : "Status note"
            }
          >
            <Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} />
          </Field>
          {needsEvidence ? (
            <Field label="Resolution evidence">
              <Input value={evidence} onChange={(event) => setEvidence(event.target.value)} />
            </Field>
          ) : null}
          {needsRationale ? (
            <Field label="Acceptance rationale">
              <Textarea
                rows={3}
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
              />
            </Field>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() =>
              onSubmit({
                status: target.status,
                note,
                evidenceReference: evidence,
                acceptanceRationale: rationale,
              })
            }
            disabled={busy}
            data-testid="bcm-finding-status-submit"
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Record change
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExerciseDetail({ exerciseId }: { exerciseId: Id<"recoveryExercises"> }) {
  const navigate = useNavigate();
  const detail = useQuery(api.recoveryExercises.getExercise, { exerciseId });
  const options = useQuery(api.recoveryExercises.exerciseFormOptions, {});

  const scheduleExercise = useMutation(api.recoveryExercises.scheduleExercise);
  const startExercise = useMutation(api.recoveryExercises.startExercise);
  const completeExercise = useMutation(api.recoveryExercises.completeExercise);
  const cancelExercise = useMutation(api.recoveryExercises.cancelExercise);
  const submitExercise = useMutation(api.recoveryExercises.submitExercise);
  const reviewExercise = useMutation(api.recoveryExercises.reviewExercise);
  const supersedeExercise = useMutation(api.recoveryExercises.supersedeExercise);
  const verifyActivity = useMutation(api.recoveryExercises.verifyExerciseActivity);
  const updateFindingStatus = useMutation(
    api.recoveryExercises.updateExerciseFindingStatus,
  );

  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const [measurementOpen, setMeasurementOpen] = useState(false);
  const [coverageOpen, setCoverageOpen] = useState(false);
  const [findingOpen, setFindingOpen] = useState(false);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [verifying, setVerifying] = useState<Id<"recoveryExerciseActivities"> | null>(null);
  const [review, setReview] = useState<"approved" | "rejected" | null>(null);
  const [superseding, setSuperseding] = useState(false);
  const [findingTarget, setFindingTarget] = useState<{
    id: Id<"recoveryExerciseFindings">;
    reference: string;
    status: BcmFindingStatus;
  } | null>(null);
  const [outcome, setOutcome] = useState({ summary: "", justification: "" });

  if (detail === undefined) return <ListSkeleton rows={6} />;
  if (detail === null) {
    return (
      <EmptyState
        icon={FlaskConical}
        title="Exercise not found"
        description="This exercise does not exist in your organization, or it was removed."
      />
    );
  }

  const exercise = detail.exercise;
  const canManage = detail.canManage;
  const canReview =
    canManage &&
    exercise.status === "in_review" &&
    detail.reviewBlockedReasons.length === 0;
  const canSupersede =
    canManage && (exercise.status === "reviewed" || exercise.status === "returned");

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "The action was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="mb-3 text-xl font-semibold tracking-tight">{exercise.title}</h2>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ExerciseStatusPill status={exercise.status} label={exercise.statusLabel} />
        <Badge variant="outline" className="font-mono text-xs">
          {exercise.reference} v{exercise.version}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {exercise.typeLabel}
        </Badge>
        <Badge variant="outline" className="text-xs">
          Tests {exercise.planReference} v{exercise.planVersion}
        </Badge>
        {!exercise.baseline.approved ? (
          <Badge variant="outline" className="border-warning/40 bg-warning/10">
            No approved baseline
          </Badge>
        ) : null}
      </div>

      <p className="mb-4 text-sm text-muted-foreground">
        {BCM_EXERCISE_TYPE_DESCRIPTIONS[exercise.type as keyof typeof BCM_EXERCISE_TYPE_DESCRIPTIONS]}
      </p>

      {detail.baselineWarning ? (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {detail.baselineWarning}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {exercise.planningEditable && canManage && options ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-4" aria-hidden />
            Amend planning
          </Button>
        ) : null}
        {canManage && exercise.status === "planned" ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => scheduleExercise({ exerciseId }), "Exercise marked as scheduled.")
            }
            data-testid="bcm-exercise-schedule"
          >
            Schedule
          </Button>
        ) : null}
        {canManage && (exercise.status === "planned" || exercise.status === "scheduled") ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(() => startExercise({ exerciseId }), "Exercise started — recording observations.")
            }
            data-testid="bcm-exercise-start"
          >
            <Play className="mr-1 size-4" aria-hidden />
            Start exercise
          </Button>
        ) : null}
        {canManage && exercise.status === "in_progress" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() => setCompleting(true)}
            data-testid="bcm-exercise-complete"
          >
            <CheckCircle2 className="mr-1 size-4" aria-hidden />
            Complete exercise
          </Button>
        ) : null}
        {canManage && exercise.status === "completed" ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                () => submitExercise({ exerciseId }),
                "Exercise submitted for independent review.",
              )
            }
            data-testid="bcm-exercise-submit"
          >
            <Send className="mr-1 size-4" aria-hidden />
            Submit for review
          </Button>
        ) : null}
        {canReview ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => setReview("approved")}
              data-testid="bcm-exercise-approve"
            >
              <BadgeCheck className="mr-1 size-4" aria-hidden />
              Accept results
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setReview("rejected")}
              data-testid="bcm-exercise-return"
            >
              <RotateCcw className="mr-1 size-4" aria-hidden />
              Return
            </Button>
          </>
        ) : null}
        {canSupersede ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => setSuperseding(true)}
            data-testid="bcm-exercise-supersede"
          >
            <RotateCcw className="mr-1 size-4" aria-hidden />
            Record a corrected version
          </Button>
        ) : null}
        {canManage &&
        (exercise.status === "planned" ||
          exercise.status === "scheduled" ||
          exercise.status === "in_progress") ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setCancelling(true)}
          >
            <XCircle className="mr-1 size-4" aria-hidden />
            Cancel exercise
          </Button>
        ) : null}
      </div>

      {exercise.status === "in_review" && detail.reviewBlockedReasons.length > 0 ? (
        <p className="mb-4 rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Independent review required: you cannot review this exercise because you{" "}
          {detail.reviewBlockedReasons.join(", ").toLowerCase()}.
        </p>
      ) : null}

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Activities"
          value={`${exercise.counts.performedActivities}/${exercise.counts.activities}`}
          hint="Reported performed of recorded"
        />
        <Metric
          label="Measurements"
          value={exercise.counts.measurements}
          hint="Recorded recovery performance"
        />
        <Metric
          label="Strategies covered"
          value={exercise.counts.strategies}
          hint="Documented steps walked"
        />
        <Metric
          label="Open findings"
          value={exercise.counts.openFindings}
          hint={`${exercise.counts.findings} raised in total`}
          tone={exercise.counts.openFindings > 0 ? "text-critical" : undefined}
        />
      </div>

      <div className="space-y-4">
        <Section title="What this exercise does not do">
          <ExerciseDisclaimer />
          <p className="mt-3 text-sm text-muted-foreground">
            The register stores planning, observations, measurements and review.
            Any operational recovery step was performed outside this system by
            authorized personnel, and this record is the evidence of it.
          </p>
        </Section>

        <Section
          title="Plan and baseline tested"
          description="Snapshotted when the exercise was recorded, so a later plan revision cannot rewrite what was tested."
        >
          <div className="space-y-3 text-sm">
            <p>
              <span className="font-medium">
                {detail.plan.reference} v{detail.plan.version} — {detail.plan.title}
              </span>{" "}
              <span className="text-xs text-muted-foreground">
                ({detail.plan.statusLabel} · {detail.plan.recoveryPriorityLabel})
              </span>
            </p>
            {exercise.baseline.biaReference ? (
              <dl className="grid gap-3 sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    Analysis
                  </dt>
                  <dd className="mt-1">
                    {exercise.baseline.biaReference} v{exercise.baseline.biaVersion}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    RTO
                  </dt>
                  <dd className="mt-1">{exercise.baseline.rtoLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    RPO / MTPD
                  </dt>
                  <dd className="mt-1">
                    {exercise.baseline.rpoLabel} / {exercise.baseline.mtpdLabel}
                  </dd>
                </div>
              </dl>
            ) : (
              <p className="text-sm text-muted-foreground">
                No analysis baseline is linked to the tested plan version.
              </p>
            )}
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Scenario
                </dt>
                <dd className="mt-1 whitespace-pre-line">{exercise.scenario}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Objectives
                </dt>
                <dd className="mt-1 whitespace-pre-line">{exercise.objectives}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Scope
                </dt>
                <dd className="mt-1 whitespace-pre-line">{exercise.scope}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  Exclusions
                </dt>
                <dd className="mt-1 whitespace-pre-line">{exercise.exclusions}</dd>
              </div>
            </dl>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Methodology
                </p>
                <p className="mt-1 whitespace-pre-line">{exercise.methodology}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Required resources
                </p>
                <p className="mt-1 whitespace-pre-line">{exercise.requiredResources}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Safety and operational constraints
                </p>
                <p className="mt-1 whitespace-pre-line">{exercise.constraints}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Evidence and documentation
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {exercise.evidenceReferences ?? "Not recorded"}
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Owner {exercise.ownerLabel} · facilitator {exercise.facilitatorLabel} ·
              planned {formatDate(exercise.plannedStartAt)} →{" "}
              {formatDate(exercise.plannedEndAt)}
              {exercise.actualStartAt
                ? ` · actual ${formatDateTime(exercise.actualStartAt)}`
                : ""}
              {exercise.actualEndAt ? ` → ${formatDateTime(exercise.actualEndAt)}` : ""}
            </p>
            <div>
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Participants
              </p>
              {exercise.participants.length === 0 ? (
                <p className="mt-1 text-sm text-muted-foreground">None recorded.</p>
              ) : (
                <ul className="mt-1 grid gap-1 text-sm sm:grid-cols-2">
                  {exercise.participants.map((participant) => (
                    <li key={String(participant.userId)}>
                      {participant.label} — {participant.role}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>

        <Section
          title="Timeline and activities"
          description="Planned activities, activities the team reported performing, and activities an independent verifier confirmed."
          action={
            canManage &&
            (exercise.planningEditable || exercise.resultsEditable) ? (
              <Button size="sm" variant="outline" onClick={() => setActivityOpen(true)}>
                <Plus className="mr-1 size-4" aria-hidden />
                Add activity
              </Button>
            ) : undefined
          }
        >
          {detail.activities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No activities recorded. Completion requires at least one activity
              reported as performed.
            </p>
          ) : (
            <ol className="space-y-2">
              {detail.activities.map((activity) => (
                <li
                  key={activity._id}
                  className="rounded-lg border border-border/70 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      #{activity.sequence}
                    </span>
                    <Badge
                      variant="outline"
                      className={
                        activity.evidenceState === "verified"
                          ? "border-success/25 bg-success/10 text-success"
                          : activity.evidenceState === "reported"
                            ? "border-info/25 bg-info/10 text-info"
                            : "border-border bg-muted text-muted-foreground"
                      }
                    >
                      {activity.evidenceState === "verified"
                        ? "Independently verified"
                        : activity.evidenceState === "reported"
                          ? "Reported performed"
                          : "Planned only"}
                    </Badge>
                    {canManage &&
                    activity.performed &&
                    !activity.verified &&
                    (exercise.status === "in_progress" ||
                      exercise.status === "completed" ||
                      exercise.status === "in_review") ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => setVerifying(activity._id)}
                      >
                        Verify
                      </Button>
                    ) : null}
                  </div>
                  <p className="mt-2 font-medium">{activity.plannedActivity}</p>
                  <p className="text-xs text-muted-foreground">
                    Expected: {activity.expectedResponse}
                  </p>
                  {activity.actualObservation ? (
                    <p className="mt-2">
                      <span className="text-xs uppercase tracking-wide text-muted-foreground">
                        Observed:
                      </span>{" "}
                      {activity.actualObservation}
                    </p>
                  ) : null}
                  {activity.deviation ? (
                    <p className="mt-1 text-xs">
                      <span className="uppercase tracking-wide text-muted-foreground">
                        Deviation:
                      </span>{" "}
                      {activity.deviation}
                    </p>
                  ) : null}
                  {activity.limitations ? (
                    <p className="mt-1 text-xs">
                      <span className="uppercase tracking-wide text-muted-foreground">
                        Limitations:
                      </span>{" "}
                      {activity.limitations}
                    </p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    {activity.performedByLabel
                      ? `Reported by ${activity.performedByLabel}${activity.performedAt ? ` on ${formatDateTime(activity.performedAt)}` : ""}`
                      : `Recorded by ${activity.recordedByLabel}`}
                    {activity.verifiedByLabel
                      ? ` · verified by ${activity.verifiedByLabel}`
                      : ""}
                    {activity.evidenceReference
                      ? ` · evidence: ${activity.evidenceReference}`
                      : ""}
                  </p>
                  {activity.verificationNotes ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Verification: {activity.verificationNotes}
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </Section>

        <Section
          title="Recovery performance"
          description="Measured observations compared with the approved objectives snapshotted on the plan version."
          action={
            canManage && exercise.resultsEditable ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setMeasurementOpen(true)}
                data-testid="bcm-measurement-new"
              >
                <Timer className="mr-1 size-4" aria-hidden />
                Record measurement
              </Button>
            ) : undefined
          }
        >
          {detail.measurements.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No measurement recorded. Completing an exercise does not assert
              that any objective was met.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.measurements.map((measurement) => (
                <div
                  key={measurement._id}
                  className="rounded-lg border border-border/70 p-3 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{measurement.objectiveLabel}</span>
                    <Badge
                      variant="outline"
                      className={
                        measurement.outcome === "met"
                          ? "border-success/25 bg-success/10 text-success"
                          : measurement.outcome === "missed"
                            ? "border-critical/30 bg-critical/10 text-critical"
                            : "border-border bg-muted text-muted-foreground"
                      }
                    >
                      {measurement.outcomeLabel}
                    </Badge>
                    {measurement.deltaMinutes !== null ? (
                      <span
                        className={
                          measurement.deltaMinutes > 0
                            ? "text-xs font-medium text-critical"
                            : "text-xs text-success"
                        }
                      >
                        {measurement.deltaMinutes > 0
                          ? `${measurement.deltaMinutes} min beyond the objective`
                          : `${Math.abs(measurement.deltaMinutes)} min within the objective`}
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1">
                    Measured {measurement.measuredLabel}
                    {measurement.objectiveMinutes !== null
                      ? ` against ${measurement.objectiveLabelValue}`
                      : ""}
                    {measurement.objectiveReference
                      ? ` (${measurement.objectiveReference})`
                      : " — no approved objective"}
                  </p>
                  <p className="mt-1 text-xs">Observed: {measurement.observedValue}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {measurement.justification} · evidence: {measurement.evidenceReference} ·
                    limitations: {measurement.limitations} · recorded by{" "}
                    {measurement.recordedByLabel}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Strategy coverage and verified capability"
          description="Which documented strategies the exercise actually walked, and whether the capability can be labelled exercise-verified."
          action={
            canManage && exercise.resultsEditable ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCoverageOpen(true)}
                data-testid="bcm-coverage-new"
              >
                <Plus className="mr-1 size-4" aria-hidden />
                Record coverage
              </Button>
            ) : undefined
          }
        >
          {detail.coverage.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No strategy coverage recorded. An exercise that tested no strategy
              can never make one exercise-verified.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.coverage.map((row) => (
                <div key={row._id} className="rounded-lg border border-border/70 p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {row.strategyReference}
                    </span>
                    <span className="font-medium">{row.strategyTitle}</span>
                    <Badge
                      variant="outline"
                      className={
                        row.capabilityVerified
                          ? "border-success/25 bg-success/10 text-success"
                          : "border-border bg-muted text-muted-foreground"
                      }
                    >
                      {row.capabilityVerified
                        ? "Exercise-verified"
                        : "Estimate — not verified"}
                    </Badge>
                  </div>
                  <p className="mt-1">{row.stepsRecorded}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {row.stepsPerformed
                      ? "Recovery steps recorded as performed"
                      : "Steps reviewed without performing them"}
                    {row.limitations ? ` · limitations: ${row.limitations}` : ""}
                  </p>
                  {!row.capabilityVerified && row.capabilityReasons.length > 0 ? (
                    <ul className="mt-1 list-disc pl-5 text-xs text-muted-foreground">
                      {row.capabilityReasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section
          title="Exercise findings and remediation"
          description="Deficiencies raised by this exercise. Closing a finding never closes a recovery gap."
          action={
            canManage && exercise.acceptsFindings ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setFindingOpen(true)}
                data-testid="bcm-finding-new"
              >
                <AlertTriangle className="mr-1 size-4" aria-hidden />
                Raise finding
              </Button>
            ) : undefined
          }
        >
          {detail.findings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No finding recorded. Absence of findings is not evidence that the
              plan worked — it only means nothing was recorded.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.findings.map((finding) => {
                const nextStatuses =
                  BCM_FINDING_TRANSITIONS[finding.status as BcmFindingStatus] ?? [];
                return (
                  <div key={finding._id} className="rounded-lg border border-border/70 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {finding.reference}
                      </span>
                      <GapSeverityPill
                        severity={finding.severity}
                        label={finding.severityLabel}
                      />
                      <FindingStatusPill
                        status={finding.status}
                        label={finding.statusLabel}
                      />
                      {finding.overdue ? (
                        <Badge
                          variant="outline"
                          className="border-critical/30 bg-critical/10 text-critical text-xs"
                        >
                          Past target date
                        </Badge>
                      ) : null}
                      {canManage && nextStatuses.length > 0 ? (
                        <span className="ml-auto flex flex-wrap gap-1">
                          {nextStatuses.map((status) => (
                            <Button
                              key={status}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setFindingTarget({
                                  id: finding._id,
                                  reference: finding.reference,
                                  status,
                                })
                              }
                            >
                              {BCM_FINDING_STATUS_LABELS[status]}
                            </Button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-line">{finding.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Owner {finding.ownerLabel} · target{" "}
                      {formatDate(finding.targetResolutionDate)}
                      {finding.strategyReference ? ` · ${finding.strategyReference}` : ""}
                      {finding.relatedObjectiveLabel
                        ? ` · ${finding.relatedObjectiveLabel}`
                        : ""}
                      {finding.recoveryGapReference
                        ? ` · linked gap ${finding.recoveryGapReference} (not closed by this action)`
                        : ""}
                    </p>
                    <p className="mt-1 text-xs">Corrective action: {finding.correctiveAction}</p>
                    {finding.resolutionNotes ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Resolution: {finding.resolutionNotes}
                        {finding.resolvedByLabel ? ` (${finding.resolvedByLabel})` : ""}
                      </p>
                    ) : null}
                    {finding.verificationNotes ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Verification: {finding.verificationNotes}
                        {finding.verifiedByLabel ? ` (${finding.verifiedByLabel})` : ""}
                      </p>
                    ) : null}
                    {finding.acceptanceRationale ? (
                      <p className="mt-1 text-xs text-muted-foreground">
                        Accepted: {finding.acceptanceRationale}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Review and outcome">
          <div className="space-y-3 text-sm">
            {exercise.outcomeSummary ? (
              <>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Outcome
                  </p>
                  <p className="mt-1 whitespace-pre-line">{exercise.outcomeSummary}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Justification
                  </p>
                  <p className="mt-1 whitespace-pre-line">
                    {exercise.outcomeJustification}
                  </p>
                </div>
              </>
            ) : (
              <p className="text-muted-foreground">
                No outcome recorded yet. Completing the exercise requires a stated
                outcome and its justification.
              </p>
            )}
            <p className="text-xs text-muted-foreground">
              Recorded by {exercise.preparedByLabel} on{" "}
              {formatDate(exercise.preparedAt)}
              {exercise.completedByLabel
                ? ` · completed by ${exercise.completedByLabel}`
                : ""}
              {exercise.submittedByLabel
                ? ` · submitted by ${exercise.submittedByLabel}`
                : ""}
              {exercise.reviewedByLabel
                ? ` · reviewed by ${exercise.reviewedByLabel} on ${formatDate(exercise.reviewedAt)} (${exercise.reviewDecision ?? ""})`
                : ""}
              {exercise.cancelledByLabel
                ? ` · cancelled by ${exercise.cancelledByLabel}: ${exercise.cancelReason ?? ""}`
                : ""}
            </p>
            {exercise.reviewNotes ? (
              <p className="rounded-md border border-border/60 px-3 py-2 text-sm">
                Review notes: {exercise.reviewNotes}
              </p>
            ) : null}
          </div>
        </Section>

        <Section title="History" description="Append-only continuity events for this exercise.">
          {detail.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.history.map((event) => (
                <li key={event._id} className="rounded-md border border-border/60 px-3 py-2">
                  <p>{event.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {event.actorLabel} · {formatDateTime(event.createdAt)}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      {editing && options ? (
        <ExerciseFormDialog
          open={editing}
          onOpenChange={setEditing}
          plans={options.plans}
          members={options.members}
          exerciseId={exerciseId}
          initial={valuesFromExercise(exercise)}
        />
      ) : null}

      <ActivityDialog
        open={activityOpen}
        onOpenChange={setActivityOpen}
        exerciseId={exerciseId}
        canReport={exercise.resultsEditable}
      />

      <MeasurementDialog
        open={measurementOpen}
        onOpenChange={setMeasurementOpen}
        exerciseId={exerciseId}
        baseline={exercise.baseline}
        coveredStrategies={detail.coverage.map((row) => ({
          _id: String(row.strategyId),
          reference: row.strategyReference,
          title: row.strategyTitle,
        }))}
      />

      <CoverageDialog
        open={coverageOpen}
        onOpenChange={setCoverageOpen}
        exerciseId={exerciseId}
        strategies={detail.strategies}
        recordedStrategyIds={detail.coverage.map((row) => String(row.strategyId))}
      />

      <FindingDialog
        open={findingOpen}
        onOpenChange={setFindingOpen}
        exerciseId={exerciseId}
        strategies={detail.strategies}
        members={detail.members}
        currentUserId={detail.currentUserId}
      />

      <FindingStatusDialog
        target={findingTarget}
        onOpenChange={(open) => {
          if (!open) setFindingTarget(null);
        }}
        busy={busy}
        onSubmit={(input) =>
          findingTarget &&
          run(async () => {
            await updateFindingStatus({
              findingId: findingTarget.id,
              status: input.status,
              note: input.note || undefined,
              evidenceReference: input.evidenceReference || undefined,
              acceptanceRationale: input.acceptanceRationale || undefined,
            });
            setFindingTarget(null);
          }, "Finding status recorded.")
        }
      />

      {completing ? (
        <Dialog open onOpenChange={(next) => !busy && (next ? null : setCompleting(false))}>
          <DialogContent className="sm:max-w-xl">
            <DialogHeader>
              <DialogTitle>Complete this exercise</DialogTitle>
              <DialogDescription>
                Completion records the outcome. It does not mark any objective
                met, verify any capability or close any gap.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <Field label="Outcome">
                <Textarea
                  rows={3}
                  value={outcome.summary}
                  onChange={(event) =>
                    setOutcome((current) => ({ ...current, summary: event.target.value }))
                  }
                  data-testid="bcm-exercise-outcome"
                />
              </Field>
              <Field label="Outcome justification">
                <Textarea
                  rows={3}
                  value={outcome.justification}
                  onChange={(event) =>
                    setOutcome((current) => ({
                      ...current,
                      justification: event.target.value,
                    }))
                  }
                  data-testid="bcm-exercise-justification"
                />
              </Field>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCompleting(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await completeExercise({
                      exerciseId,
                      outcomeSummary: outcome.summary,
                      outcomeJustification: outcome.justification,
                    });
                    setCompleting(false);
                  }, "Exercise completed, awaiting review.")
                }
                data-testid="bcm-exercise-complete-confirm"
              >
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
                Complete exercise
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {cancelling ? (
        <NoteDialog
          open
          onOpenChange={(open) => {
            if (!open) setCancelling(false);
          }}
          title="Cancel this exercise"
          description="Cancellation is recorded with a reason. A cancelled exercise keeps its place in history and cannot be reviewed."
          label="Cancellation reason"
          submitLabel="Cancel exercise"
          busy={busy}
          onSubmit={(reason) =>
            run(async () => {
              await cancelExercise({ exerciseId, reason });
              setCancelling(false);
            }, "Exercise cancelled.")
          }
        />
      ) : null}

      {verifying ? (
        <NoteDialog
          open
          onOpenChange={(open) => {
            if (!open) setVerifying(null);
          }}
          title="Independently verify this activity"
          description="Verification confirms the reported activity against the evidence. You cannot verify an activity you reported."
          label="Verification notes"
          submitLabel="Record verification"
          busy={busy}
          onSubmit={(notes) =>
            run(async () => {
              await verifyActivity({ activityId: verifying, verificationNotes: notes });
              setVerifying(null);
            }, "Activity verification recorded.")
          }
        />
      ) : null}

      {review ? (
        <NoteDialog
          open
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={review === "approved" ? "Accept these results" : "Return this exercise"}
          description={
            review === "approved"
              ? "Accepting records the review decision. It does not execute recovery, and only strategies evidenced by this exercise can become exercise-verified."
              : "A returned exercise is corrected by recording a new version; its reported results stay in history unchanged."
          }
          label="Review notes"
          submitLabel={review === "approved" ? "Accept results" : "Return exercise"}
          busy={busy}
          onSubmit={(reviewNotes) =>
            run(async () => {
              await reviewExercise({ exerciseId, decision: review, reviewNotes });
              setReview(null);
            }, review === "approved" ? "Exercise accepted." : "Exercise returned.")
          }
        />
      ) : null}

      {superseding ? (
        <NoteDialog
          open
          onOpenChange={(open) => {
            if (!open) setSuperseding(false);
          }}
          title="Record a corrected version"
          description="The earlier record keeps its results, review and history. The new version starts as a planned exercise and must be executed and reviewed again."
          label="Reason for the new version"
          submitLabel="Open new version"
          busy={busy}
          onSubmit={(reason) =>
            run(async () => {
              const result = await supersedeExercise({ exerciseId, reason });
              setSuperseding(false);
              navigate(`/bcm/dr-tests/${result.exerciseId}`);
            }, "New exercise version opened.")
          }
        />
      ) : null}
    </>
  );
}

export function BcmExerciseDetailPage({ path }: { path: string }) {
  const navigate = useNavigate();
  const session = useQuery(api.session.getSession, {});
  const params = useParams<{ exerciseId?: string }>();
  const raw = params.exerciseId ?? "";
  const exerciseId = /^[a-z0-9]{16,64}$/i.test(raw)
    ? (raw as Id<"recoveryExercises">)
    : null;

  if (session && !session.permissions?.bcm) return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path="/bcm/dr-tests" />
      <PageHeader
        eyebrow="Business Continuity"
        title="Recovery exercise"
        description="A recorded exercise: planned activities, reported observations, independent verification, measured performance, findings and review."
        actions={
          <Button variant="outline" size="sm" onClick={() => navigate(-1)}>
            <ChevronLeft className="mr-1 size-4" aria-hidden />
            Back
          </Button>
        }
      />
      <BcmBoundary title="Recovery exercise">
        {exerciseId ? (
          <ExerciseDetail exerciseId={exerciseId} />
        ) : (
          <EmptyState
            icon={ClipboardCheck}
            title="Exercise not found"
            description="The address does not identify a recovery exercise."
          />
        )}
      </BcmBoundary>
    </AppLayout>
  );
}
