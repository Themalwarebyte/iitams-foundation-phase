import { useState } from "react";
import { Link } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AppLayout } from "@/components/iitams/AppLayout";
import { Breadcrumbs, PageHeader } from "@/components/iitams/PageHeader";
import { Badge } from "@/components/ui/badge";
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
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { CyberBoundary, CyberUnauthorized, Metric } from "./CyberPrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CYBER_NARRATIVE_MIN,
  CYBER_REPORT_STATUSES,
  CYBER_REPORT_STATUS_LABELS,
  CYBER_TEXT_MAX,
  type CyberReportStatus,
} from "@/lib/cyber";
import type { AssuranceReportContent } from "@/lib/cyberReport";
import {
  buildCyberReportHtml,
  buildCyberReportWordHtml,
  reportExportFilename,
  type ExportReportMeta,
} from "@/lib/cyberReportExport";
import {
  AlertTriangle,
  ClipboardCheck,
  Download,
  FileText,
  RefreshCw,
  Search,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Phase 4A Batch 3 — Cybersecurity Reporting Hub.
 * ===============================================
 * Report discovery, review and export for security testing assurance reports.
 * Everything shown comes from stored records: a finalized report renders its
 * frozen snapshot, a draft renders live numbers and says so, and no screen
 * presents a test-pass rate as organizational security effectiveness.
 */

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

type ReportMeta = ExportReportMeta & {
  _id: Id<"cyberTestReports">;
  assessmentId: Id<"securityAssessments">;
  preparedByUserId: string;
  isDraft: boolean;
  independentlyApproved: boolean;
};

type ReportDetailData = {
  report: ReportMeta;
  content: AssuranceReportContent;
  frozen: boolean;
  history: Array<{
    _id: string;
    type: string;
    summary: string;
    reason: string | null;
    actorLabel: string;
    createdAt: number;
  }>;
  canManage: boolean;
  currentUserId: string;
  currentUserLabel: string;
};

function StatusBadge({ status, label }: { status: string; label: string }) {
  const tone: Record<string, string> = {
    draft: "border-border text-muted-foreground",
    in_review: "border-warning/50 text-warning",
    reviewed: "border-info/50 text-info",
    finalized: "border-success/50 text-success",
    superseded: "border-border text-muted-foreground",
  };
  return (
    <Badge variant="outline" className={tone[status] ?? ""}>
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Detail view
// ---------------------------------------------------------------------------

function DataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-48 shrink-0 text-muted-foreground">{label}</span>
      <span className="whitespace-pre-wrap">{value}</span>
    </div>
  );
}

export function ReportDetailPanel({
  reportId,
  onClose,
}: {
  reportId: Id<"cyberTestReports">;
  onClose?: () => void;
}) {
  const data = useQuery(api.cyberReports.getReport, { reportId }) as
    | ReportDetailData
    | undefined;
  const submit = useMutation(api.cyberReports.submitReport);
  const review = useMutation(api.cyberReports.reviewReport);
  const finalize = useMutation(api.cyberReports.finalizeReport);
  const revise = useMutation(api.cyberReports.reviseReport);
  const withdraw = useMutation(api.cyberReports.returnReport);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    try {
      await action();
      toast.success(success);
    } catch (error) {
      toast.error(errorMessage(error, "The report action failed"));
    } finally {
      setBusy(false);
    }
  }

  if (data === undefined) {
    return <ListSkeleton rows={4} />;
  }

  const { report, content } = data;
  const isPreparer = data.currentUserId === report.preparedByUserId;
  const canReview =
    data.canManage && report.status === "in_review" && !isPreparer;
  const canFinalize = data.canManage && report.status === "reviewed";

  function exportHtml() {
    if (!data) return;
    const input = {
      report,
      content,
      generatedBy: data.currentUserLabel,
      generatedAt: Date.now(),
    };
    downloadFile(
      reportExportFilename(report, "html"),
      buildCyberReportHtml(input),
      "text/html",
    );
    toast.success("Printable export prepared — use the browser print dialog to save as PDF");
  }

  function exportWord() {
    if (!data) return;
    const input = {
      report,
      content,
      generatedBy: data.currentUserLabel,
      generatedAt: Date.now(),
    };
    downloadFile(
      reportExportFilename(report, "doc"),
      buildCyberReportWordHtml(input),
      "application/msword",
    );
    toast.success("Word export prepared");
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="font-mono text-xs">{report.reference} · v{report.version}</p>
          <h2 className="text-lg font-semibold">{report.title}</h2>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <StatusBadge status={report.status} label={report.statusLabel} />
            <span>Prepared by {report.preparedByLabel}</span>
            {report.reviewedByLabel ? (
              <span>
                · Reviewed by {report.reviewedByLabel}
                {report.reviewDecision ? ` (${report.reviewDecision})` : ""}
              </span>
            ) : null}
            {report.supersededByReportId ? (
              <span>· Superseded by a later version</span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={exportHtml}>
            <Download className="mr-2 size-4" aria-hidden />
            Export PDF (print)
          </Button>
          <Button variant="outline" size="sm" onClick={exportWord}>
            <Download className="mr-2 size-4" aria-hidden />
            Export Word
          </Button>
          {onClose ? (
            <Button variant="ghost" size="sm" onClick={onClose}>
              Close
            </Button>
          ) : null}
        </div>
      </div>

      {data.frozen ? (
        <div className="flex items-start gap-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm">
          <ShieldCheck className="mt-0.5 size-4 text-success" aria-hidden />
          <p>
            Finalized {formatDateTime(report.finalizedAt)} by{" "}
            {report.finalizedByLabel ?? "—"}. This content is the frozen snapshot
            captured at finalization and does not change when later remediation
            or retesting happens.
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 text-warning" aria-hidden />
          <p>
            {report.status === "draft"
              ? "Draft: not reviewed and not approved. The numbers below are computed from the current records."
              : report.status === "in_review"
                ? "Awaiting independent review: an approved review by someone other than the preparer is required before finalization."
                : "Independently approved. The frozen copy below is exactly what the reviewer approved; finalization is refused if the underlying records changed since."}
          </p>
        </div>
      )}

      <div className="grid gap-2 sm:grid-cols-4">
        <Metric label="Test cases" value={content.tests.total} />
        <Metric label="Passed" value={content.tests.passed} />
        <Metric label="Failed" value={content.tests.failed} />
        <Metric label="Inconclusive" value={content.tests.inconclusive} />
        <Metric label="Retests" value={content.retests.total} />
        <Metric label="Awaiting review" value={content.retests.awaitingReview} />
        <Metric label="Open findings" value={content.linkedVulnerabilities.open} />
        <Metric
          label="Withheld evidence"
          value={content.evidence.withheld}
          tone={content.evidence.withheld > 0 ? "text-warning" : undefined}
        />
      </div>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Assessment and scope</h3>
        <div className="flex gap-2 text-sm">
          <span className="w-48 shrink-0 text-muted-foreground">Assessment</span>
          <Link
            to={`/cyber/assessments?assessment=${report.assessmentId}`}
            className="underline-offset-4 hover:underline"
          >
            {content.assessment.name}
          </Link>
        </div>
        <DataRow label="Type" value={content.assessment.typeLabel} />
        <DataRow label="In-scope systems" value={content.assessment.systemsInScope ?? "Not recorded"} />
        <DataRow label="Exclusions" value={content.assessment.exclusions ?? "Not recorded"} />
        <DataRow label="Methodology" value={content.assessment.methodology ?? "Not recorded"} />
        <DataRow label="Authorization" value={content.assessment.authorizationReference ?? "Not recorded"} />
        <DataRow
          label="Testing period"
          value={`${formatDate(content.assessment.authorizedStartAt)} → ${formatDate(
            content.assessment.authorizedEndAt,
          )}`}
        />
        <DataRow
          label="Systems tested"
          value={
            content.tests.testedSystems.join(", ") ||
            "None recorded as completed"
          }
        />
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Recorded testing</h3>
        <DataRow
          label="Completed / outstanding"
          value={`${content.tests.completed} / ${content.tests.planned + content.tests.inProgress}`}
        />
        <DataRow
          label="Pass / fail / inconclusive"
          value={`${content.tests.passed} / ${content.tests.failed} / ${content.tests.inconclusive}`}
        />
        <DataRow
          label="Not tested / N/A / cancelled"
          value={`${content.tests.notTested} / ${content.tests.notApplicable} / ${content.tests.cancelled}`}
        />
        <DataRow
          label="Retests (reviewed / awaiting)"
          value={`${content.retests.reviewed} / ${content.retests.awaitingReview}`}
        />
        <p className="text-xs text-muted-foreground">
          Counts of recorded results only. A pass rate is not a measure of
          organizational security effectiveness, and no security score is
          derived.
        </p>
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold">
          Linked vulnerabilities and verification
        </h3>
        <DataRow
          label="Recorded / confirmed / open"
          value={`${content.linkedVulnerabilities.total} / ${content.linkedVulnerabilities.confirmed} / ${content.linkedVulnerabilities.open}`}
        />
        <DataRow
          label="Severity distribution"
          value={`Critical ${content.severityDistribution.critical}, High ${content.severityDistribution.high}, Medium ${content.severityDistribution.medium}, Low ${content.severityDistribution.low}, Informational ${content.severityDistribution.informational}`}
        />
        <DataRow
          label="Verified / closed"
          value={`${content.verification.verified} / ${content.verification.closed}`}
        />
        <DataRow
          label="Outstanding remediation"
          value={`${content.outstandingRemediation.openVulnerabilities} open finding(s), ${content.outstandingRemediation.outstandingActions} outstanding action(s)`}
        />
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Evidence</h3>
        <DataRow
          label="Accessible / withheld"
          value={`${content.evidence.accessible} / ${content.evidence.withheld}`}
        />
        {content.evidence.withheld > 0 ? (
          <p className="text-xs text-muted-foreground">
            Restricted evidence is excluded from the view and from exports for
            users whose permissions do not cover its classification.
          </p>
        ) : null}
        <ul className="space-y-1 text-sm">
          {content.evidence.items
            .filter((item) => item.accessible)
            .map((item) => (
              <li key={item.reference} className="flex items-center gap-2">
                <FileText className="size-4" aria-hidden />
                {item.filename}
                <Badge variant="outline">{item.classification}</Badge>
              </li>
            ))}
        </ul>
      </section>

      <section className="space-y-1">
        <h3 className="text-sm font-semibold">Limitations and untested scope</h3>
        {content.limitations.truncatedDatasets.length > 0 ? (
          <p className="rounded-md border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
            Aggregation cap reached for{" "}
            {content.limitations.truncatedDatasets.join(", ")}. Counts for those
            datasets are lower bounds, not exact totals, and this report does not
            claim comprehensive coverage.
          </p>
        ) : null}
        <DataRow label="Limitations" value={report.limitations} />
        <DataRow label="Untested scope" value={report.untestedScope} />
        <DataRow label="Conclusions" value={report.conclusions} />
        <DataRow label="Recommendations" value={report.recommendations} />
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Independent review</h3>
        {report.reviewedByLabel ? (
          <>
            <DataRow
              label="Reviewer"
              value={`${report.reviewedByLabel} · ${report.reviewDecision ?? "—"} · ${formatDateTime(
                report.reviewedAt,
              )}`}
            />
            {report.reviewNotes ? (
              <DataRow label="Review notes" value={report.reviewNotes} />
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            No independent review has been recorded for this version.
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Review and finalization history</h3>
        {data.history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No events recorded.</p>
        ) : (
          <ol className="space-y-2 border-l border-border/70 pl-4">
            {data.history.map((event) => (
              <li key={event._id} className="text-sm">
                <p>{event.summary}</p>
                <p className="text-xs text-muted-foreground">
                  {event.actorLabel} · {formatDateTime(event.createdAt)}
                </p>
              </li>
            ))}
          </ol>
        )}
      </section>

      {data.canManage &&
      (report.status === "in_review" || report.status === "reviewed") ? (
        <div>
          <Label htmlFor="report-notes">
            {report.status === "in_review"
              ? "Review notes (required to approve or reject)"
              : "Finalization notes (optional)"}
          </Label>
          <Textarea
            id="report-notes"
            rows={3}
            value={notes}
            maxLength={CYBER_TEXT_MAX}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {data.canManage && report.status === "draft" ? (
          <Button
            onClick={() =>
              run(() => submit({ reportId }), "Submitted for independent review")
            }
            disabled={busy}
          >
            Submit for review
          </Button>
        ) : null}
        {canReview ? (
          <>
            <Button
              variant="outline"
              onClick={() =>
                run(
                  () =>
                    review({
                      reportId,
                      decision: "rejected",
                      reviewNotes: notes,
                    }),
                  "Report rejected and returned to the preparer",
                )
              }
              disabled={busy || notes.trim().length < CYBER_NARRATIVE_MIN}
            >
              <XCircle className="mr-2 size-4" aria-hidden />
              Reject
            </Button>
            <Button
              onClick={() =>
                run(
                  () =>
                    review({
                      reportId,
                      decision: "approved",
                      reviewNotes: notes,
                    }),
                  "Report independently approved",
                )
              }
              disabled={busy || notes.trim().length < CYBER_NARRATIVE_MIN}
            >
              <ClipboardCheck className="mr-2 size-4" aria-hidden />
              Approve review
            </Button>
          </>
        ) : null}
        {canFinalize ? (
          <>
            <Button
              variant="outline"
              onClick={() =>
                run(
                  () => withdraw({ reportId, reviewNotes: notes }),
                  "Report returned to draft; the approval is invalidated",
                )
              }
              disabled={busy || notes.trim().length < CYBER_NARRATIVE_MIN}
            >
              Invalidate review
            </Button>
            <Button
              onClick={() =>
                run(
                  () =>
                    finalize({
                      reportId,
                      reviewNotes: notes.trim() || undefined,
                    }),
                  "Report finalized from the approved review",
                )
              }
              disabled={busy}
            >
              <ShieldCheck className="mr-2 size-4" aria-hidden />
              Finalize
            </Button>
          </>
        ) : null}
        {data.canManage &&
        (report.status === "finalized" || report.status === "superseded") ? (
          <Button
            variant="outline"
            onClick={() =>
              run(() => revise({ reportId }), "New draft revision opened")
            }
            disabled={busy}
          >
            <RefreshCw className="mr-2 size-4" aria-hidden />
            Open revision
          </Button>
        ) : null}
        {data.canManage && report.status === "in_review" && isPreparer ? (
          <p className="text-xs text-muted-foreground">
            You prepared this report, so you cannot review or approve it.
          </p>
        ) : null}
        {!data.canManage ? <Badge variant="outline">Read-only</Badge> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hub
// ---------------------------------------------------------------------------

type HubRow = {
  _id: Id<"cyberTestReports">;
  reference: string;
  title: string;
  status: CyberReportStatus;
  statusLabel: string;
  version: number;
  preparedByLabel: string;
  reviewedByLabel: string | null;
  reviewDecisionLabel: string | null;
  finalizedAt: number | null;
  assessmentId: Id<"securityAssessments">;
  assessmentName: string;
  assessmentReference: string | null;
  supersededByReportId: string | null;
  frozen: boolean;
};

type PostureData = {
  tests: {
    total: number;
    completed: number;
    outstanding: number;
    passed: number;
    failed: number;
    inconclusive: number;
    notTested: number;
  };
  vulnerabilities: {
    total: number;
    confirmed: number;
    open: number;
    awaitingVerification: number;
    awaitingClosure: number;
    bySeverity: Record<string, number>;
  };
  remediation: { outstandingActions: number };
  retests: {
    total: number;
    awaitingReview: number;
    inFlight: number;
    verified: number;
    rejected: number;
  };
  reports: {
    total: number;
    finalized: number;
    superseded: number;
    awaitingReview: number;
    drafts: number;
  };
  truncated: Record<string, boolean>;
  canManage: boolean;
};

function CyberReportsInner({ path }: { path: string }) {
  const session = useQuery(api.session.getSession);
  const canView = session?.permissions?.cyber === true;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string>("all");
  const [assessmentId, setAssessmentId] = useState<string>("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [cursors, setCursors] = useState<number[]>([]);
  const [selected, setSelected] = useState<Id<"cyberTestReports"> | null>(null);

  const assessments = useQuery(
    api.cyberAssessments.listAssessments,
    canView ? { limit: 50 } : "skip",
  ) as { rows: Array<{ _id: string; name: string; reference: string | null }> } | undefined;

  const posture = useQuery(
    api.cyberReports.postureSummary,
    canView ? {} : "skip",
  ) as PostureData | undefined;

  const cursor = cursors.length > 0 ? cursors[cursors.length - 1] : undefined;
  const data = useQuery(
    api.cyberReports.reportHub,
    canView
      ? {
          search: search.trim() || undefined,
          status: status === "all" ? undefined : (status as CyberReportStatus),
          assessmentId:
            assessmentId === "all"
              ? undefined
              : (assessmentId as Id<"securityAssessments">),
          from: from ? new Date(`${from}T00:00:00`).getTime() : undefined,
          to: to ? new Date(`${to}T23:59:59`).getTime() : undefined,
          cursor,
          limit: 25,
        }
      : "skip",
  ) as
    | {
        rows: HubRow[];
        nextCursor: number | null;
        hasMore: boolean;
        counts: {
          total: number;
          draft: number;
          inReview: number;
          reviewed: number;
          finalized: number;
          superseded: number;
          truncated: boolean;
        };
        canManage: boolean;
        currentUserId: string;
      }
    | undefined;

  if (session === undefined) return <RouteLoadingBlock />;
  if (!canView) {
    return <CyberUnauthorized path={path} />;
  }

  return (
    <AppLayout>
      <Breadcrumbs path={path} />
      <PageHeader
        eyebrow="Cybersecurity Assurance"
        title="Cybersecurity Reports"
        description="Security testing assurance reports: drafts, independent review, finalized versions and exports. Counts are recorded data, not a security score."
      />

      {posture ? (
        <div className="mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Metric
            label="Tests completed / outstanding"
            value={`${posture.tests.completed} / ${posture.tests.outstanding}`}
          />
          <Metric
            label="Pass / fail / inconclusive"
            value={`${posture.tests.passed} / ${posture.tests.failed} / ${posture.tests.inconclusive}`}
          />
          <Metric label="Confirmed findings" value={posture.vulnerabilities.confirmed} />
          <Metric
            label="Critical / high"
            value={`${posture.vulnerabilities.bySeverity.critical ?? 0} / ${
              posture.vulnerabilities.bySeverity.high ?? 0
            }`}
            tone={
              (posture.vulnerabilities.bySeverity.critical ?? 0) > 0
                ? "text-critical"
                : undefined
            }
          />
          <Metric
            label="Outstanding remediation"
            value={posture.remediation.outstandingActions}
          />
          <Metric
            label="Retests awaiting review"
            value={posture.retests.awaitingReview}
          />
          <Metric
            label="Awaiting verification / closure"
            value={`${posture.vulnerabilities.awaitingVerification} / ${posture.vulnerabilities.awaitingClosure}`}
          />
          <Metric
            label="Finalized / superseded reports"
            value={`${posture.reports.finalized} / ${posture.reports.superseded}`}
          />
        </div>
      ) : null}

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <CardTitle className="text-base">Report register</CardTitle>
          <div className="flex flex-wrap gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
              <Input
                className="w-64 pl-8"
                placeholder="Search reference, title or assessment"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setCursors([]);
                }}
              />
            </div>
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value);
                setCursors([]);
              }}
            >
              <SelectTrigger className="w-48" aria-label="Report status">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All statuses</SelectItem>
                {CYBER_REPORT_STATUSES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CYBER_REPORT_STATUS_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={assessmentId}
              onValueChange={(value) => {
                setAssessmentId(value);
                setCursors([]);
              }}
            >
              <SelectTrigger className="w-56" aria-label="Assessment">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All assessments</SelectItem>
                {(assessments?.rows ?? []).map((row) => (
                  <SelectItem key={row._id} value={row._id}>
                    {row.reference ? `${row.reference} · ${row.name}` : row.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              className="w-36"
              type="date"
              aria-label="Created from"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setCursors([]);
              }}
            />
            <Input
              className="w-36"
              type="date"
              aria-label="Created to"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setCursors([]);
              }}
            />
          </div>
        </CardHeader>
        <CardContent>
          {data === undefined ? <ListSkeleton rows={5} /> : null}
          {data && data.rows.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No assurance reports match"
              description="Draft a security testing report from a cybersecurity assessment, or clear the filters."
            />
          ) : null}
          {data && data.rows.length > 0 ? (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Report</TableHead>
                    <TableHead>Assessment</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Prepared by</TableHead>
                    <TableHead>Reviewer</TableHead>
                    <TableHead>Finalized</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row) => (
                    <TableRow key={row._id}>
                      <TableCell className="font-mono text-xs">
                        {row.reference}
                        <span className="ml-1 text-muted-foreground">v{row.version}</span>
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate">{row.title}</TableCell>
                      <TableCell className="max-w-[200px] truncate">
                        <Link
                          to={`/cyber/assessments?assessment=${row.assessmentId}`}
                          className="underline-offset-4 hover:underline"
                        >
                          {row.assessmentReference
                            ? `${row.assessmentReference} · ${row.assessmentName}`
                            : row.assessmentName}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={row.status} label={row.statusLabel} />
                      </TableCell>
                      <TableCell>{row.preparedByLabel}</TableCell>
                      <TableCell>
                        {row.reviewedByLabel
                          ? `${row.reviewedByLabel}${row.reviewDecisionLabel ? ` · ${row.reviewDecisionLabel}` : ""}`
                          : "—"}
                      </TableCell>
                      <TableCell>
                        {row.finalizedAt ? formatDate(row.finalizedAt) : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setSelected(row._id)}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
                <span>
                  {data.counts.total} report(s) · {data.counts.draft} draft ·{" "}
                  {data.counts.inReview} awaiting review ·{" "}
                  {data.counts.reviewed} approved · {data.counts.finalized} finalized ·{" "}
                  {data.counts.superseded} superseded
                  {data.counts.truncated ? " (counts capped at 2 000 rows)" : ""}
                </span>
                <span className="flex gap-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={cursors.length === 0}
                    onClick={() => setCursors((prev) => prev.slice(0, -1))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!data.hasMore || data.nextCursor === null}
                    onClick={() =>
                      setCursors((prev) => [...prev, data.nextCursor as number])
                    }
                  >
                    Next
                  </Button>
                </span>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      {selected ? (
        <Card className="mt-4">
          <CardContent className="pt-4">
            <ReportDetailPanel
              reportId={selected}
              onClose={() => setSelected(null)}
            />
          </CardContent>
        </Card>
      ) : null}
    </AppLayout>
  );
}

function RouteLoadingBlock() {
  return (
    <AppLayout>
      <ListSkeleton rows={4} />
    </AppLayout>
  );
}

export default function CyberReportsPage({ path }: { path: string }) {
  return (
    <CyberBoundary title="Cybersecurity reports">
      <CyberReportsInner path={path} />
    </CyberBoundary>
  );
}
