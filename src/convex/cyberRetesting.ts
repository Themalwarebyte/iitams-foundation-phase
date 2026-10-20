import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_RETEST_REVIEW_DECISION_LABELS,
  CYBER_RETEST_STATUS_LABELS,
  CYBER_SCOPE_MAX,
  CYBER_TEST_OBSERVATIONS_MIN,
  CYBER_TEST_OUTCOME_LABELS,
  CYBER_TEST_REVIEW_MIN,
  CYBER_TEXT_MAX,
  canTransitionRetest,
  cyberRetestReviewDecisionValidator,
  cyberRetestStatusValidator,
  cyberTestOutcomeValidator,
  isRecordedOutcome,
  isRetestEligible,
  isTargetExcluded,
  isTargetInAuthorizedScope,
  isWithinTestingWindow,
  retestExecutionStatus,
  type CyberRetestStatus,
} from "../lib/cyber";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalDate,
  presentCyberEvidence,
  presentEvent,
  requireCyberManager,
  requireNarrative,
  requireOwnedAssessment,
  requireOwnedVulnerability,
  requireText,
  resolveCyberAccess,
  resolveMemberLabel,
} from "./cyberCore";

/**
 * Security retesting and independent verification (Phase 4A — Batch 2B)
 * ======================================================================
 * A retest is a fresh record against a previously recorded failed or
 * inconclusive test. It extends the Batch-2A testing model; there is no second
 * assessment, test-case, vulnerability or evidence table.
 *
 * Deliberate properties:
 *  - The original result is never modified. The original test stays
 *    `completed` with its historical outcome; the retest carries its own
 *    evidence, observations, reviewer and append-only history.
 *  - A recorded pass is a CLAIM, not verification. A retest is only verified
 *    once a different, authorized member reviews it, and it still closes no
 *    vulnerability: closure stays with the Batch-1 verification workflow.
 *  - Execution (start) is refused outside the recorded written authorization:
 *    no authorized scope, a closed window, an excluded target or an unlisted
 *    target all refuse, with the same reason text the UI shows.
 *  - Every referenced record is re-validated against the caller's
 *    organization; no function accepts an organization or role argument.
 *  - The ICT risk register is never touched.
 */

const SCAN_LIMIT = 2000;
const PAGE_SCAN_LIMIT = 250;
const PAGE_LIMIT_MAX = 100;
const EVENT_LIMIT = 200;
const EVIDENCE_LIMIT = 100;

