import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  EmptyState,
  ListSkeleton,
} from "@/components/iitams/audit/ListPageShell";
import {
  ComplianceBoundary,
  ComplianceUnauthorized,
} from "./CompliancePrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  ASSESSMENT_FINDINGS_MAX,
  ASSESSMENT_NOTES_MIN,
  ASSESSMENT_PERIOD_MAX,
  ASSESSMENT_RATIONALE_MAX,
  ASSESSMENT_RATIONALE_MIN,
  ASSESSMENT_REMEDIATION_MAX,
  ASSESSMENT_REVIEW_NOTES_MAX,
  ASSESSMENT_SCOPE_MAX,
  ASSESSMENT_TITLE_MAX,
  COMPLIANCE_ASSESSMENT_OUTCOMES,
  COMPLIANCE_ASSESSMENT_OUTCOME_LABELS,
  COMPLIANCE_ASSESSMENT_STATUSES,
  COMPLIANCE_ASSESSMENT_STATUS_LABELS,
  isFinalAssessment,
  type ComplianceAssessmentOutcome,
  type ComplianceAssessmentStatus,
} from "@/lib/compliance";
import {
  BadgeCheck,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  Loader2,
  PlayCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Phase 3C Batch 3 — compliance assessments.
 * =========================================
 * A cycle is scoped to one adopted framework and creates one item per control,
 * each carrying a snapshot of that control. The assessor records the outcome
 * and rationale; referenced control tests inform, but never decide, the result.
 * Counts are counts of real records — no compliance percentage is shown.
 */

type OutcomeSummary = {
  total: number;
  assessed: number;
  compliant: number;
  partiallyCompliant: number;
  nonCompliant: number;
  notAssessed: number;
  notApplicable: number;
  evidenceGaps: number;
  outstandingRemediation: number;
};

type AssessmentRow = {
  _id: Id<"complianceAssessments">;
  reference: string;
  title: string;
  frameworkId: Id<"complianceFrameworks">;
  scope: string | null;
  periodLabel: string | null;
  startDate: number | null;
  dueDate: number | null;
  assessorLabel: string;
  status: ComplianceAssessmentStatus;
  statusLabel: string;
  reviewRequired: boolean;
  completionNotes: string | null;
  completedAt: number | null;
  completedByLabel: string | null;
  reviewNotes: string | null;
  reviewedAt: number | null;
  reviewedByLabel: string | null;
  supersedesAssessmentId: string | null;
  supersededByAssessmentId: string | null;
  superseded: boolean;
  amendmentReason: string | null;
  open: boolean;
  createdByLabel: string;
  createdAt: number;
  summary: OutcomeSummary;
};

type AssessmentDetail = AssessmentRow & {
  framework: { _id: string; code: string; name: string };
  items: Array<{
    _id: Id<"complianceAssessmentItems">;
    controlId: Id<"controls">;
    snapshot: {
      code: string;
      title: string;
      domainLabel?: string;
      implementationStatusLabel?: string;
      effectiveness?: string;
      ownerName?: string;
    };
    outcome: ComplianceAssessmentOutcome;
    outcomeLabel: string;
    rationale: string | null;
    assessorLabel: string | null;
    assessedAt: number | null;
    controlTestIds: string[];
    findings: string | null;
    remediation: string | null;
    evidence: Array<{ mappingId: string; evidenceId: string; active: boolean }>;
    activeEvidenceCount: number;
  }>;
  summary: OutcomeSummary;
  supersededAssessment: AssessmentRow | null;
  canManage: boolean;
  canReview: boolean;
  reviewBlockedReason: string | null;
};

const OUTCOME_TONE: Record<string, string> = {
  compliant: "bg-success/10 text-success border-success/25",
  partially_compliant: "bg-warning/15 text-foreground/90 border-warning/40",
  non_compliant: "bg-critical/10 text-critical border-critical/25",
  not_assessed: "bg-muted text-muted-foreground border-border",
  not_applicable: "bg-info/10 text-info border-info/25",
};

const STATUS_TONE: Record<string, string> = {
  draft: "bg-info/10 text-info border-info/25",
  in_progress: "bg-warning/15 text-foreground/90 border-warning/40",
  completed: "bg-success/10 text-success border-success/25",
  reviewed: "bg-success/10 text-success border-success/25",
};

function Chip({ label, tone }: { label: string; tone?: string }) {
  return (
    <Badge
      variant="outline"
      className={cn(
        "gap-1 font-medium",
        tone ?? "bg-muted text-muted-foreground border-border",
      )}
    >
      <span
        aria-hidden
        className="inline-block size-1.5 rounded-full bg-current opacity-70"
      />
      {label}
    </Badge>
  );
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

// ---------------------------------------------------------------------------
// Create / supersede form
// ---------------------------------------------------------------------------

function AssessmentFormDialog({
  original,
  onClose,
}: {
  original: AssessmentRow | null;
  onClose: () => void;
}) {
  const frameworks = useQuery(api.compliance.listFrameworks, { numItems: 100 }) as
    | { rows: Array<{ _id: Id<"complianceFrameworks">; code: string; name: string }> }
    | undefined;
  const owners = useQuery(api.compliance.controlOwners, {}) as
    | Array<{ userId: string; label: string }>
    | undefined;
  const create = useMutation(api.complianceAssessments.createAssessment);
  const supersede = useMutation(api.complianceAssessments.supersedeAssessment);
  const [form, setForm] = useState({
    frameworkId: original ? String(original.frameworkId) : "",
    title: original ? `${original.title} (reassessment)` : "",
    scope: original?.scope ?? "",
    periodLabel: original?.periodLabel ?? "",
    startDate: "",
    dueDate: "",
    assessorKey: "none",
    reviewRequired: original ? original.reviewRequired : true,
    amendmentReason: "",
  });
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      const assessorUserId =
        form.assessorKey !== "none" ? (form.assessorKey as Id<"users">) : undefined;
      const dates = {
        ...(timestamp(form.startDate) ? { startDate: timestamp(form.startDate)! } : {}),
        ...(timestamp(form.dueDate) ? { dueDate: timestamp(form.dueDate)! } : {}),
      };
      if (original) {
        const result = await supersede({
          assessmentId: original._id,
          title: form.title,
          amendmentReason: form.amendmentReason,
          ...(form.periodLabel ? { periodLabel: form.periodLabel } : {}),
          ...dates,
          ...(assessorUserId ? { assessorUserId } : {}),
        });
        toast.success(
          `Reassessment ${result.reference} created — ${original.reference} is preserved.`,
        );
      } else {
        const result = await create({
          frameworkId: form.frameworkId as Id<"complianceFrameworks">,
          title: form.title,
          ...(form.scope ? { scope: form.scope } : {}),
          ...(form.periodLabel ? { periodLabel: form.periodLabel } : {}),
          ...dates,
          ...(assessorUserId ? { assessorUserId } : {}),
          reviewRequired: form.reviewRequired,
        });
        toast.success(
          `Assessment ${result.reference} created with ${result.controls} control(s) in scope.`,
        );
      }
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit =
    form.title.trim().length > 0 &&
    (original !== null || form.frameworkId !== "") &&
    (original === null || form.amendmentReason.trim().length > 0);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {original
              ? `Record a superseding assessment for ${original.reference}`
              : "New compliance assessment"}
          </DialogTitle>
          <DialogDescription>
            {original
              ? "The earlier assessment and its control snapshots stay readable; this creates a new cycle."
              : "A cycle assesses every control in one adopted framework. Each control keeps a snapshot of its detail at creation time."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          {!original && (
            <div className="sm:col-span-2">
              <Label htmlFor="assessment-framework">Framework</Label>
              <Select
                value={form.frameworkId || undefined}
                onValueChange={(value) => set("frameworkId", value)}
              >
                <SelectTrigger id="assessment-framework" aria-label="Framework">
                  <SelectValue placeholder="Select an adopted framework" />
                </SelectTrigger>
                <SelectContent>
                  {(frameworks?.rows ?? []).map((framework) => (
                    <SelectItem key={framework._id} value={framework._id}>
                      {framework.code} — {framework.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="sm:col-span-2">
            <Label htmlFor="assessment-title">Assessment title</Label>
            <Input
              id="assessment-title"
              value={form.title}
              maxLength={ASSESSMENT_TITLE_MAX}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Q1 2026 ISO 27001 assessment"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="assessment-scope">Scope</Label>
            <Textarea
              id="assessment-scope"
              rows={2}
              maxLength={ASSESSMENT_SCOPE_MAX}
              value={form.scope}
              onChange={(e) => set("scope", e.target.value)}
              placeholder="Which systems, locations or processes this assessment covers"
            />
          </div>
          <div>
            <Label htmlFor="assessment-period">Assessment period</Label>
            <Input
              id="assessment-period"
              maxLength={ASSESSMENT_PERIOD_MAX}
              value={form.periodLabel}
              onChange={(e) => set("periodLabel", e.target.value)}
              placeholder="2026-Q1"
            />
          </div>
          <div>
            <Label htmlFor="assessment-assessor">Assessor</Label>
            <Select
              value={form.assessorKey}
              onValueChange={(value) => set("assessorKey", value)}
            >
              <SelectTrigger id="assessment-assessor" aria-label="Assessor">
                <SelectValue placeholder="Unassigned" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Unassigned</SelectItem>
                {(owners ?? []).map((owner) => (
                  <SelectItem key={owner.userId} value={owner.userId}>
                    {owner.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="assessment-start">Start date</Label>
            <Input
              id="assessment-start"
              type="date"
              value={form.startDate}
              onChange={(e) => set("startDate", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="assessment-due">Due date</Label>
            <Input
              id="assessment-due"
              type="date"
              value={form.dueDate}
              onChange={(e) => set("dueDate", e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2 sm:col-span-2">
            <input
              id="assessment-review-required"
              type="checkbox"
              className="size-4 rounded border-border"
              checked={form.reviewRequired}
              onChange={(e) => set("reviewRequired", e.target.checked)}
            />
            <Label htmlFor="assessment-review-required" className="font-normal">
              Require independent review before the cycle is finalised
            </Label>
          </div>
          {original && (
            <div className="sm:col-span-2">
              <Label htmlFor="assessment-amendment-reason">Amendment reason</Label>
              <Textarea
                id="assessment-amendment-reason"
                rows={2}
                value={form.amendmentReason}
                onChange={(e) => set("amendmentReason", e.target.value)}
                placeholder="Why this assessment replaces the earlier one"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !canSubmit}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {original ? "Record reassessment" : "Create assessment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Control-level assessment form
// ---------------------------------------------------------------------------

type ItemRow = AssessmentDetail["items"][number];

function AssessItemDialog({
  assessment,
  item,
  onClose,
}: {
  assessment: AssessmentDetail;
  item: ItemRow;
  onClose: () => void;
}) {
  const references = useQuery(api.complianceAssessments.assessmentReferences, {
    assessmentId: assessment._id,
    controlId: item.controlId,
  }) as
    | {
        evidence: Array<{
          _id: string;
          filename: string;
          classification: string;
          integrity: string;
          selectable: boolean;
        }>;
        tests: Array<{
          _id: string;
          reference: string;
          title: string;
          status: string;
          outcomeLabel: string;
        }>;
      }
    | undefined;
  const assess = useMutation(api.complianceAssessments.assessControl);
  const [form, setForm] = useState({
    outcome: (item.outcome === "not_assessed" ? "" : item.outcome) as
      | ComplianceAssessmentOutcome
      | "",
    rationale: item.rationale ?? "",
    findings: item.findings ?? "",
    remediation: item.remediation ?? "",
  });
  const [testIds, setTestIds] = useState<string[]>(item.controlTestIds);
  const [evidenceIds, setEvidenceIds] = useState<string[]>(
    item.evidence.filter((e) => e.active).map((e) => e.evidenceId),
  );
  const [busy, setBusy] = useState(false);

  const needsRationale =
    form.outcome !== "" && form.outcome !== "not_assessed";
  const ready =
    form.outcome !== "" &&
    (!needsRationale ||
      form.rationale.trim().length >= ASSESSMENT_RATIONALE_MIN) &&
    (form.outcome !== "non_compliant" ||
      form.findings.trim().length > 0 ||
      form.remediation.trim().length > 0);

  async function submit() {
    setBusy(true);
    try {
      await assess({
        assessmentId: assessment._id,
        itemId: item._id,
        outcome: form.outcome as ComplianceAssessmentOutcome,
        ...(form.rationale ? { rationale: form.rationale } : {}),
        ...(form.findings ? { findings: form.findings } : {}),
        ...(form.remediation ? { remediation: form.remediation } : {}),
        controlTestIds: testIds as Id<"complianceControlTests">[],
        evidenceIds: evidenceIds as Id<"complianceEvidence">[],
      });
      toast.success(
        `${item.snapshot.code} assessed as ${
          COMPLIANCE_ASSESSMENT_OUTCOME_LABELS[
            form.outcome as ComplianceAssessmentOutcome
          ]
        }.`,
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {item.snapshot.code} — {item.snapshot.title}
          </DialogTitle>
          <DialogDescription>
            A control-test outcome informs this conclusion; it never sets it. Record
            what you concluded and why.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="item-outcome">Outcome</Label>
            <Select
              value={form.outcome || undefined}
              onValueChange={(value) =>
                setForm((prev) => ({
                  ...prev,
                  outcome: value as ComplianceAssessmentOutcome,
                }))
              }
            >
              <SelectTrigger id="item-outcome" aria-label="Assessment outcome">
                <SelectValue placeholder="Select the assessment outcome" />
              </SelectTrigger>
              <SelectContent>
                {COMPLIANCE_ASSESSMENT_OUTCOMES.map((outcome) => (
                  <SelectItem key={outcome} value={outcome}>
                    {COMPLIANCE_ASSESSMENT_OUTCOME_LABELS[outcome]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="item-rationale">
              Rationale{" "}
              {needsRationale && (
                <span className="text-muted-foreground">
                  (at least {ASSESSMENT_RATIONALE_MIN} characters)
                </span>
              )}
            </Label>
            <Textarea
              id="item-rationale"
              rows={3}
              maxLength={ASSESSMENT_RATIONALE_MAX}
              value={form.rationale}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, rationale: e.target.value }))
              }
              placeholder="What was examined, what was found, and why that conclusion follows"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="item-findings">Findings or gaps</Label>
              <Textarea
                id="item-findings"
                rows={3}
                maxLength={ASSESSMENT_FINDINGS_MAX}
                value={form.findings}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, findings: e.target.value }))
                }
              />
            </div>
            <div>
              <Label htmlFor="item-remediation">Recommended remediation</Label>
              <Textarea
                id="item-remediation"
                rows={3}
                maxLength={ASSESSMENT_REMEDIATION_MAX}
                value={form.remediation}
                onChange={(e) =>
                  setForm((prev) => ({ ...prev, remediation: e.target.value }))
                }
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border bg-muted/20 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Control tests referenced
              </p>
              {(references?.tests ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No control tests recorded for this control yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {(references?.tests ?? []).map((test) => (
                    <label
                      key={test._id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 rounded border-border"
                        checked={testIds.includes(test._id)}
                        onChange={(e) =>
                          setTestIds((prev) =>
                            e.target.checked
                              ? [...prev, test._id]
                              : prev.filter((id) => id !== test._id),
                          )
                        }
                      />
                      <span>
                        <span className="font-medium">{test.reference}</span>{" "}
                        {test.title}
                        <span className="block text-xs text-muted-foreground">
                          {test.status} · {test.outcomeLabel}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border bg-muted/20 p-3">
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Evidence linked
              </p>
              {(references?.evidence ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No evidence recorded for this control yet.
                </p>
              ) : (
                <div className="space-y-2">
                  {(references?.evidence ?? []).map((record) => (
                    <label
                      key={record._id}
                      className="flex items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 size-4 rounded border-border"
                        disabled={!record.selectable}
                        checked={evidenceIds.includes(record._id)}
                        onChange={(e) =>
                          setEvidenceIds((prev) =>
                            e.target.checked
                              ? [...prev, record._id]
                              : prev.filter((id) => id !== record._id),
                          )
                        }
                      />
                      <span>
                        {record.filename}
                        <span className="block text-xs text-muted-foreground">
                          {record.classification} · {record.integrity}
                          {!record.selectable && " · restricted"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !ready}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            Record outcome
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Complete / review
// ---------------------------------------------------------------------------

function CompleteAssessmentDialog({
  assessment,
  onClose,
}: {
  assessment: AssessmentDetail;
  onClose: () => void;
}) {
  const complete = useMutation(api.complianceAssessments.completeAssessment);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await complete({ assessmentId: assessment._id, completionNotes: notes });
      toast.success(`${assessment.reference} completed.`);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Complete {assessment.reference}</DialogTitle>
          <DialogDescription>
            Completing finalises the recorded conclusions. Later corrections are
            recorded as a superseding assessment, never by editing this one.
          </DialogDescription>
        </DialogHeader>
        {assessment.summary.notAssessed > 0 && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
            {assessment.summary.notAssessed} control(s) are still not assessed.
            Record an outcome (or not applicable) for every control first.
          </p>
        )}
        <div>
          <Label htmlFor="assessment-completion-notes">
            Completion notes (at least {ASSESSMENT_NOTES_MIN} characters)
          </Label>
          <Textarea
            id="assessment-completion-notes"
            rows={4}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="What was assessed, by whom, over which period, and any limitations"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              notes.trim().length < ASSESSMENT_NOTES_MIN ||
              assessment.summary.notAssessed > 0
            }
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            Complete assessment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewAssessmentDialog({
  assessment,
  onClose,
}: {
  assessment: AssessmentDetail;
  onClose: () => void;
}) {
  const review = useMutation(api.complianceAssessments.reviewAssessment);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await review({
        assessmentId: assessment._id,
        ...(notes ? { reviewNotes: notes } : {}),
      });
      toast.success(`${assessment.reference} reviewed.`);
      onClose();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Independent review of {assessment.reference}</DialogTitle>
          <DialogDescription>
            Independent review must be recorded by someone other than the assessor
            or the person who completed the cycle.
          </DialogDescription>
        </DialogHeader>
        {assessment.reviewBlockedReason && (
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-3 text-xs">
            {assessment.reviewBlockedReason}
          </p>
        )}
        <div>
          <Label htmlFor="assessment-review-notes">Review notes</Label>
          <Textarea
            id="assessment-review-notes"
            rows={4}
            maxLength={ASSESSMENT_REVIEW_NOTES_MAX}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !assessment.canReview}>
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            Record review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function AssessmentDetailDialog({
  assessmentId,
  onClose,
}: {
  assessmentId: Id<"complianceAssessments">;
  onClose: () => void;
}) {
  const detail = useQuery(api.complianceAssessments.getAssessment, {
    assessmentId,
  }) as AssessmentDetail | null | undefined;
  const start = useMutation(api.complianceAssessments.startAssessment);
  const [assessItem, setAssessItem] = useState<ItemRow | null>(null);
  const [completing, setCompleting] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const [busy, setBusy] = useState(false);

  if (detail === undefined) return <ListSkeleton rows={4} />;

  async function handleStart() {
    if (!detail) return;
    setBusy(true);
    try {
      await start({ assessmentId: detail._id });
      toast.success(`${detail.reference} moved to in progress.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${detail.reference} — ${detail.title}` : "Assessment"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.framework.code} — ${detail.framework.name}${
                  detail.periodLabel ? ` · ${detail.periodLabel}` : ""
                }`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {detail === null ? (
          <EmptyState
            icon={ClipboardCheck}
            title="Assessment not available"
            description="This assessment does not exist in your organization."
          />
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <Chip label={detail.statusLabel} tone={STATUS_TONE[detail.status]} />
              {detail.reviewRequired && <Chip label="Independent review required" />}
              {detail.superseded && (
                <Chip
                  label="Superseded by a later assessment"
                  tone="bg-warning/15 text-foreground/90 border-warning/40"
                />
              )}
              {detail.supersedesAssessmentId && (
                <Chip label="Supersedes an earlier assessment" tone="bg-info/10 text-info border-info/25" />
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Assessor", detail.assessorLabel],
                ["Scope", detail.scope ?? "—"],
                ["Start", detail.startDate ? formatDate(detail.startDate) : "—"],
                ["Due", detail.dueDate ? formatDate(detail.dueDate) : "—"],
                [
                  "Completed",
                  detail.completedAt
                    ? `${formatDateTime(detail.completedAt)}${
                        detail.completedByLabel ? ` by ${detail.completedByLabel}` : ""
                      }`
                    : "—",
                ],
                [
                  "Reviewed",
                  detail.reviewedAt
                    ? `${formatDateTime(detail.reviewedAt)}${
                        detail.reviewedByLabel ? ` by ${detail.reviewedByLabel}` : ""
                      }`
                    : "—",
                ],
              ].map(([label, value]) => (
                <div key={label}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-sm">{value}</p>
                </div>
              ))}
            </div>

            <div
              aria-label="Assessment summary"
              className="grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-5"
            >
              {[
                ["Controls in scope", detail.summary.total],
                ["Assessed", detail.summary.assessed],
                ["Compliant", detail.summary.compliant],
                ["Partially compliant", detail.summary.partiallyCompliant],
                ["Non-compliant", detail.summary.nonCompliant],
                ["Not assessed", detail.summary.notAssessed],
                ["Not applicable", detail.summary.notApplicable],
                ["Evidence gaps", detail.summary.evidenceGaps],
                ["Remediation open", detail.summary.outstandingRemediation],
              ].map(([label, value]) => (
                <div key={label as string}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Counts of recorded control assessments. No compliance percentage is
              calculated: scope, exclusions and weighting are not defined for this
              batch.
            </p>

            {detail.completionNotes && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Completion notes
                </p>
                <p className="text-sm text-muted-foreground">
                  {detail.completionNotes}
                </p>
              </div>
            )}
            {detail.reviewNotes && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Review notes
                </p>
                <p className="text-sm text-muted-foreground">{detail.reviewNotes}</p>
              </div>
            )}
            {detail.amendmentReason && (
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Amendment reason
                </p>
                <p className="text-sm text-muted-foreground">
                  {detail.amendmentReason}
                </p>
              </div>
            )}

            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" aria-hidden />
                Controls in scope
              </h3>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Control</TableHead>
                    <TableHead>Snapshot</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Tester</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.items.map((item) => (
                    <TableRow key={item._id}>
                      <TableCell className="font-mono text-xs">
                        {item.snapshot.code}
                        <span className="block font-sans text-xs text-muted-foreground">
                          {item.snapshot.title}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {[
                          item.snapshot.domainLabel,
                          item.snapshot.implementationStatusLabel,
                          item.snapshot.ownerName,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={item.outcomeLabel}
                          tone={OUTCOME_TONE[item.outcome]}
                        />
                        {item.rationale && (
                          <span className="mt-1 block max-w-[260px] text-xs text-muted-foreground">
                            {item.rationale}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.activeEvidenceCount} linked
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {item.assessorLabel ?? "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setAssessItem(item)}
                          disabled={!detail.canManage || !detail.open}
                        >
                          {item.outcome === "not_assessed" ? "Assess" : "View"}
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex flex-wrap gap-2">
            {detail?.canManage && detail.status === "draft" && (
              <Button variant="secondary" onClick={handleStart} disabled={busy}>
                <PlayCircle className="mr-2 size-4" aria-hidden />
                Start assessment
              </Button>
            )}
            {detail?.canManage && detail.open && (
              <Button onClick={() => setCompleting(true)}>
                <CheckCircle2 className="mr-2 size-4" aria-hidden />
                Complete assessment
              </Button>
            )}
            {detail?.canManage && detail.status === "completed" && detail.reviewRequired && (
              <Button
                variant="secondary"
                onClick={() => setReviewing(true)}
                disabled={!detail.canReview}
              >
                <UserCheck className="mr-2 size-4" aria-hidden />
                Record review
              </Button>
            )}
            {detail?.canManage && isFinalAssessment(detail.status) && !detail.superseded && (
              <Button variant="outline" onClick={() => setSuperseding(true)}>
                <RefreshCw className="mr-2 size-4" aria-hidden />
                Record superseding assessment
              </Button>
            )}
          </div>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>

        {assessItem && detail && (
          <AssessItemDialog
            assessment={detail}
            item={assessItem}
            onClose={() => setAssessItem(null)}
          />
        )}
        {completing && detail && (
          <CompleteAssessmentDialog
            assessment={detail}
            onClose={() => setCompleting(false)}
          />
        )}
        {reviewing && detail && (
          <ReviewAssessmentDialog
            assessment={detail}
            onClose={() => setReviewing(false)}
          />
        )}
        {superseding && detail && (
          <AssessmentFormDialog
            original={detail}
            onClose={() => setSuperseding(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type AssessmentSummary = {
  assessments: number;
  draft: number;
  inProgress: number;
  completed: number;
  reviewed: number;
  controlsInScope: number;
  assessed: number;
  compliant: number;
  partiallyCompliant: number;
  nonCompliant: number;
  notAssessed: number;
  notApplicable: number;
  evidenceGaps: number;
  outstandingRemediation: number;
};

function AssessmentSummaryStrip() {
  const summary = useQuery(api.complianceAssessments.assessmentSummary, {}) as
    | AssessmentSummary
    | undefined;
  const cells: Array<[string, number | undefined]> = [
    ["Assessment cycles", summary?.assessments],
    ["Draft", summary?.draft],
    ["In progress", summary?.inProgress],
    ["Completed", summary?.completed],
    ["Reviewed", summary?.reviewed],
    ["Controls in scope", summary?.controlsInScope],
    ["Assessed", summary?.assessed],
    ["Compliant", summary?.compliant],
    ["Partially compliant", summary?.partiallyCompliant],
    ["Non-compliant", summary?.nonCompliant],
    ["Not assessed", summary?.notAssessed],
    ["Evidence gaps", summary?.evidenceGaps],
  ];
  return (
    <div
      aria-label="Compliance assessment summary"
      className="mb-6 grid gap-3 rounded-lg border bg-muted/20 p-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      {cells.map(([label, value]) => (
        <div key={label}>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="text-lg font-semibold tabular-nums">
            {value === undefined ? "…" : value}
          </p>
        </div>
      ))}
      <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
        Counts of recorded assessment cycles and control outcomes. No overall
        compliance percentage is calculated because its denominator, exclusions and
        weighting rules are not defined by this batch.
      </p>
    </div>
  );
}

export function ComplianceAssessmentsPage() {
  const session = useQuery(api.session.getSession, {}) as
    | {
        permissions?: { compliance?: boolean; complianceManage?: boolean };
      }
    | null
    | undefined;
  const permissions = session?.permissions;
  const canManage = permissions?.complianceManage === true;
  const canView = permissions?.compliance === true;

  const [frameworkFilter, setFrameworkFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<Id<"complianceAssessments"> | null>(null);

  const frameworks = useQuery(api.compliance.listFrameworks, { numItems: 100 }) as
    | { rows: Array<{ _id: Id<"complianceFrameworks">; code: string; name: string }> }
    | undefined;
  const page = useQuery(
    api.complianceAssessments.listAssessments,
    canView
      ? {
          ...(frameworkFilter !== "all"
            ? { frameworkId: frameworkFilter as Id<"complianceFrameworks"> }
            : {}),
          ...(statusFilter !== "all"
            ? { status: statusFilter as ComplianceAssessmentStatus }
            : {}),
          ...(search ? { search } : {}),
          numItems: 25,
        }
      : "skip",
  ) as
    | {
        rows: AssessmentRow[];
        continueCursor: string;
        isDone: boolean;
        summary: { total: number; byStatus: Record<string, number> } | null;
      }
    | undefined;

  if (session === undefined) {
    return (
      <AppLayout>
        <Breadcrumbs path="/compliance/assessments" />
        <ListSkeleton rows={6} />
      </AppLayout>
    );
  }

  if (!canView) return <ComplianceUnauthorized />;

  const rows = page?.rows ?? [];

  return (
    <AppLayout>
      <Breadcrumbs path="/compliance/assessments" />
      <PageHeader
        eyebrow="Compliance"
        title="Assessments"
        description="Assessment cycles per adopted framework, with a snapshot of every control in scope. The assessor records the conclusion and rationale — a control test informs but never decides the outcome, and no compliance percentage is calculated."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 size-4" aria-hidden />
              New assessment
            </Button>
          ) : undefined
        }
      />

      <AssessmentSummaryStrip />

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="relative flex-1 lg:max-w-sm">
          <Label htmlFor="assessment-search" className="sr-only">
            Search assessments
          </Label>
          <Input
            id="assessment-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search reference, title or scope"
          />
        </div>
        <div className="w-full lg:w-64">
          <Label htmlFor="assessment-framework-filter">Framework</Label>
          <Select value={frameworkFilter} onValueChange={setFrameworkFilter}>
            <SelectTrigger id="assessment-framework-filter" aria-label="Framework filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All frameworks</SelectItem>
              {(frameworks?.rows ?? []).map((framework) => (
                <SelectItem key={framework._id} value={framework._id}>
                  {framework.code}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full lg:w-56">
          <Label htmlFor="assessment-status-filter">Status</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="assessment-status-filter" aria-label="Status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {COMPLIANCE_ASSESSMENT_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {COMPLIANCE_ASSESSMENT_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {page === undefined ? (
        <ListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No assessments yet"
          description={
            canManage
              ? "Create an assessment cycle for an adopted framework to record control-level conclusions."
              : "No assessment cycle has been recorded for this organization yet."
          }
          action={
            canManage ? (
              <Button onClick={() => setCreating(true)}>New assessment</Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Assessment cycles</CardTitle>
            <CardDescription>
              Finalised cycles are immutable; corrections are recorded as superseding
              assessments.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Period</TableHead>
                  <TableHead>Assessor</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Progress</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs">
                      {row.reference}
                    </TableCell>
                    <TableCell>
                      <button
                        type="button"
                        className="text-left font-medium hover:underline"
                        onClick={() => setDetailId(row._id)}
                      >
                        {row.title}
                      </button>
                      {row.superseded && (
                        <span className="block text-xs text-muted-foreground">
                          Superseded by a later assessment
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.periodLabel ?? "—"}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.assessorLabel}
                    </TableCell>
                    <TableCell>
                      <Chip label={row.statusLabel} tone={STATUS_TONE[row.status]} />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.summary.assessed} of {row.summary.total} assessed
                      {row.summary.evidenceGaps > 0 &&
                        ` · ${row.summary.evidenceGaps} evidence gap(s)`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.dueDate ? formatDate(row.dueDate) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDetailId(row._id)}
                      >
                        View
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="mt-3 flex items-start gap-2 text-xs text-muted-foreground">
              <BadgeCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Control snapshots are captured when a cycle is created, so editing the
              register never rewrites an assessment that already happened.
            </p>
          </CardContent>
        </Card>
      )}

      {creating && (
        <AssessmentFormDialog original={null} onClose={() => setCreating(false)} />
      )}
      {detailId && (
        <AssessmentDetailDialog
          assessmentId={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
    </AppLayout>
  );
}

/** Route entry — wraps the page in its own crash guard. */
export default function ComplianceAssessmentsRoute() {
  return (
    <ComplianceBoundary title="Compliance assessments">
      <ComplianceAssessmentsPage />
    </ComplianceBoundary>
  );
}
