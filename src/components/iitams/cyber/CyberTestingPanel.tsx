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
  Metric,
  ScopeStatusPill,
  TestOutcomePill,
  TestStatusPill,
} from "./CyberPrimitives";
import { formatDate, formatDateTime } from "@/lib/format";
import {
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_SCOPE_MAX,
  CYBER_SCOPE_STATUS_LABELS,
  CYBER_SUBTYPE_MAX,
  CYBER_TEST_CATEGORIES,
  CYBER_TEST_CATEGORY_LABELS,
  CYBER_TEST_EXPECTED_MIN,
  CYBER_TEST_OBSERVATIONS_MIN,
  CYBER_TEST_OUTCOMES,
  CYBER_TEST_OUTCOME_LABELS,
  CYBER_TEST_REVIEW_MIN,
  CYBER_TEST_STATUSES,
  CYBER_TEST_STATUS_LABELS,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  type CyberAssessmentStatus,
  type CyberScopeStatus,
  type CyberTestCategory,
  type CyberTestOutcome,
  type CyberTestStatus,
} from "@/lib/cyber";
import {
  CalendarClock,
  CheckCircle2,
  ClipboardCheck,
  ClipboardList,
  FlaskConical,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Search,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";

/**
 * Security testing engagements and test cases (Phase 4A — Batch 2A).
 * ==================================================================
 * Extends the cybersecurity assessment detail: a testing scope that must be
 * explicitly authorized before anything can run, and a test-case register that
 * records what a human tester actually did. Nothing here executes a scanner,
 * exploit or penetration-test tool, and a failed test never creates or verifies
 * a vulnerability by itself.
 */

export type TestingScope = {
  scopeStatus: CyberScopeStatus;
  subtype: string | null;
  systemsInScope: string | null;
  exclusions: string | null;
  leadTesterUserId: string | null;
  leadTesterLabel: string | null;
  methodology: string | null;
  rulesOfEngagement: string | null;
  authorizationReference: string | null;
  authorizedStartAt: number | null;
  authorizedEndAt: number | null;
  scopeAuthorizedAt: number | null;
  scopeAuthorizedByLabel: string | null;
};

export type TestSummaryShape = {
  total: number;
  planned: number;
  inProgress: number;
  completed: number;
  notApplicable: number;
  cancelled: number;
  passed: number;
  failed: number;
  inconclusive: number;
  notTested: number;
  outstanding: number;
  linkedVulnerability: number;
  linkedConfirmedVulnerability: number;
};

export type TestCaseRow = {
  _id: Id<"cyberTestCases">;
  assessmentId: Id<"securityAssessments">;
  reference: string;
  title: string;
  category: CyberTestCategory;
  categoryLabel: string;
  systemUnderTest: string;
  testerLabel: string;
  plannedDate: number | null;
  executionDate: number | null;
  status: CyberTestStatus;
  statusLabel: string;
  outcome: CyberTestOutcome;
  outcomeLabel: string;
  vulnerabilityId: string | null;
  vulnerabilityReference: string | null;
  vulnerabilityTitle: string | null;
  overdue: boolean;
  executionAllowed: boolean;
  executionBlockedReason: string | null;
  reviewedAt: number | null;
};

type OptionMember = { userId: string; label: string };

function dateInput(value: number | null): string {
  if (!value) return "";
  return new Date(value).toISOString().slice(0, 10);
}

function timestamp(value: string): number | undefined {
  if (!value) return undefined;
  const ts = new Date(`${value}T00:00:00`).getTime();
  return Number.isNaN(ts) ? undefined : ts;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

// ---------------------------------------------------------------------------
// Testing scope & authorization
// ---------------------------------------------------------------------------

function AuthorizeScopeDialog({
  assessmentId,
  scope,
  onClose,
}: {
  assessmentId: Id<"securityAssessments">;
  scope: TestingScope;
  onClose: () => void;
}) {
  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { members: OptionMember[] }
    | undefined;
  const authorize = useMutation(api.cyberTesting.authorizeTestingScope);
  const [form, setForm] = useState({
    subtype: scope.subtype ?? "",
    systemsInScope: scope.systemsInScope ?? "",
    exclusions: scope.exclusions ?? "",
    leadTesterUserId: scope.leadTesterUserId ?? "",
    methodology: scope.methodology ?? "",
    rulesOfEngagement: scope.rulesOfEngagement ?? "",
    authorizationReference: scope.authorizationReference ?? "",
    authorizedStartAt: dateInput(scope.authorizedStartAt),
    authorizedEndAt: dateInput(scope.authorizedEndAt),
  });
  const [busy, setBusy] = useState(false);

  const complete =
    form.systemsInScope.trim().length >= CYBER_NARRATIVE_MIN &&
    form.exclusions.trim().length >= CYBER_NARRATIVE_MIN &&
    form.methodology.trim().length >= 10 &&
    form.rulesOfEngagement.trim().length >= CYBER_NARRATIVE_MIN &&
    form.authorizationReference.trim().length >= 3 &&
    form.authorizedStartAt !== "" &&
    form.authorizedEndAt !== "";

  async function submit() {
    setBusy(true);
    try {
      await authorize({
        assessmentId,
        subtype: form.subtype || undefined,
        systemsInScope: form.systemsInScope,
        exclusions: form.exclusions,
        leadTesterUserId: form.leadTesterUserId
          ? (form.leadTesterUserId as Id<"users">)
          : undefined,
        methodology: form.methodology,
        rulesOfEngagement: form.rulesOfEngagement,
        authorizationReference: form.authorizationReference,
        authorizedStartAt: timestamp(form.authorizedStartAt) ?? 0,
        authorizedEndAt: timestamp(form.authorizedEndAt) ?? 0,
      });
      toast.success("Testing scope authorized");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not authorize the testing scope"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Authorize testing scope</DialogTitle>
          <DialogDescription>
            Recording this engagement is not authorization. Provide the written
            authorization, the exact scope, explicit exclusions, the window and
            the rules of engagement before any test can start.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="scope-subtype">Engagement subtype (optional)</Label>
            <Input
              id="scope-subtype"
              value={form.subtype}
              maxLength={CYBER_SUBTYPE_MAX}
              onChange={(e) => setForm({ ...form, subtype: e.target.value })}
              placeholder="External, internal, API, cloud configuration…"
            />
          </div>
          <div>
            <Label htmlFor="scope-lead">Lead tester / assessor</Label>
            <Select
              value={form.leadTesterUserId || "me"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  leadTesterUserId: value === "me" ? "" : value,
                })
              }
            >
              <SelectTrigger id="scope-lead">
                <SelectValue placeholder="Assign lead tester" />
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
          <div className="sm:col-span-2">
            <Label htmlFor="scope-systems">Systems or applications in scope</Label>
            <Textarea
              id="scope-systems"
              rows={2}
              value={form.systemsInScope}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, systemsInScope: e.target.value })
              }
              placeholder="Public payment portal (portal.gov.example) and its API gateway"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="scope-exclusions">Explicit exclusions</Label>
            <Textarea
              id="scope-exclusions"
              rows={2}
              value={form.exclusions}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, exclusions: e.target.value })}
              placeholder="State what is out of scope, or “None” when nothing is excluded"
            />
          </div>
          <div>
            <Label htmlFor="scope-start">Authorized window start</Label>
            <Input
              id="scope-start"
              type="date"
              value={form.authorizedStartAt}
              onChange={(e) =>
                setForm({ ...form, authorizedStartAt: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="scope-end">Authorized window end</Label>
            <Input
              id="scope-end"
              type="date"
              value={form.authorizedEndAt}
              onChange={(e) =>
                setForm({ ...form, authorizedEndAt: e.target.value })
              }
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="scope-methodology">Methodology or standard reference</Label>
            <Input
              id="scope-methodology"
              value={form.methodology}
              maxLength={500}
              onChange={(e) =>
                setForm({ ...form, methodology: e.target.value })
              }
              placeholder="PTES, OWASP WSTG v4.2, CIS Benchmarks…"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="scope-roe">Rules of engagement</Label>
            <Textarea
              id="scope-roe"
              rows={3}
              value={form.rulesOfEngagement}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, rulesOfEngagement: e.target.value })
              }
              placeholder="Testing hours, stop conditions, escalation contacts, prohibited techniques"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="scope-authref">Written authorization reference</Label>
            <Input
              id="scope-authref"
              value={form.authorizationReference}
              maxLength={160}
              onChange={(e) =>
                setForm({ ...form, authorizationReference: e.target.value })
              }
              placeholder="Signed approval reference or authorization letter ID"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !complete}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Authorize scope
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function TestingScopeSection({
  assessmentId,
  assessmentStatus,
  scope,
  canManage,
}: {
  assessmentId: Id<"securityAssessments">;
  assessmentStatus: CyberAssessmentStatus;
  scope: TestingScope;
  canManage: boolean;
}) {
  const [authorizing, setAuthorizing] = useState(false);
  const authorized = scope.scopeStatus === "authorized";
  const editable = assessmentStatus === "scheduled" || assessmentStatus === "in_progress";

  return (
    <div className="rounded-lg border border-border/70 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <FlaskConical className="size-4" aria-hidden />
          Testing scope &amp; authorization
        </h3>
        <div className="flex items-center gap-2">
          <ScopeStatusPill
            status={scope.scopeStatus}
            label={CYBER_SCOPE_STATUS_LABELS[scope.scopeStatus]}
          />
          {canManage && !authorized && editable ? (
            <Button size="sm" variant="outline" onClick={() => setAuthorizing(true)}>
              <ShieldCheck className="mr-1 size-4" aria-hidden />
              Authorize testing scope
            </Button>
          ) : null}
        </div>
      </div>

      {authorized ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Lead tester
            </p>
            <p className="text-sm">{scope.leadTesterLabel ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Authorized window
            </p>
            <p className="text-sm">
              {formatDate(scope.authorizedStartAt)} →{" "}
              {formatDate(scope.authorizedEndAt)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Authorization reference
            </p>
            <p className="text-sm">{scope.authorizationReference ?? "—"}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Authorized by
            </p>
            <p className="text-sm">
              {scope.scopeAuthorizedByLabel ?? "—"} ·{" "}
              {formatDateTime(scope.scopeAuthorizedAt)}
            </p>
          </div>
          {scope.systemsInScope ? (
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                In scope
              </p>
              <p className="text-sm whitespace-pre-wrap">{scope.systemsInScope}</p>
            </div>
          ) : null}
          {scope.exclusions ? (
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Exclusions
              </p>
              <p className="text-sm whitespace-pre-wrap">{scope.exclusions}</p>
            </div>
          ) : null}
          {scope.methodology ? (
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Methodology
              </p>
              <p className="text-sm">{scope.methodology}</p>
            </div>
          ) : null}
          {scope.rulesOfEngagement ? (
            <div className="sm:col-span-2">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                Rules of engagement
              </p>
              <p className="text-sm whitespace-pre-wrap">
                {scope.rulesOfEngagement}
              </p>
            </div>
          ) : null}
        </div>
      ) : (
        <div className="flex items-start gap-2 rounded-md bg-warning/10 p-3 text-sm">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            No testing is authorized for this engagement. Test cases can be
            planned, but execution stays blocked until an authorized user
            records the written authorization, in-scope systems, exclusions,
            window, lead tester, methodology and rules of engagement.
          </p>
        </div>
      )}

      {authorizing ? (
        <AuthorizeScopeDialog
          assessmentId={assessmentId}
          scope={scope}
          onClose={() => setAuthorizing(false)}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Test case creation
// ---------------------------------------------------------------------------

function TestCaseFormDialog({
  assessmentId,
  onClose,
}: {
  assessmentId: Id<"securityAssessments">;
  onClose: () => void;
}) {
  const options = useQuery(api.cyberAssessments.cyberFormOptions, {}) as
    | { members: OptionMember[] }
    | undefined;
  const create = useMutation(api.cyberTesting.createTestCase);
  const [form, setForm] = useState({
    title: "",
    category: "identity_authentication" as CyberTestCategory,
    systemUnderTest: "",
    objective: "",
    procedure: "",
    expectedBehaviour: "",
    testerUserId: "",
    plannedDate: "",
  });
  const [busy, setBusy] = useState(false);

  const complete =
    form.title.trim().length >= CYBER_TITLE_MIN &&
    form.systemUnderTest.trim().length >= 2 &&
    form.objective.trim().length >= CYBER_NARRATIVE_MIN &&
    form.procedure.trim().length >= CYBER_NARRATIVE_MIN &&
    form.expectedBehaviour.trim().length >= CYBER_TEST_EXPECTED_MIN;

  async function submit() {
    setBusy(true);
    try {
      const result = await create({
        assessmentId,
        title: form.title,
        category: form.category,
        systemUnderTest: form.systemUnderTest,
        objective: form.objective,
        procedure: form.procedure,
        expectedBehaviour: form.expectedBehaviour,
        testerUserId: form.testerUserId
          ? (form.testerUserId as Id<"users">)
          : undefined,
        plannedDate: timestamp(form.plannedDate),
      });
      toast.success(`Test case ${result.reference} planned`);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not create the test case"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-2xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Plan a security test case</DialogTitle>
          <DialogDescription>
            A test case records one authorized check: its objective, procedure
            and expected behaviour. Creating it does not run anything and does
            not create a vulnerability.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="ct-title">Test title</Label>
            <Input
              id="ct-title"
              value={form.title}
              maxLength={CYBER_TITLE_MAX}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Verify MFA cannot be bypassed on the admin console"
            />
          </div>
          <div>
            <Label htmlFor="ct-category">Test category</Label>
            <Select
              value={form.category}
              onValueChange={(value) =>
                setForm({ ...form, category: value as CyberTestCategory })
              }
            >
              <SelectTrigger id="ct-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CYBER_TEST_CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {CYBER_TEST_CATEGORY_LABELS[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="ct-tester">Assigned tester</Label>
            <Select
              value={form.testerUserId || "me"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  testerUserId: value === "me" ? "" : value,
                })
              }
            >
              <SelectTrigger id="ct-tester">
                <SelectValue placeholder="Assign tester" />
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
            <Label htmlFor="ct-system">System or component under test</Label>
            <Input
              id="ct-system"
              value={form.systemUnderTest}
              maxLength={CYBER_SCOPE_MAX}
              onChange={(e) =>
                setForm({ ...form, systemUnderTest: e.target.value })
              }
              placeholder="portal.gov.example"
            />
            <p className="mt-1 text-xs text-muted-foreground">
              Use the exact target named in the authorized scope. Execution is
              refused for excluded or unlisted targets, and outside the
              authorized window.
            </p>
          </div>
          <div>
            <Label htmlFor="ct-planned">Planned date</Label>
            <Input
              id="ct-planned"
              type="date"
              value={form.plannedDate}
              onChange={(e) => setForm({ ...form, plannedDate: e.target.value })}
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ct-objective">Test objective</Label>
            <Textarea
              id="ct-objective"
              rows={2}
              value={form.objective}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, objective: e.target.value })}
              placeholder="Determine whether a privileged session can be established without a second factor"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ct-procedure">Testing procedure / methodology</Label>
            <Textarea
              id="ct-procedure"
              rows={3}
              value={form.procedure}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) => setForm({ ...form, procedure: e.target.value })}
              placeholder="Steps performed, tooling used and the order of execution"
            />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="ct-expected">Expected security behaviour</Label>
            <Textarea
              id="ct-expected"
              rows={2}
              value={form.expectedBehaviour}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, expectedBehaviour: e.target.value })
              }
              placeholder="A second factor is required for every privileged session"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={busy || !complete}>
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Plan test case
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Generic note dialog (observations, review, cancellation, not applicable)
// ---------------------------------------------------------------------------

