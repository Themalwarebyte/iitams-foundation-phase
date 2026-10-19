import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { roleHasPermission } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  COMPLIANCE_FINDING_SEVERITIES,
  COMPLIANCE_FINDING_SEVERITY_LABELS,
  COMPLIANCE_FINDING_SEVERITY_RANK,
  COMPLIANCE_FINDING_STATUS_LABELS,
  COMPLIANCE_REMEDIATION_STATUS_LABELS,
  FINDING_CLOSURE_NOTES_MAX,
  FINDING_DESCRIPTION_MIN,
  FINDING_DESCRIPTION_MAX,
  FINDING_EXCEPTION_MIN,
  FINDING_GAP_MAX,
  FINDING_REOPEN_REASON_MAX,
  FINDING_REQUIREMENT_MAX,
  FINDING_TEXT_MAX,
  FINDING_TITLE_MAX,
  REMEDIATION_DESCRIPTION_MAX,
  REMEDIATION_DESCRIPTION_MIN,
  REMEDIATION_NOTES_MAX,
  REMEDIATION_REASON_MAX,
  canIndependentlyVerify,
  canTransitionFinding,
  canTransitionRemediation,
  complianceFindingSeverityValidator,
  complianceFindingStatusValidator,
  isRemediationComplete,
  isRemediationOverdue,
  isRemediationResolved,
  type ComplianceFindingStatus,
  type ComplianceRemediationStatus,
} from "../lib/compliance";

/**
 * Phase 3C — Batch 4: compliance findings, gaps and remediation tracking.
 * =====================================================================
 * Design decisions that matter for security and for an honest result:
 *
 *  - A finding is a person's record of a compliance GAP. Nothing here creates
 *    one automatically: a control assessed partially compliant or non-compliant
 *    does not become a finding, and no assessed outcome is ever converted into
 *    a verified finding by this module.
 *  - Remediation is tracked as separate actions with an explicit line between
 *    RECOMMENDED work (`recommendation` on the finding), ASSIGNED work (an
 *    action with an owner and due date), work an implementer COMPLETED
 *    (`completed`) and work an independent verifier VERIFIED (`verified`).
 *    Completing an action never verifies it.
 *  - Closing requires either independent verification of every mandatory
 *    action, or a documented exception — and no finding closes while a
 *    mandatory action is still outstanding. The implementer of an action can
 *    never record its verification or sign off the closure that depends on it.
 *  - Reopening a finding or failing a verification keeps the earlier state in
 *    an append-only history (`complianceFindingEvents`); nothing is deleted.
 *
 * Authorization: `compliance.view` for every read, `compliance.manage` plus an
 * active membership for every write. The organization always comes from the
 * server-side access context, and every framework, control, assessment, item,
 * test, evidence and member id is re-validated against it — a foreign id is
 * indistinguishable from a missing one.
 */

const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
const FINDING_LIST_LIMIT = 200;
const ACTION_LIST_LIMIT = 300;
const EVENT_LIST_LIMIT = 200;
const CONTROL_LIST_LIMIT = 300;
const ASSESSMENT_LIST_LIMIT = 200;
const ITEM_LIST_LIMIT = 300;
const EVIDENCE_LIST_LIMIT = 200;
const TEST_LIST_LIMIT = 200;

interface FindingAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
  canManage: boolean;
}

async function resolveAccess(
  ctx: QueryCtx | MutationCtx,
): Promise<FindingAccess> {
  const access = await requirePermission(ctx, "compliance.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage:
      access.isProvisioned && roleHasPermission(access.role, "compliance.manage"),
  };
}

