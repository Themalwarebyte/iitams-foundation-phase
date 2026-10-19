import { useMemo, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
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
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import {
  ComplianceBoundary,
  ComplianceUnauthorized,
} from "./CompliancePrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  COMPLIANCE_FINDING_SEVERITIES,
  COMPLIANCE_FINDING_SEVERITY_LABELS,
  COMPLIANCE_FINDING_STATUSES,
  COMPLIANCE_FINDING_STATUS_LABELS,
  FINDING_DESCRIPTION_MIN,
  FINDING_EXCEPTION_MIN,
  REMEDIATION_DESCRIPTION_MIN,
  type ComplianceFindingSeverity,
  type ComplianceFindingStatus,
  type ComplianceRemediationStatus,
} from "@/lib/compliance";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ClipboardList,
  FileWarning,
  Flag,
  Hourglass,
  Loader2,
  Plus,
  RotateCcw,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Phase 3C Batch 4 — compliance findings and remediation tracking.
 * ==============================================================
 * A finding records a compliance gap. Remediation is tracked as separate
 * actions: assigned work, work an implementer completed, and work an
 * independent verifier confirmed. Completion is never presented as
 * verification, and a finding cannot close while a mandatory action is
 * outstanding. Counts are counts of real records.
 */

type ActionRollup = {
  total: number;
  outstanding: number;
  mandatoryOutstanding: number;
  completedUnverified: number;
  verified: number;
  overdue: number;
};

type FindingRow = {
  _id: Id<"complianceFindings">;
  reference: string;
  title: string;
  description: string;
  gap: string | null;
  requirement: string | null;
  rootCause: string | null;
  recommendation: string | null;
  severity: ComplianceFindingSeverity;
  severityLabel: string;
  status: ComplianceFindingStatus;
  statusLabel: string;
  frameworkId: Id<"complianceFrameworks">;
  controlId: Id<"controls"> | null;
  assessmentId: Id<"complianceAssessments"> | null;
  assessmentItemId: Id<"complianceAssessmentItems"> | null;
  controlTestIds: string[];
  evidenceIds: string[];
  ownerUserId: string | null;
  ownerLabel: string;
  identifiedAt: number;
  targetDate: number | null;
  recordedByLabel: string;
  submittedAt: number | null;
  submittedByLabel: string | null;
  closureMethod: "verified" | "exception" | null;
  closureNotes: string | null;
  closedAt: number | null;
  closedByLabel: string | null;
  reopenCount: number;
  open: boolean;
  overdue: boolean;
  actions: ActionRollup;
  createdAt: number;
  updatedAt: number;
};

type ActionRow = {
  _id: Id<"complianceRemediationActions">;
  reference: string;
  description: string;
  ownerUserId: string | null;
  ownerLabel: string;
  dueDate: number | null;
  mandatory: boolean;
  status: ComplianceRemediationStatus;
  statusLabel: string;
  progressNotes: string | null;
  evidenceIds: string[];
  completionNotes: string | null;
  completedAt: number | null;
  completedByLabel: string | null;
  verificationNotes: string | null;
  verifiedAt: number | null;
  verifiedByLabel: string | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  overdue: boolean;
  canVerify: boolean;
};

type FindingDetail = FindingRow & {
  framework: { _id: string; code: string; name: string };
  control: { _id: string; code: string; name: string } | null;
  assessment: { _id: string; reference: string } | null;
  assessmentItem: {
    _id: string;
    controlId: string;
    controlCode: string;
    outcome: string;
  } | null;
  actionRows: ActionRow[];
  history: Array<{
    _id: string;
    type: string;
    actionId: string | null;
    fromStatus: string | null;
    toStatus: string | null;
    actorLabel: string;
    summary: string;
    reason: string | null;
    createdAt: number;
  }>;
  canManage: boolean;
  gates: {
    canSubmit: boolean;
    submitBlockedReason: string | null;
    canClose: boolean;
    closeBlockedReason: string | null;
    canCloseWithException: boolean;
    exceptionBlockedReason: string | null;
    canReopen: boolean;
    canAddActions: boolean;
  };
};

type Summary = {
  findings: number;
  open: number;
  awaitingVerification: number;
  closed: number;
  overdue: number;
  actions: number;
  actionsOutstanding: number;
  actionsOverdue: number;
  bySeverity: Record<string, number>;
};

const SEVERITY_TONE: Record<string, string> = {
  critical: "bg-critical/10 text-critical border-critical/25",
  high: "bg-warning/15 text-foreground/90 border-warning/40",
  medium: "bg-info/10 text-info border-info/25",
  low: "bg-muted text-muted-foreground border-border",
  informational: "bg-muted text-muted-foreground border-border",
};

const STATUS_TONE: Record<string, string> = {
  open: "bg-info/10 text-info border-info/25",
  in_remediation: "bg-warning/15 text-foreground/90 border-warning/40",
  awaiting_verification: "bg-primary/10 text-primary border-primary/25",
  closed: "bg-success/10 text-success border-success/25",
};