function NoteDialog({
  title,
  description,
  label,
  placeholder,
  confirmLabel,
  minLength,
  id,
  onSubmit,
  onClose,
}: {
  title: string;
  description: string;
  label: string;
  placeholder: string;
  confirmLabel: string;
  minLength: number;
  id: string;
  onSubmit: (value: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await onSubmit(value);
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not save"));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Label htmlFor={id}>{label}</Label>
        <Textarea
          id={id}
          rows={4}
          value={value}
          maxLength={CYBER_TEXT_MAX}
          onChange={(e) => setValue(e.target.value)}
          placeholder={placeholder}
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={busy || value.trim().length < minLength}
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Test execution / result form
// ---------------------------------------------------------------------------

function CompleteTestDialog({
  testCaseId,
  vulnerabilities,
  onClose,
}: {
  testCaseId: Id<"cyberTestCases">;
  vulnerabilities: Array<{ _id: Id<"vulnerabilities">; title: string; reference: string | null }>;
  onClose: () => void;
}) {
  const complete = useMutation(api.cyberTesting.completeTestCase);
  const [form, setForm] = useState({
    outcome: "pass" as CyberTestOutcome,
    observations: "",
    recommendations: "",
    executionDate: new Date().toISOString().slice(0, 10),
    vulnerabilityId: "",
  });
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await complete({
        testCaseId,
        outcome: form.outcome,
        observations: form.observations,
        recommendations: form.recommendations || undefined,
        executionDate: timestamp(form.executionDate) ?? Date.now(),
        vulnerabilityId: form.vulnerabilityId
          ? (form.vulnerabilityId as Id<"vulnerabilities">)
          : undefined,
      });
      toast.success("Test result recorded");
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, "Could not record the result"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="max-w-xl max-h-[88vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record test result</DialogTitle>
          <DialogDescription>
            The result is a recorded human finding. A failure does not create a
            vulnerability — link an existing record or raise one in the
            vulnerability register separately.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="ct-outcome">Outcome</Label>
              <Select
                value={form.outcome}
                onValueChange={(value) =>
                  setForm({ ...form, outcome: value as CyberTestOutcome })
                }
              >
                <SelectTrigger id="ct-outcome">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CYBER_TEST_OUTCOMES.filter(
                    (value) => value !== "not_tested",
                  ).map((value) => (
                    <SelectItem key={value} value={value}>
                      {CYBER_TEST_OUTCOME_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ct-executed">Execution date</Label>
              <Input
                id="ct-executed"
                type="date"
                value={form.executionDate}
                onChange={(e) =>
                  setForm({ ...form, executionDate: e.target.value })
                }
              />
            </div>
          </div>
          <div>
            <Label htmlFor="ct-observations">Actual observations</Label>
            <Textarea
              id="ct-observations"
              rows={4}
              value={form.observations}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, observations: e.target.value })
              }
              placeholder={`What actually happened, with at least ${CYBER_TEST_OBSERVATIONS_MIN} characters`}
            />
          </div>
          <div>
            <Label htmlFor="ct-recommendations">Recommendations (optional)</Label>
            <Textarea
              id="ct-recommendations"
              rows={2}
              value={form.recommendations}
              maxLength={CYBER_TEXT_MAX}
              onChange={(e) =>
                setForm({ ...form, recommendations: e.target.value })
              }
            />
          </div>
          <div>
            <Label htmlFor="ct-vuln">Link an existing vulnerability (optional)</Label>
            <Select
              value={form.vulnerabilityId || "none"}
              onValueChange={(value) =>
                setForm({
                  ...form,
                  vulnerabilityId: value === "none" ? "" : value,
                })
              }
            >
              <SelectTrigger id="ct-vuln">
                <SelectValue placeholder="No linkage" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No linkage</SelectItem>
                {vulnerabilities.map((row) => (
                  <SelectItem key={row._id} value={row._id}>
                    {row.reference ?? "Vulnerability"} — {row.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              busy ||
              form.observations.trim().length < CYBER_TEST_OBSERVATIONS_MIN
            }
          >
            {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
            Record result
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Test case detail
// ---------------------------------------------------------------------------

type TestCaseDetail = {
  testCase: TestCaseRow & {
    systemUnderTest: string;
    objective: string;
    procedure: string;
    expectedBehaviour: string;
    observations: string | null;
    recommendations: string | null;
    notes: string | null;
    reason: string | null;
    evidenceIds: string[];
    startedAt: number | null;
    startedByLabel: string | null;
    completedAt: number | null;
    completedByLabel: string | null;
    reviewedByLabel: string | null;
    reviewNotes: string | null;
    vulnerabilityStatus: string | null;
    vulnerabilityConfirmed: boolean;
    scopeStatus: CyberScopeStatus;
    assessmentStatus: string;
  };
  assessment: {
    reference: string | null;
    name: string;
    status: string;
    scopeStatus: CyberScopeStatus;
    executionAllowed: boolean;
    executionBlockedReason: string | null;
    systemsInScope: string | null;
    exclusions: string | null;
    methodology: string | null;
    rulesOfEngagement: string | null;
    authorizationReference: string | null;
    authorizedStartAt: number | null;
    authorizedEndAt: number | null;
  };
  events: Array<{
    _id: string;
    summary: string;
    actorLabel: string;
    reason: string | null;
    createdAt: number;
  }>;
  evidence: Array<{
    _id: Id<"cyberEvidence">;
    filename: string;
    classification: string;
    integrity: string;
  }>;
  canManage: boolean;
};

function TestCaseDetailDialog({
  testCaseId,
  vulnerabilities,
  evidence,
  onClose,
}: {
  testCaseId: Id<"cyberTestCases">;
  vulnerabilities: Array<{
    _id: Id<"vulnerabilities">;
    title: string;
    reference: string | null;
  }>;
  evidence: Array<{
    _id: Id<"cyberEvidence">;
    filename: string;
    classification: string;
    integrity: string;
  }>;
  onClose: () => void;
}) {
  const detail = useQuery(api.cyberTesting.getTestCase, { testCaseId }) as
    | TestCaseDetail
    | undefined;
  const start = useMutation(api.cyberTesting.startTestCase);
  const observations = useMutation(api.cyberTesting.recordTestObservations);
  const notApplicable = useMutation(api.cyberTesting.markTestCaseNotApplicable);
  const cancel = useMutation(api.cyberTesting.cancelTestCase);
  const review = useMutation(api.cyberTesting.reviewTestCase);
  const linkVulnerability = useMutation(
    api.cyberTesting.linkTestCaseVulnerability,
  );
  const attach = useMutation(api.cyberTesting.attachTestEvidence);

  const [dialog, setDialog] = useState<
    | null
    | "observations"
    | "complete"
    | "not-applicable"
    | "cancel"
    | "review"
    | "link"
    | "evidence"
  >(null);
  const [busy, setBusy] = useState(false);
  const [linkedVulnerability, setLinkedVulnerability] = useState("");
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);

  const row = detail?.testCase;
  const canManage = detail?.canManage === true;

  async function startNow() {
    setBusy(true);
    try {
      await start({ testCaseId });
      toast.success("Test started");
    } catch (error) {
      toast.error(errorMessage(error, "Could not start the test"));
    } finally {
      setBusy(false);
    }
  }

  async function linkNow() {
    if (!linkedVulnerability) return;
    setBusy(true);
    try {
      await linkVulnerability({
        testCaseId,
        vulnerabilityId: linkedVulnerability as Id<"vulnerabilities">,
      });
      toast.success("Vulnerability linked");
      setDialog(null);
      setLinkedVulnerability("");
    } catch (error) {
      toast.error(errorMessage(error, "Could not link the vulnerability"));
    } finally {
      setBusy(false);
    }
  }

  async function attachNow() {
    if (selectedEvidence.length === 0) return;
    setBusy(true);
    try {
      await attach({
        testCaseId,
        evidenceIds: selectedEvidence as Id<"cyberEvidence">[],
      });
      toast.success("Evidence attached");
      setDialog(null);
      setSelectedEvidence([]);
    } catch (error) {
      toast.error(errorMessage(error, "Could not attach evidence"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex flex-wrap items-center gap-2">
              {row?.reference ?? "Test case"}
              <span className="text-muted-foreground">{row?.title}</span>
              {row ? (
                <TestStatusPill status={row.status} label={row.statusLabel} />
              ) : null}
              {row ? (
                <TestOutcomePill
                  outcome={row.outcome}
                  label={row.outcomeLabel}
                />
              ) : null}
            </DialogTitle>
            <DialogDescription>
              {detail
                ? `${detail.assessment.reference ?? "Assessment"} · ${detail.assessment.name}`
                : "Loading test case…"}
            </DialogDescription>
          </DialogHeader>

          {!detail || !row ? (
            <ListSkeleton rows={4} />
          ) : (
            <div className="space-y-5">
              <div className="grid gap-3 sm:grid-cols-3">
                <Metric label="Category" value={row.categoryLabel} />
                <Metric label="Tester" value={row.testerLabel} />
                <Metric label="Planned" value={formatDate(row.plannedDate)} />
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    System under test
                  </p>
                  <p className="text-sm">{row.systemUnderTest}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Execution
                  </p>
                  <p className="text-sm">
                    {row.startedAt
                      ? `${formatDateTime(row.startedAt)} · ${row.startedByLabel ?? ""}`
                      : "Not started"}
                    {row.executionDate
                      ? ` · recorded ${formatDate(row.executionDate)}`
                      : ""}
                  </p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Objective
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{row.objective}</p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Procedure
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{row.procedure}</p>
                </div>
                <div className="sm:col-span-2">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground">
                    Expected security behaviour
                  </p>
                  <p className="text-sm whitespace-pre-wrap">
                    {row.expectedBehaviour}
                  </p>
                </div>
                {row.observations ? (
                  <div className="sm:col-span-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Actual observations
                    </p>
                    <p className="text-sm whitespace-pre-wrap">
                      {row.observations}
                    </p>
                  </div>
                ) : null}
                {row.recommendations ? (
                  <div className="sm:col-span-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Recommendations
                    </p>
                    <p className="text-sm whitespace-pre-wrap">
                      {row.recommendations}
                    </p>
                  </div>
                ) : null}
                {row.reason ? (
                  <div className="sm:col-span-2">
                    <p className="text-xs uppercase tracking-wide text-muted-foreground">
                      Recorded reason
                    </p>
                    <p className="text-sm whitespace-pre-wrap">{row.reason}</p>
                  </div>
                ) : null}
                {row.outcome === "fail" ? (
                  <div className="sm:col-span-2 flex items-start gap-2 rounded-md bg-critical/10 p-3 text-sm">
                    <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <p>
                      A failed test is a recorded result, not a verified
                      vulnerability. Raise or link the vulnerability in the
                      register and let it follow its own lifecycle.
                    </p>
                  </div>
                ) : null}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Link2 className="size-4" aria-hidden />
                  Linked vulnerability
                </h3>
                {row.vulnerabilityId ? (
                  <p className="text-sm">
                    {row.vulnerabilityReference ?? "Vulnerability"} —{" "}
                    {row.vulnerabilityTitle ?? ""}{" "}
                    <Badge variant="outline">
                      {row.vulnerabilityConfirmed
                        ? "Confirmed record"
                        : "Not yet confirmed"}
                    </Badge>
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    No vulnerability linked. Linking is traceability only and
                    never changes the vulnerability's status or the ICT risk
                    score.
                  </p>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <Paperclip className="size-4" aria-hidden />
                  Evidence
                </h3>
                {detail.evidence.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No evidence attached to this test yet.
                  </p>
                ) : (
                  <ul className="divide-y divide-border/70 rounded-lg border border-border/70">
                    {detail.evidence.map((item) => (
                      <li
                        key={item._id}
                        className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
                      >
                        <span className="truncate">{item.filename}</span>
                        <span className="text-xs text-muted-foreground">
                          {item.classification} · integrity {item.integrity}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <div>
                <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
                  <CalendarClock className="size-4" aria-hidden />
                  Test history
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
                {canManage && row.status === "planned" ? (
                  <Button onClick={startNow} disabled={busy}>
                    <FlaskConical className="mr-2 size-4" aria-hidden />
                    Start test
                  </Button>
                ) : null}
                {canManage && row.status === "in_progress" ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setDialog("observations")}
                    >
                      Record observations
                    </Button>
                    <Button onClick={() => setDialog("complete")}>
                      <CheckCircle2 className="mr-2 size-4" aria-hidden />
                      Complete test
                    </Button>
                  </>
                ) : null}
                {canManage && row.status === "completed" && !row.reviewedAt ? (
                  <Button
                    variant="outline"
                    onClick={() => setDialog("review")}
                  >
                    <ClipboardCheck className="mr-2 size-4" aria-hidden />
                    Review result
                  </Button>
                ) : null}
                {canManage &&
                (row.status === "planned" || row.status === "in_progress") ? (
                  <>
                    <Button
                      variant="outline"
                      onClick={() => setDialog("evidence")}
                    >
                      <Paperclip className="mr-2 size-4" aria-hidden />
                      Attach evidence
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setDialog("not-applicable")}
                    >
                      Not applicable
                    </Button>
                    <Button variant="ghost" onClick={() => setDialog("cancel")}>
                      Cancel test
                    </Button>
                  </>
                ) : null}
                {canManage &&
                row.status !== "cancelled" &&
                row.status !== "not_applicable" ? (
                  <Button variant="outline" onClick={() => setDialog("link")}>
                    <Link2 className="mr-2 size-4" aria-hidden />
                    Link vulnerability
                  </Button>
                ) : null}
                {!canManage ? (
                  <Badge variant="outline">Read-only</Badge>
                ) : null}
              </DialogFooter>

              {row.status === "planned" && !row.executionAllowed ? (
                <p className="text-xs text-muted-foreground">
                  {row.executionBlockedReason ??
                    "Execution is blocked until the parent assessment is in progress and its testing scope is authorized."}
                </p>
              ) : null}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {detail && dialog === "observations" ? (
        <NoteDialog
          title="Record observations"
          description="Observations are part of the test's history; the result is recorded separately when the test is completed."
          label="Observations"
          id="ct-obs-note"
          minLength={CYBER_TEST_OBSERVATIONS_MIN}
          placeholder="What the tester observed, with enough detail to reproduce the finding"
          confirmLabel="Save observations"
          onSubmit={(value) => observations({ testCaseId, observations: value })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail && dialog === "complete" ? (
        <CompleteTestDialog
          testCaseId={testCaseId}
          vulnerabilities={vulnerabilities}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail && dialog === "review" ? (
        <NoteDialog
          title="Review test result"
          description="A reviewer other than the tester or executor records an independent review. A result can be reviewed once."
          label="Review notes"
          id="ct-review"
          minLength={CYBER_TEST_REVIEW_MIN}
          placeholder="What was checked and whether the recorded result is supported"
          confirmLabel="Record review"
          onSubmit={(value) => review({ testCaseId, reviewNotes: value })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail && dialog === "not-applicable" ? (
        <NoteDialog
          title="Mark test not applicable"
          description="Not applicable is a documented decision, not a result."
          label="Reason"
          id="ct-na-reason"
          minLength={CYBER_REASON_MIN}
          placeholder="Why this test cannot be performed in this environment"
          confirmLabel="Mark not applicable"
          onSubmit={(value) => notApplicable({ testCaseId, reason: value })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {detail && dialog === "cancel" ? (
        <NoteDialog
          title="Cancel test case"
          description="The cancellation reason and your identity are kept in the test history."
          label="Cancellation reason"
          id="ct-cancel-reason"
          minLength={CYBER_REASON_MIN}
          placeholder="Why this test will not be executed"
          confirmLabel="Cancel test"
          onSubmit={(value) => cancel({ testCaseId, reason: value })}
          onClose={() => setDialog(null)}
        />
      ) : null}

      {detail && dialog === "link" ? (
        <Dialog open onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Link an existing vulnerability</DialogTitle>
              <DialogDescription>
                Linking records traceability. It does not create, confirm,
                remediate or close the vulnerability.
              </DialogDescription>
            </DialogHeader>
            <Select
              value={linkedVulnerability || "none"}
              onValueChange={(value) =>
                setLinkedVulnerability(value === "none" ? "" : value)
              }
            >
              <SelectTrigger id="ct-link-vuln">
                <SelectValue placeholder="Select a vulnerability" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">Select a vulnerability</SelectItem>
                {vulnerabilities.map((vulnerability) => (
                  <SelectItem key={vulnerability._id} value={vulnerability._id}>
                    {vulnerability.reference ?? "Vulnerability"} —{" "}
                    {vulnerability.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                onClick={linkNow}
                disabled={busy || linkedVulnerability === ""}
              >
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Link vulnerability
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {detail && dialog === "evidence" ? (
        <Dialog open onOpenChange={(open) => (!open ? setDialog(null) : undefined)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Attach evidence</DialogTitle>
              <DialogDescription>
                Select evidence already recorded for this assessment. Evidence
                is never copied or altered.
              </DialogDescription>
            </DialogHeader>
            {evidence.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No evidence is recorded for this assessment yet. Upload it from
                the assessment or vulnerability evidence panel first.
              </p>
            ) : (
              <ul className="space-y-2">
                {evidence.map((item) => (
                  <li
                    key={item._id}
                    className="flex items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm"
                  >
                    <input
                      id={`ct-evidence-${item._id}`}
                      type="checkbox"
                      className="size-4"
                      checked={selectedEvidence.includes(item._id)}
                      onChange={(e) =>
                        setSelectedEvidence((current) =>
                          e.target.checked
                            ? [...current, item._id]
                            : current.filter((value) => value !== item._id),
                        )
                      }
                    />
                    <label htmlFor={`ct-evidence-${item._id}`}>
                      {item.filename}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {item.classification}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => setDialog(null)}>
                Close
              </Button>
              <Button
                onClick={attachNow}
                disabled={busy || selectedEvidence.length === 0}
              >
                {busy ? <Loader2 className="mr-2 size-4 animate-spin" /> : null}
                Attach selected
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Test case register
// ---------------------------------------------------------------------------

export function TestCaseRegister({
  assessmentId,
  vulnerabilities,
  evidence,
  canManage,
}: {
  assessmentId: Id<"securityAssessments">;
  vulnerabilities: Array<{
    _id: Id<"vulnerabilities">;
    title: string;
    reference: string | null;
  }>;
  evidence: Array<{
    _id: Id<"cyberEvidence">;
    filename: string;
    classification: string;
    integrity: string;
  }>;
  canManage: boolean;
}) {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [limit, setLimit] = useState(20);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<Id<"cyberTestCases"> | null>(null);

  const data = useQuery(api.cyberTesting.listTestCases, {
    assessmentId,
    search: search || undefined,
    status: status === "all" ? undefined : (status as CyberTestStatus),
    limit,
  }) as
    | {
        rows: TestCaseRow[];
        summary: TestSummaryShape;
        hasMore: boolean;
        canManage: boolean;
      }
    | undefined;

  const rows = data?.rows ?? [];
  const summary = data?.summary;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardList className="size-4" aria-hidden />
          Security test cases
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden
            />
            <Input
              className="w-52 pl-8"
              placeholder="Search tests…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search test cases"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40" aria-label="Filter test cases by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {CYBER_TEST_STATUSES.map((value) => (
                <SelectItem key={value} value={value}>
                  {CYBER_TEST_STATUS_LABELS[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {canManage ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus className="mr-1 size-4" aria-hidden />
              Add test case
            </Button>
          ) : null}
        </div>
      </div>

      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Metric label="Planned" value={summary?.planned ?? 0} />
        <Metric label="In progress" value={summary?.inProgress ?? 0} />
        <Metric label="Completed" value={summary?.completed ?? 0} />
        <Metric
          label="Failed"
          value={summary?.failed ?? 0}
          tone={summary && summary.failed > 0 ? "text-critical" : undefined}
        />
      </div>

      {data === undefined ? (
        <ListSkeleton rows={4} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No test cases match this view"
          description={
            canManage
              ? "Plan a test case to record an authorized check, its expected behaviour and its result."
              : "No security test cases have been recorded for this assessment yet."
          }
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Test</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Tester</TableHead>
                <TableHead>Planned</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Outcome</TableHead>
                <TableHead>Vulnerability</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row._id}>
                  <TableCell className="font-mono text-xs">
                    {row.reference}
                  </TableCell>
                  <TableCell className="max-w-[220px] truncate">
                    {row.title}
                  </TableCell>
                  <TableCell className="text-xs">{row.categoryLabel}</TableCell>
                  <TableCell className="text-xs">{row.testerLabel}</TableCell>
                  <TableCell
                    className={`text-xs ${row.overdue ? "text-critical" : ""}`}
                  >
                    {formatDate(row.plannedDate)}
                  </TableCell>
                  <TableCell>
                    <TestStatusPill status={row.status} label={row.statusLabel} />
                  </TableCell>
                  <TableCell>
                    <TestOutcomePill
                      outcome={row.outcome}
                      label={row.outcomeLabel}
                    />
                  </TableCell>
                  <TableCell className="max-w-[140px] truncate text-xs">
                    {row.vulnerabilityReference ?? "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setOpenId(row._id)}
                    >
                      Open
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {data.hasMore ? (
            <div className="mt-3 flex justify-center">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setLimit((value) => Math.min(value + 20, 100))}
              >
                Load more test cases
              </Button>
            </div>
          ) : null}
        </>
      )}

      <p className="mt-3 text-xs text-muted-foreground">
        Counts are recorded results only. A penetration-test pass rate is not a
        measure of organizational security effectiveness or compliance.
      </p>

      {creating ? (
        <TestCaseFormDialog
          assessmentId={assessmentId}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {openId ? (
        <TestCaseDetailDialog
          testCaseId={openId}
          vulnerabilities={vulnerabilities}
          evidence={evidence}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