async function requireManager(ctx: MutationCtx): Promise<FindingAccess> {
  const access = await requirePermission(ctx, "compliance.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage: true,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireText(value: string, field: string, max: number, min = 1): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < min) {
    throw new Error(`${field} must be at least ${min} characters`);
  }
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function requireNarrative(
  value: string,
  field: string,
  max: number,
  min = 1,
): string {
  const cleaned = value.trim();
  if (cleaned.length < min) {
    throw new Error(`${field} must be at least ${min} characters`);
  }
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalDate(value: number | undefined, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${field} must be a valid date`);
  return Math.floor(value);
}

async function requireFinding(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  findingId: Id<"complianceFindings">,
): Promise<Doc<"complianceFindings">> {
  const finding = await ctx.db.get(findingId);
  if (!finding || finding.organizationId !== organizationId) {
    throw new Error("Finding not found in your organization");
  }
  return finding;
}

async function requireAction(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  actionId: Id<"complianceRemediationActions">,
): Promise<Doc<"complianceRemediationActions">> {
  const action = await ctx.db.get(actionId);
  if (!action || action.organizationId !== organizationId) {
    throw new Error("Remediation action not found in your organization");
  }
  return action;
}

async function requireOwnedFramework(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  frameworkId: Id<"complianceFrameworks">,
): Promise<Doc<"complianceFrameworks">> {
  const framework = await ctx.db.get(frameworkId);
  if (!framework || framework.organizationId !== organizationId) {
    throw new Error("Framework not found in your organization");
  }
  return framework;
}

/** The named owner must be an ACTIVE member of the same organization. */
async function resolveMemberLabel(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users"> | undefined,
  fallbackLabel: string,
  field: string,
): Promise<string> {
  if (userId === undefined) return fallbackLabel;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .unique();
  if (
    !profile ||
    profile.organizationId !== organizationId ||
    effectiveMembershipStatus(profile.membershipStatus) !== "active"
  ) {
    throw new Error(`${field} is not an active member of your organization`);
  }
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? fallbackLabel;
}

/** Evidence ids must exist in this organization and belong to the control. */
async function validateEvidenceIds(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  controlId: Id<"controls"> | undefined,
  evidenceIds: Id<"complianceEvidence">[] | undefined,
): Promise<Id<"complianceEvidence">[]> {
  if (!evidenceIds || evidenceIds.length === 0) return [];
  const unique = [...new Set(evidenceIds.map(String))] as Id<"complianceEvidence">[];
  for (const evidenceId of unique) {
    const record = await ctx.db.get(evidenceId);
    if (!record || record.organizationId !== organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (controlId !== undefined && record.controlId !== controlId) {
      throw new Error(
        "Evidence can only be referenced when it belongs to this control and organization",
      );
    }
  }
  return unique;
}

/** Referenced control tests must belong to THIS control and organization. */
async function validateTestIds(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  controlId: Id<"controls"> | undefined,
  testIds: Id<"complianceControlTests">[] | undefined,
): Promise<Id<"complianceControlTests">[]> {
  if (!testIds || testIds.length === 0) return [];
  const unique = [...new Set(testIds.map(String))] as Id<"complianceControlTests">[];
  for (const testId of unique) {
    const test = await ctx.db.get(testId);
    if (!test || test.organizationId !== organizationId) {
      throw new Error("Control test not found in your organization");
    }
    if (controlId !== undefined && test.controlId !== controlId) {
      throw new Error(
        "A control test can only be referenced when it belongs to this control and organization",
      );
    }
  }
  return unique;
}

async function nextReference(
  ctx: MutationCtx,
  table: "complianceFindings" | "complianceRemediationActions",
  organizationId: Id<"organizations">,
  prefix: string,
): Promise<string> {
  const rows =
    table === "complianceFindings"
      ? await ctx.db
          .query("complianceFindings")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .take(FINDING_LIST_LIMIT)
      : await ctx.db
          .query("complianceRemediationActions")
          .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
          .take(ACTION_LIST_LIMIT);
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const row of rows) {
    const match = pattern.exec(row.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

type ActionRollup = {
  total: number;
  outstanding: number;
  mandatoryOutstanding: number;
  completedUnverified: number;
  verified: number;
  overdue: number;
};

function rollupActions(
  actions: Doc<"complianceRemediationActions">[],
  now: number,
): ActionRollup {
  const rollup: ActionRollup = {
    total: actions.length,
    outstanding: 0,
    mandatoryOutstanding: 0,
    completedUnverified: 0,
    verified: 0,
    overdue: 0,
  };
  for (const action of actions) {
    if (!isRemediationComplete(action.status) && action.status !== "cancelled") {
      rollup.outstanding += 1;
    }
    if (action.mandatory && !isRemediationComplete(action.status)) {
      rollup.mandatoryOutstanding += 1;
    }
    if (action.status === "completed") rollup.completedUnverified += 1;
    if (action.status === "verified") rollup.verified += 1;
    if (isRemediationOverdue(action.dueDate, action.status, now)) {
      rollup.overdue += 1;
    }
  }
  return rollup;
}

function presentAction(
  action: Doc<"complianceRemediationActions">,
  now: number,
) {
  return {
    _id: action._id,
    findingId: action.findingId,
    reference: action.reference,
    description: action.description,
    ownerUserId: action.ownerUserId ?? null,
    ownerLabel: action.ownerLabel,
    dueDate: action.dueDate ?? null,
    mandatory: action.mandatory,
    status: action.status,
    statusLabel: COMPLIANCE_REMEDIATION_STATUS_LABELS[action.status],
    progressNotes: action.progressNotes ?? null,
    evidenceIds: (action.evidenceIds ?? []).map(String),
    completionNotes: action.completionNotes ?? null,
    completedAt: action.completedAt ?? null,
    completedByLabel: action.completedByLabel ?? null,
    verificationNotes: action.verificationNotes ?? null,
    verifiedAt: action.verifiedAt ?? null,
    verifiedByLabel: action.verifiedByLabel ?? null,
    cancelledAt: action.cancelledAt ?? null,
    cancelReason: action.cancelReason ?? null,
    /** Derived server-side; never stored (it changes with the clock). */
    overdue: isRemediationOverdue(action.dueDate, action.status, now),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function presentFinding(
  finding: Doc<"complianceFindings">,
  actions: Doc<"complianceRemediationActions">[],
  now: number,
) {
  return {
    _id: finding._id,
    reference: finding.reference,
    title: finding.title,
    description: finding.description,
    gap: finding.gap ?? null,
    requirement: finding.requirement ?? null,
    rootCause: finding.rootCause ?? null,
    recommendation: finding.recommendation ?? null,
    severity: finding.severity,
    severityLabel: COMPLIANCE_FINDING_SEVERITY_LABELS[finding.severity],
    status: finding.status,
    statusLabel: COMPLIANCE_FINDING_STATUS_LABELS[finding.status],
    frameworkId: finding.frameworkId,
    controlId: finding.controlId ?? null,
    assessmentId: finding.assessmentId ?? null,
    assessmentItemId: finding.assessmentItemId ?? null,
    controlTestIds: (finding.controlTestIds ?? []).map(String),
    evidenceIds: (finding.evidenceIds ?? []).map(String),
    ownerUserId: finding.ownerUserId ?? null,
    ownerLabel: finding.ownerLabel,
    identifiedAt: finding.identifiedAt,
    targetDate: finding.targetDate ?? null,
    recordedByLabel: finding.recordedByLabel,
    submittedAt: finding.submittedAt ?? null,
    submittedByLabel: finding.submittedByLabel ?? null,
    closureMethod: finding.closureMethod ?? null,
    closureNotes: finding.closureNotes ?? null,
    closedAt: finding.closedAt ?? null,
    closedByLabel: finding.closedByLabel ?? null,
    reopenCount: finding.reopenCount,
    open: finding.status !== "closed",
    /** Overdue when the target date has passed and the finding is still open. */
    overdue:
      finding.status !== "closed" &&
      finding.targetDate !== undefined &&
      finding.targetDate < now,
    actions: rollupActions(actions, now),
    createdAt: finding.createdAt,
    updatedAt: finding.updatedAt,
  };
}

function presentEvent(event: Doc<"complianceFindingEvents">) {
  return {
    _id: event._id,
    type: event.type,
    actionId: event.actionId ? String(event.actionId) : null,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    actorLabel: event.actorLabel,
    summary: event.summary,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
  };
}

/**
 * Append one history row. The history is the record of what happened to a
 * finding (including failed verification attempts and reopenings) and is never
 * rewritten or deleted.
 */
async function recordEvent(
  ctx: MutationCtx,
  args: {
    organizationId: Id<"organizations">;
    findingId: Id<"complianceFindings">;
    actionId?: Id<"complianceRemediationActions">;
    type: string;
    fromStatus?: string;
    toStatus?: string;
    actorUserId: Id<"users">;
    actorLabel: string;
    summary: string;
    reason?: string;
  },
): Promise<void> {
  await ctx.db.insert("complianceFindingEvents", {
    organizationId: args.organizationId,
    findingId: args.findingId,
    actionId: args.actionId,
    type: args.type,
    fromStatus: args.fromStatus,
    toStatus: args.toStatus,
    actorUserId: args.actorUserId,
    actorLabel: args.actorLabel,
    summary: args.summary,
    reason: args.reason,
    createdAt: Date.now(),
  });
}

/** Closure gates, computed from real action records. */
function closureState(
  finding: Doc<"complianceFindings">,
  actions: Doc<"complianceRemediationActions">[],
  userId: Id<"users">,
) {
  const mandatoryOutstanding = actions.filter(
    (a) => a.mandatory && !isRemediationComplete(a.status),
  );
  const mandatoryUnverified = actions.filter(
    (a) => a.mandatory && a.status !== "verified",
  );
  const hasEvidence = (finding.evidenceIds ?? []).length > 0;
  const separatorViolation =
    !canIndependentlyVerify(userId, { ownerUserId: finding.ownerUserId }) ||
    actions.some(
      (a) =>
        isRemediationComplete(a.status) &&
        !canIndependentlyVerify(userId, {
          ownerUserId: a.ownerUserId,
          completedByUserId: a.completedByUserId,
        }),
    );

  const submitBlockedReason =
    finding.status === "closed"
      ? "This finding is closed — reopen it before submitting it for verification."
      : finding.status === "awaiting_verification"
        ? "This finding is already awaiting verification."
        : actions.length === 0
          ? "Record at least one remediation action before submitting the finding for verification."
          : mandatoryOutstanding.length > 0
            ? `${mandatoryOutstanding.length} mandatory action(s) are not complete yet.`
            : null;

  const closeBlockedReason =
    finding.status === "closed"
      ? "This finding is already closed."
      : !canTransitionFinding(finding.status, "closed")
        ? "Submit the finding for verification before closing it."
        : mandatoryOutstanding.length > 0
          ? `${mandatoryOutstanding.length} mandatory action(s) must be complete before the finding can be closed.`
          : separatorViolation
            ? "Independent verification must be recorded by someone other than the owner or the implementer of the remediation."
            : mandatoryUnverified.length > 0
              ? `${mandatoryUnverified.length} mandatory action(s) are only complete, not independently verified — verify them, or close with a documented exception.`
              : !hasEvidence && actions.filter((a) => a.status === "verified").length === 0
                ? "Record verification evidence (a verified action, or at least one linked evidence record) before closing as verified."
                : null;

  const exceptionBlockedReason =
    finding.status === "closed"
      ? "This finding is already closed."
      : !canTransitionFinding(finding.status, "closed")
        ? "Submit the finding for verification before closing it."
        : mandatoryOutstanding.length > 0
          ? `${mandatoryOutstanding.length} mandatory action(s) must be complete before the finding can be closed.`
          : null;

  return {
    canSubmit: submitBlockedReason === null,
    submitBlockedReason,
    canClose: closeBlockedReason === null,
    closeBlockedReason,
    canCloseWithException: exceptionBlockedReason === null,
    exceptionBlockedReason,
    canReopen: finding.status === "closed" && canTransitionFinding("closed", "in_remediation"),
    canAddActions: finding.status !== "closed",
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Findings, newest and most severe first, cursor-paginated over the
 * organization index. Filters (severity, status, framework, control) are
 * applied to the page that was read, and the counts below the table come from
 * the same bounded scan the assessment module uses — no unbounded collection.
 */
export const listFindings = query({
  args: {
    severity: v.optional(complianceFindingSeverityValidator),
    status: v.optional(complianceFindingStatusValidator),
    frameworkId: v.optional(v.id("complianceFrameworks")),
    controlId: v.optional(v.id("controls")),
    overdueOnly: v.optional(v.boolean()),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const now = Date.now();
    const requested = args.numItems ?? PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(
        Number.isFinite(requested) ? Math.floor(requested) : PAGE_DEFAULT,
        1,
      ),
      PAGE_MAX,
    );

    // A foreign framework/control id discloses nothing.
    if (args.frameworkId) {
      const framework = await ctx.db.get(args.frameworkId);
      if (!framework || framework.organizationId !== access.organizationId) {
        return { rows: [], continueCursor: "", isDone: true, summary: null };
      }
    }
    if (args.controlId) {
      const control = await ctx.db.get(args.controlId);
      if (!control || control.organizationId !== access.organizationId) {
        return { rows: [], continueCursor: "", isDone: true, summary: null };
      }
    }

    const page = await ctx.db
      .query("complianceFindings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .order("desc")
      .paginate({ numItems, cursor: args.cursor ?? null });

    const search = args.search?.trim().toLowerCase();
    const rows: ReturnType<typeof presentFinding>[] = [];
    for (const finding of page.page) {
      if (args.severity && finding.severity !== args.severity) continue;
      if (args.status && finding.status !== args.status) continue;
      if (args.frameworkId && finding.frameworkId !== args.frameworkId) continue;
      if (args.controlId && finding.controlId !== args.controlId) continue;
      if (search) {
        const haystack = [
          finding.reference,
          finding.title,
          finding.description,
          finding.gap,
          finding.requirement,
          finding.rootCause,
          finding.recommendation,
          finding.ownerLabel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      const actions = await ctx.db
        .query("complianceRemediationActions")
        .withIndex("by_organization_finding", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("findingId", finding._id),
        )
        .take(ACTION_LIST_LIMIT);
      if (args.overdueOnly && !isFindingOverdue(finding, actions, now)) continue;
      rows.push(presentFinding(finding, actions, now));
    }

    // Severity-first ordering within the page that was read (the register is
    // worked most-severe-first; the cursor still walks newest-first).
    rows.sort(
      (a, b) =>
        COMPLIANCE_FINDING_SEVERITY_RANK[a.severity] -
          COMPLIANCE_FINDING_SEVERITY_RANK[b.severity] || b.createdAt - a.createdAt,
    );

    // Organization-wide counts (bounded scan, reported as counts of records).
    const scanned = await ctx.db
      .query("complianceFindings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(FINDING_LIST_LIMIT);
    const scannedActions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(ACTION_LIST_LIMIT);

    const bySeverity: Record<string, number> = {};
    for (const severity of COMPLIANCE_FINDING_SEVERITIES) bySeverity[severity] = 0;
    let open = 0;
    let awaitingVerification = 0;
    let closed = 0;
    let overdueFindings = 0;
    for (const finding of scanned) {
      bySeverity[finding.severity] = (bySeverity[finding.severity] ?? 0) + 1;
      if (finding.status === "closed") {
        closed += 1;
      } else {
        open += 1;
        if (
          finding.targetDate !== undefined &&
          finding.targetDate < now
        ) {
          overdueFindings += 1;
        }
      }
      if (finding.status === "awaiting_verification") awaitingVerification += 1;
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      summary: {
        total: scanned.length,
        open,
        awaitingVerification,
        closed,
        overdueFindings,
        overdueActions: scannedActions.filter((a) =>
          isRemediationOverdue(a.dueDate, a.status, now),
        ).length,
        bySeverity,
      },
    };
  },
});

/** Overdue = target date passed while the finding is still open. */
function isFindingOverdue(
  finding: Doc<"complianceFindings">,
  _actions: Doc<"complianceRemediationActions">[],
  now: number,
): boolean {
  return (
    finding.status !== "closed" &&
    finding.targetDate !== undefined &&
    finding.targetDate < now
  );
}

/** One finding with its framework/control links, actions and history. */
export const getFinding = query({
  args: { findingId: v.id("complianceFindings") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const now = Date.now();
    const finding = await ctx.db.get(args.findingId);
    if (!finding || finding.organizationId !== access.organizationId) {
      return null;
    }
    const framework = await ctx.db.get(finding.frameworkId);
    if (!framework || framework.organizationId !== access.organizationId) {
      return null;
    }
    let control = null;
    if (finding.controlId) {
      const record = await ctx.db.get(finding.controlId);
      if (record && record.organizationId === access.organizationId) {
        control = {
          _id: record._id,
          code: record.code,
          name: record.name,
        };
      }
    }
    let assessment = null;
    if (finding.assessmentId) {
      const record = await ctx.db.get(finding.assessmentId);
      if (record && record.organizationId === access.organizationId) {
        assessment = { _id: record._id, reference: record.reference };
      }
    }
    let assessmentItem = null;
    if (finding.assessmentItemId) {
      const record = await ctx.db.get(finding.assessmentItemId);
      if (
        record &&
        record.organizationId === access.organizationId &&
        record.assessmentId === finding.assessmentId
      ) {
        assessmentItem = {
          _id: record._id,
          controlId: String(record.controlId),
          controlCode: record.controlSnapshot.code,
          outcome: record.outcome,
        };
      }
    }

    const actions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization_finding", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("findingId", finding._id),
      )
      .take(ACTION_LIST_LIMIT);
    const events = await ctx.db
      .query("complianceFindingEvents")
      .withIndex("by_organization_finding", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("findingId", finding._id),
      )
      .order("desc")
      .take(EVENT_LIST_LIMIT);

    return {
      ...presentFinding(finding, actions, now),
      framework: {
        _id: framework._id,
        code: framework.code,
        name: framework.name,
      },
      control,
      assessment,
      assessmentItem,
      actionRows: actions
        .slice()
        .sort((a, b) => a.reference.localeCompare(b.reference))
        .map((action) => ({
          ...presentAction(action, now),
          /** Whether THIS caller may verify the action (separation of duties). */
          canVerify:
            action.status === "completed" &&
            canIndependentlyVerify(access.userId, {
              ownerUserId: action.ownerUserId,
              completedByUserId: action.completedByUserId,
            }),
        })),
      history: events.map(presentEvent),
      canManage: access.canManage,
      gates: closureState(finding, actions, access.userId),
    };
  },
});

/** Organization-wide finding counts (a bounded scan of real records). */
export const findingsSummary = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const now = Date.now();
    const findings = await ctx.db
      .query("complianceFindings")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(FINDING_LIST_LIMIT);
    const actions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(ACTION_LIST_LIMIT);

    const bySeverity: Record<string, number> = {};
    for (const severity of COMPLIANCE_FINDING_SEVERITIES) bySeverity[severity] = 0;
    let open = 0;
    let awaitingVerification = 0;
    let closed = 0;
    let overdue = 0;
    for (const finding of findings) {
      bySeverity[finding.severity] += 1;
      if (finding.status === "closed") closed += 1;
      else open += 1;
      if (finding.status === "awaiting_verification") awaitingVerification += 1;
      if (
        finding.status !== "closed" &&
        finding.targetDate !== undefined &&
        finding.targetDate < now
      ) {
        overdue += 1;
      }
    }
    const paidActions = actions.filter((a) => isRemediationResolved(a.status));

    return {
      findings: findings.length,
      open,
      awaitingVerification,
      closed,
      overdue,
      actions: actions.length,
      actionsOutstanding: actions.length - paidActions.length,
      actionsOverdue: actions.filter((a) =>
        isRemediationOverdue(a.dueDate, a.status, now),
      ).length,
      bySeverity,
      /**
       * Deliberately absent: any "remediation rate" or compliance percentage.
       * The denominator (what counts as a gap, and over which population) is
       * not defined here, so no such figure is invented.
       */
    };
  },
});

/**
 * Link options for the finding form: the controls, assessments, control tests
 * and evidence records a finding in this framework may reference. Everything is
 * organization-scoped and bounded.
 */
export const findingReferences = query({
  args: {
    frameworkId: v.id("complianceFrameworks"),
    controlId: v.optional(v.id("controls")),
  },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const framework = await ctx.db.get(args.frameworkId);
    if (!framework || framework.organizationId !== access.organizationId) {
      return { controls: [], assessments: [], tests: [], evidence: [] };
    }
    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization_framework", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("frameworkId", framework._id),
      )
      .take(CONTROL_LIST_LIMIT);
    const assessments = await ctx.db
      .query("complianceAssessments")
      .withIndex("by_organization_framework", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("frameworkId", framework._id),
      )
      .take(ASSESSMENT_LIST_LIMIT);

    let tests: Array<Record<string, unknown>> = [];
    let evidence: Array<Record<string, unknown>> = [];
    if (args.controlId) {
      const control = await ctx.db.get(args.controlId);
      if (
        !control ||
        control.organizationId !== access.organizationId ||
        control.frameworkId !== framework._id
      ) {
        return {
          controls: controls.map((c) => ({ _id: c._id, code: c.code, name: c.name })),
          assessments: assessments.map((a) => ({
            _id: a._id,
            reference: a.reference,
            title: a.title,
            status: a.status,
          })),
          tests: [],
          evidence: [],
        };
      }
      const testRows = await ctx.db
        .query("complianceControlTests")
        .withIndex("by_organization_control", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("controlId", control._id),
        )
        .take(TEST_LIST_LIMIT);
      tests = testRows.map((test) => ({
        _id: String(test._id),
        reference: test.reference,
        title: test.title,
        status: test.status,
        outcome: test.outcome,
      }));
      const evidenceRows = await ctx.db
        .query("complianceEvidence")
        .withIndex("by_organization_control", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("controlId", control._id),
        )
        .take(EVIDENCE_LIST_LIMIT);
      evidence = evidenceRows.map((record) => ({
        _id: String(record._id),
        filename: record.filename,
        classification: record.classification,
        integrity: record.integrity,
        selectable: record.classification !== "restricted" || access.canManage,
      }));
    }

    return {
      controls: controls.map((c) => ({ _id: c._id, code: c.code, name: c.name })),
      assessments: assessments.map((a) => ({
        _id: a._id,
        reference: a.reference,
        title: a.title,
        status: a.status,
      })),
      tests,
      evidence,
    };
  },
});

/** Assessment items of one cycle, so a finding can cite what it arose from. */
export const findingAssessmentItems = query({
  args: { assessmentId: v.id("complianceAssessments") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const assessment = await ctx.db.get(args.assessmentId);
    if (!assessment || assessment.organizationId !== access.organizationId) {
      return [];
    }
    const items = await ctx.db
      .query("complianceAssessmentItems")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", assessment._id),
      )
      .take(ITEM_LIST_LIMIT);
    return items.map((item) => ({
      _id: item._id,
      controlId: String(item.controlId),
      controlCode: item.controlSnapshot.code,
      controlTitle: item.controlSnapshot.title,
      outcome: item.outcome,
    }));
  },
});

// ---------------------------------------------------------------------------
// Writes — findings
// ---------------------------------------------------------------------------

/**
 * Record a finding. Created only by an authorized person, never automatically
 * from an assessment outcome; a partially or non-compliant control leaves the
 * finding register untouched until someone records a gap.
 */
export const createFinding = mutation({
  args: {
    title: v.string(),
    description: v.string(),
    gap: v.optional(v.string()),
    requirement: v.optional(v.string()),
    rootCause: v.optional(v.string()),
    recommendation: v.optional(v.string()),
    severity: complianceFindingSeverityValidator,
    frameworkId: v.id("complianceFrameworks"),
    controlId: v.optional(v.id("controls")),
    assessmentId: v.optional(v.id("complianceAssessments")),
    assessmentItemId: v.optional(v.id("complianceAssessmentItems")),
    controlTestIds: v.optional(v.array(v.id("complianceControlTests"))),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
    ownerUserId: v.optional(v.id("users")),
    identifiedAt: v.optional(v.number()),
    targetDate: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const framework = await requireOwnedFramework(
      ctx,
      manager.organizationId,
      args.frameworkId,
    );
    const title = requireText(args.title, "Finding title", FINDING_TITLE_MAX);
    const description = requireNarrative(
      args.description,
      "Finding description",
      FINDING_DESCRIPTION_MAX,
      FINDING_DESCRIPTION_MIN,
    );
    const gap = optionalText(args.gap, "Compliance gap", FINDING_GAP_MAX);
    const requirement = optionalText(
      args.requirement,
      "Related requirement",
      FINDING_REQUIREMENT_MAX,
    );
    const rootCause = optionalText(args.rootCause, "Root cause", FINDING_TEXT_MAX);
    const recommendation = optionalText(
      args.recommendation,
      "Recommendation",
      FINDING_TEXT_MAX,
    );
    const identifiedAt = optionalDate(args.identifiedAt, "Identified date") ?? Date.now();
    const targetDate = optionalDate(args.targetDate, "Target remediation date");
    if (targetDate !== undefined && targetDate < identifiedAt) {
      throw new Error("The target remediation date cannot precede the date identified");
    }

    // Control must belong to this organization AND this framework.
    let controlId: Id<"controls"> | undefined;
    if (args.controlId) {
      const control = await ctx.db.get(args.controlId);
      if (
        !control ||
        control.organizationId !== manager.organizationId ||
        control.frameworkId !== framework._id
      ) {
        throw new Error("Control not found in this framework and organization");
      }
      controlId = control._id;
    }

    // The assessment cycle and item must belong to the organization, and the
    // item must belong to that cycle (and to the same control, when one is set).
    let assessmentId: Id<"complianceAssessments"> | undefined;
    let assessmentItemId: Id<"complianceAssessmentItems"> | undefined;
    if (args.assessmentId) {
      const assessment = await ctx.db.get(args.assessmentId);
      if (
        !assessment ||
        assessment.organizationId !== manager.organizationId ||
        assessment.frameworkId !== framework._id
      ) {
        throw new Error("Assessment not found in this framework and organization");
      }
      assessmentId = assessment._id;
    }
    if (args.assessmentItemId) {
      const item = await ctx.db.get(args.assessmentItemId);
      if (!item || item.organizationId !== manager.organizationId) {
        throw new Error("Assessment item not found in your organization");
      }
      if (assessmentId === undefined || item.assessmentId !== assessmentId) {
        throw new Error("The assessment item does not belong to that assessment");
      }
      if (controlId !== undefined && item.controlId !== controlId) {
        throw new Error("The assessment item does not assess the referenced control");
      }
      if (controlId === undefined) {
        controlId = item.controlId;
      }
      assessmentItemId = item._id;
    }

    const controlTestIds = await validateTestIds(
      ctx,
      manager.organizationId,
      controlId,
      args.controlTestIds,
    );
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      controlId,
      args.evidenceIds,
    );
    const ownerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      manager.label,
      "Owner",
    );

    const reference = await nextReference(
      ctx,
      "complianceFindings",
      manager.organizationId,
      "CF",
    );
    const now = Date.now();
    const findingId = await ctx.db.insert("complianceFindings", {
      organizationId: manager.organizationId,
      reference,
      title,
      description,
      gap,
      requirement,
      rootCause,
      recommendation,
      severity: args.severity,
      status: "open",
      frameworkId: framework._id,
      controlId,
      assessmentId,
      assessmentItemId,
      controlTestIds: controlTestIds.length > 0 ? controlTestIds : undefined,
      evidenceIds: evidenceIds.length > 0 ? evidenceIds : undefined,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      identifiedAt,
      targetDate,
      recordedByUserId: manager.userId,
      recordedByLabel: manager.label,
      reopenCount: 0,
      createdAt: now,
      updatedAt: now,
    });

    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId,
      type: "created",
      toStatus: "open",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Finding ${reference} recorded (${COMPLIANCE_FINDING_SEVERITY_LABELS[args.severity]})`,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.finding_created",
      entityType: "complianceFindings",
      entityId: String(findingId),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(framework._id),
      summary: `Finding ${reference} recorded against ${framework.code}: ${title}`,
    });

    return { findingId, reference };
  },
});

