import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { useNavigate, useParams } from "react-router";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import {
  EmptyState,
  ListSkeleton,
} from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { formatDate } from "@/lib/format";
import {
  BCM_CAPABILITY_EVIDENCE_LABELS,
  BCM_GAP_SEVERITIES,
  BCM_GAP_SEVERITY_LABELS,
  BCM_GAP_STATUS_LABELS,
  BCM_GAP_TRANSITIONS,
  BCM_STRATEGY_STATUS_LABELS,
  BCM_STRATEGY_TRANSITIONS,
  planIsEditable,
  type BcmGapSeverity,
  type BcmGapStatus,
  type BcmStrategyStatus,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmDisclaimer,
  BcmUnauthorized,
  CriticalityPill,
  Field,
  GapSeverityPill,
  GapStatusPill,
  Metric,
  PlanStatusPill,
  StrategyStatusPill,
} from "./BcmPrimitives";
import { PlanFormDialog, valuesFromPlan } from "./BcmPlanForm";
import {
  AlertTriangle,
  Archive,
  CheckCircle2,
  ChevronLeft,
  FileText,
  GitBranch,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /bcm/plans/:planId — Business Continuity Batch 2: plan detail.
 * ============================================================
 * Shows the plan, the recovery baseline it relies on, its version family, the
 * documented recovery strategies (with their ESTIMATED capability) and the open
 * recovery gaps. Reviewer actions are only offered to a signed-in member who
 * holds bcm.manage and is not the preparer; the server refuses either way.
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

function StrategyDialog({
  open,
  onOpenChange,
  planId,
  members,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: Id<"continuityPlans">;
  members: Array<{ userId: Id<"users">; label: string }>;
  currentUserId: string;
}) {
  const createStrategy = useMutation(api.continuityPlans.createStrategy);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    title: "",
    objective: "",
    disruptionScenario: "",
    recoveryApproach: "",
    alternativeArrangements: "",
    manualFallback: "",
    personnelRequirements: "",
    ictDependencies: "",
    vendorDependencies: "",
    facilitiesRequirements: "",
    minimumServiceLevel: "",
    expectedRecoveryMinutes: "",
    targetRtoMinutes: "",
    targetRpoMinutes: "",
    targetMtpdMinutes: "",
    capabilityRationale: "",
    ownerUserId: members.some((m) => String(m.userId) === currentUserId)
      ? currentUserId
      : String(members[0]?.userId ?? ""),
    statusRationale:
      "Proposed for adoption; adoption is a separate, attributed decision.",
  });

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const minutes = (value: string): number | undefined =>
    value.trim() === "" ? undefined : Number(value);

  async function submit() {
    setBusy(true);
    try {
      await createStrategy({
        planId,
        title: form.title,
        objective: form.objective,
        disruptionScenario: form.disruptionScenario,
        recoveryApproach: form.recoveryApproach,
        alternativeArrangements: form.alternativeArrangements || undefined,
        manualFallback: form.manualFallback || undefined,
        personnelRequirements: form.personnelRequirements,
        ictDependencies: form.ictDependencies || undefined,
        vendorDependencies: form.vendorDependencies || undefined,
        facilitiesRequirements: form.facilitiesRequirements || undefined,
        minimumServiceLevel: form.minimumServiceLevel,
        expectedRecoveryMinutes: minutes(form.expectedRecoveryMinutes),
        targetRtoMinutes: minutes(form.targetRtoMinutes),
        targetRpoMinutes: minutes(form.targetRpoMinutes),
        targetMtpdMinutes: minutes(form.targetMtpdMinutes),
        capabilityEvidence: "estimate",
        capabilityRationale: form.capabilityRationale,
        ownerUserId: form.ownerUserId as Id<"users">,
        statusRationale: form.statusRationale,
      });
      toast.success("Recovery strategy documented as a proposal.");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The strategy could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Document a recovery strategy</DialogTitle>
          <DialogDescription>
            Describe how the service would be recovered. Expected recovery time
            is an estimate: no exercise has validated it, and this record never
            asserts that the objective will be met.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Strategy title" htmlFor="strategy-title">
              <Input
                id="strategy-title"
                value={form.title}
                placeholder="e.g. Warm standby payment switch"
                onChange={(e) => set("title", e.target.value)}
              />
            </Field>
            <Field label="Strategy owner" htmlFor="strategy-owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger id="strategy-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={String(member.userId)}>
                      {member.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Objective" htmlFor="strategy-objective">
            <Textarea
              id="strategy-objective"
              rows={2}
              value={form.objective}
              onChange={(e) => set("objective", e.target.value)}
            />
          </Field>
          <Field label="Disruption scenario" htmlFor="strategy-scenario">
            <Textarea
              id="strategy-scenario"
              rows={2}
              value={form.disruptionScenario}
              onChange={(e) => set("disruptionScenario", e.target.value)}
            />
          </Field>
          <Field label="Recovery approach" htmlFor="strategy-approach">
            <Textarea
              id="strategy-approach"
              rows={3}
              value={form.recoveryApproach}
              onChange={(e) => set("recoveryApproach", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Alternative work arrangements" htmlFor="strategy-alt">
              <Textarea
                id="strategy-alt"
                rows={2}
                value={form.alternativeArrangements}
                onChange={(e) => set("alternativeArrangements", e.target.value)}
              />
            </Field>
            <Field label="Manual fallback procedures" htmlFor="strategy-manual">
              <Textarea
                id="strategy-manual"
                rows={2}
                value={form.manualFallback}
                onChange={(e) => set("manualFallback", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Personnel and resource requirements" htmlFor="strategy-people">
            <Textarea
              id="strategy-people"
              rows={2}
              value={form.personnelRequirements}
              onChange={(e) => set("personnelRequirements", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="ICT dependencies" htmlFor="strategy-ict">
              <Textarea
                id="strategy-ict"
                rows={2}
                value={form.ictDependencies}
                onChange={(e) => set("ictDependencies", e.target.value)}
              />
            </Field>
            <Field label="Vendor dependencies" htmlFor="strategy-vendor">
              <Textarea
                id="strategy-vendor"
                rows={2}
                value={form.vendorDependencies}
                onChange={(e) => set("vendorDependencies", e.target.value)}
              />
            </Field>
            <Field label="Facilities and equipment" htmlFor="strategy-facilities">
              <Textarea
                id="strategy-facilities"
                rows={2}
                value={form.facilitiesRequirements}
                onChange={(e) => set("facilitiesRequirements", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Minimum service level during disruption" htmlFor="strategy-msl">
            <Textarea
              id="strategy-msl"
              rows={2}
              value={form.minimumServiceLevel}
              onChange={(e) => set("minimumServiceLevel", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Expected recovery (min)" htmlFor="strategy-expected">
              <Input
                id="strategy-expected"
                inputMode="numeric"
                value={form.expectedRecoveryMinutes}
                onChange={(e) => set("expectedRecoveryMinutes", e.target.value)}
              />
            </Field>
            <Field label="Target RTO (min)" htmlFor="strategy-rto">
              <Input
                id="strategy-rto"
                inputMode="numeric"
                value={form.targetRtoMinutes}
                onChange={(e) => set("targetRtoMinutes", e.target.value)}
              />
            </Field>
            <Field label="Target RPO (min)" htmlFor="strategy-rpo">
              <Input
                id="strategy-rpo"
                inputMode="numeric"
                value={form.targetRpoMinutes}
                onChange={(e) => set("targetRpoMinutes", e.target.value)}
              />
            </Field>
            <Field label="Target MTPD (min)" htmlFor="strategy-mtpd">
              <Input
                id="strategy-mtpd"
                inputMode="numeric"
                value={form.targetMtpdMinutes}
                onChange={(e) => set("targetMtpdMinutes", e.target.value)}
              />
            </Field>
          </div>
          <p className="rounded-md border border-border/70 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Capability evidence: {BCM_CAPABILITY_EVIDENCE_LABELS.estimate}. A
            strategy can only record an estimated capability until recovery
            exercises exist.
          </p>
          <Field
            label="Capability rationale"
            htmlFor="strategy-capability"
            hint="Why this estimate is credible: what it is based on, and what remains unproven."
          >
            <Textarea
              id="strategy-capability"
              rows={2}
              value={form.capabilityRationale}
              onChange={(e) => set("capabilityRationale", e.target.value)}
            />
          </Field>
          <Field label="Status rationale" htmlFor="strategy-status">
            <Textarea
              id="strategy-status"
              rows={2}
              value={form.statusRationale}
              onChange={(e) => set("statusRationale", e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="bcm-strategy-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Save strategy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GapDialog({
  open,
  onOpenChange,
  planId,
  strategies,
  members,
  currentUserId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planId: Id<"continuityPlans">;
  strategies: Array<{ _id: Id<"recoveryStrategies">; reference: string; title: string }>;
  members: Array<{ userId: Id<"users">; label: string }>;
  currentUserId: string;
}) {
  const createGap = useMutation(api.continuityPlans.createGap);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState(() => ({
    strategyId: "none",
    description: "",
    severity: "high" as BcmGapSeverity,
    ownerUserId: members.some((m) => String(m.userId) === currentUserId)
      ? currentUserId
      : String(members[0]?.userId ?? ""),
    targetResolutionDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    mitigationRecommendation: "",
  }));

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      await createGap({
        planId,
        ...(form.strategyId === "none"
          ? {}
          : { strategyId: form.strategyId as Id<"recoveryStrategies"> }),
        description: form.description,
        severity: form.severity,
        ownerUserId: form.ownerUserId as Id<"users">,
        targetResolutionDate: new Date(`${form.targetResolutionDate}T23:59:00`).getTime(),
        mitigationRecommendation: form.mitigationRecommendation,
      });
      toast.success("Recovery gap recorded as open.");
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The gap could not be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record a recovery gap</DialogTitle>
          <DialogDescription>
            A gap between the approved objectives and the documented recovery
            capability. It stays open until it is explicitly resolved or
            accepted, with an attributed rationale.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Related strategy" htmlFor="gap-strategy">
            <Select
              value={form.strategyId}
              onValueChange={(value) => set("strategyId", value)}
            >
              <SelectTrigger id="gap-strategy">
                <SelectValue placeholder="No specific strategy" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No specific strategy</SelectItem>
                {strategies.map((strategy) => (
                  <SelectItem key={strategy._id} value={String(strategy._id)}>
                    {strategy.reference} — {strategy.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Gap description" htmlFor="gap-description">
            <Textarea
              id="gap-description"
              rows={3}
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Severity" htmlFor="gap-severity">
              <Select
                value={form.severity}
                onValueChange={(value) => set("severity", value as BcmGapSeverity)}
              >
                <SelectTrigger id="gap-severity">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BCM_GAP_SEVERITIES.map((severity) => (
                    <SelectItem key={severity} value={severity}>
                      {BCM_GAP_SEVERITY_LABELS[severity]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Owner" htmlFor="gap-owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger id="gap-owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {members.map((member) => (
                    <SelectItem key={member.userId} value={String(member.userId)}>
                      {member.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Target resolution date" htmlFor="gap-target">
              <Input
                id="gap-target"
                type="date"
                value={form.targetResolutionDate}
                onChange={(e) => set("targetResolutionDate", e.target.value)}
              />
            </Field>
          </div>
          <Field label="Mitigation recommendation" htmlFor="gap-mitigation">
            <Textarea
              id="gap-mitigation"
              rows={3}
              value={form.mitigationRecommendation}
              onChange={(e) => set("mitigationRecommendation", e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="bcm-gap-save">
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            Record gap
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  label,
  submitLabel,
  busy,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  label: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Field label={label} htmlFor="reason-input">
          <Textarea
            id="reason-input"
            rows={4}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit(value)}
            disabled={busy}
            data-testid="bcm-reason-submit"
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
            {submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PlanDetail({ planId }: { planId: Id<"continuityPlans"> }) {
  const navigate = useNavigate();
  const detail = useQuery(api.continuityPlans.getPlan, { planId });
  const options = useQuery(api.continuityPlans.planFormOptions, {});

  const submitPlan = useMutation(api.continuityPlans.submitPlan);
  const reviewPlan = useMutation(api.continuityPlans.reviewPlan);
  const revisePlan = useMutation(api.continuityPlans.revisePlan);
  const archivePlan = useMutation(api.continuityPlans.archivePlan);
  const updateStrategyStatus = useMutation(
    api.continuityPlans.updateStrategyStatus,
  );
  const updateGapStatus = useMutation(api.continuityPlans.updateGapStatus);

  const [editing, setEditing] = useState(false);
  const [strategyOpen, setStrategyOpen] = useState(false);
  const [gapOpen, setGapOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<"approved" | "rejected" | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [strategyAction, setStrategyAction] = useState<{
    id: Id<"recoveryStrategies">;
    reference: string;
    status: BcmStrategyStatus;
  } | null>(null);
  const [gapAction, setGapAction] = useState<{
    id: Id<"recoveryGaps">;
    reference: string;
    status: BcmGapStatus;
  } | null>(null);

  if (detail === undefined) return <ListSkeleton rows={6} />;
  if (detail === null) {
    return (
      <EmptyState
        icon={FileText}
        title="Continuity plan not found"
        description="This plan does not exist in your organization, or it was removed."
      />
    );
  }

  const plan = detail.plan;
  const canManage = detail.canManage;
  const editable = canManage && planIsEditable(plan.status as never);
  const isPreparer = detail.currentUserId === plan.preparedByUserId;
  const canReview =
    canManage && plan.status === "in_review" && !isPreparer;

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The action was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h2 className="mb-3 text-xl font-semibold tracking-tight">{plan.title}</h2>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <PlanStatusPill status={plan.status} label={plan.statusLabel} />
        <Badge variant="outline" className="font-mono text-xs">
          {plan.reference} v{plan.version}
        </Badge>
        <Badge variant="outline" className="text-xs">
          {plan.recoveryPriorityLabel}
        </Badge>
        {plan.reviewOverdue ? (
          <Badge variant="outline" className="border-critical/30 bg-critical/10 text-critical">
            Review overdue
          </Badge>
        ) : null}
        {!plan.baseline.biaId ? (
          <Badge variant="outline" className="border-warning/40 bg-warning/10">
            No linked baseline
          </Badge>
        ) : null}
      </div>

      {detail.baselineWarning ? (
        <p className="mb-4 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {detail.baselineWarning}
        </p>
      ) : null}

      <div className="mb-4 flex flex-wrap gap-2">
        {editable ? (
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="mr-1 size-4" aria-hidden />
            Edit plan
          </Button>
        ) : null}
        {canManage && (plan.status === "draft" || plan.status === "returned") ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              run(
                () => submitPlan({ planId }),
                "Plan submitted for independent review.",
              )
            }
            data-testid="bcm-plan-submit"
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
              data-testid="bcm-plan-approve"
            >
              <CheckCircle2 className="mr-1 size-4" aria-hidden />
              Approve
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setReview("rejected")}
              data-testid="bcm-plan-return"
            >
              <RotateCcw className="mr-1 size-4" aria-hidden />
              Return for revision
            </Button>
          </>
        ) : null}
        {canManage && (plan.status === "approved" || plan.status === "superseded") ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await revisePlan({ planId });
                  navigate(`/bcm/plans/${result.planId}`);
                }, "Revision opened as a new draft.")
              }
              data-testid="bcm-plan-revise"
            >
              <GitBranch className="mr-1 size-4" aria-hidden />
              Open revision
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setArchiving(true)}
              data-testid="bcm-plan-archive"
            >
              <Archive className="mr-1 size-4" aria-hidden />
              Archive
            </Button>
          </>
        ) : null}
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Services covered" value={plan.serviceCount} />
        <Metric label="Recovery strategies" value={detail.strategies.length} />
        <Metric
          label="Open gaps"
          value={detail.gaps.filter((g) => g.status === "open" || g.status === "in_progress").length}
          tone={
            detail.gaps.some((g) => g.status === "open" || g.status === "in_progress")
              ? "text-critical"
              : undefined
          }
        />
        <Metric
          label="Next review"
          value={formatDate(plan.reviewDueAt)}
          hint={plan.status === "approved" ? "Approved plan" : "Draft plan"}
        />
      </div>

      <div className="space-y-4">
        <Section title="Purpose and scope">
          <div className="space-y-3 text-sm">
            <p className="whitespace-pre-line">{plan.purpose}</p>
            <dl className="grid gap-3 sm:grid-cols-2">
              {[
                ["Scope", plan.scope],
                ["Exclusions", plan.exclusions],
                ["Assumptions", plan.assumptions],
                ["Disruption scenarios addressed", plan.disruptionScenarios],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </dt>
                  <dd className="mt-1 whitespace-pre-line">{value}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted-foreground">
              Owner {plan.ownerLabel} · prepared by {plan.preparedByLabel} on{" "}
              {formatDate(plan.preparedAt)}
              {plan.approvedAt
                ? ` · approved by ${plan.reviewedByLabel} on ${formatDate(plan.approvedAt)}`
                : ""}
            </p>
          </div>
        </Section>

        <Section
          title="Services covered"
          description="The plan names a primary service and any additional services it covers."
        >
          <ul className="space-y-2 text-sm">
            {detail.primaryService ? (
              <li className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {detail.primaryService.reference}
                </Badge>
                <span className="font-medium">{detail.primaryService.name}</span>
                <span className="text-xs uppercase tracking-wide text-muted-foreground">
                  primary
                </span>
                <CriticalityPill
                  criticality={detail.primaryService.criticality}
                  label={detail.primaryService.criticality}
                />
              </li>
            ) : null}
            {detail.additionalServices.map((service) => (
              <li key={service._id} className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className="font-mono text-xs">
                  {service.reference}
                </Badge>
                <span>{service.name}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section
          title="Recovery baseline"
          description="The analysis this plan was written against, with its recorded objectives."
        >
          {detail.baseline ? (
            <div className="space-y-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">
                  {detail.baseline.reference} v{detail.baseline.version}
                </span>
                <Badge
                  variant="outline"
                  className={
                    detail.baseline.approved
                      ? "border-success/25 bg-success/10 text-success"
                      : "border-warning/40 bg-warning/10"
                  }
                >
                  {detail.baseline.status.replace("_", " ")}
                </Badge>
                {plan.baseline.biaVersion !== detail.baseline.version ? (
                  <span className="text-xs text-muted-foreground">
                    recorded at v{plan.baseline.biaVersion}
                    {plan.baseline.biaStatusAtApproval
                      ? ` · status at approval: ${plan.baseline.biaStatusAtApproval}`
                      : ""}
                  </span>
                ) : null}
              </div>
              <dl className="grid gap-3 sm:grid-cols-3">
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    RTO
                  </dt>
                  <dd className="mt-1">{detail.baseline.rtoLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    RPO
                  </dt>
                  <dd className="mt-1">{detail.baseline.rpoLabel}</dd>
                </div>
                <div>
                  <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                    MTPD
                  </dt>
                  <dd className="mt-1">{detail.baseline.mtpdLabel}</dd>
                </div>
              </dl>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Minimum acceptable service level
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {detail.baseline.minimumServiceLevel}
                </p>
              </div>
              {!detail.baseline.approved ? (
                <p className="text-xs text-muted-foreground">
                  The linked analysis is not approved, so these objectives are
                  not an approved recovery baseline. A plan relying on it is
                  flagged on the register and in the approval history.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No business impact analysis is linked. Objectives shown anywhere
              else in this module belong to the analysis, not to this plan.
            </p>
          )}
        </Section>

        <Section
          title="Recovery strategies"
          description="Documented approaches. Capability is an estimate until an exercise verifies it."
          action={
            editable ? (
              <Button size="sm" variant="outline" onClick={() => setStrategyOpen(true)}>
                <Plus className="mr-1 size-4" aria-hidden />
                Add strategy
              </Button>
            ) : undefined
          }
        >
          {detail.strategies.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recovery strategy has been documented for this plan yet.
            </p>
          ) : (
            <div className="space-y-3">
              {detail.strategies.map((strategy) => {
                const nextStatuses = BCM_STRATEGY_TRANSITIONS[
                  strategy.status as BcmStrategyStatus
                ];
                return (
                  <div
                    key={strategy._id}
                    className="rounded-lg border border-border/70 p-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {strategy.reference}
                      </span>
                      <span className="font-medium">{strategy.title}</span>
                      <StrategyStatusPill
                        status={strategy.status}
                        label={strategy.statusLabel}
                      />
                      {nextStatuses.length > 0 && editable ? (
                        <span className="ml-auto flex gap-1">
                          {nextStatuses.map((next) => (
                            <Button
                              key={next}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setStrategyAction({
                                  id: strategy._id,
                                  reference: strategy.reference,
                                  status: next,
                                })
                              }
                            >
                              {BCM_STRATEGY_STATUS_LABELS[next]}
                            </Button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm whitespace-pre-line">
                      {strategy.objective}
                    </p>
                    <dl className="mt-2 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <dt className="text-muted-foreground">Recovery approach</dt>
                        <dd className="mt-0.5">{strategy.recoveryApproach}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">
                          Estimated recovery
                        </dt>
                        <dd className="mt-0.5">
                          {strategy.expectedRecoveryLabel}
                          {strategy.baselineRtoLabel
                            ? ` · approved RTO ${strategy.baselineRtoLabel}`
                            : ""}
                          {strategy.rtoDeltaMinutes !== null ? (
                            <span
                              className={
                                strategy.rtoDeltaMinutes > 0
                                  ? "font-medium text-critical"
                                  : ""
                              }
                            >
                              {strategy.rtoDeltaMinutes > 0
                                ? ` · estimate exceeds the objective by ${strategy.rtoDeltaMinutes} min`
                                : ` · estimate within the objective by ${Math.abs(strategy.rtoDeltaMinutes)} min`}
                            </span>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Capability evidence</dt>
                        <dd className="mt-0.5">{strategy.capabilityEvidenceLabel}</dd>
                      </div>
                      <div>
                        <dt className="text-muted-foreground">Owner</dt>
                        <dd className="mt-0.5">{strategy.ownerLabel}</dd>
                      </div>
                      {strategy.personnelRequirements ? (
                        <div>
                          <dt className="text-muted-foreground">Personnel</dt>
                          <dd className="mt-0.5">{strategy.personnelRequirements}</dd>
                        </div>
                      ) : null}
                      {strategy.ictDependencies ? (
                        <div>
                          <dt className="text-muted-foreground">ICT dependencies</dt>
                          <dd className="mt-0.5">{strategy.ictDependencies}</dd>
                        </div>
                      ) : null}
                      {strategy.vendorDependencies ? (
                        <div>
                          <dt className="text-muted-foreground">Vendor dependencies</dt>
                          <dd className="mt-0.5">{strategy.vendorDependencies}</dd>
                        </div>
                      ) : null}
                      {strategy.facilitiesRequirements ? (
                        <div>
                          <dt className="text-muted-foreground">Facilities</dt>
                          <dd className="mt-0.5">{strategy.facilitiesRequirements}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <p className="mt-2 text-xs text-muted-foreground">
                      Status rationale: {strategy.statusRationale}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
          <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Documenting a strategy does not demonstrate that it would meet the
            approved objectives. Gaps are recorded separately and are never
            closed automatically.
          </p>
        </Section>

        <Section
          title="Recovery gaps"
          description="Structured gaps between the approved objectives and the documented capability."
          action={
            canManage && plan.status !== "archived" ? (
              <Button size="sm" variant="outline" onClick={() => setGapOpen(true)}>
                <Plus className="mr-1 size-4" aria-hidden />
                Record gap
              </Button>
            ) : undefined
          }
        >
          {detail.gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No recovery gaps recorded. This does not mean the strategies meet
              the objectives — only that no gap has been documented.
            </p>
          ) : (
            <div className="space-y-2">
              {detail.gaps.map((gap) => {
                const nextStatuses = BCM_GAP_TRANSITIONS[gap.status as BcmGapStatus];
                return (
                  <div
                    key={gap._id}
                    className="rounded-lg border border-border/70 p-3 text-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">
                        {gap.reference}
                      </span>
                      <GapSeverityPill severity={gap.severity} label={gap.severityLabel} />
                      <GapStatusPill status={gap.status} label={gap.statusLabel} />
                      {gap.overdue ? (
                        <Badge variant="outline" className="border-critical/30 bg-critical/10 text-critical text-xs">
                          Past target date
                        </Badge>
                      ) : null}
                      {nextStatuses.length > 0 && canManage ? (
                        <span className="ml-auto flex gap-1">
                          {nextStatuses.map((next) => (
                            <Button
                              key={next}
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                setGapAction({
                                  id: gap._id,
                                  reference: gap.reference,
                                  status: next,
                                })
                              }
                            >
                              {BCM_GAP_STATUS_LABELS[next]}
                            </Button>
                          ))}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 whitespace-pre-line">{gap.description}</p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      Owner {gap.ownerLabel} · target{" "}
                      {formatDate(gap.targetResolutionDate)}
                      {gap.strategyReference ? ` · strategy ${gap.strategyReference}` : ""}
                      {gap.statusRationale ? ` · ${gap.statusRationale}` : ""}
                    </p>
                    <p className="mt-1 text-xs">
                      Mitigation: {gap.mitigationRecommendation}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </Section>

        <Section title="Version history">
          <ul className="space-y-2 text-sm">
            {detail.versions.map((version) => (
              <li
                key={version._id}
                className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 px-3 py-2"
              >
                <span className="font-mono text-xs">{version.reference}</span>
                <span>v{version.version}</span>
                <PlanStatusPill
                  status={version.status}
                  label={version.status.replace("_", " ")}
                />
                <span className="text-xs text-muted-foreground">
                  {version.approvedAt
                    ? `approved ${formatDate(version.approvedAt)}`
                    : version.status === "superseded"
                      ? "superseded"
                      : "not approved"}
                  {version.biaReference
                    ? ` · baseline ${version.biaReference} v${version.biaVersion}`
                    : " · no baseline"}
                </span>
                {version._id !== plan._id ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-auto"
                    onClick={() => navigate(`/bcm/plans/${version._id}`)}
                  >
                    Open
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </Section>

        <Section title="History" description="Append-only continuity events for this plan.">
          {detail.history.length === 0 ? (
            <p className="text-sm text-muted-foreground">No history recorded.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {detail.history.map((event) => (
                <li
                  key={event._id}
                  className="rounded-md border border-border/60 px-3 py-2"
                >
                  <p>{event.summary}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {event.actorLabel} · {formatDate(event.createdAt)}
                    {event.reason ? ` · ${event.reason}` : ""}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>

      <BcmDisclaimer className="mt-6" />

      {editing && options ? (
        <PlanFormDialog
          open={editing}
          onOpenChange={setEditing}
          services={options.services}
          bias={options.bias}
          members={options.members}
          planId={planId}
          initial={valuesFromPlan(plan)}
        />
      ) : null}

      {strategyOpen && options ? (
        <StrategyDialog
          open={strategyOpen}
          onOpenChange={setStrategyOpen}
          planId={planId}
          members={options.members}
          currentUserId={String(options.currentUserId)}
        />
      ) : null}

      {gapOpen && options ? (
        <GapDialog
          open={gapOpen}
          onOpenChange={setGapOpen}
          planId={planId}
          strategies={detail.strategies.map((row) => ({
            _id: row._id,
            reference: row.reference,
            title: row.title,
          }))}
          members={options.members}
          currentUserId={String(options.currentUserId)}
        />
      ) : null}

      {review ? (
        <ReasonDialog
          open={review !== null}
          onOpenChange={(open) => {
            if (!open) setReview(null);
          }}
          title={review === "approved" ? "Approve this plan" : "Return for revision"}
          description={
            review === "approved"
              ? "Approval freezes this version. Later changes require a numbered revision that is reviewed again."
              : "The plan returns to its author for revision and cannot be approved until it is resubmitted."
          }
          label="Review notes"
          submitLabel={review === "approved" ? "Approve version" : "Return plan"}
          busy={busy}
          onSubmit={(notes) =>
            run(async () => {
              await reviewPlan({
                planId,
                decision: review,
                reviewNotes: notes,
              });
              setReview(null);
            }, review === "approved" ? "Plan approved." : "Plan returned for revision.")
          }
        />
      ) : null}

      {archiving ? (
        <ReasonDialog
          open={archiving}
          onOpenChange={setArchiving}
          title="Archive this plan"
          description="Archiving retires the plan from active use. Its history and versions stay readable."
          label="Archive reason"
          submitLabel="Archive plan"
          busy={busy}
          onSubmit={(reason) =>
            run(async () => {
              await archivePlan({ planId, reason });
              setArchiving(false);
            }, "Plan archived.")
          }
        />
      ) : null}

      {strategyAction ? (
        <ReasonDialog
          open={strategyAction !== null}
          onOpenChange={(open) => {
            if (!open) setStrategyAction(null);
          }}
          title={`Set ${strategyAction.reference} to ${BCM_STRATEGY_STATUS_LABELS[strategyAction.status]}`}
          description="Strategy status changes are attributed and appended to the plan history."
          label="Status rationale"
          submitLabel="Record change"
          busy={busy}
          onSubmit={(rationale) =>
            run(async () => {
              await updateStrategyStatus({
                strategyId: strategyAction.id,
                status: strategyAction.status,
                rationale,
              });
              setStrategyAction(null);
            }, "Strategy status recorded.")
          }
        />
      ) : null}

      {gapAction ? (
        <ReasonDialog
          open={gapAction !== null}
          onOpenChange={(open) => {
            if (!open) setGapAction(null);
          }}
          title={`Set ${gapAction.reference} to ${BCM_GAP_STATUS_LABELS[gapAction.status]}`}
          description="Resolving or accepting a gap requires a rationale and is attributed to you."
          label="Status rationale"
          submitLabel="Record change"
          busy={busy}
          onSubmit={(rationale) =>
            run(async () => {
              await updateGapStatus({
                gapId: gapAction.id,
                status: gapAction.status,
                rationale,
              });
              setGapAction(null);
            }, "Gap status recorded.")
          }
        />
      ) : null}
    </>
  );
}

export function BcmPlanDetailPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  const params = useParams<{ planId?: string }>();
  const raw = params.planId ?? "";
  const planId = /^[a-z0-9]{16,64}$/i.test(raw)
    ? (raw as Id<"continuityPlans">)
    : null;

  if (session && !session.permissions?.bcm) return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path="/bcm/plans" />
      <PageHeader
        eyebrow="Business Continuity"
        title="Continuity plan"
        description="Plan content, its recovery baseline, documented strategies, recovery gaps and the review lifecycle."
        actions={
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>
            <ChevronLeft className="mr-1 size-4" aria-hidden />
            Back
          </Button>
        }
      />
      <BcmBoundary title="Continuity plan">
        {planId ? (
          <PlanDetail planId={planId} />
        ) : (
          <EmptyState
            icon={FileText}
            title="Unknown plan reference"
            description="The address does not contain a valid continuity plan identifier."
          />
        )}
      </BcmBoundary>
    </AppLayout>
  );
}