export type RetestSummary = {
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

export function emptyRetestSummary(): RetestSummary {
  return {
    total: 0,
    planned: 0,
    inProgress: 0,
    awaitingReview: 0,
    reviewed: 0,
    rejected: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
  };
}

export function summarizeRetests(
  rows: Array<Doc<"cyberRetests">>,
): RetestSummary {
  const summary = emptyRetestSummary();
  for (const row of rows) {
    summary.total += 1;
    if (row.status === "planned") summary.planned += 1;
    if (row.status === "in_progress") summary.inProgress += 1;
    if (row.status === "completed") summary.awaitingReview += 1;
    if (row.status === "reviewed") summary.reviewed += 1;
    if (row.status === "rejected") summary.rejected += 1;
    if (row.outcome === "pass") summary.passed += 1;
    if (row.outcome === "fail") summary.failed += 1;
    if (row.outcome === "inconclusive") summary.inconclusive += 1;
  }
  return summary;
}

async function requireOwnedTestCase(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  testCaseId: Id<"cyberTestCases">,
): Promise<Doc<"cyberTestCases">> {
  const row = await ctx.db.get(testCaseId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Security test case not found in your organization");
  }
  return row;
}

async function requireOwnedRetest(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  retestId: Id<"cyberRetests">,
): Promise<Doc<"cyberRetests">> {
  const row = await ctx.db.get(retestId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Security retest not found in your organization");
  }
  return row;
}

async function validateEvidence(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"securityAssessments">,
  evidenceIds: Id<"cyberEvidence">[],
): Promise<Id<"cyberEvidence">[]> {
  const unique = [...new Set(evidenceIds.map(String))] as Id<"cyberEvidence">[];
  if (unique.length > EVIDENCE_LIMIT) {
    throw new Error(`At most ${EVIDENCE_LIMIT} evidence records can be attached`);
  }
  for (const evidenceId of unique) {
    const record = await ctx.db.get(evidenceId);
    if (!record || record.organizationId !== organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (
      record.assessmentId !== undefined &&
      record.assessmentId !== assessmentId
    ) {
      throw new Error(
        "Evidence can only be attached when it belongs to this assessment and organization",
      );
    }
  }
  return unique;
}

function assertRetestTransition(
  from: CyberRetestStatus,
  to: CyberRetestStatus,
  action: string,
) {
  if (!canTransitionRetest(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_RETEST_STATUS_LABELS[from]} → ${CYBER_RETEST_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

function retestExecution(
  assessment: Doc<"securityAssessments">,
  target: string,
  now: number,
) {
  return retestExecutionStatus({
    assessmentStatus: assessment.status,
    scopeStatus: assessment.scopeStatus,
    systemsInScope: assessment.systemsInScope,
    exclusions: assessment.exclusions,
    authorizedStartAt: assessment.authorizedStartAt,
    authorizedEndAt: assessment.authorizedEndAt,
    target,
    now,
  });
}

function presentRetest(
  row: Doc<"cyberRetests">,
  input: {
    original: Doc<"cyberTestCases">;
    assessment: Doc<"securityAssessments">;
    vulnerability: Doc<"vulnerabilities"> | null;
    now: number;
  },
) {
  const execution = retestExecution(input.assessment, row.systemUnderTest, input.now);
  return {
    _id: row._id,
    assessmentId: row.assessmentId,
    originalTestCaseId: row.originalTestCaseId,
    originalTestReference: input.original.reference,
    originalTestOutcome: input.original.outcome,
    originalTestOutcomeLabel: CYBER_TEST_OUTCOME_LABELS[input.original.outcome],
    originalTestReviewedAt: input.original.reviewedAt ?? null,
    reference: row.reference,
    reason: row.reason,
    scope: row.scope,
    systemUnderTest: row.systemUnderTest,
    procedure: row.procedure,
    testerUserId: row.testerUserId ?? null,
    testerLabel: row.testerLabel,
    plannedDate: row.plannedDate ?? null,
    actualDate: row.actualDate ?? null,
    status: row.status,
    statusLabel: CYBER_RETEST_STATUS_LABELS[row.status],
    outcome: row.outcome,
    outcomeLabel: CYBER_TEST_OUTCOME_LABELS[row.outcome],
    observations: row.observations ?? null,
    evidenceIds: row.evidenceIds.map(String),
    vulnerabilityId: row.vulnerabilityId ?? null,
    vulnerabilityReference: input.vulnerability?.reference ?? null,
    vulnerabilityTitle: input.vulnerability?.title ?? null,
    vulnerabilityStatus: input.vulnerability?.status ?? null,
    startedAt: row.startedAt ?? null,
    startedByLabel: row.startedByLabel ?? null,
    completedAt: row.completedAt ?? null,
    completedByUserId: row.completedByUserId ?? null,
    completedByLabel: row.completedByLabel ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByLabel: row.reviewedByLabel ?? null,
    reviewDecision: row.reviewDecision ?? null,
    reviewDecisionLabel: row.reviewDecision
      ? CYBER_RETEST_REVIEW_DECISION_LABELS[row.reviewDecision]
      : null,
    reviewNotes: row.reviewNotes ?? null,
    verified: row.status === "reviewed",
    executionAllowed: execution.allowed,
    executionBlockedReason: execution.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type PresentedRetest = ReturnType<typeof presentRetest>;

/** Retests recorded against one test case, bounded and organization-scoped. */
export async function retestsForTestCase(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  testCaseId: Id<"cyberTestCases">,
): Promise<Doc<"cyberRetests">[]> {
  return await ctx.db
    .query("cyberRetests")
    .withIndex("by_organization_original", (q) =>
      q.eq("organizationId", organizationId).eq("originalTestCaseId", testCaseId),
    )
    .take(SCAN_LIMIT);
}

/** Plan a retest against a previously recorded failed/inconclusive test. */
export const createRetest = mutation({
  args: {
    originalTestCaseId: v.id("cyberTestCases"),
    vulnerabilityId: v.optional(v.id("vulnerabilities")),
    reason: v.string(),
    scope: v.string(),
    systemUnderTest: v.string(),
    procedure: v.string(),
    testerUserId: v.optional(v.id("users")),
    plannedDate: v.optional(v.number()),
    evidenceIds: v.optional(v.array(v.id("cyberEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const original = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.originalTestCaseId,
    );
    if (!isRetestEligible(original.status, original.outcome)) {
      throw new Error(
        "A retest can only follow a completed test case whose recorded outcome is fail or inconclusive",
      );
    }
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      original.assessmentId,
    );
    if (assessment.status === "cancelled") {
      throw new Error("A retest cannot be planned against a cancelled assessment");
    }
    if ((assessment.scopeStatus ?? "draft") !== "authorized") {
      throw new Error(
        "A retest requires an authorized testing scope; record a new authorization decision first",
      );
    }

    const reason = requireNarrative(
      args.reason,
      "Reason for retesting",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const scope = requireText(args.scope, "Retest scope", CYBER_SCOPE_MAX, 4);
    const systemUnderTest = requireText(
      args.systemUnderTest,
      "System or component under test",
      CYBER_SCOPE_MAX,
      2,
    );
    const procedure = requireNarrative(
      args.procedure,
      "Retest procedure",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const testerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.testerUserId,
      manager.label,
      "Assigned tester",
    );
    const plannedDate = optionalDate(args.plannedDate, "Planned retest date");

    let vulnerabilityId: Id<"vulnerabilities"> | undefined =
      original.vulnerabilityId;
    if (args.vulnerabilityId !== undefined) {
      const vulnerability = await requireOwnedVulnerability(
        ctx,
        manager.organizationId,
        args.vulnerabilityId,
      );
      vulnerabilityId = vulnerability._id;
    } else if (vulnerabilityId !== undefined) {
      await requireOwnedVulnerability(ctx, manager.organizationId, vulnerabilityId);
    }
    const evidenceIds = args.evidenceIds
      ? await validateEvidence(
          ctx,
          manager.organizationId,
          assessment._id,
          args.evidenceIds,
        )
      : [];

    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "cyberRetests",
      manager.organizationId,
      "RT",
    );
    const retestId = await ctx.db.insert("cyberRetests", {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      originalTestCaseId: original._id,
      vulnerabilityId,
      reference,
      reason,
      scope,
      systemUnderTest,
      procedure,
      testerUserId: args.testerUserId,
      testerLabel,
      plannedDate,
      status: "planned",
      outcome: "not_tested",
      evidenceIds,
      createdAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      testCaseId: original._id,
      retestId,
      vulnerabilityId,
      type: "retest_created",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Retest ${reference} planned for test ${original.reference}`,
      reason: reason.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.retest_created",
      entityType: "cyberRetests",
      entityId: String(retestId),
      relatedEntityType: "cyberTestCases",
      relatedEntityId: String(original._id),
      summary: `Planned retest ${reference} for ${original.reference}`,
    });

    return { retestId, reference, testCaseId: original._id };
  },
});

/** Start a retest. Refused outside the recorded written authorization. */
export const startRetest = mutation({
  args: { retestId: v.id("cyberRetests") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedRetest(
      ctx,
      manager.organizationId,
      args.retestId,
    );
    assertRetestTransition(row.status, "in_progress", "start");
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      row.assessmentId,
    );
    const now = Date.now();
    const execution = retestExecution(assessment, row.systemUnderTest, now);
    if (!execution.allowed) {
      throw new Error(execution.reason ?? "Retest execution is not authorized");
    }
    await ctx.db.patch(row._id, {
      status: "in_progress",
      startedAt: now,
      startedByUserId: manager.userId,
      startedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row.originalTestCaseId,
      retestId: row._id,
      vulnerabilityId: row.vulnerabilityId,
      type: "retest_started",
      fromStatus: row.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Retest ${row.reference} started`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.retest_started",
      entityType: "cyberRetests",
      entityId: String(row._id),
      relatedEntityType: "cyberTestCases",
      relatedEntityId: String(row.originalTestCaseId),
      summary: `Started retest ${row.reference}`,
    });
    return { status: "in_progress" as const };
  },
});

/**
 * Record the retest result. This is the tester's claim: it never closes,
 * verifies or otherwise changes the linked vulnerability.
 */
export const completeRetest = mutation({
  args: {
    retestId: v.id("cyberRetests"),
    outcome: cyberTestOutcomeValidator,
    observations: v.string(),
    actualDate: v.number(),
    evidenceIds: v.optional(v.array(v.id("cyberEvidence"))),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedRetest(
      ctx,
      manager.organizationId,
      args.retestId,
    );
    assertRetestTransition(row.status, "completed", "complete");
    if (!isRecordedOutcome(args.outcome)) {
      throw new Error(
        "A completed retest requires a recorded outcome (pass, fail or inconclusive)",
      );
    }
    const observations = requireNarrative(
      args.observations,
      "Actual observations",
      CYBER_TEXT_MAX,
      CYBER_TEST_OBSERVATIONS_MIN,
    );
    const actualDate = optionalDate(args.actualDate, "Actual retest date");
    if (actualDate === undefined) {
      throw new Error("An actual retest date is required to complete a retest");
    }
    const evidenceIds = args.evidenceIds
      ? await validateEvidence(
          ctx,
          manager.organizationId,
          row.assessmentId,
          args.evidenceIds,
        )
      : row.evidenceIds;

    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "completed",
      outcome: args.outcome,
      observations,
      actualDate,
      evidenceIds,
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row.originalTestCaseId,
      retestId: row._id,
      vulnerabilityId: row.vulnerabilityId,
      type: "retest_completed",
      fromStatus: row.status,
      toStatus: "completed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Retest ${row.reference} recorded outcome ${CYBER_TEST_OUTCOME_LABELS[args.outcome]} (awaiting independent review)`,
      reason: observations.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.retest_completed",
      entityType: "cyberRetests",
      entityId: String(row._id),
      relatedEntityType: "cyberTestCases",
      relatedEntityId: String(row.originalTestCaseId),
      summary: `Completed retest ${row.reference} (${CYBER_TEST_OUTCOME_LABELS[args.outcome]})`,
    });
    // NO vulnerability patch here: a recorded retest pass closes nothing.
    return { status: "completed" as const, outcome: args.outcome };
  },
});

/**
 * Independent review of a completed retest. The reviewer must be a different
 * active member from the tester and the executor, and the decision is final:
 * a rejected retest requires a new retest, never a rewrite of this one.
 */
export const reviewRetest = mutation({
  args: {
    retestId: v.id("cyberRetests"),
    decision: cyberRetestReviewDecisionValidator,
    reviewNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedRetest(
      ctx,
      manager.organizationId,
      args.retestId,
    );
    assertRetestTransition(
      row.status,
      args.decision === "approved" ? "reviewed" : "rejected",
      "review",
    );
    if (
      row.testerUserId === manager.userId ||
      row.completedByUserId === manager.userId
    ) {
      throw new Error(
        "Independent review required: the tester or executor cannot review their own retest",
      );
    }
    const reviewNotes = requireNarrative(
      args.reviewNotes,
      "Review notes",
      CYBER_TEXT_MAX,
      CYBER_TEST_REVIEW_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: args.decision === "approved" ? "reviewed" : "rejected",
      reviewDecision: args.decision,
      reviewNotes,
      reviewedAt: now,
      reviewedByUserId: manager.userId,
      reviewedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row.originalTestCaseId,
      retestId: row._id,
      vulnerabilityId: row.vulnerabilityId,
      type: args.decision === "approved" ? "retest_reviewed" : "retest_rejected",
      fromStatus: row.status,
      toStatus: args.decision === "approved" ? "reviewed" : "rejected",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary:
        args.decision === "approved"
          ? `Retest ${row.reference} independently reviewed and approved`
          : `Retest ${row.reference} reviewed and rejected: further remediation required`,
      reason: reviewNotes.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action:
        args.decision === "approved"
          ? "cyber.retest_reviewed"
          : "cyber.retest_rejected",
      entityType: "cyberRetests",
      entityId: String(row._id),
      relatedEntityType: "cyberTestCases",
      relatedEntityId: String(row.originalTestCaseId),
      summary: `Reviewed retest ${row.reference} (${CYBER_RETEST_REVIEW_DECISION_LABELS[args.decision]})`,
    });
    return {
      status: args.decision === "approved" ? ("reviewed" as const) : ("rejected" as const),
    };
  },
});

/** One retest with history, evidence and the original result it follows. */
export const getRetest = query({
  args: { retestId: v.id("cyberRetests") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const row = await requireOwnedRetest(
      ctx,
      access.organizationId,
      args.retestId,
    );
    const original = await requireOwnedTestCase(
      ctx,
      access.organizationId,
      row.originalTestCaseId,
    );
    const assessment = await requireOwnedAssessment(
      ctx,
      access.organizationId,
      row.assessmentId,
    );
    const vulnerability = row.vulnerabilityId
      ? await ctx.db.get(row.vulnerabilityId)
      : null;
    const events = await ctx.db
      .query("vulnerabilityEvents")
      .withIndex("by_organization_retest", (q) =>
        q.eq("organizationId", access.organizationId).eq("retestId", args.retestId),
      )
      .take(EVENT_LIMIT);
    const evidence: Array<ReturnType<typeof presentCyberEvidence>> = [];
    for (const evidenceId of row.evidenceIds.slice(0, EVIDENCE_LIMIT)) {
      const record = await ctx.db.get(evidenceId);
      if (record && record.organizationId === access.organizationId) {
        evidence.push(presentCyberEvidence(record));
      }
    }
    return {
      retest: presentRetest(row, {
        original,
        assessment,
        vulnerability:
          vulnerability && vulnerability.organizationId === access.organizationId
            ? vulnerability
            : null,
        now: Date.now(),
      }),
      originalTest: {
        testCaseId: original._id,
        reference: original.reference,
        title: original.title,
        status: original.status,
        outcome: original.outcome,
        outcomeLabel: CYBER_TEST_OUTCOME_LABELS[original.outcome],
        reviewedAt: original.reviewedAt ?? null,
        reviewedByLabel: original.reviewedByLabel ?? null,
      },
      events: events
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(presentEvent),
      evidence,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Bounded, index-backed retest register. */
export const listRetests = query({
  args: {
    testCaseId: v.optional(v.id("cyberTestCases")),
    assessmentId: v.optional(v.id("securityAssessments")),
    status: v.optional(cyberRetestStatusValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    if (args.testCaseId) {
      await requireOwnedTestCase(ctx, access.organizationId, args.testCaseId);
    }
    if (args.assessmentId) {
      await requireOwnedAssessment(
        ctx,
        access.organizationId,
        args.assessmentId,
      );
    }
    const scan = await ctx.db
      .query("cyberRetests")
      .withIndex("by_organization_created", (q) => {
        const scoped = q.eq("organizationId", access.organizationId);
        return args.cursor !== undefined
          ? scoped.lt("createdAt", args.cursor)
          : scoped;
      })
      .order("desc")
      .take(PAGE_SCAN_LIMIT);
    const filtered = scan
      .filter((row) =>
        args.testCaseId ? row.originalTestCaseId === args.testCaseId : true,
      )
      .filter((row) =>
        args.assessmentId ? row.assessmentId === args.assessmentId : true,
      )
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) =>
        args.cursor !== undefined ? row.createdAt < args.cursor : true,
      );
    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);
    return {
      rows: page.map((row) => ({
        _id: row._id,
        reference: row.reference,
        originalTestCaseId: row.originalTestCaseId,
        assessmentId: row.assessmentId,
        status: row.status,
        statusLabel: CYBER_RETEST_STATUS_LABELS[row.status],
        outcome: row.outcome,
        outcomeLabel: CYBER_TEST_OUTCOME_LABELS[row.outcome],
        testerLabel: row.testerLabel,
        systemUnderTest: row.systemUnderTest,
        reviewedAt: row.reviewedAt ?? null,
        reviewDecision: row.reviewDecision ?? null,
        vulnerabilityId: row.vulnerabilityId ?? null,
        createdAt: row.createdAt,
      })),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Retests recorded for one test case with the gate state the UI must show. */
export const retestsForTestCaseQuery = query({
  args: { testCaseId: v.id("cyberTestCases") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const original = await requireOwnedTestCase(
      ctx,
      access.organizationId,
      args.testCaseId,
    );
    const assessment = await requireOwnedAssessment(
      ctx,
      access.organizationId,
      original.assessmentId,
    );
    const rows = await retestsForTestCase(
      ctx,
      access.organizationId,
      args.testCaseId,
    );
    const now = Date.now();
    return {
      eligible: isRetestEligible(original.status, original.outcome),
      eligibleReason: isRetestEligible(original.status, original.outcome)
        ? null
        : "A retest can only follow a completed test case whose recorded outcome is fail or inconclusive",
      originalOutcome: original.outcome,
      originalOutcomeLabel: CYBER_TEST_OUTCOME_LABELS[original.outcome],
      assessment: {
        assessmentId: assessment._id,
        name: assessment.name,
        reference: assessment.reference ?? null,
        status: assessment.status,
        scopeStatus: assessment.scopeStatus ?? "draft",
        systemsInScope: assessment.systemsInScope ?? null,
        exclusions: assessment.exclusions ?? null,
        authorizedStartAt: assessment.authorizedStartAt ?? null,
        authorizedEndAt: assessment.authorizedEndAt ?? null,
        windowOpen: isWithinTestingWindow(
          assessment.authorizedStartAt,
          assessment.authorizedEndAt,
          now,
        ),
        targetInScope: isTargetInAuthorizedScope(
          assessment.systemsInScope,
          original.systemUnderTest,
        ),
        targetExcluded: isTargetExcluded(
          assessment.exclusions,
          original.systemUnderTest,
        ),
      },
      retests: await Promise.all(
        rows
          .slice()
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(async (row) => {
            const vulnerability = row.vulnerabilityId
              ? await ctx.db.get(row.vulnerabilityId)
              : null;
            return presentRetest(row, {
              original,
              assessment,
              vulnerability:
                vulnerability &&
                vulnerability.organizationId === access.organizationId
                  ? vulnerability
                  : null,
              now,
            });
          }),
      ),
      summary: summarizeRetests(rows),
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/**
 * Remediation traceability: original test → recorded failure → linked
 * vulnerability → retests → independent verification → closure. Not every
 * failed test has a vulnerability and not every vulnerability came from a test;
 * those absences are reported as such rather than invented.
 */
export const testTrace = query({
  args: { testCaseId: v.id("cyberTestCases") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const original = await requireOwnedTestCase(
      ctx,
      access.organizationId,
      args.testCaseId,
    );
    const retests = await retestsForTestCase(
      ctx,
      access.organizationId,
      args.testCaseId,
    );
    const vulnerability = original.vulnerabilityId
      ? await ctx.db.get(original.vulnerabilityId)
      : null;
    const owned =
      vulnerability && vulnerability.organizationId === access.organizationId
        ? vulnerability
        : null;
    const actions = owned
      ? await ctx.db
          .query("vulnerabilityRemediationActions")
          .withIndex("by_organization_vulnerability", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("vulnerabilityId", owned._id),
          )
          .take(SCAN_LIMIT)
      : [];
    const events = await ctx.db
      .query("vulnerabilityEvents")
      .withIndex("by_organization_test", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("testCaseId", args.testCaseId),
      )
      .take(EVENT_LIMIT);
    return {
      test: {
        testCaseId: original._id,
        reference: original.reference,
        title: original.title,
        status: original.status,
        outcome: original.outcome,
        outcomeLabel: CYBER_TEST_OUTCOME_LABELS[original.outcome],
        observations: original.observations ?? null,
        reviewedAt: original.reviewedAt ?? null,
      },
      retests: retests.map((row) => ({
        _id: row._id,
        reference: row.reference,
        status: row.status,
        statusLabel: CYBER_RETEST_STATUS_LABELS[row.status],
        outcome: row.outcome,
        outcomeLabel: CYBER_TEST_OUTCOME_LABELS[row.outcome],
        reviewedAt: row.reviewedAt ?? null,
        reviewDecision: row.reviewDecision ?? null,
      })),
      vulnerability: owned
        ? {
            vulnerabilityId: owned._id,
            reference: owned.reference ?? null,
            title: owned.title,
            severity: owned.severity,
            status: owned.status,
            remediatedAt: owned.remediatedAt ?? null,
            verifiedAt: owned.verifiedAt ?? null,
            closedAt: owned.closedAt ?? null,
            actions: actions.length,
            outstandingActions: actions.filter(
              (action) => action.status !== "closed" && action.status !== "cancelled",
            ).length,
          }
        : null,
      // Explicit distinctions rather than implied certainty.
      notes: {
        failureWithoutVulnerability: !owned && original.outcome === "fail",
        vulnerabilityWithoutTest: false,
        vulnerabilityClosureIsSeparate: true,
      },
      events: events
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(presentEvent),
      canManage: access.canManage,
    };
  },
});