/** Edit an open finding. A closed finding is reopened before it is edited. */
export const updateFinding = mutation({
  args: {
    findingId: v.id("complianceFindings"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    gap: v.optional(v.string()),
    requirement: v.optional(v.string()),
    rootCause: v.optional(v.string()),
    recommendation: v.optional(v.string()),
    severity: v.optional(complianceFindingSeverityValidator),
    ownerUserId: v.optional(v.id("users")),
    identifiedAt: v.optional(v.number()),
    targetDate: v.optional(v.number()),
    controlTestIds: v.optional(v.array(v.id("complianceControlTests"))),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      args.findingId,
    );
    if (finding.status === "closed") {
      throw new Error(
        "A closed finding cannot be edited — reopen it to record further work",
      );
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const changes: string[] = [];
    if (args.title !== undefined) {
      patch.title = requireText(args.title, "Finding title", FINDING_TITLE_MAX);
      changes.push("title");
    }
    if (args.description !== undefined) {
      patch.description = requireNarrative(
        args.description,
        "Finding description",
        FINDING_DESCRIPTION_MAX,
        FINDING_DESCRIPTION_MIN,
      );
      changes.push("description");
    }
    if (args.gap !== undefined) {
      patch.gap = optionalText(args.gap, "Compliance gap", FINDING_GAP_MAX);
      changes.push("gap");
    }
    if (args.requirement !== undefined) {
      patch.requirement = optionalText(
        args.requirement,
        "Related requirement",
        FINDING_REQUIREMENT_MAX,
      );
      changes.push("requirement");
    }
    if (args.rootCause !== undefined) {
      patch.rootCause = optionalText(args.rootCause, "Root cause", FINDING_TEXT_MAX);
      changes.push("root cause");
    }
    if (args.recommendation !== undefined) {
      patch.recommendation = optionalText(
        args.recommendation,
        "Recommendation",
        FINDING_TEXT_MAX,
      );
      changes.push("recommendation");
    }
    if (args.severity !== undefined) {
      patch.severity = args.severity;
      changes.push("severity");
    }
    if (args.identifiedAt !== undefined) {
      patch.identifiedAt = optionalDate(args.identifiedAt, "Identified date");
      changes.push("identified date");
    }
    if (args.targetDate !== undefined) {
      patch.targetDate = optionalDate(args.targetDate, "Target remediation date");
      changes.push("target date");
    }
    if (args.ownerUserId !== undefined) {
      patch.ownerUserId = args.ownerUserId;
      patch.ownerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.ownerUserId,
        manager.label,
        "Owner",
      );
      changes.push("owner");
    }
    if (args.controlTestIds !== undefined) {
      const ids = await validateTestIds(
        ctx,
        manager.organizationId,
        finding.controlId,
        args.controlTestIds,
      );
      patch.controlTestIds = ids.length > 0 ? ids : undefined;
      changes.push("control tests");
    }
    if (args.evidenceIds !== undefined) {
      const ids = await validateEvidenceIds(
        ctx,
        manager.organizationId,
        finding.controlId,
        args.evidenceIds,
      );
      patch.evidenceIds = ids.length > 0 ? ids : undefined;
      changes.push("evidence");
    }
    const identifiedAt = (patch.identifiedAt as number | undefined) ?? finding.identifiedAt;
    const targetDate = (patch.targetDate as number | undefined) ?? finding.targetDate;
    if (targetDate !== undefined && targetDate < identifiedAt) {
      throw new Error("The target remediation date cannot precede the date identified");
    }

    await ctx.db.patch(finding._id, patch);
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      type: "updated",
      fromStatus: finding.status,
      toStatus: finding.status,
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Finding updated: ${changes.length > 0 ? changes.join(", ") : "no fields"}`,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.finding_updated",
      entityType: "complianceFindings",
      entityId: String(finding._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(finding.frameworkId),
      summary: `Finding ${finding.reference} updated: ${
        changes.length > 0 ? changes.join(", ") : "no fields"
      }`,
    });
    return { ok: true as const };
  },
});

/**
 * Submit the finding for verification. Refused while a mandatory action is
 * outstanding, so "done" is never claimed over unfinished work.
 */
export const submitFindingForVerification = mutation({
  args: {
    findingId: v.id("complianceFindings"),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      args.findingId,
    );
    const actions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization_finding", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("findingId", finding._id),
      )
      .take(ACTION_LIST_LIMIT);
    const gates = closureState(finding, actions, manager.userId);
    if (!gates.canSubmit) {
      throw new Error(gates.submitBlockedReason ?? "The finding cannot be submitted");
    }
    const notes = optionalText(args.notes, "Submission notes", REMEDIATION_NOTES_MAX);
    const now = Date.now();
    await ctx.db.patch(finding._id, {
      status: "awaiting_verification",
      submittedAt: now,
      submittedByUserId: manager.userId,
      submittedByLabel: manager.label,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      type: "submitted_for_verification",
      fromStatus: finding.status,
      toStatus: "awaiting_verification",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Finding submitted for verification (${actions.length} action(s))`,
      reason: notes,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.finding_submitted_for_verification",
      entityType: "complianceFindings",
      entityId: String(finding._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(finding.frameworkId),
      summary: `Finding ${finding.reference} submitted for verification`,
    });
    return { ok: true as const, status: "awaiting_verification" as ComplianceFindingStatus };
  },
});

