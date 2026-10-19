import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { roleHasPermission } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  ASSESSMENT_EVIDENCE_UNLINK_REASON_MAX,
  ASSESSMENT_FINDINGS_MAX,
  ASSESSMENT_NOTES_MIN,
  ASSESSMENT_PERIOD_MAX,
  ASSESSMENT_RATIONALE_MAX,
  ASSESSMENT_RATIONALE_MIN,
  ASSESSMENT_REMEDIATION_MAX,
  ASSESSMENT_REVIEW_NOTES_MAX,
  ASSESSMENT_SCOPE_MAX,
  ASSESSMENT_TITLE_MAX,
  COMPLIANCE_ASSESSMENT_OUTCOME_LABELS,
  COMPLIANCE_ASSESSMENT_STATUS_LABELS,
  CONTROL_DOMAIN_LABELS,
  CONTROL_IMPLEMENTATION_STATUS_LABELS,
  CONTROL_TEST_OUTCOME_LABELS,
  canTransitionAssessment,
  complianceAssessmentOutcomeValidator,
  complianceAssessmentStatusValidator,
  isAssessmentVerdict,
  isFinalAssessment,
  isOpenAssessment,
  type ComplianceAssessmentStatus,
} from "../lib/compliance";

/**
 * Phase 3C — Batch 3: compliance assessments and assessment history.
 * =================================================================
 * Design decisions that matter for security and for the honesty of the result:
 *
 *  - A cycle is scoped to ONE adopted framework. Every control in that
 *    framework at creation time becomes an assessment item carrying a SNAPSHOT
 *    of the control. Editing the register later cannot rewrite what was
 *    assessed, and reassessment never deletes earlier results.
 *  - The assessor records the conclusion and the rationale. A control-test
 *    outcome is REFERENCED, never applied: a passing test does not make a
 *    control compliant, and a failing one does not make it non-compliant.
 *  - A finalised cycle (`completed` / `reviewed`) is never patched. Corrections
 *    create a NEW cycle that supersedes it (`supersedesAssessmentId`); the
 *    earlier cycle and its items stay readable exactly as issued.
 *  - Where independent review is required, the reviewer must be a different
 *    person from the assessor AND from whoever completed the cycle: a reviewer
 *    cannot certify their own work.
 *  - Summaries are counts of real records. No compliance percentage is
 *    calculated: its denominator (scope, exclusions, not-applicable handling)
 *    is not defined by this batch, so none is presented.
 *
 * Authorization: `compliance.view` for every read, `compliance.manage` plus an
 * active membership for every write. The organization always comes from the
 * access context, and every framework, control, assessment, item, test and
 * evidence id is re-validated against it — a foreign id is indistinguishable
 * from a missing one.
 */

const PAGE_DEFAULT = 25;
const PAGE_MAX = 100;
const ASSESSMENT_LIST_LIMIT = 200;
const ITEM_SCAN_LIMIT = 500;
const CONTROL_SCAN_LIMIT = 500;
const EVIDENCE_LIST_LIMIT = 300;
const MAPPING_LIST_LIMIT = 300;
const TEST_LIST_LIMIT = 300;

interface AssessmentAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
  canManage: boolean;
}

