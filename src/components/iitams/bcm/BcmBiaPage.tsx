import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import {
  EmptyState,
  ListSkeleton,
  SearchFilterBar,
} from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card } from "@/components/ui/card";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDate } from "@/lib/format";
import {
  BCM_BIA_STATUSES,
  BCM_BIA_STATUS_LABELS,
  BCM_IMPACT_CATEGORIES,
  BCM_IMPACT_CATEGORY_LABELS,
  BCM_IMPACT_SEVERITIES,
  BCM_IMPACT_SEVERITY_LABELS,
  BCM_PRIORITIES,
  BCM_PRIORITY_LABELS,
  formatMinutes,
  type BcmBiaStatus,
  type BcmImpactCategory,
  type BcmImpactSeverity,
  type BcmImpacts,
  type BcmPriority,
} from "@/lib/bcm";
import {
  BcmBoundary,
  BcmDisclaimer,
  BcmUnauthorized,
  BiaStatusPill,
  CriticalityPill,
  Field,
  ImpactSeverityPill,
  Metric,
} from "./BcmPrimitives";
import {
  BarChart3,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Plus,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /bcm/bia — Business Continuity Batch 1: business impact analyses.
 * =================================================================
 * Each BIA records one service's assessed impacts, dependencies, assumptions
 * and normalized recovery objectives.
 *
 * Governance rules enforced server-side (and reflected here):
 *  - the preparer can never approve their own BIA;
 *  - approval needs an active member holding bcm.manage;
 *  - an approved BIA is immutable — it is revised as a new version;
 *  - every transition is appended to the service's history.
 */

type BiaRow = {
  _id: Id<"businessImpactAnalyses">;
  serviceId: Id<"businessServices">;
  serviceName: string;
  serviceReference: string | null;
  serviceCriticality: string | null;
  reference: string;
  title: string;
  version: number;
  revisionOf: Id<"businessImpactAnalyses"> | null;
  supersededByBiaId: Id<"businessImpactAnalyses"> | null;
  ownerLabel: string;
  assessmentDate: number;
  reviewDueAt: number;
  overdue: boolean;
  status: BcmBiaStatus;
  statusLabel: string;
  rtoMinutes: number;
  rpoMinutes: number | null;
  mtpdMinutes: number | null;
  rtoLabel: string;
  rpoLabel: string;
  mtpdLabel: string;
  recoveryPriorityLabel: string;
  preparedByUserId: Id<"users">;
  preparedByLabel: string;
  reviewedByLabel: string | null;
  approvedAt: number | null;
};

type ImpactForm = Record<BcmImpactCategory, { severity: BcmImpactSeverity; notes: string }>;

type BiaFormState = {
  serviceId: string;
  title: string;
  ownerUserId: string;
  assessmentDate: string;
  reviewDueAt: string;
  disruptionScenario: string;
  scope: string;
  impacts: ImpactForm;
  keyDependencies: string;
  singlePointsOfFailure: string;
  existingRecoveryArrangements: string;
  assumptions: string;
  limitations: string;
  criticalityRationale: string;
  rtoHours: string;
  rpoHours: string;
  mtpdHours: string;
  minimumServiceLevel: string;
  recoveryPriority: BcmPriority;
  objectiveRationale: string;
  mtpdExceptionJustification: string;
};

const PAGE_SIZE = 25;
const DAY = 86_400_000;

function emptyImpacts(): ImpactForm {
  return Object.fromEntries(
    BCM_IMPACT_CATEGORIES.map((category) => [
      category,
      { severity: "none" as BcmImpactSeverity, notes: "" },
    ]),
  ) as ImpactForm;
}

function toDateInput(value: number): string {
  return new Date(value).toISOString().slice(0, 10);
}

function toTimestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

/** Hours in the form are stored as whole minutes, so units never drift. */
function hoursToMinutes(value: string): number {
  const hours = Number(value);
  if (!Number.isFinite(hours) || hours <= 0) return Number.NaN;
  return Math.round(hours * 60);
}

function minutesToHours(value: number | null): string {
  if (value === null) return "";
  return String(Number((value / 60).toFixed(2)));
}

function emptyForm(defaultOwner: string, defaultServiceId: string): BiaFormState {
  const today = Date.now();
  return {
    serviceId: defaultServiceId,
    title: "",
    ownerUserId: defaultOwner,
    assessmentDate: toDateInput(today),
    reviewDueAt: toDateInput(today + 365 * DAY),
    disruptionScenario: "",
    scope: "",
    impacts: emptyImpacts(),
    keyDependencies: "",
    singlePointsOfFailure: "",
    existingRecoveryArrangements: "",
    assumptions: "",
    limitations: "",
    criticalityRationale: "",
    rtoHours: "",
    rpoHours: "",
    mtpdHours: "",
    minimumServiceLevel: "",
    recoveryPriority: "p2",
    objectiveRationale: "",
    mtpdExceptionJustification: "",
  };
}

function BiaFormDialog({
  bia,
  services,
  members,
  defaultServiceId,
  onClose,
}: {
  bia: {
    _id: Id<"businessImpactAnalyses">;
    serviceId: Id<"businessServices">;
    reference: string;
    title: string;
    version: number;
    ownerUserId: Id<"users">;
    assessmentDate: number;
    reviewDueAt: number;
    disruptionScenario: string;
    scope: string | null;
    impacts: BcmImpacts;
    keyDependencies: string | null;
    singlePointsOfFailure: string | null;
    existingRecoveryArrangements: string | null;
    assumptions: string;
    limitations: string;
    criticalityRationale: string;
    rtoMinutes: number;
    rpoMinutes: number | null;
    mtpdMinutes: number | null;
    minimumServiceLevel: string;
    recoveryPriority: BcmPriority;
    objectiveRationale: string;
    mtpdExceptionJustification: string | null;
  } | null;
  services: Array<{ _id: Id<"businessServices">; reference: string; name: string }>;
  members: Array<{ userId: Id<"users">; label: string }>;
  defaultServiceId?: string;
  onClose: () => void;
}) {
  const createBia = useMutation(api.businessImpactAnalyses.createBia);
  const updateBia = useMutation(api.businessImpactAnalyses.updateBia);
  const [form, setForm] = useState<BiaFormState>(() =>
    bia
      ? {
          serviceId: String(bia.serviceId),
          title: bia.title,
          ownerUserId: String(bia.ownerUserId),
          assessmentDate: toDateInput(bia.assessmentDate),
          reviewDueAt: toDateInput(bia.reviewDueAt),
          disruptionScenario: bia.disruptionScenario,
          scope: bia.scope ?? "",
          impacts: {
            ...emptyImpacts(),
            ...bia.impacts,
          },
          keyDependencies: bia.keyDependencies ?? "",
          singlePointsOfFailure: bia.singlePointsOfFailure ?? "",
          existingRecoveryArrangements: bia.existingRecoveryArrangements ?? "",
          assumptions: bia.assumptions,
          limitations: bia.limitations,
          criticalityRationale: bia.criticalityRationale,
          rtoHours: minutesToHours(bia.rtoMinutes),
          rpoHours: minutesToHours(bia.rpoMinutes),
          mtpdHours: minutesToHours(bia.mtpdMinutes),
          minimumServiceLevel: bia.minimumServiceLevel,
          recoveryPriority: bia.recoveryPriority,
          objectiveRationale: bia.objectiveRationale,
          mtpdExceptionJustification: bia.mtpdExceptionJustification ?? "",
        }
      : emptyForm("", defaultServiceId ?? ""),
  );
  const [busy, setBusy] = useState(false);

  function set<K extends keyof BiaFormState>(key: K, value: BiaFormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  function setImpact(
    category: BcmImpactCategory,
    patch: Partial<{ severity: BcmImpactSeverity; notes: string }>,
  ) {
    setForm((prev) => ({
      ...prev,
      impacts: {
        ...prev.impacts,
        [category]: { ...prev.impacts[category], ...patch },
      },
    }));
  }

  async function submit() {
    if (!form.serviceId) {
      toast.error("Select the business service this analysis covers.");
      return;
    }
    if (!form.ownerUserId) {
      toast.error("Select the assessment owner.");
      return;
    }
    const assessmentDate = toTimestamp(form.assessmentDate);
    const reviewDueAt = toTimestamp(form.reviewDueAt);
    if (assessmentDate === undefined || reviewDueAt === undefined) {
      toast.error("Record both the assessment date and the review due date.");
      return;
    }
    const rtoMinutes = hoursToMinutes(form.rtoHours);
    if (!Number.isFinite(rtoMinutes)) {
      toast.error("A recovery time objective (RTO) is required.");
      return;
    }
    setBusy(true);
    try {
      const payload = {
        serviceId: form.serviceId as Id<"businessServices">,
        title: form.title,
        ownerUserId: form.ownerUserId as Id<"users">,
        assessmentDate,
        reviewDueAt,
        disruptionScenario: form.disruptionScenario,
        scope: form.scope || undefined,
        impacts: form.impacts,
        keyDependencies: form.keyDependencies || undefined,
        singlePointsOfFailure: form.singlePointsOfFailure || undefined,
        existingRecoveryArrangements:
          form.existingRecoveryArrangements || undefined,
        assumptions: form.assumptions,
        limitations: form.limitations,
        criticalityRationale: form.criticalityRationale,
        rtoMinutes,
        rpoMinutes: form.rpoHours ? hoursToMinutes(form.rpoHours) : undefined,
        mtpdMinutes: form.mtpdHours ? hoursToMinutes(form.mtpdHours) : undefined,
        minimumServiceLevel: form.minimumServiceLevel,
        recoveryPriority: form.recoveryPriority,
        objectiveRationale: form.objectiveRationale,
        mtpdExceptionJustification:
          form.mtpdExceptionJustification || undefined,
      };
      if (bia) {
        await updateBia({ biaId: bia._id, ...payload });
        toast.success(`Draft ${bia.reference} v${bia.version} saved.`);
      } else {
        const result = await createBia(payload);
        toast.success(`BIA ${result.reference} created as a draft.`);
      }
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {bia
              ? `Edit draft ${bia.reference} v${bia.version}`
              : "New business impact analysis"}
          </DialogTitle>
          <DialogDescription>
            Record assessed impact per category, key dependencies, assumptions
            and the recovery objectives. The analysis is saved as a draft and
            needs an independent reviewer before it is approved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="grid gap-4 sm:grid-cols-2">
            <Field label="Business service" htmlFor="bia-service">
              <Select
                value={form.serviceId}
                onValueChange={(value) => set("serviceId", value)}
                disabled={Boolean(bia)}
              >
                <SelectTrigger id="bia-service">
                  <SelectValue placeholder="Select a registered service" />
                </SelectTrigger>
                <SelectContent>
                  {services.map((service) => (
                    <SelectItem key={service._id} value={service._id}>
                      {service.reference} — {service.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Assessment owner" htmlFor="bia-owner">
              <Select
                value={form.ownerUserId}
                onValueChange={(value) => set("ownerUserId", value)}
              >
                <SelectTrigger id="bia-owner">
                  <SelectValue placeholder="Select an active member" />
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
            <Field label="Title" htmlFor="bia-title" className="sm:col-span-2">
              <Input
                id="bia-title"
                value={form.title}
                onChange={(e) => set("title", e.target.value)}
                placeholder="Citizen payments — core switch outage"
              />
            </Field>
            <Field label="Assessment date" htmlFor="bia-assessed">
              <Input
                id="bia-assessed"
                type="date"
                value={form.assessmentDate}
                onChange={(e) => set("assessmentDate", e.target.value)}
              />
            </Field>
            <Field label="Review due" htmlFor="bia-review-due">
              <Input
                id="bia-review-due"
                type="date"
                value={form.reviewDueAt}
                onChange={(e) => set("reviewDueAt", e.target.value)}
              />
            </Field>
            <Field
              label="Disruption scenario / scope"
              htmlFor="bia-scenario"
              className="sm:col-span-2"
            >
              <Textarea
                id="bia-scenario"
                rows={3}
                value={form.disruptionScenario}
                onChange={(e) => set("disruptionScenario", e.target.value)}
                placeholder="Describe the disruption being assessed, e.g. loss of the primary payment switch for an extended period."
              />
            </Field>
            <Field
              label="Assessment scope (optional)"
              htmlFor="bia-scope"
              className="sm:col-span-2"
            >
              <Textarea
                id="bia-scope"
                rows={2}
                value={form.scope}
                onChange={(e) => set("scope", e.target.value)}
              />
            </Field>
          </section>

          <section>
            <h3 className="text-sm font-semibold">Impact assessment</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Record a severity judgement and its rationale for every category.
              IITAMS stores the recorded judgement only — it does not estimate
              downtime, monetary loss or an overall score.
            </p>
            <div className="mt-3 space-y-3">
              {BCM_IMPACT_CATEGORIES.map((category) => (
                <div
                  key={category}
                  className="grid gap-2 rounded-md border border-border/60 p-3 sm:grid-cols-[180px_1fr]"
                >
                  <Field
                    label={BCM_IMPACT_CATEGORY_LABELS[category]}
                    htmlFor={`impact-${category}`}
                  >
                    <Select
                      value={form.impacts[category].severity}
                      onValueChange={(value) =>
                        setImpact(category, {
                          severity: value as BcmImpactSeverity,
                        })
                      }
                    >
                      <SelectTrigger id={`impact-${category}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {BCM_IMPACT_SEVERITIES.map((severity) => (
                          <SelectItem key={severity} value={severity}>
                            {BCM_IMPACT_SEVERITY_LABELS[severity]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                  <Field
                    label="Rationale"
                    htmlFor={`impact-notes-${category}`}
                  >
                    <Textarea
                      id={`impact-notes-${category}`}
                      rows={2}
                      value={form.impacts[category].notes}
                      onChange={(e) =>
                        setImpact(category, { notes: e.target.value })
                      }
                      placeholder="Why this severity, and what it would affect."
                    />
                  </Field>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4">
            <Field label="Key dependencies" htmlFor="bia-dependencies">
              <Textarea
                id="bia-dependencies"
                rows={2}
                value={form.keyDependencies}
                onChange={(e) => set("keyDependencies", e.target.value)}
              />
            </Field>
            <Field
              label="Single points of failure"
              htmlFor="bia-spof"
            >
              <Textarea
                id="bia-spof"
                rows={2}
                value={form.singlePointsOfFailure}
                onChange={(e) => set("singlePointsOfFailure", e.target.value)}
              />
            </Field>
            <Field
              label="Existing recovery arrangements"
              htmlFor="bia-existing"
            >
              <Textarea
                id="bia-existing"
                rows={2}
                value={form.existingRecoveryArrangements}
                onChange={(e) =>
                  set("existingRecoveryArrangements", e.target.value)
                }
                placeholder="Backups, alternate site, manual workaround — as they exist today."
              />
            </Field>
            <Field label="Assumptions" htmlFor="bia-assumptions">
              <Textarea
                id="bia-assumptions"
                rows={2}
                value={form.assumptions}
                onChange={(e) => set("assumptions", e.target.value)}
              />
            </Field>
            <Field label="Limitations" htmlFor="bia-limitations">
              <Textarea
                id="bia-limitations"
                rows={2}
                value={form.limitations}
                onChange={(e) => set("limitations", e.target.value)}
                placeholder="What this analysis does not cover or could not verify."
              />
            </Field>
            <Field
              label="Rationale for criticality"
              htmlFor="bia-criticality-rationale"
            >
              <Textarea
                id="bia-criticality-rationale"
                rows={2}
                value={form.criticalityRationale}
                onChange={(e) => set("criticalityRationale", e.target.value)}
              />
            </Field>
          </section>

          <section>
            <h3 className="text-sm font-semibold">Recovery objectives</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Stored in normalized minutes. RTO and RPO are independent: no
              ordering is assumed between them. An RTO beyond the MTPD needs a
              documented exception justification.
            </p>
            <div className="mt-3 grid gap-4 sm:grid-cols-3">
              <Field label="RTO (hours)" htmlFor="bia-rto">
                <Input
                  id="bia-rto"
                  type="number"
                  min="0.01"
                  step="0.25"
                  value={form.rtoHours}
                  onChange={(e) => set("rtoHours", e.target.value)}
                />
              </Field>
              <Field label="RPO (hours, optional)" htmlFor="bia-rpo">
                <Input
                  id="bia-rpo"
                  type="number"
                  min="0.01"
                  step="0.25"
                  value={form.rpoHours}
                  onChange={(e) => set("rpoHours", e.target.value)}
                />
              </Field>
              <Field label="MTPD (hours, optional)" htmlFor="bia-mtpd">
                <Input
                  id="bia-mtpd"
                  type="number"
                  min="0.01"
                  step="0.25"
                  value={form.mtpdHours}
                  onChange={(e) => set("mtpdHours", e.target.value)}
                />
              </Field>
              <Field
                label="Minimum acceptable service level"
                htmlFor="bia-minimum"
                className="sm:col-span-3"
              >
                <Textarea
                  id="bia-minimum"
                  rows={2}
                  value={form.minimumServiceLevel}
                  onChange={(e) => set("minimumServiceLevel", e.target.value)}
                  placeholder="What must keep working during a disruption, at what level."
                />
              </Field>
              <Field label="Recovery priority" htmlFor="bia-priority">
                <Select
                  value={form.recoveryPriority}
                  onValueChange={(value) =>
                    set("recoveryPriority", value as BcmPriority)
                  }
                >
                  <SelectTrigger id="bia-priority">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BCM_PRIORITIES.map((priority) => (
                      <SelectItem key={priority} value={priority}>
                        {BCM_PRIORITY_LABELS[priority]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field
                label="Rationale and supporting assumptions"
                htmlFor="bia-objective-rationale"
                className="sm:col-span-2"
              >
                <Textarea
                  id="bia-objective-rationale"
                  rows={2}
                  value={form.objectiveRationale}
                  onChange={(e) => set("objectiveRationale", e.target.value)}
                />
              </Field>
              <Field
                label="MTPD exception justification (only if RTO > MTPD)"
                htmlFor="bia-exception"
                className="sm:col-span-3"
              >
                <Textarea
                  id="bia-exception"
                  rows={2}
                  value={form.mtpdExceptionJustification}
                  onChange={(e) =>
                    set("mtpdExceptionJustification", e.target.value)
                  }
                />
              </Field>
            </div>
          </section>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy} data-testid="bia-save">
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {bia ? "Save draft" : "Create draft BIA"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewDialog({
  biaId,
  reference,
  version,
  onClose,
}: {
  biaId: Id<"businessImpactAnalyses">;
  reference: string;
  version: number;
  onClose: () => void;
}) {
  const reviewBia = useMutation(api.businessImpactAnalyses.reviewBia);
  const [decision, setDecision] = useState<"approved" | "rejected">("approved");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await reviewBia({ biaId, decision, reviewNotes: notes });
      toast.success(
        decision === "approved"
          ? `BIA ${reference} v${version} approved.`
          : `BIA ${reference} v${version} returned for revision.`,
      );
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Independent review</DialogTitle>
          <DialogDescription>
            Your decision and notes are recorded against {reference} v{version}.
            The preparer cannot review their own analysis.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Decision" htmlFor="review-decision">
            <Select
              value={decision}
              onValueChange={(value) =>
                setDecision(value as "approved" | "rejected")
              }
            >
              <SelectTrigger id="review-decision">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="approved">Approve</SelectItem>
                <SelectItem value="rejected">Return for revision</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Review notes"
            htmlFor="review-notes"
            hint="Required: explain the basis for the decision."
          >
            <Textarea
              id="review-notes"
              rows={4}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            Record decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BiaDetailDialog({
  biaId,
  services,
  members,
  onClose,
  onSelect,
}: {
  biaId: Id<"businessImpactAnalyses">;
  services: Array<{ _id: Id<"businessServices">; reference: string; name: string }>;
  members: Array<{ userId: Id<"users">; label: string }>;
  onClose: () => void;
  onSelect: (id: Id<"businessImpactAnalyses">) => void;
}) {
  const detail = useQuery(api.businessImpactAnalyses.getBia, { biaId });
  const submitBia = useMutation(api.businessImpactAnalyses.submitBia);
  const reviseBia = useMutation(api.businessImpactAnalyses.reviseBia);
  const [editing, setEditing] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);

  const bia = detail?.bia;
  const canReview =
    Boolean(detail?.canManage) &&
    bia !== undefined &&
    bia.status === "in_review" &&
    bia.preparedByUserId !== detail?.currentUserId;

  async function submitForReview() {
    if (!bia) return;
    setBusy(true);
    try {
      await submitBia({ biaId: bia._id });
      toast.success(`BIA ${bia.reference} v${bia.version} submitted for review.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function openRevision() {
    if (!bia) return;
    setBusy(true);
    try {
      const result = await reviseBia({ biaId: bia._id });
      toast.success(`Revision ${result.reference} v${result.version} opened.`);
      onSelect(result.biaId);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {bia ? `${bia.reference} v${bia.version} — ${bia.title}` : "Business impact analysis"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.service.reference} — ${detail.service.name}`
              : "Loading the analysis…"}
          </DialogDescription>
        </DialogHeader>

        {!detail || !bia ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <BiaStatusPill status={bia.status} label={bia.statusLabel} />
              {detail.service.criticality ? (
                <CriticalityPill
                  criticality={detail.service.criticality}
                  label={detail.service.criticality}
                />
              ) : null}
              <span className="text-xs text-muted-foreground">
                Owner {bia.ownerLabel} · assessed {formatDate(bia.assessmentDate)}{" "}
                · review due {formatDate(bia.reviewDueAt)}
                {bia.overdue ? " · overdue" : ""}
              </span>
            </div>

            <p className="whitespace-pre-line text-sm leading-6">
              {bia.disruptionScenario}
            </p>

            <section>
              <h3 className="text-sm font-semibold">Impact assessment</h3>
              <div className="mt-2 divide-y divide-border/60 rounded-md border border-border/60">
                {BCM_IMPACT_CATEGORIES.map((category) => (
                  <div key={category} className="flex gap-3 px-3 py-2 text-sm">
                    <div className="w-36 shrink-0">
                      <span className="block text-xs uppercase tracking-wide text-muted-foreground">
                        {BCM_IMPACT_CATEGORY_LABELS[category]}
                      </span>
                      <ImpactSeverityPill
                        severity={bia.impacts[category].severity}
                        label={BCM_IMPACT_SEVERITY_LABELS[bia.impacts[category].severity]}
                      />
                    </div>
                    <p className="min-w-0 flex-1 whitespace-pre-line text-foreground/90">
                      {bia.impacts[category].notes}
                    </p>
                  </div>
                ))}
              </div>
            </section>

            <section className="grid gap-3 sm:grid-cols-3">
              <Metric label="RTO" value={bia.rtoLabel} hint="Recovery time objective" />
              <Metric
                label="RPO"
                value={bia.rpoMinutes === null ? "Not recorded" : bia.rpoLabel}
                hint="Recovery point objective"
              />
              <Metric
                label="MTPD"
                value={bia.mtpdMinutes === null ? "Not recorded" : bia.mtpdLabel}
                hint="Maximum tolerable disruption"
              />
            </section>
            <p className="text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Priority:
              </span>{" "}
              {bia.recoveryPriorityLabel}
            </p>
            <p className="whitespace-pre-line text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Minimum service level:
              </span>{" "}
              {bia.minimumServiceLevel}
            </p>
            <p className="whitespace-pre-line text-sm">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Objective rationale:
              </span>{" "}
              {bia.objectiveRationale}
            </p>
            {bia.mtpdExceptionJustification ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                MTPD exception: {bia.mtpdExceptionJustification}
              </p>
            ) : null}

            <section className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Key dependencies
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {bia.keyDependencies ?? "Not recorded"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Single points of failure
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {bia.singlePointsOfFailure ?? "Not recorded"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Existing recovery arrangements
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {bia.existingRecoveryArrangements ?? "Not recorded"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Criticality rationale
                </p>
                <p className="mt-1 whitespace-pre-line">
                  {bia.criticalityRationale}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Assumptions
                </p>
                <p className="mt-1 whitespace-pre-line">{bia.assumptions}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Limitations
                </p>
                <p className="mt-1 whitespace-pre-line">{bia.limitations}</p>
              </div>
            </section>

            {bia.status === "approved" ? (
              <p className="rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
                This analysis is approved and cannot be edited. Material changes
                are recorded as a new version, which needs its own independent
                review.
              </p>
            ) : null}
            {bia.status === "in_review" ? (
              <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                Submitted by {bia.submittedByLabel ?? "the preparer"}.
                {canReview
                  ? " You are an independent reviewer for this analysis."
                  : " An independent reviewer holding bcm.manage must record the decision."}
              </p>
            ) : null}
            {bia.reviewedByLabel ? (
              <p className="text-sm text-muted-foreground">
                Last review: {bia.reviewDecisionLabel ?? bia.reviewDecision} by{" "}
                {bia.reviewedByLabel} on {formatDate(bia.reviewedAt)}
                {bia.reviewNotes ? ` — ${bia.reviewNotes}` : ""}
              </p>
            ) : null}

            <section className="grid gap-4 sm:grid-cols-2">
              <div>
                <h3 className="text-sm font-semibold">Versions</h3>
                <ul className="mt-2 space-y-1 text-sm">
                  {detail.versions.map((row) => (
                    <li key={row._id}>
                      <button
                        type="button"
                        className="rounded-sm text-left hover:text-primary"
                        onClick={() => onSelect(row._id)}
                      >
                        v{row.version} · {row.reference} · {row.status}
                        {row.approvedAt
                          ? ` · approved ${formatDate(row.approvedAt)}`
                          : ""}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="text-sm font-semibold">History</h3>
                <ul className="mt-2 space-y-2 text-sm">
                  {detail.history.map((event) => (
                    <li
                      key={event._id}
                      className="rounded-md border border-border/60 px-3 py-2"
                    >
                      <p>{event.summary}</p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {event.actorLabel} · {formatDate(event.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2">
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          {detail?.canManage && bia?.status === "draft" ? (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Edit draft
            </Button>
          ) : null}
          {detail?.canManage && bia?.status === "draft" ? (
            <Button onClick={submitForReview} disabled={busy} data-testid="bia-submit">
              Submit for review
            </Button>
          ) : null}
          {canReview ? (
            <Button onClick={() => setReviewing(true)} data-testid="bia-review">
              Record review
            </Button>
          ) : null}
          {detail?.canManage &&
          (bia?.status === "approved" || bia?.status === "superseded") ? (
            <Button onClick={openRevision} disabled={busy}>
              Open revision
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
      {editing && bia ? (
        <BiaFormDialog
          bia={bia}
          services={services}
          members={members}
          onClose={() => setEditing(false)}
        />
      ) : null}
      {reviewing && bia ? (
        <ReviewDialog
          biaId={bia._id}
          reference={bia.reference}
          version={bia.version}
          onClose={() => setReviewing(false)}
        />
      ) : null}
    </Dialog>
  );
}

function BiaRegister() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [cursors, setCursors] = useState<Array<number | undefined>>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<Id<"businessImpactAnalyses"> | null>(
    null,
  );
  const [creating, setCreating] = useState(false);

  const data = useQuery(api.businessImpactAnalyses.listBias, {
    search: search || undefined,
    status: status === "all" ? undefined : (status as BcmBiaStatus),
    limit: PAGE_SIZE,
    cursor: cursors[pageIndex],
  });
  const options = useQuery(api.businessServices.formOptions, {});
  const serviceList = useQuery(api.businessServices.listServices, {
    limit: 100,
  });
  const summary = useQuery(api.businessImpactAnalyses.continuitySummary, {});

  const resetPaging = (fn: () => void) => {
    setPageIndex(0);
    setCursors([undefined]);
    fn();
  };

  const rows: BiaRow[] = data?.rows ?? [];
  const canManage = data?.canManage ?? false;
  const services =
    serviceList?.rows.map((row) => ({
      _id: row._id,
      reference: row.reference,
      name: row.name,
    })) ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Business Continuity"
        title="Business impact analysis"
        description="Documented assessment of what a disruption would do to each business service, and the recovery objectives that follow from it."
        actions={
          canManage ? (
            <Button
              onClick={() => setCreating(true)}
              disabled={services.length === 0}
              data-testid="bia-new"
            >
              <Plus className="mr-2 size-4" aria-hidden />
              New BIA
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Analyses recorded"
          value={summary?.review.approvedTotal ?? "—"}
          hint="Approved analyses"
        />
        <Metric
          label="Awaiting review"
          value={summary?.review.awaitingReview ?? "—"}
          hint="Submitted, no decision recorded"
        />
        <Metric
          label="Overdue reassessment"
          value={summary?.review.overdueReassessment ?? "—"}
          hint="Approved past their review date"
        />
        <Metric
          label="Services with a BIA"
          value={summary?.coverage.withApprovedBia ?? "—"}
          hint="Approved analysis in place"
        />
      </div>

      <SearchFilterBar
        search={search}
        onSearch={(value) => resetPaging(() => setSearch(value))}
        searchPlaceholder="Search reference, title, service or reviewer…"
        filters={[
          {
            label: "Status",
            value: status,
            options: [
              { value: "all", label: "All statuses" },
              ...BCM_BIA_STATUSES.map((value) => ({
                value,
                label: BCM_BIA_STATUS_LABELS[value],
              })),
            ],
            onChange: (value) => resetPaging(() => setStatus(value)),
          },
        ]}
      />

      {!data ? (
        <ListSkeleton rows={6} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={BarChart3}
          title={
            services.length === 0 && canManage
              ? "Register a business service first"
              : "No business impact analyses recorded yet"
          }
          description={
            services.length === 0 && canManage
              ? "A BIA analyses one registered service. Add the service to the continuity register, then record its analysis."
              : "No analysis matches the current filters."
          }
        />
      ) : (
        <Card className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Service</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>RTO</TableHead>
                <TableHead>RPO</TableHead>
                <TableHead>Review due</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow
                  key={row._id}
                  className="cursor-pointer"
                  onClick={() => setSelected(row._id)}
                  data-testid={`bia-row-${row.reference}`}
                >
                  <TableCell>
                    <p className="font-mono text-xs">{row.reference}</p>
                    <p className="text-xs text-muted-foreground">v{row.version}</p>
                  </TableCell>
                  <TableCell>
                    <p className="font-medium">{row.serviceName}</p>
                    <p className="text-xs text-muted-foreground">
                      {row.serviceReference ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <BiaStatusPill status={row.status} label={row.statusLabel} />
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {formatMinutes(row.rtoMinutes)}
                  </TableCell>
                  <TableCell className="text-sm tabular-nums">
                    {row.rpoMinutes === null
                      ? "—"
                      : formatMinutes(row.rpoMinutes)}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className={row.overdue ? "text-critical" : undefined}>
                      {formatDate(row.reviewDueAt)}
                      {row.overdue ? " · overdue" : ""}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      {data && (pageIndex > 0 || data.hasMore) ? (
        <div className="mt-4 flex items-center justify-between text-sm">
          <span className="text-xs text-muted-foreground">
            Page {pageIndex + 1}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pageIndex === 0}
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft className="mr-1 size-4" aria-hidden />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.hasMore}
              onClick={() => {
                if (!data.nextCursor) return;
                setCursors((prev) => {
                  const next = prev.slice(0, pageIndex + 1);
                  next.push(data.nextCursor ?? undefined);
                  return next;
                });
                setPageIndex((index) => index + 1);
              }}
            >
              Next
              <ChevronRight className="ml-1 size-4" aria-hidden />
            </Button>
          </div>
        </div>
      ) : null}

      <BcmDisclaimer className="mt-6" />

      {creating ? (
        <BiaFormDialog
          bia={null}
          services={services}
          members={options?.members ?? []}
          defaultServiceId={services.length === 1 ? services[0]._id : undefined}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {selected ? (
        <BiaDetailDialog
          biaId={selected}
          services={services}
          members={options?.members ?? []}
          onClose={() => setSelected(null)}
          onSelect={(id) => setSelected(id)}
        />
      ) : null}
    </>
  );
}

export function BcmBiaPage({ path }: { path: string }) {
  const session = useQuery(api.session.getSession, {});
  if (session && !session.permissions?.bcm)
    return <BcmUnauthorized path={path} />;

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <BcmBoundary title="Business impact analysis">
        <BiaRegister />
      </BcmBoundary>
    </AppLayout>
  );
}