/**
 * Close the finding. Two honest routes are supported:
 *   - `verified`: every mandatory action is independently verified (or the
 *     finding carries verification evidence), and the closer is nobody's
 *     implementer or owner;
 *   - `exception`: work is complete but verification evidence is missing, and a
 *     written exception records why. Missing evidence never silently becomes a
 *     verified result.
 * Both routes refuse closure while a mandatory action is outstanding.
 */
export const closeFinding = mutation({
  args: {
    findingId: v.id("complianceFindings"),
    method: v.union(v.literal("verified"), v.literal("exception")),
    notes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      args.findingId,
    );
    const actions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization_finding", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("findingId", finding._id),
      )
      .take(ACTION_LIST_LIMIT);

    const mandatoryOutstanding = actions.filter(
      (a) => a.mandatory && !isRemediationComplete(a.status),
    );
    if (mandatoryOutstanding.length > 0) {
      throw new Error(
        `${mandatoryOutstanding.length} mandatory action(s) must be complete before the finding can be closed`,
      );
    }
    if (!canTransitionFinding(finding.status, "closed")) {
      throw new Error(
        "Submit the finding for verification before closing it",
      );
    }
    const notes = requireNarrative(
      args.notes,
      "Closure notes",
      FINDING_CLOSURE_NOTES_MAX,
      FINDING_EXCEPTION_MIN,
    );

    if (args.method === "verified") {
      // Separation of duties is checked FIRST: an implementer must never learn
      // a closure rule they could satisfy by re-writing their own work.
      const violators = actions.filter(
        (a) =>
          isRemediationComplete(a.status) &&
          !canIndependentlyVerify(manager.userId, {
            ownerUserId: a.ownerUserId,
            completedByUserId: a.completedByUserId,
          }),
      );
      if (
        !canIndependentlyVerify(manager.userId, { ownerUserId: finding.ownerUserId }) ||
        violators.length > 0
      ) {
        throw new Error(
          "Independent verification must be recorded by someone other than the owner or the implementer of the remediation",
        );
      }
      const mandatoryUnverified = actions.filter(
        (a) => a.mandatory && a.status !== "verified",
      );
      if (mandatoryUnverified.length > 0) {
        throw new Error(
          `${mandatoryUnverified.length} mandatory action(s) are only complete, not independently verified`,
        );
      }
      const hasEvidence =
        (finding.evidenceIds ?? []).length > 0 ||
        actions.some((a) => a.status === "verified");
      if (!hasEvidence) {
        throw new Error(
          "A verified closure requires verification evidence: a verified action or at least one linked evidence record",
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(finding._id, {
      status: "closed",
      closureMethod: args.method,
      closureNotes: notes,
      closedAt: now,
      closedByUserId: manager.userId,
      closedByLabel: manager.label,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      type: "closed",
      fromStatus: finding.status,
      toStatus: "closed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary:
        args.method === "verified"
          ? "Finding closed after independent verification"
          : `Finding closed with a documented exception: ${notes.slice(0, 120)}`,
      reason: notes,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.finding_closed",
      entityType: "complianceFindings",
      entityId: String(finding._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(finding.frameworkId),
      summary: `Finding ${finding.reference} closed (${args.method}) with ${actions.length} remediation action(s)`,
    });
    return { ok: true as const, status: "closed" as ComplianceFindingStatus };
  },
});

/**
 * Reopen a closed finding. The closure stays in the history; the finding moves
 * back to remediation with a required reason.
 */
export const reopenFinding = mutation({
  args: {
    findingId: v.id("complianceFindings"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      args.findingId,
    );
    if (finding.status !== "closed") {
      throw new Error("Only a closed finding can be reopened");
    }
    const reason = requireNarrative(
      args.reason,
      "Reopen reason",
      FINDING_REOPEN_REASON_MAX,
      FINDING_EXCEPTION_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(finding._id, {
      status: "in_remediation",
      closureMethod: undefined,
      closureNotes: undefined,
      closedAt: undefined,
      closedByUserId: undefined,
      closedByLabel: undefined,
      submittedAt: undefined,
      submittedByUserId: undefined,
      submittedByLabel: undefined,
      reopenCount: finding.reopenCount + 1,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      type: "reopened",
      fromStatus: "closed",
      toStatus: "in_remediation",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Finding reopened: ${reason}`,
      reason,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.finding_reopened",
      entityType: "complianceFindings",
      entityId: String(finding._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(finding.frameworkId),
      summary: `Finding ${finding.reference} reopened: ${reason}`,
    });
    return { ok: true as const, status: "in_remediation" as ComplianceFindingStatus };
  },
});

// ---------------------------------------------------------------------------
// Writes — remediation actions
// ---------------------------------------------------------------------------

/** Assign a remediation action. An assigned action is not a completed one. */
export const assignRemediationAction = mutation({
  args: {
    findingId: v.id("complianceFindings"),
    description: v.string(),
    ownerUserId: v.optional(v.id("users")),
    dueDate: v.optional(v.number()),
    mandatory: v.optional(v.boolean()),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      args.findingId,
    );
    if (finding.status === "closed") {
      throw new Error(
        "A closed finding cannot take new actions — reopen it to record further work",
      );
    }
    const description = requireNarrative(
      args.description,
      "Action description",
      REMEDIATION_DESCRIPTION_MAX,
      REMEDIATION_DESCRIPTION_MIN,
    );
    const dueDate = optionalDate(args.dueDate, "Due date");
    const ownerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      manager.label,
      "Action owner",
    );
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      finding.controlId,
      args.evidenceIds,
    );
    const reference = await nextReference(
      ctx,
      "complianceRemediationActions",
      manager.organizationId,
      "RA",
    );
    const now = Date.now();
    const actionId = await ctx.db.insert("complianceRemediationActions", {
      organizationId: manager.organizationId,
      findingId: finding._id,
      reference,
      description,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      dueDate,
      mandatory: args.mandatory ?? true,
      status: "assigned",
      evidenceIds: evidenceIds.length > 0 ? evidenceIds : undefined,
      createdAt: now,
      updatedAt: now,
    });

    // The first action moves an open finding into remediation.
    let findingStatus = finding.status;
    if (finding.status === "open") {
      findingStatus = "in_remediation";
      await ctx.db.patch(finding._id, { status: findingStatus, updatedAt: now });
    }

    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      actionId,
      type: "action_assigned",
      fromStatus: finding.status,
      toStatus: findingStatus,
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${reference} assigned to ${ownerLabel}${args.mandatory ?? true ? " (mandatory)" : ""}`,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_assigned",
      entityType: "complianceRemediationActions",
      entityId: String(actionId),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(finding._id),
      summary: `Remediation ${reference} assigned for finding ${finding.reference}: ${description.slice(0, 160)}`,
    });
    return { actionId, reference };
  },
});

/** Edit an action that is still being worked. Verified work is immutable. */
export const updateRemediationAction = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    description: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    dueDate: v.optional(v.number()),
    mandatory: v.optional(v.boolean()),
    progressNotes: v.optional(v.string()),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      action.findingId,
    );
    if (finding.status === "closed" || isRemediationResolved(action.status)) {
      throw new Error(
        "A verified or cancelled action cannot be edited — assign a new action instead",
      );
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const changes: string[] = [];
    if (args.description !== undefined) {
      patch.description = requireNarrative(
        args.description,
        "Action description",
        REMEDIATION_DESCRIPTION_MAX,
        REMEDIATION_DESCRIPTION_MIN,
      );
      changes.push("description");
    }
    if (args.ownerUserId !== undefined) {
      patch.ownerUserId = args.ownerUserId;
      patch.ownerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.ownerUserId,
        manager.label,
        "Action owner",
      );
      changes.push("owner");
    }
    if (args.dueDate !== undefined) {
      patch.dueDate = optionalDate(args.dueDate, "Due date");
      changes.push("due date");
    }
    if (args.mandatory !== undefined) {
      patch.mandatory = args.mandatory;
      changes.push(args.mandatory ? "mandatory" : "optional");
    }
    if (args.progressNotes !== undefined) {
      patch.progressNotes = optionalText(
        args.progressNotes,
        "Progress notes",
        REMEDIATION_NOTES_MAX,
      );
      changes.push("progress");
    }
    if (args.evidenceIds !== undefined) {
      const ids = await validateEvidenceIds(
        ctx,
        manager.organizationId,
        finding.controlId,
        args.evidenceIds,
      );
      patch.evidenceIds = ids.length > 0 ? ids : undefined;
      changes.push("evidence");
    }

    await ctx.db.patch(action._id, patch);
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: finding._id,
      actionId: action._id,
      type: "action_updated",
      fromStatus: action.status,
      toStatus: action.status,
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} updated: ${
        changes.length > 0 ? changes.join(", ") : "no fields"
      }`,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_updated",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(finding._id),
      summary: `Remediation ${action.reference} updated: ${
        changes.length > 0 ? changes.join(", ") : "no fields"
      }`,
    });
    return { ok: true as const };
  },
});

/** assigned → in_progress. */
export const startRemediationAction = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    progressNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    if (!canTransitionRemediation(action.status, "in_progress")) {
      throw new Error(
        `A ${COMPLIANCE_REMEDIATION_STATUS_LABELS[action.status].toLowerCase()} action cannot be started`,
      );
    }
    const progressNotes = optionalText(
      args.progressNotes,
      "Progress notes",
      REMEDIATION_NOTES_MAX,
    );
    await ctx.db.patch(action._id, {
      status: "in_progress",
      progressNotes: progressNotes ?? action.progressNotes,
      updatedAt: Date.now(),
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: action.findingId,
      actionId: action._id,
      type: "action_started",
      fromStatus: action.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} moved to in progress`,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_started",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(action.findingId),
      summary: `Remediation ${action.reference} started`,
    });
    return { ok: true as const, status: "in_progress" as ComplianceRemediationStatus };
  },
});

