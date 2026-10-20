import { useState } from "react";
import { useSearchParams } from "react-router";
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
  AssessmentStatusPill,
  CyberBoundary,
  CyberUnauthorized,
  Metric,
  SeverityPill,
} from "./CyberPrimitives";
import {
  TestingScopeSection,
  TestCaseRegister,
  type TestSummaryShape,
  type TestingScope,
} from "./CyberTestingPanel";
import { AssuranceReportSection } from "./CyberRetestPanel";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CYBER_ASSESSMENT_STATUSES,
  CYBER_ASSESSMENT_STATUS_LABELS,
  CYBER_ASSESSMENT_TYPES,
  CYBER_ASSESSMENT_TYPE_LABELS,
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_SCOPE_MAX,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  type CyberAssessmentStatus,
  type CyberAssessmentType,
} from "@/lib/cyber";
import {
  CalendarClock,
  ClipboardList,
  Download,
  FileCheck2,
  Loader2,
  PlayCircle,
  Plus,
  Search,
  ShieldCheck,
  ShieldX,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Cybersecurity Assurance — assessment register (Phase 4A — Batch 1).
 * ==================================================================
 * The register is the honest record of assessment work: lifecycle is explicit
 * (planned → in progress → completed | cancelled), completion requires an
 * outcome summary, and vulnerability counts are DERIVED from the vulnerability
 * register rather than stored on the assessment. Completing an assessment never
 * marks linked vulnerabilities resolved.
 */

type SeverityCounts = {
  critical: number;
  high: number;
  medium: number;
  low: number;
  informational: number;
};

type AssessmentRow = {
  _id: Id<"securityAssessments">;
  reference: string | null;
  name: string;
  type: CyberAssessmentType;
  typeLabel: string;
  status: CyberAssessmentStatus;
  statusLabel: string;
  description: string | null;
  scope: string | null;
  objectives: string | null;
  relatedAssetOrService: string | null;
  ownerUserId: string | null;
  ownerLabel: string | null;
  plannedStartAt: number | null;
  plannedEndAt: number | null;
  startedAt: number | null;
  startedByLabel: string | null;
  completedAt: number | null;
  completedByLabel: string | null;
  outcomeSummary: string | null;
  cancelledAt: number | null;
  cancelledByLabel: string | null;
  cancelReason: string | null;
  vulnerabilityCount: number;
  openVulnerabilityCount: number;
  overdueVulnerabilityCount: number;
  severityCounts: SeverityCounts;
  createdAt: number;
  updatedAt: number;
};

type VulnerabilityRow = {
  _id: Id<"vulnerabilities">;
  reference: string | null;
  title: string;
  assetName: string;
  severity: string;
  severityLabel: string;
  status: string;
  statusLabel: string;
  cvssScore: number | null;
  ownerLabel: string | null;
  remediationDue: number | null;
  overdue: boolean;
};

type EventRow = {
  _id: string;
  type: string;
  actorLabel: string;
  summary: string;
  reason: string | null;
  createdAt: number;
};

type EvidenceRow = {
  _id: Id<"cyberEvidence">;
  filename: string;
  classification: string;
  integrity: string;
  fileType: string;
  sizeBytes: number;
  uploadedByLabel: string;
  createdAt: number;
};

type Detail = {
  assessment: AssessmentRow;
  testingScope: TestingScope;
  testSummary: TestSummaryShape;
  outstandingTests: number;
  vulnerabilities: VulnerabilityRow[];
  events: EventRow[];
  evidence: EvidenceRow[];
  canManage: boolean;
  currentUserId: string;
};

function dateInput(value: number | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

function AssessmentFormDialog({
  editing,
  onClose,
}: {
  editing: AssessmentRow | null;
  onClose: () => void;
}) {
  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { members: Array<{ userId: string; label: string }> }
    | undefined;
  const create = useMutation(api.cyberAssessments.createAssessment);
  const update = useMutation(api.cyberAssessments.updateAssessment);
  const [form, setForm] = useState({
    name: editing?.name ?? "",
    type: editing?.type ?? ("penetration_test" as CyberAssessmentType),
    ownerUserId: editing?.ownerUserId ?? "",
    scope: editing?.scope ?? "",
    relatedAssetOrService: editing?.relatedAssetOrService ?? "",
    plannedStartAt: dateInput(editing?.plannedStartAt ?? null),
    plannedEndAt: dateInput(editing?.plannedEndAt ?? null),
    objectives: editing?.objectives ?? "",
    description: editing?.description ?? "",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      if (editing) {
        await update({
          assessmentId: editing._id,
          name: form.name,
          type: form.type,
          ownerUserId: form.ownerUserId
            ? (form.ownerUserId as Id<"users">)
            : undefined,
          scope: form.scope || undefined,
          relatedAssetOrService: form.relatedAssetOrService || undefined,
          plannedStartAt: timestamp(form.plannedStartAt),
          plannedEndAt: timestamp(form.plannedEndAt),
          objectives: form.objectives || undefined,
          description: form.description || undefined,
        });
        toast.success("Assessment updated");
      } else {
        const result = await create({
          name: form.name,
          type: form.type,
          ownerUserId: form.ownerUserId
            ? (form.ownerUserId as Id<"users">)
            : undefined,
          scope: form.scope || undefined,
          relatedAssetOrService: form.relatedAssetOrService || undefined,
          plannedStartAt: timestamp(form.plannedStartAt),
          plannedEndAt: timestamp(form.plannedEndAt),
          objectives: form.objectives || undefined,
          description: form.description || undefined,
        });
        toast.success(`Assessment ${result.reference} planned`);
      }
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {editing ? "Edit planned assessment" : "Plan a cybersecurity assessment"}
          </DialogTitle>
          <DialogDescription>
            An assessment starts as planned. Findings and vulnerabilities are
            recorded separately and never fill in the assessment automatically.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="cyber-assessment-title">Title</Label>
            <Input
              id="cyber-assessment-title"
              value={form.name}
              maxLength={CYBER_TITLE_MAX}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Annual perimeter penetration test"
            />
          </div>
          <div>
            <Label>Assessment type</Label>
            <Select
              value={form.type}
              onValueChange={(value) =>
                setForm({ ...form, type: value as CyberAssessmentType })
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYBER_ASSESSMENT_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {CYBER_ASSESSMENT_TYPE_LABELS[type]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Owner</Label>
            <Select
              value={form.ownerUserId || "me"}
              onValueChange={(value) =>
                setForm({ ...form, ownerUserId: value === "me" ? "" : value })
              }
            >
              <SelectTrigger>
                <SelectValue placeholder="Assign owner" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Recorded by me</SelectItem>
                {(options?.members ?? []).map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="cyber-assessment-start">Planned start</Label>
            <Input
              id="cyber-assessment-start"
              type="date"
              value={form.plannedStartAt}
              onChange={(e) =>
                setForm({ ...form, plannedStartAt: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="cyber-assessment-end">Planned end</Label>
            <Input
              id="cyber-assessment-end"
              type="date"
              value={form.plannedEndAt}
              onChange={(e) => setForm({ ...form, plannedEndAt: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cyber-assessment-asset">
              Related asset, system or service
            </Label>
            <Input
              id="cyber-assessment-asset"
              value={form.relatedAssetOrService}
              maxLength={CYBER_SCOPE_MAX}
              onChange={(e) =>
                setForm({ ...form, relatedAssetOrService: e.target.value })
              }
              placeholder="Public payment portal and API gateway"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cyber-assessment-scope">Scope</Label>
            <Input
              id="cyber-assessment-scope"
              value={form.scope}
              maxLength={CYBER_SCOPE_MAX}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              placeholder="External perimeter, authentication and session handling"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cyber-assessment-objectives">Objectives</Label>
            <Textarea
              id="cyber-assessment-objectives"
              rows={3}
              value={form.objectives}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, objectives: e.target.value })}
              placeholder="Identify exploitable weaknesses in the externally exposed estate"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="cyber-assessment-description">Description</Label>
            <Textarea
              id="cyber-assessment-description"
              rows={2}
              value={form.description}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || form.name.trim().length < 4}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {editing ? "Save changes" : "Plan assessment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({
  assessment,
  onClose,
}: {
  assessment: AssessmentRow;
  onClose: () => void;
}) {
  const complete = useMutation(api.cyberAssessments.completeAssessment);
  const [outcome, setOutcome] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await complete({
        assessmentId: assessment._id,
        outcomeSummary: outcome,
      });
      toast.success("Assessment completed");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not complete");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Complete assessment</DialogTitle>
          <DialogDescription>
            Record what the assessment concluded. This does not resolve linked
            vulnerabilities — each one keeps its own governed lifecycle.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={5}
          value={outcome}
          maxLength={CYBER_TEXT_MAX}
          onChange={(e) => setOutcome(e.target.value)}
          placeholder={`At least ${CYBER_NARRATIVE_MIN} characters describing coverage and conclusions`}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || outcome.trim().length < CYBER_NARRATIVE_MIN}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Complete assessment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  assessment,
  onClose,
}: {
  assessment: AssessmentRow;
  onClose: () => void;
}) {
  const cancel = useMutation(api.cyberAssessments.cancelAssessment);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await cancel({ assessmentId: assessment._id, reason });
      toast.success("Assessment cancelled");
      onClose();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not cancel");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Cancel assessment</DialogTitle>
          <DialogDescription>
            Cancelling is recorded permanently with the reason and your identity.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          rows={4}
          value={reason}
          maxLength={CYBER_TEXT_MAX}
          onChange={(e) => setReason(e.target.value)}
          placeholder={`At least ${CYBER_REASON_MIN} characters`}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Keep assessment
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={busy || reason.trim().length < CYBER_REASON_MIN}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Cancel assessment
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DetailDialog({
  assessmentId,
  onClose,
}: {
  assessmentId: Id<"securityAssessments">;
  onClose: () => void;
}) {
  const detail = useQuery(api.cyberAssessments.getAssessment, {
    assessmentId,
  }) as Detail | undefined;
  const start = useMutation(api.cyberAssessments.startAssessment);
  const download = useMutation(api.cyberEvidence.evidenceDownloadUrl);
  const [completing, setCompleting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [busy, setBusy] = useState(false);

  async function startNow() {
    setBusy(true);
    try {
      await start({ assessmentId });
      toast.success("Assessment started");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not start");
    } finally {
      setBusy(false);
    }
  }

  async function openEvidence(evidenceId: Id<"cyberEvidence">) {
    try {
      const result = await download({ evidenceId });
      window.open(result.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Evidence unavailable");
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="max-w-4xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {detail?.assessment.reference ?? "Assessment"}
              <span className="text-muted-foreground">
                {detail?.assessment.name}
              </span>
              {detail ? (
                <AssessmentStatusPill
                  status={detail.assessment.status}
                  label={detail.assessment.statusLabel}
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.assessment.typeLabel}${
                    detail.assessment.relatedAssetOrService
                      ? ` · ${detail.assessment.relatedAssetOrService}`
                      : ""
                  }`
                : "Loading assessment…"}
            </DialogDescription>
          </DialogHeader>

          {!detail ? (
            <ListSkeleton rows={4} />
          ) : (
            <div className="space-y-6">
              <div className="grid gap-3 sm:grid-cols-4">
                <Metric
                  label="Vulnerabilities"
                  value={detail.assessment.vulnerabilityCount}
                />
                <Metric
                  label="Open"
                  value={detail.assessment.openVulnerabilityCount}
                />
                <Metric
                  label="Overdue"
                  value={detail.assessment.overdueVulnerabilityCount}
                  tone={
                    detail.assessment.overdueVulnerabilityCount > 0
                      ? "text-critical"
                      : undefined
                  }
                />
                <Metric
                  label="Critical / high"
                  value={`${detail.assessment.severityCounts.critical} / ${detail.assessment.severityCounts.high}`}
                />
              </div>

              <TestingScopeSection
                assessmentId={detail.assessment._id}
                assessmentStatus={detail.assessment.status}
                scope={detail.testingScope}
                canManage={detail.canManage}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Owner
                  </p>
                  <p className="text-sm">{detail.assessment.ownerLabel ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Planned window
                  </p>
                  <p className="text-sm">
                    {formatDate(detail.assessment.plannedStartAt)} →{" "}
                    {formatDate(detail.assessment.plannedEndAt)}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Started
                  </p>
                  <p className="text-sm">
                    {detail.assessment.startedAt
                      ? `${formatDateTime(detail.assessment.startedAt)} · ${detail.assessment.startedByLabel ?? ""}`
                      : "Not started"}
                  </p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Completed
                  </p>
                  <p className="text-sm">
                    {detail.assessment.completedAt
                      ? `${formatDateTime(detail.assessment.completedAt)} · ${detail.assessment.completedByLabel ?? ""}`
                      : "Not completed"}
                  </p>
                </div>
              </div>

              {detail.assessment.scope ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Scope
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {detail.assessment.scope}
                  </p>
                </div>
              ) : null}
              {detail.assessment.objectives ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Objectives
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {detail.assessment.objectives}
                  </p>
                </div>
              ) : null}
              {detail.assessment.outcomeSummary ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Outcome
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {detail.assessment.outcomeSummary}
                  </p>
                </div>
              ) : null}
              {detail.assessment.cancelReason ? (
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Cancellation reason
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {detail.assessment.cancelReason}
                  </p>
                </div>
              ) : null}

              <TestCaseRegister
                assessmentId={detail.assessment._id}
                vulnerabilities={detail.vulnerabilities}
                evidence={detail.evidence}
                canManage={detail.canManage}
              />

              <AssuranceReportSection
                assessmentId={detail.assessment._id}
                canManage={detail.canManage}
              />

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4" aria-hidden />
                  Linked vulnerabilities
                </h3>
                {detail.vulnerabilities.length === 0 ? (
                  <EmptyState
                    icon={ShieldCheck}
                    title="No vulnerabilities linked"
                    description="Vulnerabilities are recorded in the vulnerability register and can be linked to this assessment there."
                  />
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Reference</TableHead>
                        <TableHead>Vulnerability</TableHead>
                        <TableHead>Asset</TableHead>
                        <TableHead>Severity</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Due</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.vulnerabilities.map((row) => (
                        <TableRow key={row._id}>
                          <TableCell className="font-mono text-xs">
                            {row.reference ?? "—"}
                          </TableCell>
                          <TableCell className="max-w-[220px] truncate">
                            {row.title}
                          </TableCell>
                          <TableCell className="max-w-[160px] truncate">
                            {row.assetName}
                          </TableCell>
                          <TableCell>
                            <SeverityPill
                              severity={row.severity}
                              label={row.severityLabel}
                            />
                          </TableCell>
                          <TableCell>
                            <Badge variant="outline">{row.statusLabel}</Badge>
                          </TableCell>
                          <TableCell
                            className={row.overdue ? "text-critical" : undefined}
                          >
                            {formatDate(row.remediationDue)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <FileCheck2 className="size-4" aria-hidden />
                  Evidence
                </h3>
                {detail.evidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No evidence recorded for this assessment yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
                    {detail.evidence.map((row) => (
                      <li
                        key={row._id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                      >
                        <span className="min-w-0">
                          <span className="block truncate">{row.filename}</span>
                          <span className="text-xs text-muted-foreground">
                            {row.classification} · integrity {row.integrity} ·{" "}
                            {row.uploadedByLabel}
                          </span>
                        </span>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => openEvidence(row._id)}
                        >
                          <Download className="mr-1 size-4" aria-hidden />
                          Open
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="size-4" aria-hidden />
                  History
                </h3>
                <ol className="space-y-2 border-l border-border/70 pl-4">
                  {detail.events.length === 0 ? (
                    <li className="text-sm text-muted-foreground">
                      No history recorded.
                    </li>
                  ) : (
                    detail.events.map((event) => (
                      <li key={event._id} className="text-sm">
                        <p>{event.summary}</p>
                        <p className="text-xs text-muted-foreground">
                          {event.actorLabel} · {formatDateTime(event.createdAt)}
                        </p>
                        {event.reason ? (
                          <p className="mt-1 text-xs text-muted-foreground">
                            {event.reason}
                          </p>
                        ) : null}
                      </li>
                    ))
                  )}
                </ol>
              </div>

              <DialogFooter className="gap-2">
                {detail.canManage && detail.assessment.status === "scheduled" ? (
                  <Button onClick={startNow} disabled={busy}>
                    <PlayCircle className="mr-2 size-4" aria-hidden />
                    Start assessment
                  </Button>
                ) : null}
                {detail.canManage && detail.assessment.status === "in_progress" ? (
                  <div className="flex flex-col items-end gap-1">
                    <Button
                      onClick={() => setCompleting(true)}
                      disabled={detail.outstandingTests > 0}
                    >
                      <ShieldCheck className="mr-2 size-4" aria-hidden />
                      Complete
                    </Button>
                    {detail.outstandingTests > 0 ? (
                      <span className="text-xs text-muted-foreground">
                        {detail.outstandingTests} test case(s) are still planned
                        or in progress
                      </span>
                    ) : null}
                  </div>
                ) : null}
                {detail.canManage &&
                (detail.assessment.status === "scheduled" ||
                  detail.assessment.status === "in_progress") ? (
                  <Button variant="outline" onClick={() => setCancelling(true)}>
                    <XCircle className="mr-2 size-4" aria-hidden />
                    Cancel assessment
                  </Button>
                ) : null}
                {!detail.canManage ? (
                  <Badge variant="outline" className="gap-1">
                    <ShieldX className="size-3.5" aria-hidden />
                    Read-only
                  </Badge>
                ) : null}
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
      {completing && detail ? (
        <CompleteDialog
          assessment={detail.assessment}
          onClose={() => setCompleting(false)}
        />
      ) : null}
      {cancelling && detail ? (
        <CancelDialog
          assessment={detail.assessment}
          onClose={() => setCancelling(false)}
        />
      ) : null}
    </>
  );
}

function CyberAssessmentsInner() {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.cyber === true;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [type, setType] = useState<string>("all");
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<AssessmentRow | null>(null);
  // Deep link from the cybersecurity reporting hub: `?assessment=<id>` opens
  // that assessment's detail. A malformed value is ignored rather than sent to
  // the backend as an invalid id.
  const [searchParams] = useSearchParams();
  const linkedAssessment = searchParams.get("assessment");
  const [detailId, setDetailId] = useState<Id<"securityAssessments"> | null>(
    linkedAssessment && /^[a-z0-9]{16,64}$/i.test(linkedAssessment)
      ? (linkedAssessment as Id<"securityAssessments">)
      : null,
  );

  const data = useQuery(
    api.cyberAssessments.listAssessments,
    canView
      ? {
          search: search || undefined,
          status:
            status === "all" ? undefined : (status as CyberAssessmentStatus),
          type: type === "all" ? undefined : (type as CyberAssessmentType),
        }
      : "skip",
  ) as
    | {
        rows: AssessmentRow[];
        summary: {
          total: number;
          planned: number;
          inProgress: number;
          completed: number;
          cancelled: number;
          canManage: boolean;
          currentUserId: string;
        };
      }
    | undefined;

  const testing = useQuery(
    api.cyberTesting.testingSummary,
    canView ? {} : "skip",
  ) as { summary: TestSummaryShape } | undefined;

  if (session === undefined) {
    return (
      <AppLayout>
        <Breadcrumbs path="/cyber/assessments" />
        <ListSkeleton rows={6} />
      </AppLayout>
    );
  }
  if (!canView) return <CyberUnauthorized path="/cyber/assessments" />;

  const rows = data?.rows ?? [];
  const summary = data?.summary;
  const canManage = summary?.canManage === true;

  return (
    <AppLayout>
      <Breadcrumbs path="/cyber/assessments" />
      <PageHeader
        eyebrow="Cybersecurity Assurance"
        title="Security assessments"
        description="Organization-scoped cybersecurity assessments with an explicit lifecycle. Assessment outcomes and vulnerability counts are recorded and derived from real records — completing an assessment never marks a vulnerability resolved."
        actions={
          canManage ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="mr-2 size-4" aria-hidden />
              Plan assessment
            </Button>
          ) : undefined
        }
      />

      <div className="mb-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric label="Assessments" value={summary?.total ?? 0} />
        <Metric label="Planned" value={summary?.planned ?? 0} />
        <Metric label="In progress" value={summary?.inProgress ?? 0} />
        <Metric label="Completed" value={summary?.completed ?? 0} />
      </div>

      <div className="mb-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Metric
          label="Tests planned"
          value={testing?.summary.planned ?? 0}
          hint="Test cases recorded, not executed"
        />
        <Metric
          label="Tests in progress"
          value={testing?.summary.inProgress ?? 0}
        />
        <Metric
          label="Tests completed"
          value={testing?.summary.completed ?? 0}
        />
        <Metric
          label="Failed tests"
          value={testing?.summary.failed ?? 0}
          tone={
            testing && testing.summary.failed > 0 ? "text-critical" : undefined
          }
          hint="Recorded results, not verified vulnerabilities"
        />
      </div>
      <p className="mb-5 text-xs text-muted-foreground">
        Testing counts are recorded results only. A pass rate is not a measure
        of organizational security effectiveness or compliance.
      </p>

      <Card>
        <CardHeader className="gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <ClipboardList className="size-4" aria-hidden />
                Assessment register
              </CardTitle>
              <CardDescription>
                Planned, in progress and completed assessments for your
                organization.
              </CardDescription>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search
                  className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  className="w-56 pl-8"
                  placeholder="Search reference, title, owner…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Search assessments"
                />
              </div>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger className="w-40" aria-label="Filter by status">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  {CYBER_ASSESSMENT_STATUSES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CYBER_ASSESSMENT_STATUS_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={type} onValueChange={setType}>
                <SelectTrigger className="w-44" aria-label="Filter by type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All types</SelectItem>
                  {CYBER_ASSESSMENT_TYPES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {CYBER_ASSESSMENT_TYPE_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {data === undefined ? (
            <ListSkeleton rows={6} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No assessments match this view"
              description={
                canManage
                  ? "Plan a cybersecurity assessment to begin tracking scope, objectives and outcomes."
                  : "There are no assessments in this organization yet."
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Reference</TableHead>
                  <TableHead>Assessment</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Owner</TableHead>
                  <TableHead>Planned</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Vulnerabilities</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row._id}>
                    <TableCell className="font-mono text-xs">
                      {row.reference ?? "—"}
                    </TableCell>
                    <TableCell className="max-w-[240px]">
                      <span className="block truncate font-medium">
                        {row.name}
                      </span>
                      {row.relatedAssetOrService ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          {row.relatedAssetOrService}
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-xs">{row.typeLabel}</TableCell>
                    <TableCell className="text-xs">
                      {row.ownerLabel ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">
                      {formatDate(row.plannedStartAt)} →{" "}
                      {formatDate(row.plannedEndAt)}
                    </TableCell>
                    <TableCell>
                      <AssessmentStatusPill
                        status={row.status}
                        label={row.statusLabel}
                      />
                    </TableCell>
                    <TableCell className="text-xs">
                      <span className="font-medium">
                        {row.openVulnerabilityCount} open
                      </span>
                      <span className="text-muted-foreground">
                        {" "}
                        / {row.vulnerabilityCount}
                      </span>
                      {row.overdueVulnerabilityCount > 0 ? (
                        <span className="block text-critical">
                          {row.overdueVulnerabilityCount} overdue
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-right">
                      {canManage && row.status === "scheduled" ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setEditing(row)}
                        >
                          Edit
                        </Button>
                      ) : null}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setDetailId(row._id)}
                      >
                        Open
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {creating ? (
        <AssessmentFormDialog editing={null} onClose={() => setCreating(false)} />
      ) : null}
      {editing ? (
        <AssessmentFormDialog editing={editing} onClose={() => setEditing(null)} />
      ) : null}
      {detailId ? (
        <DetailDialog assessmentId={detailId} onClose={() => setDetailId(null)} />
      ) : null}
    </AppLayout>
  );
}

export default function CyberAssessmentsPage() {
  return (
    <CyberBoundary title="Cybersecurity assessments">
      <CyberAssessmentsInner />
    </CyberBoundary>
  );
}