async function resolveAccess(
  ctx: QueryCtx | MutationCtx,
): Promise<AssessmentAccess> {
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

async function requireManager(ctx: MutationCtx): Promise<AssessmentAccess> {
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

function requireNarrative(value: string, field: string, max: number): string {
  const cleaned = value.trim();
  if (!cleaned) throw new Error(`${field} is required`);
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

async function requireAssessment(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"complianceAssessments">,
): Promise<Doc<"complianceAssessments">> {
  const assessment = await ctx.db.get(assessmentId);
  if (!assessment || assessment.organizationId !== organizationId) {
    throw new Error("Assessment not found in your organization");
  }
  return assessment;
}

/** The named assessor must be an ACTIVE member of the same organization. */
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

async function nextAssessmentReference(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<string> {
  const existing = await ctx.db
    .query("complianceAssessments")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(ASSESSMENT_LIST_LIMIT * 5);
  let highest = 0;
  for (const row of existing) {
    const match = /^CA-(\d+)$/.exec(row.reference);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `CA-${String(highest + 1).padStart(3, "0")}`;
}

function snapshotControl(
  control: Doc<"controls">,
  framework: Doc<"complianceFrameworks">,
) {
  return {
    code: control.code,
    title: control.name,
    domain: control.domain,
    domainLabel: control.domain ? CONTROL_DOMAIN_LABELS[control.domain] : undefined,
    implementationStatus: control.implementationStatus,
    implementationStatusLabel: control.implementationStatus
      ? CONTROL_IMPLEMENTATION_STATUS_LABELS[control.implementationStatus]
      : undefined,
    effectiveness: control.effectiveness,
    ownerName: control.ownerName,
    frameworkCode: framework.code,
    frameworkName: framework.name,
  };
}

function presentAssessment(
  assessment: Doc<"complianceAssessments">,
  supersededBy?: string,
) {
  return {
    _id: assessment._id,
    reference: assessment.reference,
    title: assessment.title,
    frameworkId: assessment.frameworkId,
    scope: assessment.scope ?? null,
    periodLabel: assessment.periodLabel ?? null,
    startDate: assessment.startDate ?? null,
    dueDate: assessment.dueDate ?? null,
    assessorUserId: assessment.assessorUserId ?? null,
    assessorLabel: assessment.assessorLabel,
    status: assessment.status,
    statusLabel: COMPLIANCE_ASSESSMENT_STATUS_LABELS[assessment.status],
    reviewRequired: assessment.reviewRequired,
    completionNotes: assessment.completionNotes ?? null,
    completedAt: assessment.completedAt ?? null,
    completedByLabel: assessment.completedByLabel ?? null,
    reviewNotes: assessment.reviewNotes ?? null,
    reviewedAt: assessment.reviewedAt ?? null,
    reviewedByLabel: assessment.reviewedByLabel ?? null,
    supersedesAssessmentId: assessment.supersedesAssessmentId ?? null,
    amendmentReason: assessment.amendmentReason ?? null,
    /** Derived from a LATER cycle; never stored on this row. */
    supersededByAssessmentId: supersededBy ?? null,
    superseded: Boolean(supersededBy),
    open: isOpenAssessment(assessment.status),
    createdByLabel: assessment.createdByLabel,
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  };
}

function presentItem(item: Doc<"complianceAssessmentItems">) {
  return {
    _id: item._id,
    assessmentId: item.assessmentId,
    controlId: item.controlId,
    snapshot: item.controlSnapshot,
    outcome: item.outcome,
    outcomeLabel: COMPLIANCE_ASSESSMENT_OUTCOME_LABELS[item.outcome],
    rationale: item.rationale ?? null,
    assessorUserId: item.assessorUserId ?? null,
    assessorLabel: item.assessorLabel ?? null,
    assessedAt: item.assessedAt ?? null,
    controlTestIds: (item.controlTestIds ?? []).map(String),
    findings: item.findings ?? null,
    remediation: item.remediation ?? null,
  };
}

type ItemOutcomeSummary = {
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

/**
 * Counts of real item records. `assessed` is the number of controls carrying an
 * assessor's conclusion; `evidenceGaps` counts concluded items with no active
 * evidence link. No percentage is produced — see the module comment.
 */
function summarizeItems(
  items: Doc<"complianceAssessmentItems">[],
  activeEvidenceByItem: Map<string, number>,
): ItemOutcomeSummary {
  const summary: ItemOutcomeSummary = {
    total: items.length,
    assessed: 0,
    compliant: 0,
    partiallyCompliant: 0,
    nonCompliant: 0,
    notAssessed: 0,
    notApplicable: 0,
    evidenceGaps: 0,
    outstandingRemediation: 0,
  };
  for (const item of items) {
    switch (item.outcome) {
      case "compliant":
        summary.compliant += 1;
        break;
      case "partially_compliant":
        summary.partiallyCompliant += 1;
        break;
      case "non_compliant":
        summary.nonCompliant += 1;
        break;
      case "not_applicable":
        summary.notApplicable += 1;
        break;
      default:
        summary.notAssessed += 1;
    }
    if (isAssessmentVerdict(item.outcome)) {
      summary.assessed += 1;
      if ((activeEvidenceByItem.get(String(item._id)) ?? 0) === 0) {
        summary.evidenceGaps += 1;
      }
    }
    if (item.remediation && item.outcome !== "compliant") {
      summary.outstandingRemediation += 1;
    }
  }
  return summary;
}

async function activeMappingCounts(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"complianceAssessments">,
): Promise<Map<string, number>> {
  const mappings = await ctx.db
    .query("complianceAssessmentEvidence")
    .withIndex("by_organization_assessment", (q) =>
      q.eq("organizationId", organizationId).eq("assessmentId", assessmentId),
    )
    .take(MAPPING_LIST_LIMIT);
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    if (!mapping.active) continue;
    const key = String(mapping.itemId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** Assessment cycles, newest first, cursor-paginated over the org index. */
export const listAssessments = query({
  args: {
    frameworkId: v.optional(v.id("complianceFrameworks")),
    status: v.optional(complianceAssessmentStatusValidator),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const requested = args.numItems ?? PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(
        Number.isFinite(requested) ? Math.floor(requested) : PAGE_DEFAULT,
        1,
      ),
      PAGE_MAX,
    );

    // A foreign framework id discloses nothing.
    if (args.frameworkId) {
      const framework = await ctx.db.get(args.frameworkId);
      if (!framework || framework.organizationId !== access.organizationId) {
        return { rows: [], continueCursor: "", isDone: true, summary: null };
      }
    }

    const page = args.frameworkId
      ? await ctx.db
          .query("complianceAssessments")
          .withIndex("by_organization_framework", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("frameworkId", args.frameworkId as Id<"complianceFrameworks">),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null })
      : await ctx.db
          .query("complianceAssessments")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null });

    const search = args.search?.trim().toLowerCase();
    const rows = [];
    for (const assessment of page.page) {
      if (args.status && assessment.status !== args.status) continue;
      if (search) {
        const haystack = [
          assessment.reference,
          assessment.title,
          assessment.scope,
          assessment.periodLabel,
          assessment.assessorLabel,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      const superseding = await ctx.db
        .query("complianceAssessments")
        .withIndex("by_organization_supersedes", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("supersedesAssessmentId", assessment._id),
        )
        .first();
      const items = await ctx.db
        .query("complianceAssessmentItems")
        .withIndex("by_organization_assessment", (q) =>
          q
            .eq("organizationId", access.organizationId)
            .eq("assessmentId", assessment._id),
        )
        .take(ITEM_SCAN_LIMIT);
      const evidenceCounts = await activeMappingCounts(
        ctx,
        access.organizationId,
        assessment._id,
      );
      rows.push({
        ...presentAssessment(
          assessment,
          superseding ? String(superseding._id) : undefined,
        ),
        summary: summarizeItems(items, evidenceCounts),
      });
    }

    // Cycle counts across the organization (bounded scan).
    const scanned = await ctx.db
      .query("complianceAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(ASSESSMENT_LIST_LIMIT);
    const byStatus: Record<string, number> = {};
    for (const assessment of scanned) {
      byStatus[assessment.status] = (byStatus[assessment.status] ?? 0) + 1;
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      summary: { total: scanned.length, byStatus },
    };
  },
});

/** One cycle with its items, evidence links, summary and review state. */
export const getAssessment = query({
  args: { assessmentId: v.id("complianceAssessments") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const assessment = await ctx.db.get(args.assessmentId);
    if (!assessment || assessment.organizationId !== access.organizationId) {
      return null;
    }
    const framework = await ctx.db.get(assessment.frameworkId);
    if (!framework || framework.organizationId !== access.organizationId) {
      return null;
    }

    const items = await ctx.db
      .query("complianceAssessmentItems")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", assessment._id),
      )
      .take(ITEM_SCAN_LIMIT);
    const mappings = await ctx.db
      .query("complianceAssessmentEvidence")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", assessment._id),
      )
      .take(MAPPING_LIST_LIMIT);

    const evidenceByItem = new Map<
      string,
      Array<{ mappingId: string; evidenceId: string; active: boolean; unlinkedAt: number | null }>
    >();
    for (const mapping of mappings) {
      const key = String(mapping.itemId);
      const list = evidenceByItem.get(key) ?? [];
      list.push({
        mappingId: String(mapping._id),
        evidenceId: String(mapping.evidenceId),
        active: mapping.active,
        unlinkedAt: mapping.unlinkedAt ?? null,
      });
      evidenceByItem.set(key, list);
    }
    const activeCounts = new Map<string, number>();
    for (const [key, list] of evidenceByItem) {
      activeCounts.set(
        key,
        list.filter((m) => m.active).length,
      );
    }

    const superseding = await ctx.db
      .query("complianceAssessments")
      .withIndex("by_organization_supersedes", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("supersedesAssessmentId", assessment._id),
      )
      .first();

    let supersededAssessment = null;
    if (assessment.supersedesAssessmentId) {
      const earlier = await ctx.db.get(assessment.supersedesAssessmentId);
      if (earlier && earlier.organizationId === access.organizationId) {
        supersededAssessment = presentAssessment(earlier);
      }
    }

    return {
      ...presentAssessment(
        assessment,
        superseding ? String(superseding._id) : undefined,
      ),
      framework: {
        _id: framework._id,
        code: framework.code,
        name: framework.name,
      },
      items: items.map((item) => ({
        ...presentItem(item),
        evidence: evidenceByItem.get(String(item._id)) ?? [],
        activeEvidenceCount: activeCounts.get(String(item._id)) ?? 0,
      })),
      summary: summarizeItems(items, activeCounts),
      supersededAssessment,
      canManage: access.canManage,
      /**
       * Independent review: the caller must hold the write permission, the
       * cycle must await review, and they must not be the assessor or the
       * person who completed it.
       */
      canReview:
        access.canManage &&
        assessment.status === "completed" &&
        assessment.reviewRequired &&
        assessment.assessorUserId !== access.userId &&
        assessment.completedByUserId !== access.userId,
      /** Explicit, human-readable reason shown when review is not available. */
      reviewBlockedReason:
        assessment.status !== "completed"
          ? null
          : !assessment.reviewRequired
            ? "This cycle does not require independent review."
            : assessment.assessorUserId === access.userId ||
                assessment.completedByUserId === access.userId
              ? "Independent review must be recorded by someone other than the assessor or the person who completed the cycle."
              : null,
    };
  },
});

/** Evidence records and control tests that can support an assessment item. */
export const assessmentReferences = query({
  args: { assessmentId: v.id("complianceAssessments"), controlId: v.id("controls") },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const assessment = await ctx.db.get(args.assessmentId);
    if (!assessment || assessment.organizationId !== access.organizationId) {
      return { evidence: [], tests: [] };
    }
    const control = await ctx.db.get(args.controlId);
    if (!control || control.organizationId !== access.organizationId) {
      return { evidence: [], tests: [] };
    }

    const evidenceRows = await ctx.db
      .query("complianceEvidence")
      .withIndex("by_organization_control", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("controlId", control._id),
      )
      .take(EVIDENCE_LIST_LIMIT);
    const tests = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization_control", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("controlId", control._id),
      )
      .take(TEST_LIST_LIMIT);

    return {
      evidence: evidenceRows.map((record) => ({
        _id: String(record._id),
        filename: record.filename,
        classification: record.classification,
        integrity: record.integrity,
        sha256: record.sha256 || null,
        createdAt: record.createdAt,
        // A restricted file is never offered to a caller who cannot download it.
        selectable:
          record.classification !== "restricted" || access.canManage,
      })),
      tests: tests.map((test) => ({
        _id: String(test._id),
        reference: test.reference,
        title: test.title,
        status: test.status,
        outcome: test.outcome,
        outcomeLabel: CONTROL_TEST_OUTCOME_LABELS[test.outcome],
      })),
    };
  },
});

/** Organization-wide assessment reporting: counts of real records only. */
export const assessmentSummary = query({
  args: { frameworkId: v.optional(v.id("complianceFrameworks")) },
  handler: async (ctx, args) => {
    const access = await resolveAccess(ctx);
    const empty = {
      assessments: 0,
      draft: 0,
      inProgress: 0,
      completed: 0,
      reviewed: 0,
      controlsInScope: 0,
      assessed: 0,
      compliant: 0,
      partiallyCompliant: 0,
      nonCompliant: 0,
      notAssessed: 0,
      notApplicable: 0,
      evidenceGaps: 0,
      outstandingRemediation: 0,
    };

    if (args.frameworkId) {
      const framework = await ctx.db.get(args.frameworkId);
      if (!framework || framework.organizationId !== access.organizationId) {
        return empty;
      }
    }

    const assessments = (
      await ctx.db
        .query("complianceAssessments")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(ASSESSMENT_LIST_LIMIT)
    ).filter((a) => !args.frameworkId || a.frameworkId === args.frameworkId);

    const assessmentsById = new Map(
      assessments.map((a) => [String(a._id), a]),
    );

    const items = (
      await ctx.db
        .query("complianceAssessmentItems")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(ITEM_SCAN_LIMIT)
    ).filter((item) => assessmentsById.has(String(item.assessmentId)));

    const mappings = await ctx.db
      .query("complianceAssessmentEvidence")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(MAPPING_LIST_LIMIT);
    const activeByItem = new Map<string, number>();
    for (const mapping of mappings) {
      if (!mapping.active) continue;
      const key = String(mapping.itemId);
      activeByItem.set(key, (activeByItem.get(key) ?? 0) + 1);
    }

    // One item per control per cycle: the "latest" figure is the count of items
    // recorded, never a de-duplicated score across cycles.
    const totals = summarizeItems(items, activeByItem);
    const byStatus: Record<ComplianceAssessmentStatus, number> = {
      draft: 0,
      in_progress: 0,
      completed: 0,
      reviewed: 0,
    };
    for (const assessment of assessments) byStatus[assessment.status] += 1;

    return {
      assessments: assessments.length,
      draft: byStatus.draft,
      inProgress: byStatus.in_progress,
      completed: byStatus.completed,
      reviewed: byStatus.reviewed,
      controlsInScope: totals.total,
      assessed: totals.assessed,
      compliant: totals.compliant,
      partiallyCompliant: totals.partiallyCompliant,
      nonCompliant: totals.nonCompliant,
      notAssessed: totals.notAssessed,
      notApplicable: totals.notApplicable,
      evidenceGaps: totals.evidenceGaps,
      outstandingRemediation: totals.outstandingRemediation,
    };
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Start a cycle: creates the cycle and one item per control in the framework,
 * each carrying a snapshot of the control as it stands today.
 */
export const createAssessment = mutation({
  args: {
    frameworkId: v.id("complianceFrameworks"),
    title: v.string(),
    scope: v.optional(v.string()),
    periodLabel: v.optional(v.string()),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assessorUserId: v.optional(v.id("users")),
    reviewRequired: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const framework = await requireOwnedFramework(
      ctx,
      manager.organizationId,
      args.frameworkId,
    );
    const title = requireText(args.title, "Assessment title", ASSESSMENT_TITLE_MAX);
    const scope = optionalText(args.scope, "Assessment scope", ASSESSMENT_SCOPE_MAX);
    const periodLabel = optionalText(
      args.periodLabel,
      "Assessment period",
      ASSESSMENT_PERIOD_MAX,
    );
    const startDate = optionalDate(args.startDate, "Start date");
    const dueDate = optionalDate(args.dueDate, "Due date");
    if (startDate !== undefined && dueDate !== undefined && dueDate < startDate) {
      throw new Error("Due date cannot precede the start date");
    }
    const assessorLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.assessorUserId,
      manager.label,
      "Assessor",
    );

    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization_framework", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("frameworkId", framework._id),
      )
      .take(CONTROL_SCAN_LIMIT);
    if (controls.length === 0) {
      throw new Error(
        "This framework has no controls, so there is nothing to assess",
      );
    }

    const reference = await nextAssessmentReference(ctx, manager.organizationId);
    const now = Date.now();
    const assessmentId = await ctx.db.insert("complianceAssessments", {
      organizationId: manager.organizationId,
      frameworkId: framework._id,
      reference,
      title,
      scope,
      periodLabel,
      startDate,
      dueDate,
      assessorUserId: args.assessorUserId,
      assessorLabel,
      status: "draft",
      reviewRequired: args.reviewRequired ?? true,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });

    for (const control of controls) {
      await ctx.db.insert("complianceAssessmentItems", {
        organizationId: manager.organizationId,
        assessmentId,
        frameworkId: framework._id,
        controlId: control._id,
        controlSnapshot: snapshotControl(control, framework),
        outcome: "not_assessed",
        createdAt: now,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_created",
      entityType: "complianceAssessments",
      entityId: String(assessmentId),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(framework._id),
      summary: `Assessment ${reference} created for ${framework.code} with ${controls.length} control(s) in scope`,
    });

    return { assessmentId, reference, controls: controls.length };
  },
});

/** Edit cycle metadata. Finalised cycles are immutable. */
export const updateAssessment = mutation({
  args: {
    assessmentId: v.id("complianceAssessments"),
    title: v.optional(v.string()),
    scope: v.optional(v.string()),
    periodLabel: v.optional(v.string()),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assessorUserId: v.optional(v.id("users")),
    reviewRequired: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (isFinalAssessment(assessment.status)) {
      throw new Error(
        "A finalised assessment cannot be edited — record a superseding assessment instead",
      );
    }
    await requireOwnedFramework(
      ctx,
      manager.organizationId,
      assessment.frameworkId,
    );

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    const changes: string[] = [];
    if (args.title !== undefined) {
      patch.title = requireText(args.title, "Assessment title", ASSESSMENT_TITLE_MAX);
      changes.push("title");
    }
    if (args.scope !== undefined) {
      patch.scope = optionalText(args.scope, "Assessment scope", ASSESSMENT_SCOPE_MAX);
      changes.push("scope");
    }
    if (args.periodLabel !== undefined) {
      patch.periodLabel = optionalText(
        args.periodLabel,
        "Assessment period",
        ASSESSMENT_PERIOD_MAX,
      );
      changes.push("period");
    }
    if (args.startDate !== undefined) {
      patch.startDate = optionalDate(args.startDate, "Start date");
      changes.push("startDate");
    }
    if (args.dueDate !== undefined) {
      patch.dueDate = optionalDate(args.dueDate, "Due date");
      changes.push("dueDate");
    }
    const startDate = (patch.startDate as number | undefined) ?? assessment.startDate;
    const dueDate = (patch.dueDate as number | undefined) ?? assessment.dueDate;
    if (startDate !== undefined && dueDate !== undefined && dueDate < startDate) {
      throw new Error("Due date cannot precede the start date");
    }
    if (args.assessorUserId !== undefined) {
      patch.assessorUserId = args.assessorUserId;
      patch.assessorLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.assessorUserId,
        manager.label,
        "Assessor",
      );
      changes.push("assessor");
    }
    if (args.reviewRequired !== undefined) {
      patch.reviewRequired = args.reviewRequired;
      changes.push("reviewRequired");
    }

    await ctx.db.patch(assessment._id, patch);
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_updated",
      entityType: "complianceAssessments",
      entityId: String(assessment._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(assessment.frameworkId),
      summary: `Assessment ${assessment.reference} updated: ${
        changes.length > 0 ? changes.join(", ") : "no fields"
      }`,
    });
    return { ok: true as const };
  },
});

/** draft → in_progress. */
export const startAssessment = mutation({
  args: { assessmentId: v.id("complianceAssessments") },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (!canTransitionAssessment(assessment.status, "in_progress")) {
      throw new Error(
        `A ${COMPLIANCE_ASSESSMENT_STATUS_LABELS[assessment.status].toLowerCase()} assessment cannot be started`,
      );
    }
    await ctx.db.patch(assessment._id, {
      status: "in_progress",
      updatedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_started",
      entityType: "complianceAssessments",
      entityId: String(assessment._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(assessment.frameworkId),
      summary: `Assessment ${assessment.reference} moved to in progress`,
    });
    return { ok: true as const, status: "in_progress" as ComplianceAssessmentStatus };
  },
});

/**
 * Record the assessor's conclusion for one control. A verdict (or a
 * not-applicable call) requires a rationale; the referenced control tests and
 * evidence must belong to this organization AND to this control.
 */
export const assessControl = mutation({
  args: {
    assessmentId: v.id("complianceAssessments"),
    itemId: v.id("complianceAssessmentItems"),
    outcome: complianceAssessmentOutcomeValidator,
    rationale: v.optional(v.string()),
    findings: v.optional(v.string()),
    remediation: v.optional(v.string()),
    controlTestIds: v.optional(v.array(v.id("complianceControlTests"))),
    evidenceIds: v.optional(v.array(v.id("complianceEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (!isOpenAssessment(assessment.status)) {
      throw new Error(
        "A finalised assessment cannot be changed — record a superseding assessment instead",
      );
    }
    const item = await ctx.db.get(args.itemId);
    if (
      !item ||
      item.organizationId !== manager.organizationId ||
      item.assessmentId !== assessment._id
    ) {
      throw new Error("Assessment item not found in this assessment");
    }

    const rationale = optionalText(
      args.rationale,
      "Rationale",
      ASSESSMENT_RATIONALE_MAX,
    );
    if (
      (isAssessmentVerdict(args.outcome) || args.outcome === "not_applicable") &&
      (!rationale || rationale.length < ASSESSMENT_RATIONALE_MIN)
    ) {
      throw new Error(
        `A ${COMPLIANCE_ASSESSMENT_OUTCOME_LABELS[args.outcome].toLowerCase()} outcome requires a rationale of at least ${ASSESSMENT_RATIONALE_MIN} characters`,
      );
    }
    const findings = optionalText(args.findings, "Findings", ASSESSMENT_FINDINGS_MAX);
    const remediation = optionalText(
      args.remediation,
      "Recommended remediation",
      ASSESSMENT_REMEDIATION_MAX,
    );
    if (args.outcome === "non_compliant" && !findings && !remediation) {
      throw new Error(
        "A non-compliant outcome requires the findings or recommended remediation",
      );
    }

    // Control-test references: same organization AND the same control.
    const testIds: Id<"complianceControlTests">[] = [];
    for (const testId of args.controlTestIds ?? []) {
      const test = await ctx.db.get(testId);
      if (
        !test ||
        test.organizationId !== manager.organizationId ||
        test.controlId !== item.controlId
      ) {
        throw new Error(
          "A control test can only be referenced when it belongs to this control and organization",
        );
      }
      if (!testIds.some((id) => String(id) === String(test._id))) {
        testIds.push(test._id);
      }
    }

    // Evidence links: same organization AND the same control.
    const requestedEvidence: Doc<"complianceEvidence">[] = [];
    for (const evidenceId of args.evidenceIds ?? []) {
      const record = await ctx.db.get(evidenceId);
      if (
        !record ||
        record.organizationId !== manager.organizationId ||
        record.controlId !== item.controlId
      ) {
        throw new Error(
          "Evidence can only be linked when it belongs to this control and organization",
        );
      }
      if (!requestedEvidence.some((e) => String(e._id) === String(record._id))) {
        requestedEvidence.push(record);
      }
    }

    const now = Date.now();
    const isConclusion =
      isAssessmentVerdict(args.outcome) || args.outcome === "not_applicable";
    await ctx.db.patch(item._id, {
      outcome: args.outcome,
      rationale: isConclusion ? rationale : undefined,
      findings,
      remediation,
      controlTestIds: testIds.length > 0 ? testIds : undefined,
      assessorUserId: isConclusion ? manager.userId : undefined,
      assessorLabel: isConclusion ? manager.label : undefined,
      assessedAt: isConclusion ? now : undefined,
      updatedAt: now,
    });

    // Reconcile evidence links. Removed links are deactivated with a reason —
    // the evidence record, its hash and the audit trail all survive.
    const existing = await ctx.db
      .query("complianceAssessmentEvidence")
      .withIndex("by_organization_item", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("itemId", item._id),
      )
      .take(MAPPING_LIST_LIMIT);
    const wanted = new Set(requestedEvidence.map((e) => String(e._id)));
    for (const mapping of existing) {
      if (mapping.active && !wanted.has(String(mapping.evidenceId))) {
        await ctx.db.patch(mapping._id, {
          active: false,
          unlinkedAt: now,
          unlinkedByUserId: manager.userId,
          unlinkedByLabel: manager.label,
          unlinkReason: "Removed while updating the assessment record",
          updatedAt: now,
        });
        await logAudit(ctx, {
          organizationId: manager.organizationId,
          userId: manager.userId,
          actorId: manager.userId,
          actorLabel: manager.label,
          action: "compliance.assessment_evidence_unlinked",
          entityType: "complianceAssessmentEvidence",
          entityId: String(mapping._id),
          relatedEntityType: "complianceEvidence",
          relatedEntityId: String(mapping.evidenceId),
          summary:
            "Assessment evidence link removed (evidence record and audit history retained)",
        });
      }
    }
    const activeEvidence = new Set(
      existing.filter((m) => m.active).map((m) => String(m.evidenceId)),
    );
    for (const record of requestedEvidence) {
      if (activeEvidence.has(String(record._id))) continue;
      const mappingId = await ctx.db.insert("complianceAssessmentEvidence", {
        organizationId: manager.organizationId,
        assessmentId: assessment._id,
        itemId: item._id,
        controlId: item.controlId,
        evidenceId: record._id,
        linkedByUserId: manager.userId,
        linkedByLabel: manager.label,
        linkedAt: now,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      await logAudit(ctx, {
        organizationId: manager.organizationId,
        userId: manager.userId,
        actorId: manager.userId,
        actorLabel: manager.label,
        action: "compliance.assessment_evidence_linked",
        entityType: "complianceAssessmentEvidence",
        entityId: String(mappingId),
        relatedEntityType: "complianceEvidence",
        relatedEntityId: String(record._id),
        summary: `Evidence ${record.filename} linked to assessment ${assessment.reference} for control ${item.controlSnapshot.code}`,
      });
    }

    if (assessment.status === "draft") {
      await ctx.db.patch(assessment._id, {
        status: "in_progress",
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_control_assessed",
      entityType: "complianceAssessmentItems",
      entityId: String(item._id),
      relatedEntityType: "complianceAssessments",
      relatedEntityId: String(assessment._id),
      summary: `Control ${item.controlSnapshot.code} assessed as ${
        COMPLIANCE_ASSESSMENT_OUTCOME_LABELS[args.outcome]
      } in ${assessment.reference}`,
    });

    return {
      ok: true as const,
      outcome: args.outcome,
      evidenceLinked: requestedEvidence.length,
      testsReferenced: testIds.length,
    };
  },
});

/** Complete a cycle. Refused while any control is still not assessed. */
export const completeAssessment = mutation({
  args: {
    assessmentId: v.id("complianceAssessments"),
    completionNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (!canTransitionAssessment(assessment.status, "completed")) {
      throw new Error(
        `A ${COMPLIANCE_ASSESSMENT_STATUS_LABELS[assessment.status].toLowerCase()} assessment cannot be completed again`,
      );
    }
    const completionNotes = requireNarrative(
      args.completionNotes,
      "Completion notes",
      4000,
    );
    if (completionNotes.length < ASSESSMENT_NOTES_MIN) {
      throw new Error(
        `Completion notes must be at least ${ASSESSMENT_NOTES_MIN} characters describing the assessment`,
      );
    }

    const items = await ctx.db
      .query("complianceAssessmentItems")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("assessmentId", assessment._id),
      )
      .take(ITEM_SCAN_LIMIT);
    const outstanding = items.filter((item) => item.outcome === "not_assessed");
    if (outstanding.length > 0) {
      throw new Error(
        `${outstanding.length} control(s) in this assessment are still not assessed — record an outcome (or not applicable) for every control before completing`,
      );
    }

    const now = Date.now();
    await ctx.db.patch(assessment._id, {
      status: "completed",
      completionNotes,
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_completed",
      entityType: "complianceAssessments",
      entityId: String(assessment._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(assessment.frameworkId),
      summary: `Assessment ${assessment.reference} completed across ${items.length} control(s)${
        assessment.reviewRequired ? " — awaiting independent review" : ""
      }`,
    });
    return {
      ok: true as const,
      status: "completed" as ComplianceAssessmentStatus,
      reviewedRequired: assessment.reviewRequired,
    };
  },
});

/**
 * Independent review of a completed cycle. The reviewer can be neither the
 * assessor nor the person who completed it.
 */
export const reviewAssessment = mutation({
  args: {
    assessmentId: v.id("complianceAssessments"),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (assessment.status !== "completed") {
      throw new Error("Only a completed assessment can be reviewed");
    }
    if (!assessment.reviewRequired) {
      throw new Error("This assessment does not require independent review");
    }
    if (
      assessment.assessorUserId === manager.userId ||
      assessment.completedByUserId === manager.userId
    ) {
      throw new Error(
        "Independent review must be recorded by someone other than the assessor or the person who completed the assessment",
      );
    }
    const reviewNotes = optionalText(
      args.reviewNotes,
      "Review notes",
      ASSESSMENT_REVIEW_NOTES_MAX,
    );

    await ctx.db.patch(assessment._id, {
      status: "reviewed",
      reviewNotes,
      reviewedAt: Date.now(),
      reviewedByUserId: manager.userId,
      reviewedByLabel: manager.label,
      updatedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_reviewed",
      entityType: "complianceAssessments",
      entityId: String(assessment._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(assessment.frameworkId),
      summary: `Assessment ${assessment.reference} independently reviewed by ${manager.label}`,
    });
    return { ok: true as const, status: "reviewed" as ComplianceAssessmentStatus };
  },
});

/**
 * Record a correction as a NEW draft cycle that supersedes a finalised one. The
 * original cycle and its items are never modified, so the earlier result stays
 * readable exactly as issued.
 */
export const supersedeAssessment = mutation({
  args: {
    assessmentId: v.id("complianceAssessments"),
    title: v.string(),
    amendmentReason: v.string(),
    periodLabel: v.optional(v.string()),
    startDate: v.optional(v.number()),
    dueDate: v.optional(v.number()),
    assessorUserId: v.optional(v.id("users")),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const original = await requireAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (!isFinalAssessment(original.status)) {
      throw new Error(
        "Only a completed or reviewed assessment can be superseded — edit the open assessment instead",
      );
    }
    const already = await ctx.db
      .query("complianceAssessments")
      .withIndex("by_organization_supersedes", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("supersedesAssessmentId", original._id),
      )
      .first();
    if (already) {
      throw new Error(
        `Assessment ${original.reference} is already superseded by ${already.reference}`,
      );
    }
    const framework = await requireOwnedFramework(
      ctx,
      manager.organizationId,
      original.frameworkId,
    );

    const title = requireText(args.title, "Assessment title", ASSESSMENT_TITLE_MAX);
    const amendmentReason = requireNarrative(
      args.amendmentReason,
      "Amendment reason",
      ASSESSMENT_SCOPE_MAX,
    );
    const periodLabel = optionalText(
      args.periodLabel,
      "Assessment period",
      ASSESSMENT_PERIOD_MAX,
    );
    const startDate = optionalDate(args.startDate, "Start date");
    const dueDate = optionalDate(args.dueDate, "Due date");
    if (startDate !== undefined && dueDate !== undefined && dueDate < startDate) {
      throw new Error("Due date cannot precede the start date");
    }
    const assessorLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.assessorUserId,
      manager.label,
      "Assessor",
    );

    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization_framework", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("frameworkId", framework._id),
      )
      .take(CONTROL_SCAN_LIMIT);
    if (controls.length === 0) {
      throw new Error("This framework has no controls to reassess");
    }

    const reference = await nextAssessmentReference(ctx, manager.organizationId);
    const now = Date.now();
    const assessmentId = await ctx.db.insert("complianceAssessments", {
      organizationId: manager.organizationId,
      frameworkId: framework._id,
      reference,
      title,
      scope: original.scope,
      periodLabel: periodLabel ?? original.periodLabel,
      startDate,
      dueDate,
      assessorUserId: args.assessorUserId,
      assessorLabel,
      status: "draft",
      reviewRequired: original.reviewRequired,
      supersedesAssessmentId: original._id,
      amendmentReason,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });
    for (const control of controls) {
      await ctx.db.insert("complianceAssessmentItems", {
        organizationId: manager.organizationId,
        assessmentId,
        frameworkId: framework._id,
        controlId: control._id,
        controlSnapshot: snapshotControl(control, framework),
        outcome: "not_assessed",
        createdAt: now,
        updatedAt: now,
      });
    }

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_superseded",
      entityType: "complianceAssessments",
      entityId: String(assessmentId),
      relatedEntityType: "complianceAssessments",
      relatedEntityId: String(original._id),
      summary: `Assessment ${reference} supersedes ${original.reference}: ${amendmentReason}. The earlier result is preserved`,
    });

    return { assessmentId, reference, supersedesAssessmentId: original._id };
  },
});

/**
 * Remove an evidence link from an assessment item. The mapping row is retained
 * with its unlink metadata and the evidence itself is never deleted.
 */
export const unlinkAssessmentEvidence = mutation({
  args: {
    mappingId: v.id("complianceAssessmentEvidence"),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const mapping = await ctx.db.get(args.mappingId);
    if (!mapping || mapping.organizationId !== manager.organizationId) {
      throw new Error("Evidence link not found in your organization");
    }
    const assessment = await requireAssessment(
      ctx,
      manager.organizationId,
      mapping.assessmentId,
    );
    if (!isOpenAssessment(assessment.status)) {
      throw new Error(
        "A finalised assessment cannot be changed — record a superseding assessment instead",
      );
    }
    if (!mapping.active) {
      throw new Error("This evidence link has already been removed");
    }
    const reason = requireNarrative(
      args.reason,
      "Unlink reason",
      ASSESSMENT_EVIDENCE_UNLINK_REASON_MAX,
    );
    const now = Date.now();
    await ctx.db.patch(mapping._id, {
      active: false,
      unlinkedAt: now,
      unlinkedByUserId: manager.userId,
      unlinkedByLabel: manager.label,
      unlinkReason: reason,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.assessment_evidence_unlinked",
      entityType: "complianceAssessmentEvidence",
      entityId: String(mapping._id),
      relatedEntityType: "complianceEvidence",
      relatedEntityId: String(mapping.evidenceId),
      summary: `Assessment evidence link removed: ${reason} (evidence record and audit history retained)`,
    });
    return { ok: true as const };
  },
});

/** Items in one cycle (used by tests and the detail dialog's filters). */
export const listAssessmentItems = query({
  args: {
    assessmentId: v.id("complianceAssessments"),
    outcome: v.optional(complianceAssessmentOutcomeValidator),
  },
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
      .take(ITEM_SCAN_LIMIT);
    return items
      .filter((item) => !args.outcome || item.outcome === args.outcome)
      .map(presentItem);
  },
});
