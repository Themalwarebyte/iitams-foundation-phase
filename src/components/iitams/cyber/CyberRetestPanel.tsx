import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/iitams/audit/ListPageShell";
import { Metric } from "./CyberPrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_RETEST_STATUS_LABELS,
  CYBER_SCOPE_MAX,
  CYBER_TEST_OBSERVATIONS_MIN,
  CYBER_TEST_OUTCOMES,
  CYBER_TEST_OUTCOME_LABELS,
  CYBER_TEST_REVIEW_MIN,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  type CyberRetestStatus,
  type CyberTestOutcome,
} from "@/lib/cyber";
import type { AssuranceReportContent } from "@/lib/cyberReport";
import { ReportDetailPanel } from "./CyberReportsPage";
import {
  CheckCircle2,
  ClipboardCheck,
  FileText,
  History,
  Loader2,
  Plus,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Security retesting, independent verification and assurance reporting
 * (Phase 4A — Batch 2B).
 *
 * The UI never executes anything: it records a retest against a previously
 * recorded failed/inconclusive test, refuses a self-review, and reports only
 * what is recorded. A recorded retest pass closes no vulnerability, and a
 * finalized report is shown from its frozen snapshot.
 */

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

type EvidenceOption = {
  _id: string;
  filename: string;
  /** Presenter output names it `classification`; labels are optional. */
  classification?: string;
  classificationLabel?: string;
};

type RetestRow = {
  _id: Id<"cyberRetests">;
  reference: string;
  status: CyberRetestStatus;
  statusLabel: string;
  outcome: CyberTestOutcome;
  outcomeLabel: string;
  testerLabel: string;
  systemUnderTest: string;
  reviewedAt: number | null;
  reviewDecision: "approved" | "rejected" | null;
  executionAllowed: boolean;
  executionBlockedReason: string | null;
};

function RetestStatusPill({ status }: { status: CyberRetestStatus }) {
  const tone: Record<CyberRetestStatus, string> = {
    planned: "border-border text-muted-foreground",
    in_progress: "border-info/40 text-info",
    completed: "border-warning/50 text-warning",
    reviewed: "border-success/50 text-success",
    rejected: "border-critical/50 text-critical",
  };
  return (
    <Badge variant="outline" className={tone[status]}>
      {CYBER_RETEST_STATUS_LABELS[status]}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Plan retest
// ---------------------------------------------------------------------------

function RetestFormDialog({
  testCaseId,
  defaultSystem,
  onClose,
}: {
  testCaseId: Id<"cyberTestCases">;
  defaultSystem: string;
  onClose: () => void;
}) {
  const members = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { members: Array<{ userId: string; label: string }> }
    | undefined;
  const create = useMutation(api.cyberRetesting.createRetest);
  const [form, setForm] = useState({
    reason: "",
    scope: "",
    systemUnderTest: defaultSystem,
    procedure: "",
    testerUserId: "",
    plannedDate: new Date().toISOString().slice(0, 10),
  });
  const [busy, setBusy] = useState(false);
  const complete =
    form.reason.trim().length >= CYBER_REASON_MIN &&
    form.scope.trim().length >= 4 &&
    form.systemUnderTest.trim().length >= 2 &&
    form.procedure.trim().length >= CYBER_NARRATIVE_MIN;

  async function submit() {
    setBusy(true);
    try {
      await create({
        originalTestCaseId: testCaseId,
        reason: form.reason,
        scope: form.scope,
        systemUnderTest: form.systemUnderTest,
        procedure: form.procedure,
        testerUserId: form.testerUserId
          ? (form.testerUserId as Id<"users">)
          : undefined,
        plannedDate: timestamp(form.plannedDate),
      });
      toast.success("Retest planned");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not plan the retest"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Plan a retest</DialogTitle>
          <DialogDescription>
            A retest is a new record against the earlier result. The original
            failed or inconclusive outcome is never rewritten.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="rt-reason">Reason for retesting</Label>
            <Textarea
              id="rt-reason"
              rows={2}
              value={form.reason}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              placeholder="Remediation was claimed for the missing second factor"
            />
          </div>
          <div>
            <Label htmlFor="rt-system">Target under retest</Label>
            <Input
              id="rt-system"
              value={form.systemUnderTest}
              maxLength={CYBER_SCOPE_MAX}
              onChange={(e) =>
                setForm({ ...form, systemUnderTest: e.target.value })
              }
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Must be inside the authorized testing scope and window.
            </p>
          </div>
          <div>
            <Label htmlFor="rt-scope">Retest scope</Label>
            <Input
              id="rt-scope"
              value={form.scope}
              maxLength={CYBER_SCOPE_MAX}
              onChange={(e) => setForm({ ...form, scope: e.target.value })}
              placeholder="Admin console sign-in only"
            />
          </div>
          <div>
            <Label htmlFor="rt-tester">Assigned tester</Label>
            <Select
              value={form.testerUserId || "me"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  testerUserId: value === "me" ? "" : value,
                })
              }
            >
              <SelectTrigger id="rt-tester">
                <SelectValue placeholder="Assign tester" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="me">Recorded by me</SelectItem>
                {(members?.members ?? []).map((member) => (
                  <SelectItem key={member.userId} value={member.userId}>
                    {member.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="rt-planned">Planned date</Label>
            <Input
              id="rt-planned"
              type="date"
              value={form.plannedDate}
              onChange={(e) => setForm({ ...form, plannedDate: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="rt-procedure">Retest procedure</Label>
            <Textarea
              id="rt-procedure"
              rows={3}
              value={form.procedure}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, procedure: e.target.value })}
              placeholder="Repeat the original sign-in attempt with a valid password and no second factor, then inspect the session claims"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !complete}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Plan retest
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Record result / review
// ---------------------------------------------------------------------------

function CompleteRetestDialog({
  retestId,
  evidence,
  onClose,
}: {
  retestId: Id<"cyberRetests">;
  evidence: EvidenceOption[];
  onClose: () => void;
}) {
  const complete = useMutation(api.cyberRetesting.completeRetest);
  const [form, setForm] = useState({
    outcome: "" as "" | CyberTestOutcome,
    observations: "",
    actualDate: new Date().toISOString().slice(0, 10),
    evidenceIds: [] as string[],
  });
  const [busy, setBusy] = useState(false);
  const done =
    form.outcome !== "" &&
    form.outcome !== "not_tested" &&
    form.observations.trim().length >= CYBER_TEST_OBSERVATIONS_MIN;

  async function submit() {
    setBusy(true);
    try {
      await complete({
        retestId,
        outcome: form.outcome as CyberTestOutcome,
        observations: form.observations,
        actualDate: timestamp(form.actualDate) ?? Date.now(),
        evidenceIds: form.evidenceIds.length
          ? (form.evidenceIds as Id<"cyberEvidence">[])
          : undefined,
      });
      toast.success("Retest result recorded; independent review is still required");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not record the retest result"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record retest result</DialogTitle>
          <DialogDescription>
            This is the tester's claim. A recorded pass does not close the linked
            vulnerability — a different reviewer must verify it, and closure
            stays with the vulnerability workflow.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor="rt-outcome">Outcome</Label>
            <Select
              value={form.outcome || undefined}
              onValueChange={(value) =>
                setForm({ ...form, outcome: value as CyberTestOutcome })
              }
            >
              <SelectTrigger id="rt-outcome">
                <SelectValue placeholder="Select an outcome" />
              </SelectTrigger>
              <SelectContent>
                {CYBER_TEST_OUTCOMES.filter((o) => o !== "not_tested").map(
                  (outcome) => (
                    <SelectItem key={outcome} value={outcome}>
                      {CYBER_TEST_OUTCOME_LABELS[outcome]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="rt-actual">Actual date</Label>
            <Input
              id="rt-actual"
              type="date"
              value={form.actualDate}
              onChange={(e) => setForm({ ...form, actualDate: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="rt-obs">Actual observations</Label>
            <Textarea
              id="rt-obs"
              rows={4}
              value={form.observations}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, observations: e.target.value })}
              placeholder="A second factor was requested for every privileged sign-in attempt"
            />
          </div>
          {evidence.length > 0 ? (
            <fieldset>
              <legend className="text-sm font-medium">Evidence</legend>
              <div className="mt-2 grid gap-1">
                {evidence.slice(0, 20).map((item) => (
                  <label
                    key={item._id}
                    className="flex items-center gap-2 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={form.evidenceIds.includes(item._id)}
                      onChange={(e) =>
                        setForm({
                          ...form,
                          evidenceIds: e.target.checked
                            ? [...form.evidenceIds, item._id]
                            : form.evidenceIds.filter((id) => id !== item._id),
                        })
                      }
                    />
                    <span>{item.filename}</span>
                    {item.classificationLabel ?? item.classification ? (
                      <Badge variant="outline">
                        {item.classificationLabel ?? item.classification}
                      </Badge>
                    ) : null}
                  </label>
                ))}
              </div>
            </fieldset>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !done}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Record result
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewRetestDialog({
  retestId,
  onClose,
}: {
  retestId: Id<"cyberRetests">;
  onClose: () => void;
}) {
  const review = useMutation(api.cyberRetesting.reviewRetest);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(decision: "approved" | "rejected") {
    setBusy(true);
    try {
      await review({ retestId, decision, reviewNotes: notes });
      toast.success(
        decision === "approved"
          ? "Retest independently reviewed"
          : "Retest rejected; further remediation is required",
      );
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not review the retest"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Independent review</DialogTitle>
          <DialogDescription>
            The tester and the executor cannot review their own retest. Approving
            a retest verifies the retest record only; the vulnerability keeps its
            own verification and closure workflow.
          </DialogDescription>
        </DialogHeader>
        <div>
          <Label htmlFor="rt-review">Review notes</Label>
          <Textarea
            id="rt-review"
            rows={4}
            value={notes}
            maxLength={CYBER_TEXT_MAX}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Repeated the sign-in attempt myself; the second factor is now enforced"
          />
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="outline"
            onClick={() => submit("rejected")}
            disabled={busy || notes.trim().length < CYBER_TEST_REVIEW_MIN}
          >
            <XCircle className="mr-2 size-4" aria-hidden />
            Reject
          </Button>
          <Button
            onClick={() => submit("approved")}
            disabled={busy || notes.trim().length < CYBER_TEST_REVIEW_MIN}
          >
            <ClipboardCheck className="mr-2 size-4" aria-hidden />
            Approve review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Retest detail
// ---------------------------------------------------------------------------

type RetestDetail = {
  retest: RetestRow & {
    testerUserId: string | null;
    reason: string;
    scope: string;
    procedure: string;
    observations: string | null;
    plannedDate: number | null;
    actualDate: number | null;
    originalTestReference: string;
    originalTestOutcomeLabel: string;
    vulnerabilityReference: string | null;
    vulnerabilityStatus: string | null;
    completedByUserId: string | null;
    completedByLabel: string | null;
    reviewedByLabel: string | null;
    reviewNotes: string | null;
    verified: boolean;
  };
  originalTest: { reference: string; title: string };
  events: Array<{ _id: string; summary: string; actorLabel: string; createdAt: number }>;
  evidence: EvidenceOption[];
  canManage: boolean;
  currentUserId: string;
};

function RetestDetailDialog({
  retestId,
  evidence,
  onClose,
}: {
  retestId: Id<"cyberRetests">;
  evidence: EvidenceOption[];
  onClose: () => void;
}) {
  const detail = useQuery(api.cyberRetesting.getRetest, { retestId }) as
    | RetestDetail
    | undefined;
  const start = useMutation(api.cyberRetesting.startRetest);
  const [dialog, setDialog] = useState<"complete" | "review" | null>(null);
  const [busy, setBusy] = useState(false);

  async function startNow() {
    setBusy(true);
    try {
      await start({ retestId });
      toast.success("Retest started");
    } catch (error) {
      toast.error(errorMessage(error, "Could not start the retest"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Retest {detail?.retest.reference ?? ""}
            {detail ? <RetestStatusPill status={detail.retest.status} /> : null}
          </DialogTitle>
          <DialogDescription>
            Follows test {detail?.originalTest.reference ?? "—"} (
            {detail?.retest.originalTestOutcomeLabel ?? "—"}
            {detail?.retest.originalTestOutcomeLabel ? ") " : ""}
            and never rewrites that recorded result.
          </DialogDescription>
        </DialogHeader>
        {!detail ? (
          <p className="py-6 text-sm text-muted-foreground">Loading retest…</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 rounded-md border border-border/70 p-3 sm:grid-cols-2">
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Tester
                </p>
                <p className="text-sm">{detail.retest.testerLabel}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Outcome
                </p>
                <p className="text-sm">{detail.retest.outcomeLabel}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Target
                </p>
                <p className="text-sm">{detail.retest.systemUnderTest}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Planned → actual
                </p>
                <p className="text-sm">
                  {formatDate(detail.retest.plannedDate)} →{" "}
                  {formatDate(detail.retest.actualDate)}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Linked vulnerability
                </p>
                <p className="text-sm">
                  {detail.retest.vulnerabilityReference
                    ? `${detail.retest.vulnerabilityReference} · ${detail.retest.vulnerabilityStatus}`
                    : "None linked"}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-wide text-muted-foreground">
                  Verified
                </p>
                <p className="text-sm">
                  {detail.retest.verified
                    ? `Yes · ${detail.retest.reviewedByLabel ?? ""}`
                    : "Not verified"}
                </p>
              </div>
            </div>

            <div>
              <h3 className="mb-1 text-sm font-semibold">Reason for retesting</h3>
              <p className="text-sm whitespace-pre-wrap">{detail.retest.reason}</p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Procedure</h3>
              <p className="text-sm whitespace-pre-wrap">
                {detail.retest.procedure}
              </p>
            </div>
            <div>
              <h3 className="mb-1 text-sm font-semibold">Observations</h3>
              <p className="text-sm whitespace-pre-wrap">
                {detail.retest.observations ?? "No observations recorded yet."}
              </p>
            </div>
            {detail.retest.reviewNotes ? (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Review</h3>
                <p className="text-sm whitespace-pre-wrap">
                  {detail.retest.reviewNotes}
                </p>
              </div>
            ) : null}
            {detail.evidence.length > 0 ? (
              <div>
                <h3 className="mb-1 text-sm font-semibold">Evidence</h3>
                <ul className="space-y-1 text-sm">
                  {detail.evidence.map((item) => (
                    <li key={item._id} className="flex items-center gap-2">
                      <FileText className="size-4" aria-hidden />
                      {item.filename}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <History className="size-4" aria-hidden />
                Retest history
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
                    </li>
                  ))
                )}
              </ol>
            </div>

            <DialogFooter className="flex-wrap gap-2">
              {detail.canManage && detail.retest.status === "planned" ? (
                <Button onClick={startNow} disabled={busy}>
                  <RefreshCw className="mr-2 size-4" aria-hidden />
                  Start retest
                </Button>
              ) : null}
              {detail.canManage && detail.retest.status === "in_progress" ? (
                <Button onClick={() => setDialog("complete")}>
                  <CheckCircle2 className="mr-2 size-4" aria-hidden />
                  Record result
                </Button>
              ) : null}
              {detail.canManage &&
              detail.retest.status === "completed" &&
              detail.currentUserId !== detail.retest.testerUserId &&
              detail.currentUserId !== detail.retest.completedByUserId ? (
                <Button variant="outline" onClick={() => setDialog("review")}>
                  <ClipboardCheck className="mr-2 size-4" aria-hidden />
                  Independent review
                </Button>
              ) : null}
              {!detail.canManage ? (
                <Badge variant="outline">Read-only</Badge>
              ) : null}
            </DialogFooter>

            {detail.retest.status === "planned" &&
            !detail.retest.executionAllowed ? (
              <p className="text-xs text-muted-foreground">
                {detail.retest.executionBlockedReason ??
                  "Execution is blocked until the recorded authorization covers this target and date."}
              </p>
            ) : null}
          </div>
        )}
      </DialogContent>

      {detail && dialog === "complete" ? (
        <CompleteRetestDialog
          retestId={retestId}
          evidence={evidence.length > 0 ? evidence : detail.evidence}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail && dialog === "review" ? (
        <ReviewRetestDialog retestId={retestId} onClose={() => setDialog(null)} />
      ) : null}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Retest section (inside the test-case detail)
// ---------------------------------------------------------------------------

type RetestSectionData = {
  eligible: boolean;
  eligibleReason: string | null;
  originalOutcomeLabel: string;
  assessment: {
    systemsInScope: string | null;
    scopeStatus: string;
    windowOpen: boolean;
    targetInScope: boolean;
    targetExcluded: boolean;
  };
  retests: RetestRow[];
  summary: {
    total: number;
    planned: number;
    inProgress: number;
    awaitingReview: number;
    reviewed: number;
    rejected: number;
    passed: number;
    failed: number;
    inconclusive: number;
  };
  canManage: boolean;
};

export function RetestSection({
  testCaseId,
  evidence,
}: {
  testCaseId: Id<"cyberTestCases">;
  evidence: EvidenceOption[];
}) {
  const data = useQuery(api.cyberRetesting.retestsForTestCaseQuery, {
    testCaseId,
  }) as RetestSectionData | undefined;
  const [planning, setPlanning] = useState(false);
  const [openId, setOpenId] = useState<Id<"cyberRetests"> | null>(null);

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <RefreshCw className="size-4" aria-hidden />
          Retests and independent verification
        </h3>
        {data?.canManage && data.eligible ? (
          <Button size="sm" variant="outline" onClick={() => setPlanning(true)}>
            <Plus className="mr-2 size-4" aria-hidden />
            Plan retest
          </Button>
        ) : null}
      </div>

      {!data ? (
        <p className="text-sm text-muted-foreground">Loading retests…</p>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {data.eligible
              ? `Eligible for retest: the recorded outcome is ${data.originalOutcomeLabel.toLowerCase()}. A retest never rewrites it.`
              : data.eligibleReason}
          </p>
          <div className="grid gap-2 sm:grid-cols-4">
            <Metric label="Retests" value={data.summary.total} />
            <Metric label="Awaiting review" value={data.summary.awaitingReview} />
            <Metric label="Verified" value={data.summary.reviewed} />
            <Metric
              label="Rejected"
              value={data.summary.rejected}
              tone={data.summary.rejected > 0 ? "text-critical" : undefined}
            />
          </div>
          {data.retests.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No retest has been recorded for this test.
            </p>
          ) : (
            <ul className="divide-y divide-border/60">
              {data.retests.map((row) => (
                <li
                  key={row._id}
                  className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs">{row.reference}</span>
                    <RetestStatusPill status={row.status} />
                    <span className="text-muted-foreground">
                      {row.outcomeLabel} · {row.testerLabel}
                    </span>
                    {row.executionAllowed === false &&
                    row.status === "planned" ? (
                      <Badge variant="outline" className="text-warning">
                        Execution blocked
                      </Badge>
                    ) : null}
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpenId(row._id)}
                  >
                    Open
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-xs text-muted-foreground">
            Approval of a retest verifies the retest record only. Closing a
            vulnerability stays with its own verification workflow.
          </p>
        </>
      )}

      {planning && data ? (
        <RetestFormDialog
          testCaseId={testCaseId}
          defaultSystem=""
          onClose={() => setPlanning(false)}
        />
      ) : null}
      {openId ? (
        <RetestDetailDialog
          retestId={openId}
          evidence={evidence}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}

function CreateReportDialog({
  assessmentId,
  onClose,
}: {
  assessmentId: Id<"securityAssessments">;
  onClose: () => void;
}) {
  const preview = useQuery(api.cyberReports.previewReport, { assessmentId }) as
    | { content: AssuranceReportContent }
    | undefined;
  const create = useMutation(api.cyberReports.createReport);
  const [form, setForm] = useState({
    title: "Security testing assurance report",
    conclusions: "",
    recommendations: "",
    limitations: "Testing was limited to the authorized scope recorded above.",
    untestedScope: "Not tested: see the recorded not-tested and excluded scope.",
  });
  const [busy, setBusy] = useState(false);
  const complete =
    form.title.trim().length >= CYBER_TITLE_MIN &&
    form.conclusions.trim().length >= CYBER_NARRATIVE_MIN &&
    form.recommendations.trim().length >= CYBER_NARRATIVE_MIN &&
    form.limitations.trim().length >= 4 &&
    form.untestedScope.trim().length >= 4;

  async function submit() {
    setBusy(true);
    try {
      await create({ assessmentId, ...form });
      toast.success("Draft report created");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not create the report"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New assurance report</DialogTitle>
          <DialogDescription>
            The report is built from recorded rows only. Test counts are not a
            security score, and a finalized report keeps this exact snapshot.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div>
            <Label htmlFor="str-title">Title</Label>
            <Input
              id="str-title"
              value={form.title}
              maxLength={CYBER_TITLE_MAX}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
          </div>
          <div>
            <Label htmlFor="str-conclusions">Conclusions</Label>
            <Textarea
              id="str-conclusions"
              rows={3}
              value={form.conclusions}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, conclusions: e.target.value })
              }
              placeholder="What the recorded testing actually supports concluding"
            />
          </div>
          <div>
            <Label htmlFor="str-recommendations">Recommendations</Label>
            <Textarea
              id="str-recommendations"
              rows={3}
              value={form.recommendations}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, recommendations: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="str-limitations">Limitations</Label>
            <Textarea
              id="str-limitations"
              rows={2}
              value={form.limitations}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, limitations: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="str-untested">Untested scope</Label>
            <Textarea
              id="str-untested"
              rows={2}
              value={form.untestedScope}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, untestedScope: e.target.value })
              }
            />
          </div>
          {preview ? (
            <p className="text-xs text-muted-foreground">
              Snapshot now: {preview.content.tests.total} test case(s),{" "}
              {preview.content.retests.total} retest(s),{" "}
              {preview.content.linkedVulnerabilities.total} recorded
              vulnerability(ies).
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !complete}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Create draft
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type ReportListRow = {
  _id: Id<"cyberTestReports">;
  reference: string;
  version: number;
  statusLabel: string;
  preparedByLabel: string;
  finalizedAt: number | null;
};

export function AssuranceReportSection({
  assessmentId,
  canManage,
}: {
  assessmentId: Id<"securityAssessments">;
  canManage: boolean;
}) {
  const data = useQuery(api.cyberReports.listReports, { assessmentId }) as
    | { rows: ReportListRow[] }
    | undefined;
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<Id<"cyberTestReports"> | null>(null);

  return (
    <div className="space-y-3 rounded-md border border-border/70 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <FileText className="size-4" aria-hidden />
          Security testing report
        </h3>
        {canManage ? (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <Plus className="mr-2 size-4" aria-hidden />
            New report
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        Reports summarise recorded testing, retesting and verification. A
        finalized report is frozen; later remediation never rewrites it.
      </p>
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading reports…</p>
      ) : data.rows.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No assurance report yet"
          description="Draft a report from the recorded test cases, retests and vulnerabilities of this assessment."
        />
      ) : (
        <ul className="divide-y divide-border/60">
          {data.rows.map((row) => (
            <li
              key={row._id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">{row.reference}</span>
                <Badge variant="outline">v{row.version}</Badge>
                <Badge variant="outline">{row.statusLabel}</Badge>
                <span className="text-muted-foreground">
                  {row.preparedByLabel}
                  {row.finalizedAt
                    ? ` · finalized ${formatDate(row.finalizedAt)}`
                    : ""}
                </span>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setOpenId(row._id)}
              >
                Open
              </Button>
            </li>
          ))}
        </ul>
      )}
      {creating ? (
        <CreateReportDialog
          assessmentId={assessmentId}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {openId ? (
        <Dialog open onOpenChange={(open) => (!open ? setOpenId(null) : undefined)}>
          <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Security testing report</DialogTitle>
              <DialogDescription>
                Review, approval, finalization and export of the frozen report.
              </DialogDescription>
            </DialogHeader>
            <ReportDetailPanel
              reportId={openId}
              onClose={() => setOpenId(null)}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </div>
  );
}
