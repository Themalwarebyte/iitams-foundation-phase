import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { AdminPageShell } from "./AdminShell";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { StatusChip } from "@/components/iitams/badges";
import { formatDate, formatDateTime, formatRelative } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  ACCESS_REVIEW_CYCLE_STATUS_LABELS,
  ACCESS_REVIEW_DECISION_LABELS,
  ACCESS_REVIEW_DECISIONS,
  ACCESS_REVIEW_NOTE_MAX,
  ACCESS_REVIEW_RECOMMENDATION_LABELS,
  ACCESS_REVIEW_RECOMMENDATIONS,
  ACCESS_REVIEW_REMEDIATION_STATUS_LABELS,
  type AccessReviewDecision,
  type AccessReviewRecommendation,
} from "@/lib/accessReview";
import {
  INITIAL_ROLE_LABELS,
  PROVISIONABLE_INITIAL_ROLES,
  type ProvisionableInitialRole,
} from "@/lib/membership";
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  ClipboardList,
  ClipboardPlus,
  Gavel,
  Loader2,
  LockKeyhole,
  ShieldCheck,
  Undo2,
  UserRoundCheck,
} from "lucide-react";
import { toast } from "sonner";

/**
 * /admin/access-reviews — Phase 3A Batch A3 foundation.
 * ====================================================
 * Organisation-scoped access reviews (recertification):
 *  - create a review cycle with a title and due date (memberships are
 *    snapshotted at creation; later role changes never rewrite the evidence);
 *  - record reviewer decisions (confirmed / remediation required / exception);
 *  - record remediation RECOMMENDATIONS and apply them through the existing
 *    authorized role-change and membership-status mutations;
 *  - complete a cycle only when every snapshot has a decision.
 *
 * Every action is re-authorized server-side; this page only mirrors what the
 * session's permissions allow and never performs a privilege change itself.
 */

const DECISION_TONE: Record<AccessReviewDecision, string> = {
  access_confirmed: "bg-success/10 text-success border-success/25",
  remediation_required: "bg-warning/15 text-foreground/90 border-warning/40",
  exception_pending: "bg-info/10 text-info border-info/25",
};

function decisionLabel(value: AccessReviewDecision | null | undefined): string {
  return value ? ACCESS_REVIEW_DECISION_LABELS[value] : "Awaiting review";
}

// ---------------------------------------------------------------------------
// New cycle
// ---------------------------------------------------------------------------