/** Record that the implementation is COMPLETE. This is not a verification. */
export const completeRemediationAction = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    completionNotes: v.string(),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      action.findingId,
    );
    if (finding.status === "closed") {
      throw new Error("A closed finding cannot take further remediation work");
    }
    if (!canTransitionRemediation(action.status, "completed")) {
      throw new Error(
        `A ${COMPLIANCE_REMEDIATION_STATUS_LABELS[action.status].toLowerCase()} action cannot be completed`,
      );
    }
    const completionNotes = requireNarrative(
      args.completionNotes,
      "Completion notes",
      REMEDIATION_NOTES_MAX,
      REMEDIATION_DESCRIPTION_MIN,
    );
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      finding.controlId,
      args.evidenceIds,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "completed",
      completionNotes,
      evidenceIds:
        evidenceIds.length > 0
          ? [...(action.evidenceIds ?? []), ...evidenceIds].filter(
              (id, index, all) => all.findIndex((other) => other === id) === index,
            )
          : action.evidenceIds,
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      // A new implementation invalidates any earlier verification attempt.
      verificationNotes: undefined,
      verifiedAt: undefined,
      verifiedByUserId: undefined,
      verifiedByLabel: undefined,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: action.findingId,
      actionId: action._id,
      type: "action_completed",
      fromStatus: action.status,
      toStatus: "completed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} implementation recorded complete — awaiting independent verification`,
      reason: completionNotes,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_completed",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(action.findingId),
      summary: `Remediation ${action.reference} implementation complete (verification outstanding)`,
    });
    return { ok: true as const, status: "completed" as ComplianceRemediationStatus };
  },
});

