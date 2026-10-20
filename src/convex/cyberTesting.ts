import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CYBER_AUTHORIZATION_REF_MAX,
  CYBER_METHODOLOGY_MAX,
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_SCOPE_MAX,
  CYBER_SUBTYPE_MAX,
  CYBER_TEST_CATEGORY_LABELS,
  CYBER_TEST_EXPECTED_MIN,
  CYBER_TEST_OBSERVATIONS_MIN,
  CYBER_TEST_OUTCOME_LABELS,
  CYBER_TEST_REVIEW_MIN,
  CYBER_TEST_STATUS_LABELS,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  canTransitionTest,
  cyberTestCategoryValidator,
  cyberTestOutcomeValidator,
  cyberTestStatusValidator,
  isConfirmedVulnerabilityStatus,
  isOutstandingTest,
  isRecordedOutcome,
  mayExecuteTests,
  testingExecutionStatus,
  type CyberTestStatus,
} from "../lib/cyber";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalDate,
  optionalText,
  presentCyberEvidence,
  presentEvent,
  requireCyberManager,
  requireNarrative,
  requireOwnedAssessment,
  requireOwnedVulnerability,
  requireText,
  resolveCyberAccess,
  resolveMemberLabel,
  type CyberAccess,
} from "./cyberCore";

/**
 * Security testing engagements and test cases (Phase 4A — Batch 2A)
 * =================================================================
 * Extends the existing cybersecurity assessment register; there is no second
 * assessment table and no second vulnerability register.
 *
 * Deliberate properties:
 *  - Recording an engagement never authorizes intrusive work. A scope is a
 *    DRAFT until an authorized user records in-scope systems, explicit
 *    exclusions, a window, a lead tester, methodology, rules of engagement and
 *    an authorization reference. Execution is refused before that point.
 *  - No test is executed by the application: this module records authorized
 *    human testing. There is no scanner, exploit or penetration-test runner.
 *  - Status and outcome are separate fields. `completed` is not a result, and
 *    an outcome can never be inferred from a status.
 *  - A failed test NEVER creates, changes or verifies a vulnerability. Linking
 *    an existing vulnerability is traceability only; the vulnerability keeps
 *    its own governed lifecycle.
 *  - Completed test cases are immutable. Corrections are new test cases, and
 *    the reviewer of a completed test must be a different person from the
 *    tester/executor (one recorded review, append-only history).
 *  - Every reference (assessment, tester, evidence, vulnerability) is
 *    re-validated against the caller's organization; no function accepts an
 *    organization or role argument.
 */

/** Aggregate scan cap for the honest organization summary (documented). */
const SUMMARY_SCAN_LIMIT = 2000;
/** Rows inspected per page for filtered listing (bounded read). */
const PAGE_SCAN_LIMIT = 250;
const PAGE_LIMIT_MAX = 100;
const EVENT_LIMIT = 200;
const EVIDENCE_LIMIT = 100;