function NewCycleDialog({ disabled }: { disabled: boolean }) {
  const createCycle = useMutation(api.accessReview.createCycle);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);

  const dueAt = useMemo(() => {
    if (!dueDate) return null;
    const ts = new Date(`${dueDate}T23:59:00`).getTime();
    return Number.isNaN(ts) ? null : ts;
  }, [dueDate]);

  async function submit() {
    if (!dueAt) return;
    setBusy(true);
    try {
      const result = await createCycle({ title, dueAt });
      toast.success(
        result.scanComplete
          ? `Review cycle created — ${result.capturedTotal} membership snapshot(s) captured.`
          : `Review cycle created — ${result.capturedTotal} snapshot(s) so far; continue capture to finish the snapshot.`,
      );
      setOpen(false);
      setTitle("");
      setDueDate("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The cycle was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button onClick={() => setOpen(true)} disabled={disabled}>
        <ClipboardPlus className="size-4" aria-hidden />
        New review cycle
      </Button>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create an access review cycle</DialogTitle>
          <DialogDescription>
            The organization&apos;s active memberships are snapshotted now. The
            snapshot preserves each member&apos;s role, status and last activity
            so later changes do not rewrite review evidence.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="review-title">Title</Label>
            <Input
              id="review-title"
              value={title}
              maxLength={120}
              placeholder="e.g. Q1 2027 privileged access recertification"
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="review-due">Due date</Label>
            <Input
              id="review-due"
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Reviews still open after this date are flagged overdue; decisions
              remain possible but are visibly late.
            </p>
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={busy || title.trim().length < 3 || !dueAt}
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Create cycle
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Decision dialog
// ---------------------------------------------------------------------------

function DecisionDialog({
  cycleId,
  itemId,
  targetLabel,
  selfPrivileged,
  trigger,
}: {
  cycleId: Id<"accessReviewCycles">;
  itemId: Id<"accessReviewItems">;
  targetLabel: string;
  selfPrivileged: boolean;
  trigger: ReactNode;
}) {
  const recordDecision = useMutation(api.accessReview.recordDecision);
  const [open, setOpen] = useState(false);
  const [decision, setDecision] = useState<AccessReviewDecision>("access_confirmed");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await recordDecision({
        cycleId,
        itemId,
        decision,
        notes: notes.trim() || undefined,
      });
      toast.success(`Decision recorded for ${targetLabel}.`);
      setOpen(false);
      setNotes("");
      setDecision("access_confirmed");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The decision was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span onClick={() => !selfPrivileged && setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Record review decision</DialogTitle>
          <DialogDescription>
            Decision for <strong>{targetLabel}</strong>. Reviewer identity and
            timestamp are recorded; a new decision supersedes the previous one
            but the full history is retained.
          </DialogDescription>
        </DialogHeader>
        {selfPrivileged ? (
          <p className="rounded-md bg-warning/15 px-3 py-2 text-sm">
            You cannot certify your own administrator access — an independent
            administrator must review this item.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="review-decision">Decision</Label>
              <Select
                value={decision}
                onValueChange={(v) => setDecision(v as AccessReviewDecision)}
              >
                <SelectTrigger id="review-decision">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ACCESS_REVIEW_DECISIONS.map((d) => (
                    <SelectItem key={d} value={d}>
                      {ACCESS_REVIEW_DECISION_LABELS[d]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="review-notes">
                Reviewer note{" "}
                {decision !== "access_confirmed" && (
                  <span className="text-critical">(required)</span>
                )}
              </Label>
              <Textarea
                id="review-notes"
                value={notes}
                maxLength={ACCESS_REVIEW_NOTE_MAX}
                rows={3}
                placeholder="Evidence considered and the reason for this decision…"
                onChange={(e) => setNotes(e.target.value)}
              />
            </div>
          </div>
        )}
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy ||
              selfPrivileged ||
              (decision !== "access_confirmed" && notes.trim().length === 0)
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Save decision
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Recommendation dialog
// ---------------------------------------------------------------------------

function RecommendationDialog({
  cycleId,
  itemId,
  targetLabel,
  trigger,
}: {
  cycleId: Id<"accessReviewCycles">;
  itemId: Id<"accessReviewItems">;
  targetLabel: string;
  trigger: ReactNode;
}) {
  const propose = useMutation(api.accessReview.proposeRemediation);
  const [open, setOpen] = useState(false);
  const [recommendation, setRecommendation] =
    useState<AccessReviewRecommendation>("change_role");
  const [targetRole, setTargetRole] = useState<ProvisionableInitialRole | "">("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await propose({
        cycleId,
        itemId,
        recommendation,
        targetRole: recommendation === "change_role" ? targetRole : undefined,
        notes: notes.trim() || undefined,
      });
      toast.success("Recommendation recorded — not applied until executed.");
      setOpen(false);
      setNotes("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The recommendation was refused.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <span onClick={() => setOpen(true)}>{trigger}</span>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Recommend remediation</DialogTitle>
          <DialogDescription>
            A recommendation is recorded separately from the access change. It
            does not modify <strong>{targetLabel}</strong> until an authorized
            administrator applies it through the existing role / membership
            workflow.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="remediation-kind">Recommendation</Label>
            <Select
              value={recommendation}
              onValueChange={(v) =>
                setRecommendation(v as AccessReviewRecommendation)
              }
            >
              <SelectTrigger id="remediation-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ACCESS_REVIEW_RECOMMENDATIONS.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ACCESS_REVIEW_RECOMMENDATION_LABELS[r]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {recommendation === "change_role" && (
            <div className="space-y-2">
              <Label htmlFor="remediation-role">Target role</Label>
              <Select
                value={targetRole}
                onValueChange={(v) => setTargetRole(v as ProvisionableInitialRole)}
              >
                <SelectTrigger id="remediation-role">
                  <SelectValue placeholder="Select the correct role…" />
                </SelectTrigger>
                <SelectContent>
                  {PROVISIONABLE_INITIAL_ROLES.map((r) => (
                    <SelectItem key={r} value={r}>
                      {INITIAL_ROLE_LABELS[r]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-2">
            <Label htmlFor="remediation-notes">Reviewer note</Label>
            <Textarea
              id="remediation-notes"
              value={notes}
              maxLength={ACCESS_REVIEW_NOTE_MAX}
              rows={3}
              placeholder="Why this access should change…"
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={
              busy || (recommendation === "change_role" && targetRole === "")
            }
          >
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
            Record recommendation
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Cycle detail
// ---------------------------------------------------------------------------

function CycleDetail({
  cycleId,
  canManage,
  currentUserId,
}: {
  cycleId: Id<"accessReviewCycles">;
  canManage: boolean;
  currentUserId: string | null;
}) {
  const data = useQuery(api.accessReview.getCycle, { cycleId });
  const capture = useMutation(api.accessReview.captureMembers);
  const complete = useMutation(api.accessReview.completeCycle);
  const cancel = useMutation(api.accessReview.cancelCycle);
  const applyRemediation = useMutation(api.accessReview.applyRemediation);
  const withdrawRemediation = useMutation(api.accessReview.withdrawRemediation);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmComplete, setConfirmComplete] = useState(false);

  if (data === undefined) return <ListSkeleton rows={4} />;
  if (data === null) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="Cycle unavailable"
        description="This review cycle does not exist in your organization."
      />
    );
  }

  const { cycle, items } = data;
  const decided = items.filter((i) => i.latestDecision !== null).length;
  const pending = items.length - decided;
  const active = cycle.status === "in_progress";
  const snapshotComplete = cycle.captureScanComplete;
  const canComplete = pending === 0 && snapshotComplete && cycle.outstanding === 0;

  async function runAction(
    key: string,
    fn: () => Promise<unknown>,
    success: string,
  ) {
    setBusy(key);
    try {
      await fn();
      toast.success(success);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "The action was refused.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <CardTitle className="flex items-center gap-2">
                {cycle.title}
                <StatusChip status={cycle.status} />
                {cycle.overdue && (
                  <Badge
                    variant="outline"
                    className="gap-1 bg-critical/10 text-critical border-critical/25"
                  >
                    <AlertTriangle className="size-3" aria-hidden />
                    Overdue
                  </Badge>
                )}
              </CardTitle>
              <CardDescription className="mt-1">
                Created by {cycle.creatorLabel} on {formatDate(cycle.createdAt)} ·{" "}
                <span className="inline-flex items-center gap-1">
                  <CalendarClock className="size-3.5" aria-hidden />
                  {formatDate(cycle.dueAt)} ({formatRelative(cycle.dueAt)})
                </span>
                {cycle.completedAt && (
                  <> · closed {formatDateTime(cycle.completedAt)}</>
                )}
              </CardDescription>
            </div>
            {canManage && active && (
              <div className="flex flex-wrap gap-2">
                {!snapshotComplete && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy !== null}
                    onClick={() =>
                      void runAction(
                        "capture",
                        async () => {
                          // Resumable, page-by-page capture. Each server call is
                          // bounded; the loop simply advances the stored cursor
                          // until the scan is exhausted (or the click budget).
                          for (let i = 0; i < 50; i += 1) {
                            const page = await capture({ cycleId });
                            if (page.scanComplete) {
                              toast.success(
                                `Snapshot complete — ${page.capturedTotal} of ${page.eligibleTotal} eligible member(s) captured.`,
                              );
                              return;
                            }
                          }
                          toast.message(
                            "Capture still in progress — press Continue capture again to resume.",
                          );
                        },
                        "Snapshot captured.",
                      )
                    }
                  >
                    {busy === "capture" ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <ClipboardList className="size-3.5" aria-hidden />
                    )}
                    Continue capture
                  </Button>
                )}
                <Button
                  size="sm"
                  disabled={busy !== null || !canComplete}
                  title={
                    !snapshotComplete
                      ? "Finish capturing the membership snapshot first"
                      : pending > 0
                        ? `${pending} item(s) still need a decision`
                        : "Complete the cycle"
                  }
                  onClick={() => setConfirmComplete(true)}
                >
                  <CheckCircle2 className="size-3.5" aria-hidden />
                  Complete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() =>
                    void runAction(
                      "cancel",
                      () => cancel({ cycleId }),
                      "Cycle cancelled — history retained.",
                    )
                  }
                >
                  Cancel cycle
                </Button>
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Captured snapshots
              </dt>
              <dd className="mt-0.5 font-semibold tabular-nums">
                {items.length}
                {snapshotComplete && (
                  <span className="ml-1 text-xs font-normal text-muted-foreground">
                    of {cycle.membersEligible} eligible
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Decided
              </dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{decided}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Pending
              </dt>
              <dd className="mt-0.5 font-semibold tabular-nums">{pending}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                Status
              </dt>
              <dd className="mt-0.5 font-semibold">
                {ACCESS_REVIEW_CYCLE_STATUS_LABELS[cycle.status]}
              </dd>
            </div>
          </dl>

          {!snapshotComplete && (
            <p className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
              Snapshot capture is incomplete ({cycle.membersScanned} profile(s)
              scanned so far). The cycle cannot be completed until capture
              finishes; existing snapshots are preserved and resuming never
              duplicates them.
            </p>
          )}
          {snapshotComplete && cycle.outstanding > 0 && (
            <p className="mt-3 rounded-md border border-critical/30 bg-critical/10 px-3 py-2 text-xs text-critical">
              {cycle.outstanding} eligible membership(s) are not represented in
              this snapshot — the review cannot be completed as a full review.
            </p>
          )}
        </CardContent>
      </Card>

      {items.length === 0 ? (
        <EmptyState
          icon={ClipboardList}
          title="No membership snapshots"
          description="No active, non-guest memberships were captured for this cycle. Capture members once the directory has provisioned users."
        />
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const decision = item.latestDecision;
            const openRecommendation = item.remediations.find(
              (r) => r.status === "proposed",
            );
            const selfPrivileged =
              currentUserId !== null &&
              item.targetUserId === currentUserId &&
              item.roleSnapshot === "admin";
            const needsRemediation =
              decision?.decision === "remediation_required";

            return (
              <Card key={item._id}>
                <CardContent className="space-y-3 pt-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        {item.targetLabel}
                        <Badge variant="outline" className="gap-1 font-mono text-[11px]">
                          {item.roleSnapshot ?? "member"}
                        </Badge>
                        <StatusChip status={item.membershipStatusSnapshot} />
                        {selfPrivileged && (
                          <Badge
                            variant="outline"
                            className="gap-1 bg-warning/15 text-foreground/90 border-warning/40"
                          >
                            <LockKeyhole className="size-3" aria-hidden />
                            Your access — independent review required
                          </Badge>
                        )}
                      </p>
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {item.targetEmail ?? "no email on record"} · last activity{" "}
                        {item.lastActivityAt
                          ? formatRelative(item.lastActivityAt)
                          : "not recorded"}{" "}
                        · snapshotted {formatDateTime(item.capturedAt)}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className={
                          decision
                            ? DECISION_TONE[decision.decision]
                            : "bg-muted text-muted-foreground border-border"
                        }
                      >
                        {decisionLabel(decision?.decision)}
                      </Badge>
                    </div>
                  </div>

                  {decision && (
                    <p className="rounded-md bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                      <UserRoundCheck className="mr-1 inline size-3.5" aria-hidden />
                      {decision.reviewerLabel} · {formatDateTime(decision.createdAt)}
                      {decision.notes ? ` — ${decision.notes}` : ""}
                    </p>
                  )}

                  {item.decisions.length > 1 && (
                    <details className="text-xs text-muted-foreground">
                      <summary className="cursor-pointer select-none">
                        Decision history ({item.decisions.length})
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {item.decisions.map((d) => (
                          <li key={d._id}>
                            {formatDateTime(d.createdAt)} · {d.reviewerLabel} ·{" "}
                            {ACCESS_REVIEW_DECISION_LABELS[d.decision]}
                            {d.notes ? ` — ${d.notes}` : ""}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}

                  {openRecommendation && (
                    <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
                      <p className="flex flex-wrap items-center gap-2 font-medium">
                        <Gavel className="size-3.5" aria-hidden />
                        {ACCESS_REVIEW_RECOMMENDATION_LABELS[
                          openRecommendation.recommendation
                        ]}
                        {openRecommendation.targetRole
                          ? ` ${INITIAL_ROLE_LABELS[openRecommendation.targetRole as ProvisionableInitialRole] ?? openRecommendation.targetRole}`
                          : ""}
                        <Badge variant="outline" className="text-[11px]">
                          {
                            ACCESS_REVIEW_REMEDIATION_STATUS_LABELS[
                              openRecommendation.status
                            ]
                          }
                        </Badge>
                      </p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Recorded by {openRecommendation.proposedByLabel} ·{" "}
                        {formatDateTime(openRecommendation.createdAt)}
                        {openRecommendation.notes
                          ? ` — ${openRecommendation.notes}`
                          : ""}
                      </p>
                      {canManage && active && (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(
                                `apply-${openRecommendation._id}`,
                                () => applyRemediation({ remediationId: openRecommendation._id }),
                                "Applied through the authorized membership workflow.",
                              )
                            }
                          >
                            {busy === `apply-${openRecommendation._id}` ? (
                              <Loader2 className="size-3.5 animate-spin" aria-hidden />
                            ) : (
                              <ShieldCheck className="size-3.5" aria-hidden />
                            )}
                            Apply through role / membership workflow
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy !== null}
                            onClick={() =>
                              void runAction(
                                `withdraw-${openRecommendation._id}`,
                                () =>
                                  withdrawRemediation({
                                    remediationId: openRecommendation._id,
                                  }),
                                "Recommendation withdrawn.",
                              )
                            }
                          >
                            <Undo2 className="size-3.5" aria-hidden />
                            Withdraw
                          </Button>
                        </div>
                      )}
                    </div>
                  )}

                  {item.remediations
                    .filter((r) => r.status === "applied")
                    .slice(0, 1)
                    .map((r) => (
                      <p
                        key={r._id}
                        className="rounded-md bg-success/10 px-3 py-2 text-xs text-success"
                      >
                        Applied {formatDateTime(r.appliedAt)} by {r.appliedByLabel} —
                        role {r.roleBefore ?? "—"} → {r.roleAfter ?? "—"}, membership{" "}
                        {r.membershipBefore ?? "—"} → {r.membershipAfter ?? "—"}
                      </p>
                    ))}

                  {canManage && active && (
                    <div className="flex flex-wrap gap-2">
                      <DecisionDialog
                        cycleId={cycleId}
                        itemId={item._id}
                        targetLabel={item.targetLabel}
                        selfPrivileged={selfPrivileged}
                        trigger={
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={busy !== null || selfPrivileged}
                          >
                            <UserRoundCheck className="size-3.5" aria-hidden />
                            {decision ? "Record new decision" : "Record decision"}
                          </Button>
                        }
                      />
                      {needsRemediation && !openRecommendation && (
                        <RecommendationDialog
                          cycleId={cycleId}
                          itemId={item._id}
                          targetLabel={item.targetLabel}
                          trigger={
                            <Button size="sm" disabled={busy !== null}>
                              <Gavel className="size-3.5" aria-hidden />
                              Recommend remediation
                            </Button>
                          }
                        />
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <AlertDialog open={confirmComplete} onOpenChange={setConfirmComplete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Complete this review cycle?</AlertDialogTitle>
            <AlertDialogDescription>
              All {items.length} membership snapshot(s) have a decision. The
              cycle becomes read-only and its snapshot evidence is retained.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Back</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmComplete(false);
                void runAction(
                  "complete",
                  () => complete({ cycleId }),
                  "Review cycle completed.",
                );
              }}
            >
              Complete cycle
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/** Shape returned by the cursor-paginated `accessReview.listCycles`. */
type CycleRow = {
  _id: Id<"accessReviewCycles">;
  title: string;
  dueAt: number;
  status: string;
  decidedCount: number;
  itemCount: number;
  captureScanComplete: boolean;
  overdue: boolean;
};

type CyclePage = {
  rows: CycleRow[];
  continueCursor: string;
  isDone: boolean;
};

export function AdminAccessReviewsPage() {
  const session = useQuery(api.session.getSession);
  // Cursor pagination: the newest page is live; older pages are appended when
  // the user asks for them, so every historical cycle stays reachable without
  // reading the whole history in one query execution.
  const [cursor, setCursor] = useState<string | null>(null);
  const [olderRows, setOlderRows] = useState<CycleRow[]>([]);
  const page = useQuery(
    api.accessReview.listCycles,
    cursor ? { cursor } : {},
  ) as CyclePage | undefined;
  const cycles = useMemo(() => {
    if (!page) return undefined;
    const byId = new Map<string, CycleRow>();
    for (const row of [...olderRows, ...page.rows]) byId.set(row._id, row);
    return [...byId.values()];
  }, [page, olderRows]);
  const [selectedId, setSelectedId] = useState<Id<"accessReviewCycles"> | null>(
    null,
  );
  const canManage = session?.permissions?.adminManage === true;

  const activeSelection = useMemo(() => {
    if (!cycles || cycles.length === 0) return null;
    const match = cycles.find((c) => c._id === selectedId);
    return match ?? cycles[0];
  }, [cycles, selectedId]);

  return (
    <AdminPageShell
      path="/admin/access-reviews"
      title="Access Reviews"
      description="Periodic recertification of organization access. Snapshot the reviewed memberships, record reviewer decisions, and apply remediation only through the existing authorized role and membership workflows."
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="max-w-2xl text-sm text-muted-foreground">
            A review snapshot is evidence: it keeps the role and membership
            status seen at capture time even after later changes. Reviewer
            identity, notes and timestamps are recorded for every decision, and
            no reviewer can certify their own administrator access.
          </p>
          <NewCycleDialog disabled={!canManage} />
        </div>

        {!canManage && session !== undefined && (
          <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
            Your role can read reviews but not record decisions. Recording
            requires the <code>admin.manage</code> permission.
          </p>
        )}

        {cycles === undefined ? (
          <ListSkeleton rows={5} />
        ) : cycles.length === 0 ? (
          <EmptyState
            icon={ClipboardList}
            title="No access reviews yet"
            description="Create a review cycle to snapshot current memberships and start recertification. Cycles are scoped to your organization."
          />
        ) : (
          <div className="grid gap-4 lg:grid-cols-[320px_1fr]">
            <nav aria-label="Review cycles" className="space-y-2">
              {cycles.map((cycle) => {
                const selected = activeSelection?._id === cycle._id;
                return (
                  <button
                    key={cycle._id}
                    type="button"
                    onClick={() => setSelectedId(cycle._id)}
                    aria-current={selected ? "true" : undefined}
                    className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${
                      selected
                        ? "border-primary/40 bg-primary/5"
                        : "border-border bg-card hover:bg-accent/40"
                    }`}
                  >
                    <span className="flex items-start justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {cycle.title}
                      </span>
                      <StatusChip status={cycle.status} />
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      {cycle.decidedCount}/{cycle.itemCount} decided ·{" "}
                      {formatDate(cycle.dueAt)} ({formatRelative(cycle.dueAt)})
                    </span>
                    {!cycle.captureScanComplete && (
                      <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-warning">
                        <AlertTriangle className="size-3" aria-hidden />
                        Capture incomplete
                      </span>
                    )}
                    {cycle.overdue && (
                      <span className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-critical">
                        <AlertTriangle className="size-3" aria-hidden />
                        Overdue
                      </span>
                    )}
                  </button>
                );
              })}
              {page && !page.isDone && (
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => {
                    setOlderRows((prev) => [...prev, ...page.rows]);
                    setCursor(page.continueCursor);
                  }}
                >
                  Load older cycles
                </Button>
              )}
            </nav>

            {activeSelection && (
              <CycleDetail
                key={activeSelection._id}
                cycleId={activeSelection._id}
                canManage={canManage}
                currentUserId={session?.userId ?? null}
              />
            )}
          </div>
        )}
      </div>
    </AdminPageShell>
  );
}