/**
 * Independently verify a completed action. The verifier can be neither the
 * action's owner nor the implementer who recorded completion, and a
 * verification statement or evidence reference is required.
 */
export const verifyRemediationAction = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    verificationNotes: v.optional(v.string()),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      action.findingId,
    );
    if (finding.status === "closed") {
      throw new Error("A closed finding cannot take further remediation work");
    }
    if (!canTransitionRemediation(action.status, "verified")) {
      throw new Error(
        `Only an action whose implementation is complete can be verified — this action is ${COMPLIANCE_REMEDIATION_STATUS_LABELS[action.status].toLowerCase()}`,
      );
    }
    if (
      !canIndependentlyVerify(manager.userId, {
        ownerUserId: action.ownerUserId,
        completedByUserId: action.completedByUserId,
      })
    ) {
      throw new Error(
        "Independent verification must be recorded by someone other than the action owner or the implementer",
      );
    }
    const verificationNotes = optionalText(
      args.verificationNotes,
      "Verification notes",
      REMEDIATION_NOTES_MAX,
    );
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      finding.controlId,
      args.evidenceIds,
    );
    const combinedEvidence = [
      ...(action.evidenceIds ?? []),
      ...evidenceIds,
    ].filter((id, index, all) => all.findIndex((other) => other === id) === index);
    if (!verificationNotes && combinedEvidence.length === 0) {
      throw new Error(
        "A verification needs a statement or at least one evidence reference",
      );
    }
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "verified",
      verificationNotes,
      evidenceIds: combinedEvidence.length > 0 ? combinedEvidence : undefined,
      verifiedAt: now,
      verifiedByUserId: manager.userId,
      verifiedByLabel: manager.label,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: action.findingId,
      actionId: action._id,
      type: "action_verified",
      fromStatus: action.status,
      toStatus: "verified",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} independently verified by ${manager.label}`,
      reason: verificationNotes,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_verified",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(action.findingId),
      summary: `Remediation ${action.reference} independently verified`,
    });
    return { ok: true as const, status: "verified" as ComplianceRemediationStatus };
  },
});

/**
 * A failed verification sends the action back to work. The attempt is kept in
 * the history and the action must be implemented again before it can be
 * verified.
 */
export const failRemediationVerification = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      action.findingId,
    );
    if (action.status !== "completed") {
      throw new Error(
        "Only an action awaiting verification can be returned for further work",
      );
    }
    const reason = requireNarrative(
      args.reason,
      "Verification failure reason",
      REMEDIATION_NOTES_MAX,
      REMEDIATION_DESCRIPTION_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "in_progress",
      completedAt: undefined,
      completedByUserId: undefined,
      completedByLabel: undefined,
      progressNotes: reason,
      updatedAt: now,
    });

    // A finding awaiting verification goes back to remediation, so a failed
    // check can never leave it looking closed-ready.
    let findingStatus = finding.status;
    if (finding.status === "awaiting_verification") {
      findingStatus = "in_remediation";
      await ctx.db.patch(finding._id, {
        status: findingStatus,
        submittedAt: undefined,
        submittedByUserId: undefined,
        submittedByLabel: undefined,
        updatedAt: now,
      });
    }

    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: action.findingId,
      actionId: action._id,
      type: "action_verification_failed",
      fromStatus: "completed",
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} verification failed — returned for further work: ${reason}`,
      reason,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_verification_failed",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(action.findingId),
      summary: `Remediation ${action.reference} failed verification: ${reason}`,
    });
    return { ok: true as const, status: "in_progress" as ComplianceRemediationStatus };
  },
});