const ACTION_TONE: Record<string, string> = {
  assigned: "bg-info/10 text-info border-info/25",
  in_progress: "bg-warning/15 text-foreground/90 border-warning/40",
  completed: "bg-primary/10 text-primary border-primary/25",
  verified: "bg-success/10 text-success border-success/25",
  cancelled: "bg-muted text-muted-foreground border-border",
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

function sourceDate(value: number | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Create / edit form
// ---------------------------------------------------------------------------

function FindingFormDialog({
  original,
  onClose,
}: {
  original: FindingDetail | null;
  onClose: () => void;
}) {
  const frameworks = useQuery(api.compliance.listFrameworks, { numItems: 100 }) as
    | { rows: Array<{ _id: Id<"complianceFrameworks">; code: string; name: string }> }
    | undefined;
  const owners = useQuery(api.compliance.controlOwners, {}) as
    | Array<{ userId: string; label: string }>
    | undefined;

  const [form, setForm] = useState({
    frameworkId: original ? String(original.frameworkId) : "",
    controlId: original?.controlId ? String(original.controlId) : "none",
    assessmentId: original?.assessmentId ? String(original.assessmentId) : "none",
    assessmentItemId: original?.assessmentItemId
      ? String(original.assessmentItemId)
      : "none",
    severity: (original?.severity ??
      "medium") as ComplianceFindingSeverity,
    title: original?.title ?? "",
    description: original?.description ?? "",
    gap: original?.gap ?? "",
    requirement: original?.requirement ?? "",
    rootCause: original?.rootCause ?? "",
    recommendation: original?.recommendation ?? "",
    ownerKey: original?.ownerUserId ?? "self",
    identifiedAt: original ? sourceDate(original.identifiedAt) : "",
    targetDate: original?.targetDate ? sourceDate(original.targetDate) : "",
    controlTestIds: original?.controlTestIds ?? [],
    evidenceIds: original?.evidenceIds ?? [],
  });
  const [busy, setBusy] = useState(false);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const references = useQuery(
    api.complianceFindings.findingReferences,
    form.frameworkId
      ? {
          frameworkId: form.frameworkId as Id<"complianceFrameworks">,
          ...(form.controlId !== "none"
            ? { controlId: form.controlId as Id<"controls"> }
            : {}),
        }
      : "skip",
  ) as
    | {
        controls: Array<{ _id: string; code: string; name: string }>;
        assessments: Array<{
          _id: string;
          reference: string;
          title: string;
          status: string;
        }>;
        tests: Array<{ _id: string; reference: string; title: string; outcome: string }>;
        evidence: Array<{
          _id: string;
          filename: string;
          integrity: string;
          selectable: boolean;
        }>;
      }
    | undefined;

  const items = useQuery(
    api.complianceFindings.findingAssessmentItems,
    form.assessmentId !== "none"
      ? { assessmentId: form.assessmentId as Id<"complianceAssessments"> }
      : "skip",
  ) as
    | Array<{
        _id: string;
        controlId: string;
        controlCode: string;
        outcome: string;
      }>
    | undefined;

  const create = useMutation(api.complianceFindings.createFinding);
  const update = useMutation(api.complianceFindings.updateFinding);

  // Control tests offered here are already scoped to the selected control by
  // the backend query, so no client-side filtering is needed.
  const applicableTests = useMemo(() => references?.tests ?? [], [references]);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      if (original) {
        await update({
          findingId: original._id,
          title: form.title,
          description: form.description,
          gap: form.gap || undefined,
          requirement: form.requirement || undefined,
          rootCause: form.rootCause || undefined,
          recommendation: form.recommendation || undefined,
          severity: form.severity,
          ownerUserId:
            form.ownerKey === "self" ? undefined : (form.ownerKey as Id<"users">),
          ...(timestamp(form.identifiedAt)
            ? { identifiedAt: timestamp(form.identifiedAt) }
            : {}),
          ...(timestamp(form.targetDate)
            ? { targetDate: timestamp(form.targetDate) }
            : {}),
          controlTestIds: form.controlTestIds as Id<"complianceControlTests">[],
          evidenceIds: form.evidenceIds as Id<"complianceEvidence">[],
        });
        toast.success("Finding updated");
      } else {
        await create({
          title: form.title,
          description: form.description,
          gap: form.gap || undefined,
          requirement: form.requirement || undefined,
          rootCause: form.rootCause || undefined,
          recommendation: form.recommendation || undefined,
          severity: form.severity,
          frameworkId: form.frameworkId as Id<"complianceFrameworks">,
          ...(form.controlId !== "none"
            ? { controlId: form.controlId as Id<"controls"> }
            : {}),
          ...(form.assessmentId !== "none"
            ? { assessmentId: form.assessmentId as Id<"complianceAssessments"> }
            : {}),
          ...(form.assessmentItemId !== "none"
            ? {
                assessmentItemId:
                  form.assessmentItemId as Id<"complianceAssessmentItems">,
              }
            : {}),
          ...(form.ownerKey !== "self"
            ? { ownerUserId: form.ownerKey as Id<"users"> }
            : {}),
          ...(timestamp(form.identifiedAt)
            ? { identifiedAt: timestamp(form.identifiedAt) }
            : {}),
          ...(timestamp(form.targetDate)
            ? { targetDate: timestamp(form.targetDate) }
            : {}),
          ...(form.controlTestIds.length > 0
            ? { controlTestIds: form.controlTestIds as Id<"complianceControlTests">[] }
            : {}),
          ...(form.evidenceIds.length > 0
            ? { evidenceIds: form.evidenceIds as Id<"complianceEvidence">[] }
            : {}),
        });
        toast.success("Finding recorded");
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save the finding");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{original ? "Edit finding" : "Record a finding"}</DialogTitle>
          <DialogDescription>
            A finding is recorded by a person. A partially compliant control does
            not create one automatically, and recording it does not verify it.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="finding-title">Title</Label>
            <Input
              id="finding-title"
              value={form.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Access reviews not performed for the sampled period"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="finding-description">
              Description (at least {FINDING_DESCRIPTION_MIN} characters)
            </Label>
            <Textarea
              id="finding-description"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              rows={3}
            />
          </div>

          {!original && (
            <>
              <div>
                <Label htmlFor="finding-framework">Framework</Label>
                <Select
                  value={form.frameworkId}
                  onValueChange={(value) => {
                    set("frameworkId", value);
                    set("controlId", "none");
                    set("assessmentId", "none");
                    set("assessmentItemId", "none");
                    set("controlTestIds", []);
                    set("evidenceIds", []);
                  }}
                >
                  <SelectTrigger id="finding-framework" aria-label="Framework">
                    <SelectValue placeholder="Select a framework" />
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
              <div>
                <Label htmlFor="finding-control">Control (optional)</Label>
                <Select
                  value={form.controlId}
                  onValueChange={(value) => {
                    set("controlId", value);
                    set("controlTestIds", []);
                    set("evidenceIds", []);
                  }}
                  disabled={!form.frameworkId}
                >
                  <SelectTrigger id="finding-control" aria-label="Control">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked to a control</SelectItem>
                    {(references?.controls ?? []).map((control) => (
                      <SelectItem key={control._id} value={control._id}>
                        {control.code} — {control.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="finding-assessment">Assessment cycle (optional)</Label>
                <Select
                  value={form.assessmentId}
                  onValueChange={(value) => {
                    set("assessmentId", value);
                    set("assessmentItemId", "none");
                  }}
                  disabled={!form.frameworkId}
                >
                  <SelectTrigger id="finding-assessment" aria-label="Assessment cycle">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked to a cycle</SelectItem>
                    {(references?.assessments ?? []).map((assessment) => (
                      <SelectItem key={assessment._id} value={assessment._id}>
                        {assessment.reference} — {assessment.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label htmlFor="finding-item">Assessment item (optional)</Label>
                <Select
                  value={form.assessmentItemId}
                  onValueChange={(value) => {
                    set("assessmentItemId", value);
                    const item = (items ?? []).find((i) => i._id === value);
                    if (item) set("controlId", item.controlId);
                  }}
                  disabled={form.assessmentId === "none"}
                >
                  <SelectTrigger id="finding-item" aria-label="Assessment item">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Not linked to an item</SelectItem>
                    {(items ?? []).map((item) => (
                      <SelectItem key={item._id} value={item._id}>
                        {item.controlCode} — {item.outcome}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          )}

          <div>
            <Label htmlFor="finding-severity">Severity</Label>
            <Select
              value={form.severity}
              onValueChange={(value) =>
                set("severity", value as ComplianceFindingSeverity)
              }
            >
              <SelectTrigger id="finding-severity" aria-label="Severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPLIANCE_FINDING_SEVERITIES.map((severity) => (
                  <SelectItem key={severity} value={severity}>
                    {COMPLIANCE_FINDING_SEVERITY_LABELS[severity]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="finding-owner">Responsible owner</Label>
            <Select
              value={form.ownerKey}
              onValueChange={(value) => set("ownerKey", value)}
            >
              <SelectTrigger id="finding-owner" aria-label="Responsible owner">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="self">Me (recorded by)</SelectItem>
                {(owners ?? []).map((owner) => (
                  <SelectItem key={owner.userId} value={owner.userId}>
                    {owner.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="finding-identified">Date identified</Label>
            <Input
              id="finding-identified"
              type="date"
              value={form.identifiedAt}
              onChange={(e) => set("identifiedAt", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="finding-target">Target remediation date</Label>
            <Input
              id="finding-target"
              type="date"
              value={form.targetDate}
              onChange={(e) => set("targetDate", e.target.value)}
            />
          </div>

          <div className="sm:col-span-2">
            <Label htmlFor="finding-gap">Compliance gap</Label>
            <Textarea
              id="finding-gap"
              value={form.gap}
              onChange={(e) => set("gap", e.target.value)}
              rows={2}
            />
          </div>
          <div>
            <Label htmlFor="finding-requirement">Related requirement</Label>
            <Input
              id="finding-requirement"
              value={form.requirement}
              onChange={(e) => set("requirement", e.target.value)}
              placeholder="A.5.15 / clause 6.1"
            />
          </div>
          <div>
            <Label htmlFor="finding-root-cause">Root cause</Label>
            <Input
              id="finding-root-cause"
              value={form.rootCause}
              onChange={(e) => set("rootCause", e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="finding-recommendation">
              Recommended remediation (a recommendation is not an assigned action)
            </Label>
            <Textarea
              id="finding-recommendation"
              value={form.recommendation}
              onChange={(e) => set("recommendation", e.target.value)}
              rows={2}
            />
          </div>

          {form.controlId !== "none" && (
            <>
              <div className="sm:col-span-2">
                <Label>Control-test references</Label>
                <div className="mt-1 space-y-1 rounded-md border p-2">
                  {(references?.tests ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No control tests recorded for this control yet.
                    </p>
                  ) : (
                    applicableTests.map((test) => (
                      <label
                        key={test._id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          checked={form.controlTestIds.includes(test._id)}
                          onCheckedChange={(checked) =>
                            set(
                              "controlTestIds",
                              checked
                                ? [...form.controlTestIds, test._id]
                                : form.controlTestIds.filter((id) => id !== test._id),
                            )
                          }
                        />
                        <span>
                          {test.reference} — {test.title} ({test.outcome})
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
              <div className="sm:col-span-2">
                <Label>Evidence references</Label>
                <div className="mt-1 space-y-1 rounded-md border p-2">
                  {(references?.evidence ?? []).length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      No compliance evidence recorded for this control yet.
                    </p>
                  ) : (
                    (references?.evidence ?? []).map((record) => (
                      <label
                        key={record._id}
                        className="flex items-center gap-2 text-sm"
                      >
                        <Checkbox
                          disabled={!record.selectable}
                          checked={form.evidenceIds.includes(record._id)}
                          onCheckedChange={(checked) =>
                            set(
                              "evidenceIds",
                              checked
                                ? [...form.evidenceIds, record._id]
                                : form.evidenceIds.filter((id) => id !== record._id),
                            )
                          }
                        />
                        <span>
                          {record.filename} ({record.integrity})
                        </span>
                      </label>
                    ))
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              !form.title ||
              form.description.trim().length < FINDING_DESCRIPTION_MIN ||
              (!original && !form.frameworkId)
            }
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {original ? "Save changes" : "Record finding"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Remediation actions
// ---------------------------------------------------------------------------

function AssignActionForm({ findingId }: { findingId: Id<"complianceFindings"> }) {
  const owners = useQuery(api.compliance.controlOwners, {}) as
    | Array<{ userId: string; label: string }>
    | undefined;
  const assign = useMutation(api.complianceFindings.assignRemediationAction);
  const [description, setDescription] = useState("");
  const [ownerKey, setOwnerKey] = useState("self");
  const [dueDate, setDueDate] = useState("");
  const [mandatory, setMandatory] = useState(true);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (busy) return;
    setBusy(true);
    try {
      await assign({
        findingId,
        description,
        ...(ownerKey !== "self" ? { ownerUserId: ownerKey as Id<"users"> } : {}),
        ...(timestamp(dueDate) ? { dueDate: timestamp(dueDate) } : {}),
        mandatory,
      });
      toast.success("Remediation action assigned");
      setDescription("");
      setDueDate("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not assign the action");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">Assign a remediation action</p>
      <p className="mb-2 text-xs text-muted-foreground">
        An assigned action is not completed work, and completed work is not
        verification.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="action-description">
            Description (at least {REMEDIATION_DESCRIPTION_MIN} characters)
          </Label>
          <Textarea
            id="action-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
          />
        </div>
        <div>
          <Label htmlFor="action-owner">Owner</Label>
          <Select value={ownerKey} onValueChange={setOwnerKey}>
            <SelectTrigger id="action-owner" aria-label="Action owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="self">Me</SelectItem>
              {(owners ?? []).map((owner) => (
                <SelectItem key={owner.userId} value={owner.userId}>
                  {owner.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="action-due">Due date</Label>
          <Input
            id="action-due"
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Checkbox
            checked={mandatory}
            onCheckedChange={(checked) => setMandatory(checked === true)}
          />
          Mandatory — the finding cannot be closed until this action is complete
        </label>
      </div>
      <Button
        className="mt-3"
        size="sm"
        onClick={submit}
        disabled={busy || description.trim().length < REMEDIATION_DESCRIPTION_MIN}
      >
        {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
        Assign action
      </Button>
    </div>
  );
}

function ActionRowControls({
  action,
  canManage,
}: {
  action: ActionRow;
  canManage: boolean;
}) {
  const start = useMutation(api.complianceFindings.startRemediationAction);
  const complete = useMutation(api.complianceFindings.completeRemediationAction);
  const verify = useMutation(api.complianceFindings.verifyRemediationAction);
  const failVerification = useMutation(
    api.complianceFindings.failRemediationVerification,
  );
  const cancel = useMutation(api.complianceFindings.cancelRemediationAction);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<"complete" | "verify" | "fail" | "cancel" | null>(
    null,
  );
  const [text, setText] = useState("");

  if (!canManage) return null;

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      setOpen(null);
      setText("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1">
        {action.status === "assigned" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(
                () => start({ actionId: action._id }),
                "Action started",
              )
            }
          >
            Start
          </Button>
        )}
        {(action.status === "assigned" || action.status === "in_progress") && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setOpen(open === "complete" ? null : "complete")}
            >
              Record completion
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(open === "cancel" ? null : "cancel")}
            >
              Cancel action
            </Button>
          </>
        )}
        {action.status === "completed" && (
          <>
            {action.canVerify ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => setOpen(open === "verify" ? null : "verify")}
              >
                Verify independently
              </Button>
            ) : (
              <span className="text-xs text-muted-foreground">
                Verification must be recorded by someone other than the owner or
                implementer.
              </span>
            )}
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setOpen(open === "fail" ? null : "fail")}
            >
              Verification failed
            </Button>
          </>
        )}
      </div>

      {open === "complete" && (
        <div className="rounded-md border p-2">
          <Label htmlFor={`complete-${action._id}`}>Completion notes</Label>
          <Textarea
            id={`complete-${action._id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={busy || text.trim().length < REMEDIATION_DESCRIPTION_MIN}
            onClick={() =>
              run(
                () =>
                  complete({ actionId: action._id, completionNotes: text }),
                "Implementation recorded complete",
              )
            }
          >
            Save completion
          </Button>
        </div>
      )}
      {(open === "verify" || open === "fail") && (
        <div className="rounded-md border p-2">
          <Label htmlFor={`verify-${action._id}`}>
            {open === "verify" ? "Verification statement" : "Reason verification failed"}
          </Label>
          <Textarea
            id={`verify-${action._id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={busy || text.trim().length < REMEDIATION_DESCRIPTION_MIN}
            onClick={() =>
              open === "verify"
                ? run(
                    () =>
                      verify({
                        actionId: action._id,
                        verificationNotes: text,
                        evidenceIds: action.evidenceIds as Id<"complianceEvidence">[],
                      }),
                    "Action independently verified",
                  )
                : run(
                    () => failVerification({ actionId: action._id, reason: text }),
                    "Verification failure recorded",
                  )
            }
          >
            {open === "verify" ? "Verify" : "Return for further work"}
          </Button>
        </div>
      )}
      {open === "cancel" && (
        <div className="rounded-md border p-2">
          <Label htmlFor={`cancel-${action._id}`}>Cancellation reason</Label>
          <Textarea
            id={`cancel-${action._id}`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={2}
          />
          <Button
            className="mt-2"
            size="sm"
            disabled={busy || text.trim().length < REMEDIATION_DESCRIPTION_MIN}
            onClick={() =>
              run(
                () => cancel({ actionId: action._id, reason: text }),
                "Action cancelled",
              )
            }
          >
            Cancel action
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function FindingDetailDialog({
  findingId,
  onClose,
}: {
  findingId: Id<"complianceFindings">;
  onClose: () => void;
}) {
  const detail = useQuery(api.complianceFindings.getFinding, { findingId }) as
    | FindingDetail
    | null
    | undefined;
  const submitForVerification = useMutation(
    api.complianceFindings.submitFindingForVerification,
  );
  const close = useMutation(api.complianceFindings.closeFinding);
  const reopen = useMutation(api.complianceFindings.reopenFinding);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [closeMethod, setCloseMethod] = useState<"verified" | "exception">("verified");
  const [closeNotes, setCloseNotes] = useState("");
  const [reopenReason, setReopenReason] = useState("");

  if (detail === undefined) return <ListSkeleton rows={4} />;
  if (detail === null) {
    return (
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Finding unavailable</DialogTitle>
            <DialogDescription>
              This finding is not available in your organization.
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const canManage = detail.canManage;

  async function run(fn: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      setCloseNotes("");
      setReopenReason("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-4xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-muted-foreground">
              {detail.reference}
            </span>
            {detail.title}
          </DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <Chip
              label={detail.severityLabel}
              tone={SEVERITY_TONE[detail.severity]}
            />
            <Chip label={detail.statusLabel} tone={STATUS_TONE[detail.status]} />
            {detail.overdue && (
              <Chip
                label="Beyond target date"
                tone="bg-critical/10 text-critical border-critical/25"
              />
            )}
            <span>
              {detail.framework.code} · recorded by {detail.recordedByLabel} ·{" "}
              {formatDate(detail.identifiedAt)}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Gap
            </p>
            <p>{detail.gap ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Description
            </p>
            <p>{detail.description}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Control
            </p>
            <p>
              {detail.control
                ? `${detail.control.code} — ${detail.control.name}`
                : "Not linked to a control"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Assessment linkage
            </p>
            <p>
              {detail.assessment
                ? `${detail.assessment.reference}${
                    detail.assessmentItem
                      ? ` · item ${detail.assessmentItem.controlCode} (${detail.assessmentItem.outcome})`
                      : ""
                  }`
                : "Not linked to an assessment cycle"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Owner / target
            </p>
            <p>
              {detail.ownerLabel} ·{" "}
              {detail.targetDate ? formatDate(detail.targetDate) : "no target date"}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Requirement · root cause
            </p>
            <p>
              {detail.requirement ?? "—"} · {detail.rootCause ?? "—"}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Recommended remediation
            </p>
            <p>{detail.recommendation ?? "—"}</p>
          </div>
          {(detail.evidenceIds.length > 0 || detail.controlTestIds.length > 0) && (
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                References
              </p>
              <p>
                {detail.controlTestIds.length} control test(s) ·{" "}
                {detail.evidenceIds.length} evidence record(s)
              </p>
            </div>
          )}
        </div>

        {detail.closureMethod && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">
              Closed {detail.closureMethod === "verified" ? "after independent verification" : "with a documented exception"}
            </p>
            <p className="text-muted-foreground">
              {detail.closedByLabel} ·{" "}
              {detail.closedAt ? formatDateTime(detail.closedAt) : ""}
              {detail.reopenCount > 0 && ` · reopened ${detail.reopenCount} time(s)`}
            </p>
            <p className="mt-1">{detail.closureNotes}</p>
          </div>
        )}

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">
              Remediation actions ({detail.actionRows.length})
            </h3>
            <p className="text-xs text-muted-foreground">
              {detail.actions.verified} verified · {detail.actions.completedUnverified}{" "}
              awaiting verification
              {detail.actions.overdue > 0 && ` · ${detail.actions.overdue} overdue`}
            </p>
          </div>
          {detail.actionRows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No remediation action has been assigned yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Due</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Controls</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.actionRows.map((action) => (
                  <TableRow key={action._id}>
                    <TableCell className="font-mono text-xs">
                      {action.reference}
                      {action.mandatory && (
                        <span className="ml-1 text-[10px] uppercase text-muted-foreground">
                          mandatory
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="block">{action.description}</span>
                      {action.progressNotes && (
                        <span className="block text-xs text-muted-foreground">
                          {action.progressNotes}
                        </span>
                      )}
                      {action.completionNotes && (
                        <span className="block text-xs text-muted-foreground">
                          Completed: {action.completionNotes}
                          {action.completedByLabel ? ` (${action.completedByLabel})` : ""}
                        </span>
                      )}
                      {action.verificationNotes && (
                        <span className="block text-xs text-success">
                          Verified: {action.verificationNotes}
                          {action.verifiedByLabel ? ` (${action.verifiedByLabel})` : ""}
                        </span>
                      )}
                      {action.cancelReason && (
                        <span className="block text-xs text-muted-foreground">
                          Cancelled: {action.cancelReason}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {action.ownerLabel}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {action.dueDate ? formatDate(action.dueDate) : "—"}
                      {action.overdue && (
                        <span className="block text-xs text-critical">Overdue</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={action.statusLabel}
                        tone={ACTION_TONE[action.status]}
                      />
                    </TableCell>
                    <TableCell className="text-right">
                      <ActionRowControls action={action} canManage={canManage} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
          {canManage && detail.gates.canAddActions && (
            <div className="mt-3">
              <AssignActionForm findingId={detail._id} />
            </div>
          )}
        </div>

        {canManage && (
          <div className="rounded-md border p-3">
            <h3 className="text-sm font-semibold">Verification and closure</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Completion is not verification. A finding closes only when every
              mandatory action is verified, or when a documented exception
              explains the missing verification evidence — and never while a
              mandatory action is outstanding.
            </p>

            {detail.status !== "closed" && (
              <div className="mt-3 flex flex-col gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !detail.gates.canSubmit}
                    onClick={() =>
                      run(
                        () => submitForVerification({ findingId: detail._id }),
                        "Finding submitted for verification",
                      )
                    }
                  >
                    <Hourglass className="mr-2 size-4" aria-hidden />
                    Submit for verification
                  </Button>
                  {!detail.gates.canSubmit && detail.gates.submitBlockedReason && (
                    <span className="text-xs text-muted-foreground">
                      {detail.gates.submitBlockedReason}
                    </span>
                  )}
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <div className="w-48">
                    <Label htmlFor="close-method">Closure route</Label>
                    <Select
                      value={closeMethod}
                      onValueChange={(value) =>
                        setCloseMethod(value as "verified" | "exception")
                      }
                    >
                      <SelectTrigger id="close-method" aria-label="Closure route">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="verified">
                          Independently verified
                        </SelectItem>
                        <SelectItem value="exception">
                          Documented exception
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="min-w-56 flex-1">
                    <Label htmlFor="close-notes">
                      Closure notes (at least {FINDING_EXCEPTION_MIN} characters)
                    </Label>
                    <Textarea
                      id="close-notes"
                      value={closeNotes}
                      onChange={(e) => setCloseNotes(e.target.value)}
                      rows={2}
                    />
                  </div>
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      closeNotes.trim().length < FINDING_EXCEPTION_MIN ||
                      (closeMethod === "verified"
                        ? !detail.gates.canClose
                        : !detail.gates.canCloseWithException)
                    }
                    onClick={() =>
                      run(
                        () =>
                          close({
                            findingId: detail._id,
                            method: closeMethod,
                            notes: closeNotes,
                          }),
                        "Finding closed",
                      )
                    }
                  >
                    <CheckCircle2 className="mr-2 size-4" aria-hidden />
                    Close finding
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {closeMethod === "verified"
                    ? (detail.gates.closeBlockedReason ??
                      "Ready to close once you record the verification statement.")
                    : (detail.gates.exceptionBlockedReason ??
                      "Available when work is complete but verification evidence is missing.")}
                </p>
              </div>
            )}

            {detail.status === "closed" && detail.gates.canReopen && (
              <div className="mt-3 flex flex-wrap items-end gap-2">
                <div className="min-w-56 flex-1">
                  <Label htmlFor="reopen-reason">
                    Reopen reason (at least {FINDING_EXCEPTION_MIN} characters)
                  </Label>
                  <Textarea
                    id="reopen-reason"
                    value={reopenReason}
                    onChange={(e) => setReopenReason(e.target.value)}
                    rows={2}
                  />
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || reopenReason.trim().length < FINDING_EXCEPTION_MIN}
                  onClick={() =>
                    run(
                      () =>
                        reopen({ findingId: detail._id, reason: reopenReason }),
                      "Finding reopened",
                    )
                  }
                >
                  <RotateCcw className="mr-2 size-4" aria-hidden />
                  Reopen finding
                </Button>
              </div>
            )}
          </div>
        )}

        <div>
          <h3 className="mb-2 text-sm font-semibold">
            History ({detail.history.length})
          </h3>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {detail.history.map((event) => (
              <li key={event._id} className="flex gap-2">
                <span className="w-32 shrink-0 font-mono">
                  {formatDateTime(event.createdAt)}
                </span>
                <span>
                  <span className="font-medium text-foreground">
                    {event.actorLabel}
                  </span>{" "}
                  — {event.summary}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter>
          {canManage && detail.status !== "closed" && (
            <Button variant="outline" onClick={() => setEditing(true)}>
              Edit finding
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>

        {editing && (
          <FindingFormDialog original={detail} onClose={() => setEditing(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function ComplianceFindingsPage() {
  const session = useQuery(api.session.getSession, {}) as
    | { permissions?: { compliance?: boolean; complianceManage?: boolean } }
    | null
    | undefined;
  const canView = session?.permissions?.compliance === true;
  const canManage = session?.permissions?.complianceManage === true;

  const [severityFilter, setSeverityFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<Id<"complianceFindings"> | null>(null);

  const summary = useQuery(
    api.complianceFindings.findingsSummary,
    canView ? {} : "skip",
  ) as Summary | undefined;

  const page = useQuery(
    api.complianceFindings.listFindings,
    canView
      ? {
          ...(severityFilter !== "all"
            ? { severity: severityFilter as ComplianceFindingSeverity }
            : {}),
          ...(statusFilter !== "all"
            ? { status: statusFilter as ComplianceFindingStatus }
            : {}),
          ...(overdueOnly ? { overdueOnly: true } : {}),
          ...(search ? { search } : {}),
          ...(cursor ? { cursor } : {}),
          numItems: 25,
        }
      : "skip",
  ) as
    | {
        rows: FindingRow[];
        continueCursor: string;
        isDone: boolean;
        summary: Summary | null;
      }
    | undefined;

  if (session === undefined) {
    return (
      <AppLayout>
        <Breadcrumbs path="/compliance/findings" />
        <ListSkeleton rows={6} />
      </AppLayout>
    );
  }
  if (!canView) return <ComplianceUnauthorized />;

  const rows = page?.rows ?? [];

  return (
    <AppLayout>
      <Breadcrumbs path="/compliance/findings" />
      <PageHeader
        eyebrow="Compliance"
        title="Findings & remediation"
        description="Compliance gaps, their remediation actions and their verification. A completed action is not a verified correction: closure needs independent verification or a documented exception, and no finding closes with a mandatory action outstanding."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 size-4" aria-hidden />
              Record finding
            </Button>
          ) : undefined
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryTile
          icon={FileWarning}
          label="Open findings"
          value={summary?.open ?? "—"}
          hint={summary ? `${summary.overdue} beyond target date` : undefined}
        />
        <SummaryTile
          icon={Hourglass}
          label="Awaiting verification"
          value={summary?.awaitingVerification ?? "—"}
          hint={
            summary
              ? `${summary.actionsOutstanding} action(s) outstanding`
              : undefined
          }
        />
        <SummaryTile
          icon={AlertTriangle}
          label="Overdue actions"
          value={summary?.actionsOverdue ?? "—"}
          hint={summary ? `${summary.actions} action(s) recorded` : undefined}
        />
        <SummaryTile
          icon={BadgeCheck}
          label="Closed findings"
          value={summary?.closed ?? "—"}
          hint={summary ? `${summary.findings} finding(s) recorded` : undefined}
        />
      </div>

      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-end">
        <div className="flex-1 lg:max-w-sm">
          <Label htmlFor="finding-search" className="sr-only">
            Search findings
          </Label>
          <Input
            id="finding-search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setCursor(null);
            }}
            placeholder="Search reference, title, gap or owner"
          />
        </div>
        <div className="w-full lg:w-52">
          <Label htmlFor="finding-severity-filter">Severity</Label>
          <Select
            value={severityFilter}
            onValueChange={(value) => {
              setSeverityFilter(value);
              setCursor(null);
            }}
          >
            <SelectTrigger
              id="finding-severity-filter"
              aria-label="Severity filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All severities</SelectItem>
              {COMPLIANCE_FINDING_SEVERITIES.map((severity) => (
                <SelectItem key={severity} value={severity}>
                  {COMPLIANCE_FINDING_SEVERITY_LABELS[severity]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="w-full lg:w-52">
          <Label htmlFor="finding-status-filter">Status</Label>
          <Select
            value={statusFilter}
            onValueChange={(value) => {
              setStatusFilter(value);
              setCursor(null);
            }}
          >
            <SelectTrigger id="finding-status-filter" aria-label="Status filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {COMPLIANCE_FINDING_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {COMPLIANCE_FINDING_STATUS_LABELS[status]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={overdueOnly}
            onCheckedChange={(checked) => {
              setOverdueOnly(checked === true);
              setCursor(null);
            }}
          />
          Overdue only
        </label>
      </div>

      <p className="mb-4 flex items-start gap-2 text-xs text-muted-foreground">
        <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        No overall remediation rate is calculated: the population of gaps and the
        handling of exceptions are not defined here, so no such figure is
        published. Counts describe the records that exist.
      </p>

      {page === undefined ? (
        <ListSkeleton rows={5} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No findings recorded"
          description={
            canManage
              ? "Record a finding when an assessment or a control test identifies a compliance gap. Nothing is created automatically from an assessment outcome."
              : "No compliance finding has been recorded for this organization."
          }
          action={
            canManage ? (
              <Button onClick={() => setCreating(true)}>Record finding</Button>
            ) : undefined
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Findings register</CardTitle>
            <CardDescription>
              Severity-first ordering, with overdue indicators derived from the
              target dates on real records.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Finding</TableHead>
                  <TableHead>Severity</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>Remediation</TableHead>
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
                      {row.reopenCount > 0 && (
                        <span className="block text-xs text-muted-foreground">
                          Reopened {row.reopenCount} time(s)
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip
                        label={row.severityLabel}
                        tone={SEVERITY_TONE[row.severity]}
                      />
                    </TableCell>
                    <TableCell>
                      <Chip label={row.statusLabel} tone={STATUS_TONE[row.status]} />
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.ownerLabel}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.targetDate ? formatDate(row.targetDate) : "—"}
                      {row.overdue && (
                        <span className="block text-xs text-critical">Overdue</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.actions.total} action(s)
                      {row.actions.verified > 0 &&
                        ` · ${row.actions.verified} verified`}
                      {row.actions.completedUnverified > 0 &&
                        ` · ${row.actions.completedUnverified} awaiting verification`}
                      {row.actions.mandatoryOutstanding > 0 &&
                        ` · ${row.actions.mandatoryOutstanding} outstanding`}
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

            <div className="mt-3 flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Severity-first within each page; the cursor walks newest-first.
              </p>
              {!page.isDone && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCursor(page.continueCursor)}
                >
                  Load older findings
                </Button>
              )}
            </div>
            {cursor && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => setCursor(null)}
              >
                Back to newest
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      {creating && <FindingFormDialog original={null} onClose={() => setCreating(false)} />}
      {detailId && (
        <FindingDetailDialog findingId={detailId} onClose={() => setDetailId(null)} />
      )}
    </AppLayout>
  );
}

function SummaryTile({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof Flag;
  label: string;
  value: number | string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 pt-6">
        <span className="rounded-md bg-primary/10 p-2 text-primary">
          <Icon className="size-4" aria-hidden />
        </span>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className="text-2xl font-semibold">{value}</p>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

/** Route entry — wraps the page in its own crash guard. */
export default function ComplianceFindingsRoute() {
  return (
    <ComplianceBoundary title="Compliance findings">
      <ComplianceFindingsPage />
    </ComplianceBoundary>
  );
}