export type TestCaseSummary = {
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

export function emptyTestSummary(): TestCaseSummary {
  return {
    total: 0,
    planned: 0,
    inProgress: 0,
    completed: 0,
    notApplicable: 0,
    cancelled: 0,
    passed: 0,
    failed: 0,
    inconclusive: 0,
    notTested: 0,
    outstanding: 0,
    linkedVulnerability: 0,
    linkedConfirmedVulnerability: 0,
  };
}

/**
 * Roll-up of test cases. `linkedConfirmedVulnerability` counts links to
 * vulnerabilities a human actually confirmed — never merely recorded as open.
 */
export function summarizeTestCases(
  rows: Array<Doc<"cyberTestCases">>,
  vulnerabilityStatusById: Map<string, Doc<"vulnerabilities">["status"]>,
): TestCaseSummary {
  const summary = emptyTestSummary();
  for (const row of rows) {
    summary.total += 1;
    if (row.status === "planned") summary.planned += 1;
    if (row.status === "in_progress") summary.inProgress += 1;
    if (row.status === "completed") summary.completed += 1;
    if (row.status === "not_applicable") summary.notApplicable += 1;
    if (row.status === "cancelled") summary.cancelled += 1;
    if (isOutstandingTest(row.status)) summary.outstanding += 1;
    if (row.outcome === "pass") summary.passed += 1;
    if (row.outcome === "fail") summary.failed += 1;
    if (row.outcome === "inconclusive") summary.inconclusive += 1;
    if (row.outcome === "not_tested") summary.notTested += 1;
    if (row.vulnerabilityId) {
      summary.linkedVulnerability += 1;
      const status = vulnerabilityStatusById.get(String(row.vulnerabilityId));
      if (status && isConfirmedVulnerabilityStatus(status)) {
        summary.linkedConfirmedVulnerability += 1;
      }
    }
  }
  return summary;
}

/** Test cases for one assessment (bounded) — used by the detail views. */
export async function testsForAssessment(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"securityAssessments">,
): Promise<Doc<"cyberTestCases">[]> {
  return await ctx.db
    .query("cyberTestCases")
    .withIndex("by_organization_assessment", (q) =>
      q.eq("organizationId", organizationId).eq("assessmentId", assessmentId),
    )
    .take(SUMMARY_SCAN_LIMIT);
}

/**
 * The mandatory-test policy: an assessment may only be completed once every
 * one of its test cases has reached a terminal state (completed, not
 * applicable or cancelled). Returned for the completion gate.
 */
export async function outstandingTestsForAssessment(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"securityAssessments">,
): Promise<Doc<"cyberTestCases">[]> {
  const rows = await testsForAssessment(ctx, organizationId, assessmentId);
  return rows.filter((row) => isOutstandingTest(row.status));
}

async function vulnerabilityStatusMap(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
): Promise<Map<string, Doc<"vulnerabilities">["status"]>> {
  const rows = await ctx.db
    .query("vulnerabilities")
    .withIndex("by_organization", (q) =>
      q.eq("organizationId", organizationId),
    )
    .take(SUMMARY_SCAN_LIMIT);
  return new Map(rows.map((row) => [String(row._id), row.status]));
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

function assertTransition(
  from: CyberTestStatus,
  to: CyberTestStatus,
  action: string,
) {
  if (!canTransitionTest(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_TEST_STATUS_LABELS[from]} → ${CYBER_TEST_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

/** Evidence may only be referenced when it belongs to the same organization. */
async function validateEvidenceIds(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"securityAssessments">,
  evidenceIds: Id<"cyberEvidence">[],
): Promise<Id<"cyberEvidence">[]> {
  const unique = [...new Set(evidenceIds.map(String))] as Id<"cyberEvidence">[];
  if (unique.length === 0) {
    throw new Error("Select at least one evidence record to attach");
  }
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

function presentTestCase(
  row: Doc<"cyberTestCases">,
  input: {
    assessment: Doc<"securityAssessments">;
    vulnerability: Doc<"vulnerabilities"> | null;
    now: number;
  },
) {
  const overdue =
    row.plannedDate !== undefined &&
    row.plannedDate < input.now &&
    isOutstandingTest(row.status);
  // The same server-side gate that refuses execution is presented here, so the
  // UI never implies a test may run against an unauthorized target or window.
  const execution = testingExecutionStatus({
    assessmentStatus: input.assessment.status,
    scopeStatus: input.assessment.scopeStatus,
    systemsInScope: input.assessment.systemsInScope,
    exclusions: input.assessment.exclusions,
    authorizedStartAt: input.assessment.authorizedStartAt,
    authorizedEndAt: input.assessment.authorizedEndAt,
    target: row.systemUnderTest,
    now: input.now,
  });
  return {
    _id: row._id,
    assessmentId: row.assessmentId,
    reference: row.reference,
    title: row.title,
    category: row.category,
    categoryLabel: CYBER_TEST_CATEGORY_LABELS[row.category],
    systemUnderTest: row.systemUnderTest,
    objective: row.objective,
    procedure: row.procedure,
    expectedBehaviour: row.expectedBehaviour,
    testerUserId: row.testerUserId ?? null,
    testerLabel: row.testerLabel,
    plannedDate: row.plannedDate ?? null,
    executionDate: row.executionDate ?? null,
    status: row.status,
    statusLabel: CYBER_TEST_STATUS_LABELS[row.status],
    outcome: row.outcome,
    outcomeLabel: CYBER_TEST_OUTCOME_LABELS[row.outcome],
    recordedOutcome: isRecordedOutcome(row.outcome),
    observations: row.observations ?? null,
    recommendations: row.recommendations ?? null,
    notes: row.notes ?? null,
    evidenceIds: row.evidenceIds.map(String),
    vulnerabilityId: row.vulnerabilityId ?? null,
    vulnerabilityReference: input.vulnerability?.reference ?? null,
    vulnerabilityTitle: input.vulnerability?.title ?? null,
    vulnerabilityStatus: input.vulnerability?.status ?? null,
    vulnerabilityConfirmed: input.vulnerability
      ? isConfirmedVulnerabilityStatus(input.vulnerability.status)
      : false,
    reason: row.reason ?? null,
    startedAt: row.startedAt ?? null,
    startedByLabel: row.startedByLabel ?? null,
    completedAt: row.completedAt ?? null,
    completedByLabel: row.completedByLabel ?? null,
    notApplicableAt: row.notApplicableAt ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancelledByLabel: row.cancelledByLabel ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByLabel: row.reviewedByLabel ?? null,
    reviewNotes: row.reviewNotes ?? null,
    overdue,
    assessmentStatus: input.assessment.status,
    scopeStatus: input.assessment.scopeStatus ?? "draft",
    executionAllowed: execution.allowed,
    executionBlockedReason: execution.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export type PresentedTestCase = ReturnType<typeof presentTestCase>;

async function presentRows(
  ctx: QueryCtx,
  access: CyberAccess,
  rows: Doc<"cyberTestCases">[],
  assessmentsById: Map<string, Doc<"securityAssessments">>,
  vulnerabilitiesById: Map<string, Doc<"vulnerabilities">>,
): Promise<PresentedTestCase[]> {
  const now = Date.now();
  const presented: PresentedTestCase[] = [];
  for (const row of rows) {
    const assessment =
      assessmentsById.get(String(row.assessmentId)) ??
      (await requireOwnedAssessment(ctx, access.organizationId, row.assessmentId));
    const vulnerability = row.vulnerabilityId
      ? vulnerabilitiesById.get(String(row.vulnerabilityId)) ?? null
      : null;
    presented.push(presentTestCase(row, { assessment, vulnerability, now }));
  }
  return presented;
}

/**
 * Test cases + roll-up for ONE assessment, used by the assessment detail view.
 * Bounded by the same scan cap as the register; linked vulnerabilities are
 * re-validated against the caller's organization before they are presented.
 */
export async function assessmentTestingDetail(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessment: Doc<"securityAssessments">,
) {
  const rows = await testsForAssessment(ctx, organizationId, assessment._id);
  const linked = new Map<string, Doc<"vulnerabilities">>();
  const statusById = new Map<string, Doc<"vulnerabilities">["status"]>();
  const ids = [
    ...new Set(
      rows
        .map((row) => (row.vulnerabilityId ? String(row.vulnerabilityId) : null))
        .filter((value): value is string => value !== null),
    ),
  ];
  for (const id of ids) {
    const vulnerability = await ctx.db.get(id as Id<"vulnerabilities">);
    if (vulnerability && vulnerability.organizationId === organizationId) {
      linked.set(String(id), vulnerability);
      statusById.set(String(id), vulnerability.status);
    }
  }
  const now = Date.now();
  return {
    testCases: rows
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((row) =>
        presentTestCase(row, {
          assessment,
          vulnerability: row.vulnerabilityId
            ? linked.get(String(row.vulnerabilityId)) ?? null
            : null,
          now,
        }),
      ),
    summary: summarizeTestCases(rows, statusById),
    outstanding: rows.filter((row) => isOutstandingTest(row.status)).length,
  };
}

/** Bounded, index-backed test-case register with filters and a summary. */
export const listTestCases = query({
  args: {
    assessmentId: v.optional(v.id("securityAssessments")),
    status: v.optional(cyberTestStatusValidator),
    category: v.optional(cyberTestCategoryValidator),
    outcome: v.optional(cyberTestOutcomeValidator),
    search: v.optional(v.string()),
    limit: v.optional(v.number()),
    /** Keyset cursor: the createdAt of the last row of the previous page. */
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    const search = args.search?.trim().toLowerCase() ?? "";
    const cursor =
      args.cursor !== undefined && Number.isFinite(args.cursor)
        ? args.cursor
        : undefined;

    if (args.assessmentId) {
      await requireOwnedAssessment(
        ctx,
        access.organizationId,
        args.assessmentId,
      );
    }

    const scanned = await ctx.db
      .query("cyberTestCases")
      .withIndex(
        args.assessmentId ? "by_organization_assessment" : "by_organization_created",
        (q) => {
          if (args.assessmentId) {
            return q
              .eq("organizationId", access.organizationId)
              .eq("assessmentId", args.assessmentId);
          }
          const scoped = q.eq("organizationId", access.organizationId);
          return cursor !== undefined
            ? scoped.lt("createdAt", cursor)
            : scoped;
        },
      )
      .order("desc")
      .take(PAGE_SCAN_LIMIT);

    const filtered = scanned
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => (args.category ? row.category === args.category : true))
      .filter((row) => (args.outcome ? row.outcome === args.outcome : true))
      .filter((row) => {
        if (!search) return true;
        return [
          row.reference,
          row.title,
          row.systemUnderTest,
          row.testerLabel,
          row.objective,
          row.observations ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .filter((row) => (cursor !== undefined ? row.createdAt < cursor : true))
      .sort((a, b) => b.createdAt - a.createdAt);

    const page = filtered.slice(0, limit);
    // More rows may exist either inside this bounded scan or beyond it; the
    // keyset cursor is only offered when another page is actually possible.
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scanned.length === PAGE_SCAN_LIMIT);
    const nextCursor = hasMore ? page[page.length - 1].createdAt : null;

    const summaryRows = args.assessmentId
      ? await testsForAssessment(ctx, access.organizationId, args.assessmentId)
      : await ctx.db
          .query("cyberTestCases")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId),
          )
          .take(SUMMARY_SCAN_LIMIT);
    const vulnerabilities = await vulnerabilityStatusMap(
      ctx,
      access.organizationId,
    );

    const assessments = await ctx.db
      .query("securityAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SUMMARY_SCAN_LIMIT);
    const assessmentsById = new Map(
      assessments.map((row) => [String(row._id), row]),
    );
    const vulnerabilityRows = await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SUMMARY_SCAN_LIMIT);
    const vulnerabilitiesById = new Map(
      vulnerabilityRows.map((row) => [String(row._id), row]),
    );

    return {
      rows: await presentRows(
        ctx,
        access,
        page,
        assessmentsById,
        vulnerabilitiesById,
      ),
      summary: summarizeTestCases(summaryRows, vulnerabilities),
      nextCursor,
      hasMore: nextCursor !== null,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Organization-scoped testing summary for the assessment register header. */
export const testingSummary = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveCyberAccess(ctx);
    const rows = await ctx.db
      .query("cyberTestCases")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SUMMARY_SCAN_LIMIT);
    const vulnerabilities = await vulnerabilityStatusMap(
      ctx,
      access.organizationId,
    );
    return {
      summary: summarizeTestCases(rows, vulnerabilities),
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** One test case with its append-only history, evidence and linked records. */
export const getTestCase = query({
  args: { testCaseId: v.id("cyberTestCases") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      access.organizationId,
      args.testCaseId,
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
      .withIndex("by_organization_test", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("testCaseId", args.testCaseId),
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
      testCase: presentTestCase(row, {
        assessment,
        vulnerability:
          vulnerability && vulnerability.organizationId === access.organizationId
            ? vulnerability
            : null,
        now: Date.now(),
      }),
      assessment: {
        assessmentId: assessment._id,
        reference: assessment.reference ?? null,
        name: assessment.name,
        status: assessment.status,
        scopeStatus: assessment.scopeStatus ?? "draft",
        executionAllowed: mayExecuteTests(
          assessment.status,
          assessment.scopeStatus,
        ),
        systemsInScope: assessment.systemsInScope ?? null,
        exclusions: assessment.exclusions ?? null,
        methodology: assessment.methodology ?? null,
        rulesOfEngagement: assessment.rulesOfEngagement ?? null,
        authorizationReference: assessment.authorizationReference ?? null,
        authorizedStartAt: assessment.authorizedStartAt ?? null,
        authorizedEndAt: assessment.authorizedEndAt ?? null,
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

/**
 * Record and authorize the testing scope of an engagement. Refused until every
 * required authorization input is present; the engagement itself is never
 * auto-authorized by a type flag or by creating a test case.
 */
export const authorizeTestingScope = mutation({
  args: {
    assessmentId: v.id("securityAssessments"),
    subtype: v.optional(v.string()),
    systemsInScope: v.string(),
    exclusions: v.string(),
    leadTesterUserId: v.optional(v.id("users")),
    methodology: v.string(),
    rulesOfEngagement: v.string(),
    authorizationReference: v.string(),
    authorizedStartAt: v.number(),
    authorizedEndAt: v.number(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (assessment.status === "completed" || assessment.status === "cancelled") {
      throw new Error(
        "A completed or cancelled assessment cannot be authorized for testing",
      );
    }
    if ((assessment.scopeStatus ?? "draft") === "authorized") {
      throw new Error(
        "This testing scope is already authorized; record a new engagement for a new authorization",
      );
    }

    const subtype = optionalText(args.subtype, "Engagement subtype", CYBER_SUBTYPE_MAX);
    const systemsInScope = requireNarrative(
      args.systemsInScope,
      "Systems or applications in scope",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const exclusions = requireNarrative(
      args.exclusions,
      "Explicit exclusions (state “None” when nothing is excluded)",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const methodology = requireText(
      args.methodology,
      "Methodology or standard reference",
      CYBER_METHODOLOGY_MAX,
      CYBER_TEST_REVIEW_MIN,
    );
    const rulesOfEngagement = requireNarrative(
      args.rulesOfEngagement,
      "Rules of engagement",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const authorizationReference = requireText(
      args.authorizationReference,
      "Written authorization reference",
      CYBER_AUTHORIZATION_REF_MAX,
      3,
    );
    const authorizedStartAt = optionalDate(args.authorizedStartAt, "Testing window start");
    const authorizedEndAt = optionalDate(args.authorizedEndAt, "Testing window end");
    if (authorizedStartAt === undefined || authorizedEndAt === undefined) {
      throw new Error("An authorized testing window start and end are required");
    }
    if (authorizedEndAt <= authorizedStartAt) {
      throw new Error("The testing window must end after it starts");
    }
    const leadTesterLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.leadTesterUserId,
      manager.label,
      "Lead tester",
    );

    const now = Date.now();
    await ctx.db.patch(assessment._id, {
      subtype,
      systemsInScope,
      exclusions,
      methodology,
      rulesOfEngagement,
      authorizationReference,
      authorizedStartAt,
      authorizedEndAt,
      leadTesterUserId: args.leadTesterUserId,
      leadTesterLabel,
      scopeStatus: "authorized",
      scopeAuthorizedAt: now,
      scopeAuthorizedByUserId: manager.userId,
      scopeAuthorizedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "assessment_scope_authorized",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Testing scope authorized for ${assessment.reference ?? assessment.name} (${authorizationReference})`,
      reason: authorizationReference,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.testing_scope_authorized",
      entityType: "securityAssessments",
      entityId: String(assessment._id),
      summary: `Authorized testing scope for ${assessment.reference ?? assessment.name}`,
    });

    return { assessmentId: assessment._id, scopeStatus: "authorized" as const };
  },
});

/** Plan a test case against an existing assessment. Executes nothing. */
export const createTestCase = mutation({
  args: {
    assessmentId: v.id("securityAssessments"),
    title: v.string(),
    category: cyberTestCategoryValidator,
    systemUnderTest: v.string(),
    objective: v.string(),
    procedure: v.string(),
    expectedBehaviour: v.string(),
    testerUserId: v.optional(v.id("users")),
    plannedDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (assessment.status === "completed" || assessment.status === "cancelled") {
      throw new Error(
        "Test cases cannot be added to a completed or cancelled assessment",
      );
    }
    const title = requireText(
      args.title,
      "Test title",
      CYBER_TITLE_MAX,
      CYBER_TITLE_MIN,
    );
    const systemUnderTest = requireText(
      args.systemUnderTest,
      "System or component under test",
      CYBER_SCOPE_MAX,
      2,
    );
    const objective = requireNarrative(
      args.objective,
      "Test objective",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const procedure = requireNarrative(
      args.procedure,
      "Testing procedure",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const expectedBehaviour = requireNarrative(
      args.expectedBehaviour,
      "Expected security behaviour",
      CYBER_TEXT_MAX,
      CYBER_TEST_EXPECTED_MIN,
    );
    const notes = optionalText(args.notes, "Notes", CYBER_TEXT_MAX);
    const plannedDate = optionalDate(args.plannedDate, "Planned date");
    const testerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.testerUserId,
      manager.label,
      "Assigned tester",
    );

    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "cyberTestCases",
      manager.organizationId,
      "CT",
    );
    const testCaseId = await ctx.db.insert("cyberTestCases", {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      reference,
      title,
      category: args.category,
      systemUnderTest,
      objective,
      procedure,
      expectedBehaviour,
      testerUserId: args.testerUserId,
      testerLabel,
      plannedDate,
      status: "planned",
      outcome: "not_tested",
      notes,
      evidenceIds: [],
      createdAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      testCaseId,
      type: "test_case_created",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test case ${reference} planned (${title})`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_case_created",
      entityType: "cyberTestCases",
      entityId: String(testCaseId),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(assessment._id),
      summary: `Planned security test ${reference} for assessment ${assessment.reference ?? assessment.name}`,
    });

    return { testCaseId, reference };
  },
});

/** Correct a PLANNED test case. Started/completed cases are never rewritten. */
export const updateTestCase = mutation({
  args: {
    testCaseId: v.id("cyberTestCases"),
    title: v.optional(v.string()),
    category: v.optional(cyberTestCategoryValidator),
    systemUnderTest: v.optional(v.string()),
    objective: v.optional(v.string()),
    procedure: v.optional(v.string()),
    expectedBehaviour: v.optional(v.string()),
    testerUserId: v.optional(v.id("users")),
    plannedDate: v.optional(v.number()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    if (row.status !== "planned") {
      throw new Error(
        "Only a planned test case can be edited; started and completed results are immutable",
      );
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.title !== undefined) {
      patch.title = requireText(
        args.title,
        "Test title",
        CYBER_TITLE_MAX,
        CYBER_TITLE_MIN,
      );
    }
    if (args.category !== undefined) patch.category = args.category;
    if (args.systemUnderTest !== undefined) {
      patch.systemUnderTest = requireText(
        args.systemUnderTest,
        "System or component under test",
        CYBER_SCOPE_MAX,
        2,
      );
    }
    if (args.objective !== undefined) {
      patch.objective = requireNarrative(
        args.objective,
        "Test objective",
        CYBER_TEXT_MAX,
        CYBER_NARRATIVE_MIN,
      );
    }
    if (args.procedure !== undefined) {
      patch.procedure = requireNarrative(
        args.procedure,
        "Testing procedure",
        CYBER_TEXT_MAX,
        CYBER_NARRATIVE_MIN,
      );
    }
    if (args.expectedBehaviour !== undefined) {
      patch.expectedBehaviour = requireNarrative(
        args.expectedBehaviour,
        "Expected security behaviour",
        CYBER_TEXT_MAX,
        CYBER_TEST_EXPECTED_MIN,
      );
    }
    if (args.notes !== undefined) {
      patch.notes = optionalText(args.notes, "Notes", CYBER_TEXT_MAX);
    }
    if (args.plannedDate !== undefined) {
      patch.plannedDate = optionalDate(args.plannedDate, "Planned date");
    }
    if (args.testerUserId !== undefined) {
      patch.testerUserId = args.testerUserId;
      patch.testerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.testerUserId,
        manager.label,
        "Assigned tester",
      );
    }

    await ctx.db.patch(row._id, patch);
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_case_updated",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test case ${row.reference} details updated`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_case_updated",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Updated planned security test ${row.reference}`,
    });
    return { testCaseId: row._id };
  },
});

/**
 * Start execution. Refused unless the parent assessment is in progress AND its
 * testing scope is authorized — planning a record never permits testing.
 */
export const startTestCase = mutation({
  args: { testCaseId: v.id("cyberTestCases") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      row.assessmentId,
    );
    assertTransition(row.status, "in_progress", "start");
    const now = Date.now();
    const execution = testingExecutionStatus({
      assessmentStatus: assessment.status,
      scopeStatus: assessment.scopeStatus,
      systemsInScope: assessment.systemsInScope,
      exclusions: assessment.exclusions,
      authorizedStartAt: assessment.authorizedStartAt,
      authorizedEndAt: assessment.authorizedEndAt,
      target: row.systemUnderTest,
      now,
    });
    if (!execution.allowed) {
      throw new Error(execution.reason ?? "Testing is not authorized");
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
      testCaseId: row._id,
      type: "test_started",
      fromStatus: row.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} started`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_started",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Started security test ${row.reference}`,
    });
    return { status: "in_progress" as const };
  },
});

/** Record observations while a test is in progress (audited, not a result). */
export const recordTestObservations = mutation({
  args: {
    testCaseId: v.id("cyberTestCases"),
    observations: v.string(),
    recommendations: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    if (row.status !== "in_progress") {
      throw new Error(
        "Observations can only be recorded while the test is in progress",
      );
    }
    const observations = requireNarrative(
      args.observations,
      "Observations",
      CYBER_TEXT_MAX,
      CYBER_TEST_OBSERVATIONS_MIN,
    );
    const recommendations = optionalText(
      args.recommendations,
      "Recommendations",
      CYBER_TEXT_MAX,
    );
    await ctx.db.patch(row._id, {
      observations,
      recommendations,
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_observations_recorded",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Observations recorded for test ${row.reference}`,
      reason: observations.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_observations_recorded",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Recorded observations for security test ${row.reference}`,
    });
    return { testCaseId: row._id };
  },
});

/** Attach existing organization evidence to a test that is not yet final. */
export const attachTestEvidence = mutation({
  args: {
    testCaseId: v.id("cyberTestCases"),
    evidenceIds: v.array(v.id("cyberEvidence")),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    if (row.status === "completed" || row.status === "cancelled") {
      throw new Error(
        "Evidence can only be attached while the test is planned or in progress",
      );
    }
    const evidenceIds = await validateEvidenceIds(
      ctx,
      manager.organizationId,
      row.assessmentId,
      args.evidenceIds,
    );
    const merged = [
      ...new Set([...row.evidenceIds.map(String), ...evidenceIds.map(String)]),
    ] as Id<"cyberEvidence">[];
    await ctx.db.patch(row._id, {
      evidenceIds: merged,
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_evidence_linked",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `${evidenceIds.length} evidence record(s) attached to test ${row.reference}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_evidence_attached",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Attached evidence to security test ${row.reference}`,
    });
    return { testCaseId: row._id, evidenceIds: merged.map(String) };
  },
});

/**
 * Record the result and complete the test. A failed result NEVER creates a
 * vulnerability: an authorized user links or records one separately.
 */
export const completeTestCase = mutation({
  args: {
    testCaseId: v.id("cyberTestCases"),
    outcome: cyberTestOutcomeValidator,
    observations: v.string(),
    recommendations: v.optional(v.string()),
    executionDate: v.number(),
    vulnerabilityId: v.optional(v.id("vulnerabilities")),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    assertTransition(row.status, "completed", "complete");
    if (!isRecordedOutcome(args.outcome)) {
      throw new Error(
        "A completed test requires a recorded outcome (pass, fail or inconclusive)",
      );
    }
    const observations = requireNarrative(
      args.observations,
      "Actual observations",
      CYBER_TEXT_MAX,
      CYBER_TEST_OBSERVATIONS_MIN,
    );
    const recommendations = optionalText(
      args.recommendations,
      "Recommendations",
      CYBER_TEXT_MAX,
    );
    const executionDate = optionalDate(args.executionDate, "Execution date");
    if (executionDate === undefined) {
      throw new Error("An execution date is required to complete a test");
    }
    let vulnerabilityId: Id<"vulnerabilities"> | undefined;
    if (args.vulnerabilityId) {
      const vulnerability = await requireOwnedVulnerability(
        ctx,
        manager.organizationId,
        args.vulnerabilityId,
      );
      vulnerabilityId = vulnerability._id;
    }

    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "completed",
      outcome: args.outcome,
      observations,
      recommendations,
      executionDate,
      vulnerabilityId,
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_completed",
      fromStatus: row.status,
      toStatus: "completed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} completed with outcome ${CYBER_TEST_OUTCOME_LABELS[args.outcome]}`,
      reason: observations.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_completed",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Completed security test ${row.reference} (${CYBER_TEST_OUTCOME_LABELS[args.outcome]})`,
    });
    return { status: "completed" as const, outcome: args.outcome };
  },
});

/** Not applicable is a decision, never a result — a reason is mandatory. */
export const markTestCaseNotApplicable = mutation({
  args: { testCaseId: v.id("cyberTestCases"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    assertTransition(row.status, "not_applicable", "mark not applicable");
    const reason = requireNarrative(
      args.reason,
      "Reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "not_applicable",
      outcome: "not_tested",
      reason,
      notApplicableAt: now,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_not_applicable",
      fromStatus: row.status,
      toStatus: "not_applicable",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} marked not applicable`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_not_applicable",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Marked security test ${row.reference} not applicable`,
    });
    return { status: "not_applicable" as const };
  },
});

export const cancelTestCase = mutation({
  args: { testCaseId: v.id("cyberTestCases"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    assertTransition(row.status, "cancelled", "cancel");
    const reason = requireNarrative(
      args.reason,
      "Cancellation reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "cancelled",
      outcome: "not_tested",
      reason,
      cancelledAt: now,
      cancelledByUserId: manager.userId,
      cancelledByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_cancelled",
      fromStatus: row.status,
      toStatus: "cancelled",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} cancelled`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_cancelled",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Cancelled security test ${row.reference}`,
    });
    return { status: "cancelled" as const };
  },
});

/** Link an existing vulnerability (traceability only; nothing is changed). */
export const linkTestCaseVulnerability = mutation({
  args: {
    testCaseId: v.id("cyberTestCases"),
    vulnerabilityId: v.id("vulnerabilities"),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    if (row.status === "cancelled" || row.status === "not_applicable") {
      throw new Error("A cancelled or not-applicable test cannot be linked");
    }
    const vulnerability = await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
    await ctx.db.patch(row._id, {
      vulnerabilityId: vulnerability._id,
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      vulnerabilityId: vulnerability._id,
      testCaseId: row._id,
      type: "test_vulnerability_linked",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} linked to ${vulnerability.reference ?? vulnerability.title}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_vulnerability_linked",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "vulnerabilities",
      relatedEntityId: String(vulnerability._id),
      summary: `Linked security test ${row.reference} to ${vulnerability.reference ?? vulnerability.title}`,
    });
    return { testCaseId: row._id, vulnerabilityId: vulnerability._id };
  },
});

/**
 * Record independent review of a completed test. The tester/executor can never
 * review their own result, and a review is recorded once (append-only).
 */
export const reviewTestCase = mutation({
  args: { testCaseId: v.id("cyberTestCases"), reviewNotes: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedTestCase(
      ctx,
      manager.organizationId,
      args.testCaseId,
    );
    if (row.status !== "completed") {
      throw new Error("Only a completed test case can be reviewed");
    }
    if (row.reviewedAt !== undefined) {
      throw new Error("This test result has already been reviewed");
    }
    if (
      row.testerUserId === manager.userId ||
      row.completedByUserId === manager.userId
    ) {
      throw new Error(
        "Independent review required: the tester or executor cannot review their own test result",
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
      reviewedAt: now,
      reviewedByUserId: manager.userId,
      reviewedByLabel: manager.label,
      reviewNotes,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      testCaseId: row._id,
      type: "test_reviewed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Test ${row.reference} independently reviewed`,
      reason: reviewNotes.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.test_reviewed",
      entityType: "cyberTestCases",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Reviewed security test ${row.reference}`,
    });
    return { testCaseId: row._id, reviewedAt: now };
  },
});