/** Cancel an action that is no longer required (reason required). */
export const cancelRemediationAction = mutation({
  args: {
    actionId: v.id("complianceRemediationActions"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await requireAction(
      ctx,
      manager.organizationId,
      args.actionId,
    );
    const finding = await requireFinding(
      ctx,
      manager.organizationId,
      action.findingId,
    );
    if (finding.status === "closed") {
      throw new Error("A closed finding cannot take further remediation work");
    }
    if (!canTransitionRemediation(action.status, "cancelled")) {
      throw new Error(
        `A ${COMPLIANCE_REMEDIATION_STATUS_LABELS[action.status].toLowerCase()} action cannot be cancelled`,
      );
    }
    const reason = requireNarrative(
      args.reason,
      "Cancellation reason",
      REMEDIATION_REASON_MAX,
      REMEDIATION_DESCRIPTION_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelledByUserId: manager.userId,
      cancelledByLabel: manager.label,
      cancelReason: reason,
      updatedAt: now,
    });
    await recordEvent(ctx, {
      organizationId: manager.organizationId,
      findingId: action.findingId,
      actionId: action._id,
      type: "action_cancelled",
      fromStatus: action.status,
      toStatus: "cancelled",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${action.reference} cancelled: ${reason}`,
      reason,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.remediation_cancelled",
      entityType: "complianceRemediationActions",
      entityId: String(action._id),
      relatedEntityType: "complianceFindings",
      relatedEntityId: String(action.findingId),
      summary: `Remediation ${action.reference} cancelled: ${reason}`,
    });
    return { ok: true as const, status: "cancelled" as ComplianceRemediationStatus };
  },
});
