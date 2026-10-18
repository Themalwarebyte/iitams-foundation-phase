import { useMemo, useRef, useState } from "react";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  COMPLIANCE_EVIDENCE_CLASSIFICATION_LABELS,
  COMPLIANCE_EVIDENCE_MAX_BYTES,
  COMPLIANCE_EVIDENCE_TYPES,
  CONTROL_TEST_COMPLETION_MIN,
  CONTROL_TEST_EXCEPTION_MIN,
  CONTROL_TEST_OUTCOMES,
  CONTROL_TEST_OUTCOME_LABELS,
  CONTROL_TEST_TEXT_MAX,
  CONTROL_TEST_TITLE_MAX,
  CONTROL_TEST_VERDICTS,
  COMPLIANCE_EVIDENCE_DESCRIPTION_MAX,
  isOpenControlTest,
  type ComplianceEvidenceClassification,
  type ControlTestOutcome,
} from "@/lib/compliance";
import {
  AlertTriangle,
  BadgeCheck,
  CheckCircle2,
  ClipboardList,
  Download,
  FilePlus2,
  FlaskConical,
  Link2Off,
  Loader2,
  PlayCircle,
  ShieldCheck,
  Unlink,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Phase 3C Batch 2 — control testing and evidence mapping UI.
 * ==========================================================
 * Renders a control's test history, the plan/start/complete/supersede
 * workflow, and its evidence records (upload, map, integrity, audited
 * download). Nothing here computes a compliance percentage: the panel reports
 * the tests and evidence that actually exist.
 */

type TestRow = {
  _id: Id<"complianceControlTests">;
  reference: string;
  title: string;
  objective: string;
  procedure: string;
  status: string;
  statusLabel: string;
  outcome: ControlTestOutcome;
  outcomeLabel: string;
  testerLabel: string;
  plannedStart: number | null;
  plannedEnd: number | null;
  actualStart: number | null;
  actualEnd: number | null;
  periodLabel: string | null;
  sampleSize: number | null;
  sampleDescription: string | null;
  observations: string | null;
  exceptions: string | null;
  recommendations: string | null;
  completionNotes: string | null;
  evidenceException: string | null;
  completedAt: number | null;
  completedByLabel: string | null;
  supersedesTestId: string | null;
  supersededByTestId: string | null;
  superseded: boolean;
  open: boolean;
  createdAt: number;
};

type EvidenceRow = {
  mappingId: Id<"complianceEvidenceMappings">;
  _id: Id<"complianceEvidence">;
  filename: string;
  fileType: string;
  sizeBytes: number;
  classification: ComplianceEvidenceClassification;
  description: string | null;
  source: string | null;
  sha256: string | null;
  integrity: "pending" | "intact" | "hash_mismatch" | "blob_missing";
  integrityCheckedAt: number | null;
  uploadedByLabel: string;
  createdAt: number;
  active: boolean;
  downloadable: boolean;
  unlinkedAt: number | null;
  unlinkReason: string | null;
};

type TestDetail = TestRow & {
  control: { _id: string; code: string; title: string; implementationStatus: string; effectiveness: string };
  framework: { _id: string; code: string; name: string };
  evidence: EvidenceRow[];
  activeEvidenceCount: number;
  supersededTest: TestRow | null;
  canManage: boolean;
};

const OUTCOME_TONE: Record<string, string> = {
  effective: "bg-success/10 text-success border-success/25",
  partially_effective: "bg-warning/15 text-foreground/90 border-warning/40",
  ineffective: "bg-critical/10 text-critical border-critical/25",
  not_tested: "bg-muted text-muted-foreground border-border",
};

const STATUS_TONE: Record<string, string> = {
  planned: "bg-info/10 text-info border-info/25",
  in_progress: "bg-warning/15 text-foreground/90 border-warning/40",
  completed: "bg-success/10 text-success border-success/25",
};

const INTEGRITY_TONE: Record<string, string> = {
  pending: "bg-muted text-muted-foreground border-border",
  intact: "bg-success/10 text-success border-success/25",
  hash_mismatch: "bg-critical/10 text-critical border-critical/25",
  blob_missing: "bg-critical/10 text-critical border-critical/25",
};

const INTEGRITY_LABEL: Record<string, string> = {
  pending: "Hashing queued",
  intact: "Integrity verified",
  hash_mismatch: "Hash mismatch",
  blob_missing: "File missing",
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

function toTimestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

// ---------------------------------------------------------------------------
// Plan / supersede form
// ---------------------------------------------------------------------------

function TestPlanForm({
  controlId,
  supersedes,
  onClose,
}: {
  controlId: Id<"controls">;
  supersedes: TestRow | null;
  onClose: () => void;
}) {
  const createTest = useMutation(api.complianceTesting.createControlTest);
  const supersede = useMutation(api.complianceTesting.supersedeControlTest);
  const owners = useQuery(api.compliance.controlOwners, {}) as
    | Array<{ userId: string; label: string }>
    | undefined;
  const [form, setForm] = useState({
    title: supersedes ? `Repeat test of ${supersedes.reference}` : "",
    objective: "",
    procedure: "",
    testerKey: "none",
    plannedStart: "",
    plannedEnd: "",
    periodLabel: "",
    sampleSize: "",
    sampleDescription: "",
    amendmentReason: "",
  });
  const [busy, setBusy] = useState(false);

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    setBusy(true);
    try {
      const testerUserId =
        form.testerKey !== "none" ? (form.testerKey as Id<"users">) : undefined;
      const payload = {
        title: form.title,
        objective: form.objective,
        procedure: form.procedure,
        ...(testerUserId ? { testerUserId } : {}),
        ...(toTimestamp(form.plannedStart)
          ? { plannedStart: toTimestamp(form.plannedStart)! }
          : {}),
        ...(toTimestamp(form.plannedEnd)
          ? { plannedEnd: toTimestamp(form.plannedEnd)! }
          : {}),
        ...(form.periodLabel ? { periodLabel: form.periodLabel } : {}),
        ...(form.sampleSize ? { sampleSize: Number(form.sampleSize) } : {}),
        ...(form.sampleDescription
          ? { sampleDescription: form.sampleDescription }
          : {}),
      };
      if (supersedes) {
        const result = await supersede({
          testId: supersedes._id,
          amendmentReason: form.amendmentReason,
          ...payload,
        });
        toast.success(
          `Superseding test ${result.reference} recorded — ${supersedes.reference} is preserved.`,
        );
      } else {
        const result = await createTest({ controlId, ...payload });
        toast.success(`Control test ${result.reference} planned.`);
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {supersedes
              ? `Record a superseding test for ${supersedes.reference}`
              : "Plan a control test"}
          </DialogTitle>
          <DialogDescription>
            {supersedes
              ? "The earlier result is never modified: a new test record supersedes it and the amendment is audited."
              : "A test states what will be tested, how, and by whom. It records an outcome — it never changes the control's effectiveness by itself."}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="test-title">Test title</Label>
            <Input
              id="test-title"
              value={form.title}
              maxLength={CONTROL_TEST_TITLE_MAX}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Walkthrough of access provisioning approvals"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="test-objective">Test objective</Label>
            <Textarea
              id="test-objective"
              value={form.objective}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={2}
              onChange={(e) => set("objective", e.target.value)}
              placeholder="What this test sets out to establish"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="test-procedure">Test procedure</Label>
            <Textarea
              id="test-procedure"
              value={form.procedure}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={3}
              onChange={(e) => set("procedure", e.target.value)}
              placeholder="How the sample will be selected and examined"
            />
          </div>
          <div>
            <Label htmlFor="test-tester">Tester</Label>
            <Select
              value={form.testerKey}
              onValueChange={(value) => set("testerKey", value)}
            >
              <SelectTrigger id="test-tester" aria-label="Tester">
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
            <Label htmlFor="test-period">Test period / sample information</Label>
            <Input
              id="test-period"
              value={form.periodLabel}
              onChange={(e) => set("periodLabel", e.target.value)}
              placeholder="2026-Q1"
            />
          </div>
          <div>
            <Label htmlFor="test-planned-start">Planned start</Label>
            <Input
              id="test-planned-start"
              type="date"
              value={form.plannedStart}
              onChange={(e) => set("plannedStart", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="test-planned-end">Planned end</Label>
            <Input
              id="test-planned-end"
              type="date"
              value={form.plannedEnd}
              onChange={(e) => set("plannedEnd", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="test-sample-size">Sample size</Label>
            <Input
              id="test-sample-size"
              type="number"
              min={0}
              value={form.sampleSize}
              onChange={(e) => set("sampleSize", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="test-sample-description">Sample description</Label>
            <Input
              id="test-sample-description"
              value={form.sampleDescription}
              onChange={(e) => set("sampleDescription", e.target.value)}
              placeholder="25 user access requests from the period"
            />
          </div>
          {supersedes && (
            <div className="sm:col-span-2">
              <Label htmlFor="test-amendment-reason">Amendment reason</Label>
              <Textarea
                id="test-amendment-reason"
                value={form.amendmentReason}
                maxLength={CONTROL_TEST_TEXT_MAX}
                rows={2}
                onChange={(e) => set("amendmentReason", e.target.value)}
                placeholder="Why this result replaces the earlier one"
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              !form.title ||
              !form.objective ||
              !form.procedure ||
              (supersedes !== null && !form.amendmentReason)
            }
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            {supersedes ? "Record superseding test" : "Plan test"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Completion form
// ---------------------------------------------------------------------------

function TestCompletionForm({
  test,
  onClose,
}: {
  test: TestRow;
  onClose: () => void;
}) {
  const complete = useMutation(api.complianceTesting.completeControlTest);
  const detail = useQuery(api.complianceTesting.getControlTest, {
    testId: test._id,
  }) as TestDetail | null | undefined;
  const [form, setForm] = useState({
    outcome: "" as ControlTestOutcome | "",
    observations: "",
    exceptions: "",
    recommendations: "",
    completionNotes: "",
    evidenceException: "",
  });
  const [busy, setBusy] = useState(false);

  function set(key: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  const activeEvidence = detail?.activeEvidenceCount ?? 0;
  const needsException = activeEvidence === 0;

  async function submit() {
    if (!form.outcome) return;
    setBusy(true);
    try {
      const result = await complete({
        testId: test._id,
        outcome: form.outcome,
        observations: form.observations,
        exceptions: form.exceptions,
        recommendations: form.recommendations,
        completionNotes: form.completionNotes,
        ...(needsException ? { evidenceException: form.evidenceException } : {}),
      });
      toast.success(
        `Test ${test.reference} completed as ${CONTROL_TEST_OUTCOME_LABELS[result.outcome]} (${
          result.evidenceMapped
        } evidence record(s) mapped).`,
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
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Complete {test.reference}</DialogTitle>
          <DialogDescription>
            A completed test is final: it records the result as issued. A
            correction is a new superseding test, so history is never rewritten.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label htmlFor="test-outcome">Outcome</Label>
            <Select
              value={form.outcome || undefined}
              onValueChange={(value) => set("outcome", value)}
            >
              <SelectTrigger id="test-outcome" aria-label="Test outcome">
                <SelectValue placeholder="Select the test outcome" />
              </SelectTrigger>
              <SelectContent>
                {CONTROL_TEST_VERDICTS.map((outcome) => (
                  <SelectItem key={outcome} value={outcome}>
                    {CONTROL_TEST_OUTCOME_LABELS[outcome]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="test-observations">Observations</Label>
            <Textarea
              id="test-observations"
              value={form.observations}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={3}
              onChange={(e) => set("observations", e.target.value)}
              placeholder="Required when the outcome is partially effective or ineffective"
            />
          </div>
          <div>
            <Label htmlFor="test-exceptions">Exceptions</Label>
            <Textarea
              id="test-exceptions"
              value={form.exceptions}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={2}
              onChange={(e) => set("exceptions", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="test-recommendations">Recommendations</Label>
            <Textarea
              id="test-recommendations"
              value={form.recommendations}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={2}
              onChange={(e) => set("recommendations", e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="test-completion-notes">
              Completion notes (at least {CONTROL_TEST_COMPLETION_MIN} characters)
            </Label>
            <Textarea
              id="test-completion-notes"
              value={form.completionNotes}
              maxLength={CONTROL_TEST_TEXT_MAX}
              rows={3}
              onChange={(e) => set("completionNotes", e.target.value)}
              placeholder="What was actually done, by whom, and on what evidence"
            />
          </div>
          {needsException && (
            <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
              <p className="flex items-start gap-2 text-xs font-medium">
                <AlertTriangle className="mt-0.5 size-3.5" aria-hidden />
                No evidence is mapped to this test yet. Either upload and map
                evidence, or document why it could not be obtained (at least{" "}
                {CONTROL_TEST_EXCEPTION_MIN} characters). A result cannot be
                recorded without one of the two.
              </p>
              <Label htmlFor="test-evidence-exception" className="mt-3 block">
                Documented missing-evidence exception
              </Label>
              <Textarea
                id="test-evidence-exception"
                value={form.evidenceException}
                maxLength={CONTROL_TEST_TEXT_MAX}
                rows={2}
                onChange={(e) => set("evidenceException", e.target.value)}
              />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              !form.outcome ||
              form.completionNotes.trim().length < CONTROL_TEST_COMPLETION_MIN ||
              (needsException &&
                form.evidenceException.trim().length < CONTROL_TEST_EXCEPTION_MIN)
            }
          >
            {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
            Complete test
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Evidence upload
// ---------------------------------------------------------------------------

function EvidenceUpload({
  controlId,
  testId,
  onDone,
}: {
  controlId: Id<"controls">;
  testId: Id<"complianceControlTests">;
  onDone: () => void;
}) {
  const generateUploadUrl = useMutation(
    api.complianceTesting.generateEvidenceUploadUrl,
  );
  const confirmUpload = useMutation(api.complianceTesting.confirmEvidenceUpload);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [classification, setClassification] =
    useState<ComplianceEvidenceClassification>("internal");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  async function upload() {
    const file = fileRef.current?.files?.[0];
    if (!file) {
      toast.error("Choose a file first.");
      return;
    }
    if (file.size > COMPLIANCE_EVIDENCE_MAX_BYTES) {
      toast.error("Evidence files must be 10 MB or smaller.");
      return;
    }
    if (!(COMPLIANCE_EVIDENCE_TYPES as readonly string[]).includes(file.type)) {
      toast.error(`Unsupported file type: ${file.type || "unknown"}`);
      return;
    }
    setBusy(true);
    try {
      const uploadUrl = await generateUploadUrl({});
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": file.type },
        body: file,
      });
      if (!res.ok) throw new Error("Upload failed");
      const { storageId } = (await res.json()) as { storageId: Id<"_storage"> };
      await confirmUpload({
        storageId,
        controlId,
        testId,
        filename: file.name,
        fileType: file.type,
        sizeBytes: file.size,
        classification,
        ...(description ? { description } : {}),
      });
      toast.success("Evidence uploaded — server-side integrity hashing queued.");
      if (fileRef.current) fileRef.current.value = "";
      setDescription("");
      onDone();
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-border/80 p-3">
      <p className="mb-2 flex items-center gap-2 text-xs font-medium">
        <FilePlus2 className="size-3.5" aria-hidden />
        Upload evidence for this test
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
        <div className="flex-1">
          <Label htmlFor="evidence-file">File (10 MB max)</Label>
          <Input id="evidence-file" type="file" ref={fileRef} />
        </div>
        <div className="w-full sm:w-44">
          <Label htmlFor="evidence-classification">Classification</Label>
          <Select
            value={classification}
            onValueChange={(value) =>
              setClassification(value as ComplianceEvidenceClassification)
            }
          >
            <SelectTrigger id="evidence-classification" aria-label="Classification">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                Object.keys(
                  COMPLIANCE_EVIDENCE_CLASSIFICATION_LABELS,
                ) as ComplianceEvidenceClassification[]
              ).map((value) => (
                <SelectItem key={value} value={value}>
                  {COMPLIANCE_EVIDENCE_CLASSIFICATION_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="mt-2">
        <Label htmlFor="evidence-description">Description</Label>
        <Input
          id="evidence-description"
          value={description}
          maxLength={COMPLIANCE_EVIDENCE_DESCRIPTION_MAX}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this evidence shows"
        />
      </div>
      <Button className="mt-3" size="sm" onClick={upload} disabled={busy}>
        {busy && <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />}
        Upload and map
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test detail dialog
// ---------------------------------------------------------------------------

function TestDetailDialog({
  testId,
  canManage,
  onClose,
}: {
  testId: Id<"complianceControlTests">;
  canManage: boolean;
  onClose: () => void;
}) {
  const detail = useQuery(api.complianceTesting.getControlTest, { testId }) as
    | TestDetail
    | null
    | undefined;
  const startTest = useMutation(api.complianceTesting.startControlTest);
  const verifyIntegrity = useMutation(
    api.complianceTesting.verifyEvidenceIntegrity,
  );
  const downloadUrl = useMutation(api.complianceTesting.evidenceDownloadUrl);
  const unlink = useMutation(api.complianceTesting.unlinkEvidenceMapping);
  const [completing, setCompleting] = useState(false);
  const [superseding, setSuperseding] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<EvidenceRow | null>(null);
  const [unlinkReason, setUnlinkReason] = useState("");
  const [busy, setBusy] = useState(false);

  if (detail === undefined) return <ListSkeleton rows={4} />;

  async function start() {
    if (!detail) return;
    setBusy(true);
    try {
      await startTest({ testId: detail._id });
      toast.success(`Test ${detail.reference} moved to in progress.`);
    } catch (error) {
      toast.error((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDownload(evidenceId: Id<"complianceEvidence">, filename: string) {
    try {
      const { url } = await downloadUrl({ evidenceId });
      window.open(url, "_blank", "noopener");
      toast.success(`Download of ${filename} recorded in the audit trail.`);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {detail ? `${detail.reference} — ${detail.title}` : "Control test"}
          </DialogTitle>
          <DialogDescription>
            {detail
              ? `${detail.framework.code} · control ${detail.control.code} — ${detail.control.title}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        {detail === null ? (
          <EmptyState
            icon={FlaskConical}
            title="Test not available"
            description="This control test does not exist in your organization."
          />
        ) : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Chip label={detail.statusLabel} tone={STATUS_TONE[detail.status]} />
              <Chip
                label={detail.outcomeLabel}
                tone={OUTCOME_TONE[detail.outcome]}
              />
              {detail.superseded && (
                <Chip
                  label="Superseded by a later test"
                  tone="bg-warning/15 text-foreground/90 border-warning/40"
                />
              )}
              {detail.evidenceException && (
                <Chip
                  label="Documented missing-evidence exception"
                  tone="bg-warning/15 text-foreground/90 border-warning/40"
                />
              )}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Tester", detail.testerLabel],
                ["Planned", detail.plannedStart ? formatDate(detail.plannedStart) : "—"],
                [
                  "Planned end",
                  detail.plannedEnd ? formatDate(detail.plannedEnd) : "—",
                ],
                [
                  "Actual",
                  detail.actualStart
                    ? `${formatDate(detail.actualStart)}${
                        detail.actualEnd ? ` → ${formatDate(detail.actualEnd)}` : ""
                      }`
                    : "—",
                ],
                ["Period", detail.periodLabel ?? "—"],
                [
                  "Sample",
                  detail.sampleSize !== null
                    ? `${detail.sampleSize}${detail.sampleDescription ? ` — ${detail.sampleDescription}` : ""}`
                    : (detail.sampleDescription ?? "—"),
                ],
                [
                  "Completed",
                  detail.completedAt
                    ? `${formatDateTime(detail.completedAt)}${detail.completedByLabel ? ` by ${detail.completedByLabel}` : ""}`
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

            {[
              ["Objective", detail.objective],
              ["Procedure", detail.procedure],
              ["Observations", detail.observations],
              ["Exceptions", detail.exceptions],
              ["Recommendations", detail.recommendations],
              ["Completion notes", detail.completionNotes],
              ["Missing-evidence exception", detail.evidenceException],
            ]
              .filter(([, value]) => Boolean(value))
              .map(([label, value]) => (
                <div key={label as string}>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-sm text-muted-foreground">{value}</p>
                </div>
              ))}

            {detail.supersedesTestId && (
              <p className="text-xs text-muted-foreground">
                Supersedes an earlier test record; the earlier result remains
                readable in the control's test history.
              </p>
            )}

            <div>
              <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                <ShieldCheck className="size-4" aria-hidden />
                Evidence ({detail.evidence.filter((e) => e.active).length} active)
              </h3>
              {detail.evidence.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-sm text-muted-foreground">
                  No evidence is mapped to this test yet.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>File</TableHead>
                      <TableHead>Classification</TableHead>
                      <TableHead>Integrity</TableHead>
                      <TableHead>SHA-256</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {detail.evidence.map((evidence) => (
                      <TableRow key={evidence.mappingId}>
                        <TableCell>
                          <span className="font-medium">{evidence.filename}</span>
                          <span className="block text-xs text-muted-foreground">
                            {Math.round(evidence.sizeBytes / 1024)} KB ·{" "}
                            {evidence.uploadedByLabel} ·{" "}
                            {formatDate(evidence.createdAt)}
                            {!evidence.active && " · mapping removed"}
                          </span>
                        </TableCell>
                        <TableCell className="capitalize">
                          {evidence.classification}
                        </TableCell>
                        <TableCell>
                          <Chip
                            label={INTEGRITY_LABEL[evidence.integrity]}
                            tone={INTEGRITY_TONE[evidence.integrity]}
                          />
                        </TableCell>
                        <TableCell className="max-w-[220px] truncate font-mono text-[11px]">
                          {evidence.sha256 ?? "—"}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {evidence.downloadable ? (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() =>
                                  handleDownload(evidence._id, evidence.filename)
                                }
                              >
                                <Download className="mr-1 size-3.5" aria-hidden />
                                Download
                              </Button>
                            ) : (
                              <span className="self-center text-xs text-muted-foreground">
                                Restricted
                              </span>
                            )}
                            {canManage && (
                              <>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={async () => {
                                    try {
                                      await verifyIntegrity({
                                        evidenceId: evidence._id,
                                      });
                                      toast.success("Integrity re-check queued.");
                                    } catch (error) {
                                      toast.error((error as Error).message);
                                    }
                                  }}
                                >
                                  Verify
                                </Button>
                                {evidence.active && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setUnlinkTarget(evidence);
                                      setUnlinkReason("");
                                    }}
                                  >
                                    <Unlink className="size-3.5" aria-hidden />
                                  </Button>
                                )}
                              </>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
              {canManage && isOpenControlTest(detail.status as never) && (
                <div className="mt-3">
                  <EvidenceUpload
                    controlId={detail.control._id as Id<"controls">}
                    testId={detail._id}
                    onDone={() => undefined}
                  />
                </div>
              )}
              <p className="mt-2 text-xs text-muted-foreground">
                Downloads are recorded in the audit trail. Removing a mapping
                never deletes the evidence record, its hash or its history.
              </p>
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <div className="flex gap-2">
            {canManage && detail && detail.status === "planned" && (
              <Button variant="secondary" onClick={start} disabled={busy}>
                <PlayCircle className="mr-2 size-4" aria-hidden />
                Start test
              </Button>
            )}
            {canManage && detail && detail.open && (
              <Button onClick={() => setCompleting(true)}>
                <CheckCircle2 className="mr-2 size-4" aria-hidden />
                Complete test
              </Button>
            )}
            {canManage && detail && detail.status === "completed" && !detail.superseded && (
              <Button variant="secondary" onClick={() => setSuperseding(true)}>
                <XCircle className="mr-2 size-4" aria-hidden />
                Record superseding test
              </Button>
            )}
          </div>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>

        {completing && detail && (
          <TestCompletionForm test={detail} onClose={() => setCompleting(false)} />
        )}
        {superseding && detail && (
          <TestPlanForm
            controlId={detail.control._id as Id<"controls">}
            supersedes={detail}
            onClose={() => setSuperseding(false)}
          />
        )}
        {unlinkTarget && (
          <Dialog open onOpenChange={(open) => !open && setUnlinkTarget(null)}>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Remove evidence mapping</DialogTitle>
                <DialogDescription>
                  The evidence record, its integrity hash and the audit trail are
                  retained — only the link is removed.
                </DialogDescription>
              </DialogHeader>
              <Label htmlFor="unlink-reason">Reason</Label>
              <Textarea
                id="unlink-reason"
                value={unlinkReason}
                rows={2}
                onChange={(e) => setUnlinkReason(e.target.value)}
              />
              <DialogFooter>
                <Button variant="outline" onClick={() => setUnlinkTarget(null)}>
                  Cancel
                </Button>
                <Button
                  onClick={async () => {
                    try {
                      await unlink({
                        mappingId: unlinkTarget.mappingId,
                        reason: unlinkReason,
                      });
                      toast.success("Mapping removed; evidence retained.");
                      setUnlinkTarget(null);
                    } catch (error) {
                      toast.error((error as Error).message);
                    }
                  }}
                  disabled={unlinkReason.trim().length < 3}
                >
                  <Link2Off className="mr-2 size-4" aria-hidden />
                  Remove mapping
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Control testing panel (opened from the control register)
// ---------------------------------------------------------------------------

export function ControlTestingPanel({
  controlId,
  controlLabel,
  canManage,
  onClose,
}: {
  controlId: Id<"controls">;
  controlLabel: string;
  canManage: boolean;
  onClose: () => void;
}) {
  const page = useQuery(api.complianceTesting.listControlTests, { controlId }) as
    | {
        rows: TestRow[];
        summary: {
          total: number;
          byStatus: Record<string, number>;
          byOutcome: Record<string, number>;
        } | null;
      }
    | undefined;
  const [planning, setPlanning] = useState(false);
  const [openTestId, setOpenTestId] = useState<Id<"complianceControlTests"> | null>(
    null,
  );

  const rows = page?.rows ?? [];
  const summary = page?.summary;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Control testing — {controlLabel}</DialogTitle>
          <DialogDescription>
            Tests record what was examined and the outcome observed. The control's
            effectiveness is never changed by a test record.
          </DialogDescription>
        </DialogHeader>

        {page === undefined ? (
          <ListSkeleton rows={4} />
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Tests recorded", summary?.total ?? 0],
                ["Planned", summary?.byStatus?.planned ?? 0],
                ["In progress", summary?.byStatus?.in_progress ?? 0],
                ["Completed", summary?.byStatus?.completed ?? 0],
              ].map(([label, value]) => (
                <div
                  key={label as string}
                  className="rounded-lg border bg-muted/20 px-3 py-2"
                >
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    {label}
                  </p>
                  <p className="text-lg font-semibold tabular-nums">{value}</p>
                </div>
              ))}
            </div>

            {summary && summary.total > 0 && (
              <div className="flex flex-wrap gap-2">
                {CONTROL_TEST_OUTCOMES.filter(
                  (outcome) => (summary.byOutcome?.[outcome] ?? 0) > 0,
                ).map((outcome) => (
                  <Chip
                    key={outcome}
                    label={`${CONTROL_TEST_OUTCOME_LABELS[outcome]}: ${
                      summary.byOutcome[outcome]
                    }`}
                    tone={OUTCOME_TONE[outcome]}
                  />
                ))}
              </div>
            )}

            {rows.length === 0 ? (
              <EmptyState
                icon={FlaskConical}
                title="No control tests yet"
                description={
                  canManage
                    ? "Plan a test to record how this control will be examined and what was observed."
                    : "No test has been recorded for this control yet."
                }
                action={
                  canManage ? (
                    <Button onClick={() => setPlanning(true)}>Plan a test</Button>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Reference</TableHead>
                    <TableHead>Test</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Outcome</TableHead>
                    <TableHead>Tester</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((test) => (
                    <TableRow key={test._id}>
                      <TableCell className="font-mono text-xs">
                        {test.reference}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium hover:underline"
                          onClick={() => setOpenTestId(test._id)}
                        >
                          {test.title}
                        </button>
                        {test.superseded && (
                          <span className="block text-xs text-muted-foreground">
                            Superseded by a later test
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={test.statusLabel}
                          tone={STATUS_TONE[test.status]}
                        />
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={test.outcomeLabel}
                          tone={OUTCOME_TONE[test.outcome]}
                        />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {test.testerLabel}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setOpenTestId(test._id)}
                        >
                          Open
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <BadgeCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              Completed tests are immutable. Corrections are recorded as a new
              superseding test, so the original result stays readable.
            </p>
          </div>
        )}

        <DialogFooter className="sm:justify-between">
          {canManage ? (
            <Button onClick={() => setPlanning(true)}>
              <ClipboardList className="mr-2 size-4" aria-hidden />
              Plan a test
            </Button>
          ) : (
            <span />
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>

        {planning && (
          <TestPlanForm
            controlId={controlId}
            supersedes={null}
            onClose={() => setPlanning(false)}
          />
        )}
        {openTestId && (
          <TestDetailDialog
            testId={openTestId}
            canManage={canManage}
            onClose={() => setOpenTestId(null)}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reporting strip (real counts only — never a compliance percentage)
// ---------------------------------------------------------------------------

export function ComplianceTestingSummary() {
  const summary = useQuery(api.complianceTesting.testingSummary, {}) as
    | {
        controls: number;
        notTested: number;
        effective: number;
        partiallyEffective: number;
        ineffective: number;
        plannedTests: number;
        inProgressTests: number;
        completedTests: number;
        evidenceGaps: number;
        evidenceRecords: number;
        unverifiedEvidence: number;
      }
    | undefined;
  const cells = useMemo(
    () =>
      [
        ["Tests planned", summary?.plannedTests],
        ["Tests in progress", summary?.inProgressTests],
        ["Tests completed", summary?.completedTests],
        ["Controls not tested", summary?.notTested],
        ["Effective outcomes", summary?.effective],
        ["Partially effective", summary?.partiallyEffective],
        ["Ineffective outcomes", summary?.ineffective],
        ["Evidence gaps", summary?.evidenceGaps],
      ] as Array<[string, number | undefined]>,
    [summary],
  );

  return (
    <div
      aria-label="Control testing summary"
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
        Counts of real test records and evidence mappings. Outcome counts use the
        latest completed test per control; "Evidence gaps" counts controls with
        no evidence recorded. No overall compliance percentage is calculated
        because its denominator and assessment rules are not defined by this
        batch.
      </p>
    </div>
  );
}
