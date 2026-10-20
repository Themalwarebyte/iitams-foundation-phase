import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CYBER_ASSESSMENT_TYPE_LABELS,
  CYBER_NARRATIVE_MIN as REPORT_MIN,
  CYBER_REPORT_REVIEW_DECISION_LABELS,
  CYBER_REPORT_STATUS_LABELS,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  canTransitionReport,
  cyberReportReviewDecisionValidator,
  cyberReportStatusValidator,
  isConfirmedVulnerabilityStatus,
  isOpenVulnerabilityStatus,
  mayReadRestrictedCyberEvidence,
  type CyberReportStatus,
} from "../lib/cyber";
import {
  buildAssuranceReportContent,
  redactReportContentForViewer,
  reportContentFingerprint,
  type AssuranceReportContent,
} from "../lib/cyberReport";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalText,
  presentCyberEvidence,
  requireCyberManager,
  requireNarrative,
  requireOwnedAssessment,
  requireText,
  resolveCyberAccess,
  type CyberAccess,
} from "./cyberCore";
import { testsForAssessment } from "./cyberTesting";

/**
 * Security assurance reports (Phase 4A — Batch 2B)
 * ================================================
 * A report is an organization-scoped snapshot of RECORDED testing evidence for
 * one existing assessment. It is not a security score and certifies nothing.
 *
 *  - Lifecycle: draft → in review → finalized, with a revision creating a new
 *    draft version instead of editing an approved report.
 *  - `snapshot` is written exactly once, at finalization, and never patched, so
 *    later remediation and retesting cannot quietly change what was approved.
 *  - Reads use `cyber.view`, writes `cyber.manage` + active membership, and the
 *    organization always comes from the access context.
 */

const SCAN_LIMIT = 2000;
const PAGE_SCAN_LIMIT = 250;
const PAGE_LIMIT_MAX = 100;

function assertReportTransition(
  from: CyberReportStatus,
  to: CyberReportStatus,
  action: string,
) {
  if (!canTransitionReport(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_REPORT_STATUS_LABELS[from]} → ${CYBER_REPORT_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

async function requireOwnedReport(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  reportId: Id<"cyberTestReports">,
): Promise<Doc<"cyberTestReports">> {
  const row = await ctx.db.get(reportId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Security assurance report not found in your organization");
  }
  return row;
}

/**
 * Aggregates the honest, recorded content for one assessment. Used both for the
 * live preview and — at finalization — for the frozen snapshot, so the preview
 * and the approved report can never use different arithmetic.
 */
export async function reportContentForAssessment(
  ctx: QueryCtx | MutationCtx,
  access: { organizationId: Id<"organizations">; canManage: boolean },
  assessment: Doc<"securityAssessments">,
): Promise<AssuranceReportContent> {
  const tests = await testsForAssessment(
    ctx,
    access.organizationId,
    assessment._id,
  );
  const retests = await ctx.db
    .query("cyberRetests")
    .withIndex("by_organization_assessment", (q) =>
      q
        .eq("organizationId", access.organizationId)
        .eq("assessmentId", assessment._id),
    )
    .take(SCAN_LIMIT);
  const vulnerabilities = (
    await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT)
  ).filter((row) => row.assessmentId === assessment._id);
  const vulnerabilityIds = new Set(vulnerabilities.map((row) => String(row._id)));
  const actions = (
    await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT)
  ).filter(
    (row) =>
      row.vulnerabilityId !== undefined &&
      vulnerabilityIds.has(String(row.vulnerabilityId)),
  );
  const evidenceRows = await ctx.db
    .query("cyberEvidence")
    .withIndex("by_organization_assessment", (q) =>
      q
        .eq("organizationId", access.organizationId)
        .eq("assessmentId", assessment._id),
    )
    .take(SCAN_LIMIT);
  const canReadRestricted = mayReadRestrictedCyberEvidence(access.canManage);
  const evidence = evidenceRows.map((row) => ({
    reference: String(row._id),
    filename: row.filename,
    classification: row.classification,
    accessible:
      canReadRestricted || row.classification === "public" ||
      row.classification === "internal" ||
      row.classification === "confidential",
  }));
  const testReferences = new Map(
    tests.map((row) => [String(row._id), row.reference]),
  );
  const vulnerabilityReferenceById = new Map(
    vulnerabilities.map((row) => [String(row._id), row.reference ?? null]),
  );
  // A scan that reached its cap means the counts below are lower bounds. The
  // report must disclose that instead of implying comprehensive coverage.
  const truncatedDatasets: string[] = [];
  if (tests.length === SCAN_LIMIT) truncatedDatasets.push("test cases");
  if (retests.length === SCAN_LIMIT) truncatedDatasets.push("retests");
  if (vulnerabilities.length === SCAN_LIMIT) {
    truncatedDatasets.push("vulnerabilities");
  }
  if (actions.length === SCAN_LIMIT) {
    truncatedDatasets.push("remediation actions");
  }
  if (evidenceRows.length === SCAN_LIMIT) truncatedDatasets.push("evidence records");

  return buildAssuranceReportContent({
    assessment: {
      name: assessment.name,
      reference: assessment.reference ?? null,
      typeLabel: CYBER_ASSESSMENT_TYPE_LABELS[assessment.type],
      status: assessment.status,
      scope: assessment.scope ?? null,
      objectives: assessment.objectives ?? null,
      systemsInScope: assessment.systemsInScope ?? null,
      exclusions: assessment.exclusions ?? null,
      methodology: assessment.methodology ?? null,
      authorizationReference: assessment.authorizationReference ?? null,
      authorizedStartAt: assessment.authorizedStartAt ?? null,
      authorizedEndAt: assessment.authorizedEndAt ?? null,
      leadTesterLabel: assessment.leadTesterLabel ?? null,
      ownerLabel: assessment.ownerLabel ?? null,
    },
    tests: tests.map((row) => ({
      reference: row.reference,
      title: row.title,
      status: row.status,
      outcome: row.outcome,
      systemUnderTest: row.systemUnderTest,
      vulnerabilityId: row.vulnerabilityId ? String(row.vulnerabilityId) : null,
    })),
    retests: retests.map((row) => ({
      reference: row.reference,
      originalTestReference:
        testReferences.get(String(row.originalTestCaseId)) ?? "unknown test",
      status: row.status,
      outcome: row.outcome,
      reviewedAt: row.reviewedAt ?? null,
      reviewDecision: row.reviewDecision ?? null,
    })),
    vulnerabilities: vulnerabilities.map((row) => ({
      reference: row.reference ?? null,
      title: row.title,
      severity: row.severity,
      status: row.status,
      verifiedAt: row.verifiedAt ?? null,
      closedAt: row.closedAt ?? null,
    })),
    actions: actions.map((row) => ({
      status: row.status,
      vulnerabilityReference: row.vulnerabilityId
        ? vulnerabilityReferenceById.get(String(row.vulnerabilityId)) ?? null
        : null,
    })),
    evidence,
    truncatedDatasets,
    generatedAt: Date.now(),
  });
}

function presentReport(row: Doc<"cyberTestReports">) {
  return {
    _id: row._id,
    assessmentId: row.assessmentId,
    reference: row.reference,
    title: row.title,
    status: row.status,
    statusLabel: CYBER_REPORT_STATUS_LABELS[row.status],
    version: row.version,
    revisionOf: row.revisionOf ?? null,
    supersededByReportId: row.supersededByReportId ?? null,
    conclusions: row.conclusions,
    recommendations: row.recommendations,
    limitations: row.limitations,
    untestedScope: row.untestedScope,
    preparedByUserId: row.preparedByUserId,
    preparedByLabel: row.preparedByLabel,
    preparedAt: row.preparedAt,
    submittedAt: row.submittedAt ?? null,
    submittedByLabel: row.submittedByLabel ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedByLabel: row.reviewedByLabel ?? null,
    reviewDecision: row.reviewDecision ?? null,
    reviewDecisionLabel: row.reviewDecision
      ? CYBER_REPORT_REVIEW_DECISION_LABELS[row.reviewDecision]
      : null,
    reviewNotes: row.reviewNotes ?? null,
    independentlyApproved:
      row.reviewDecision === "approved" && row.reviewedSnapshot !== undefined,
    finalizedAt: row.finalizedAt ?? null,
    finalizedByLabel: row.finalizedByLabel ?? null,
    frozen: row.snapshot !== undefined,
    isDraft: row.status === "draft",
  };
}

/** Live content preview for an assessment (never stored). */
export const previewReport = query({
  args: { assessmentId: v.id("securityAssessments") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      access.organizationId,
      args.assessmentId,
    );
    return {
      content: await reportContentForAssessment(ctx, access, assessment),
      assessmentName: assessment.name,
      canManage: access.canManage,
    };
  },
});

export const listReports = query({
  args: {
    assessmentId: v.optional(v.id("securityAssessments")),
    status: v.optional(cyberReportStatusValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access: CyberAccess = await resolveCyberAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    if (args.assessmentId) {
      await requireOwnedAssessment(
        ctx,
        access.organizationId,
        args.assessmentId,
      );
    }
    const scan = await ctx.db
      .query("cyberTestReports")
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
      rows: page.map(presentReport),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      canManage: access.canManage,
    };
  },
});

export const getReport = query({
  args: { reportId: v.id("cyberTestReports") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const row = await requireOwnedReport(
      ctx,
      access.organizationId,
      args.reportId,
    );
    const assessment = await requireOwnedAssessment(
      ctx,
      access.organizationId,
      row.assessmentId,
    );
    // A finalized (or superseded) report is read from its frozen snapshot; a
    // draft or in-review report shows the live numbers it would capture.
    const stored = (row.snapshot ??
      (await reportContentForAssessment(ctx, access, assessment))) as AssuranceReportContent;
    // Evidence visibility follows the CURRENT viewer, not whoever captured the
    // snapshot: a restrictive classification is always withheld.
    const content = redactReportContentForViewer(
      stored,
      mayReadRestrictedCyberEvidence(access.canManage),
    );
    // Review/finalization history is part of the report record: the append-only
    // event table keeps who decided what, when, and why.
    const history = await ctx.db
      .query("vulnerabilityEvents")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", assessment._id),
      )
      .take(200);
    return {
      report: presentReport(row),
      history: history
        .filter((event) => event.type.startsWith("report_"))
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((event) => ({
          _id: event._id,
          type: event.type,
          summary: event.summary,
          reason: event.reason ?? null,
          actorLabel: event.actorLabel,
          createdAt: event.createdAt,
        })),
      assessment: {
        assessmentId: assessment._id,
        name: assessment.name,
        reference: assessment.reference ?? null,
        status: assessment.status,
      },
      content,
      frozen: row.snapshot !== undefined,
      evidence: (
        await ctx.db
          .query("cyberEvidence")
          .withIndex("by_organization_assessment", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("assessmentId", assessment._id),
          )
          .take(100)
      ).map(presentCyberEvidence),
      canManage: access.canManage,
      currentUserId: access.userId,
      currentUserLabel: access.label,
    };
  },
});

export const createReport = mutation({
  args: {
    assessmentId: v.id("securityAssessments"),
    title: v.string(),
    conclusions: v.string(),
    recommendations: v.string(),
    limitations: v.string(),
    untestedScope: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    const title = requireText(
      args.title,
      "Report title",
      CYBER_TITLE_MAX,
      CYBER_TITLE_MIN,
    );
    const conclusions = requireNarrative(
      args.conclusions,
      "Conclusions",
      CYBER_TEXT_MAX,
      REPORT_MIN,
    );
    const recommendations = requireNarrative(
      args.recommendations,
      "Recommendations",
      CYBER_TEXT_MAX,
      REPORT_MIN,
    );
    const limitations = requireText(
      args.limitations,
      "Limitations",
      CYBER_TEXT_MAX,
      4,
    );
    const untestedScope = requireText(
      args.untestedScope,
      "Untested scope",
      CYBER_TEXT_MAX,
      4,
    );
    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "cyberTestReports",
      manager.organizationId,
      "STR",
    );
    const reportId = await ctx.db.insert("cyberTestReports", {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      reference,
      title,
      status: "draft",
      version: 1,
      conclusions,
      recommendations,
      limitations,
      untestedScope,
      preparedByUserId: manager.userId,
      preparedByLabel: manager.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "report_created",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${reference} drafted for ${assessment.reference ?? assessment.name}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_created",
      entityType: "cyberTestReports",
      entityId: String(reportId),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(assessment._id),
      summary: `Drafted assurance report ${reference}`,
    });
    return { reportId, reference, version: 1 };
  },
});

/** Narrative edits are only possible while the report is still a draft. */
export const updateReport = mutation({
  args: {
    reportId: v.id("cyberTestReports"),
    title: v.optional(v.string()),
    conclusions: v.optional(v.string()),
    recommendations: v.optional(v.string()),
    limitations: v.optional(v.string()),
    untestedScope: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    if (row.status !== "draft") {
      throw new Error(
        "Only a draft report can be edited; submitted and finalized reports are immutable",
      );
    }
    // Editing the draft invalidates any earlier decision: the approved copy and
    // its reviewer stamps are cleared so a stale approval can never be reused.
    const patch: Record<string, unknown> = {
      updatedAt: Date.now(),
      reviewDecision: undefined,
      reviewNotes: undefined,
      reviewedAt: undefined,
      reviewedByUserId: undefined,
      reviewedByLabel: undefined,
      reviewedSnapshot: undefined,
    };
    if (args.title !== undefined) {
      patch.title = requireText(
        args.title,
        "Report title",
        CYBER_TITLE_MAX,
        CYBER_TITLE_MIN,
      );
    }
    if (args.conclusions !== undefined) {
      patch.conclusions = requireNarrative(
        args.conclusions,
        "Conclusions",
        CYBER_TEXT_MAX,
        REPORT_MIN,
      );
    }
    if (args.recommendations !== undefined) {
      patch.recommendations = requireNarrative(
        args.recommendations,
        "Recommendations",
        CYBER_TEXT_MAX,
        REPORT_MIN,
      );
    }
    if (args.limitations !== undefined) {
      patch.limitations = requireText(
        args.limitations,
        "Limitations",
        CYBER_TEXT_MAX,
        4,
      );
    }
    if (args.untestedScope !== undefined) {
      patch.untestedScope = requireText(
        args.untestedScope,
        "Untested scope",
        CYBER_TEXT_MAX,
        4,
      );
    }
    await ctx.db.patch(row._id, patch);
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_updated",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${row.reference} draft updated`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_updated",
      entityType: "cyberTestReports",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Updated assurance report ${row.reference} draft`,
    });
    return { reportId: row._id };
  },
});

export const submitReport = mutation({
  args: { reportId: v.id("cyberTestReports") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    assertReportTransition(row.status, "in_review", "submit for review");
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      row.assessmentId,
    );
    // Review is where the numbers are checked against the records; the report
    // is not submitted for approval while the engagement still has open test
    // work, because the counts would already be stale.
    const tests = await testsForAssessment(
      ctx,
      manager.organizationId,
      assessment._id,
    );
    const outstanding = tests.filter(
      (test) => test.status === "planned" || test.status === "in_progress",
    );
    if (outstanding.length > 0) {
      throw new Error(
        `Cannot submit for review: ${outstanding.length} test case(s) are still planned or in progress`,
      );
    }
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "in_review",
      submittedAt: now,
      submittedByUserId: manager.userId,
      submittedByLabel: manager.label,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_submitted",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${row.reference} submitted for review`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_submitted",
      entityType: "cyberTestReports",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Submitted assurance report ${row.reference} for review`,
    });
    return { status: "in_review" as const };
  },
});

/**
 * Independent review decision on a submitted report. The reviewer must be a
 * different active member from the preparer; approval stores the exact content
 * that was approved, so finalization can refuse a report whose underlying data
 * changed after review.
 */
export const reviewReport = mutation({
  args: {
    reportId: v.id("cyberTestReports"),
    decision: cyberReportReviewDecisionValidator,
    reviewNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    if (row.status !== "in_review") {
      throw new Error(
        "Only a report submitted for review can be reviewed; a draft must be submitted first",
      );
    }
    // Separation of duties: the preparer can never approve or reject their own
    // report, and the caller must be an active member of this organization.
    if (row.preparedByUserId === manager.userId) {
      throw new Error(
        "Independent review required: the preparer cannot review their own report",
      );
    }
    const reviewNotes = requireNarrative(
      args.reviewNotes,
      "Review notes",
      CYBER_TEXT_MAX,
      REPORT_MIN,
    );
    const now = Date.now();
    if (args.decision === "approved") {
      assertReportTransition(row.status, "reviewed", "approve");
      const assessment = await requireOwnedAssessment(
        ctx,
        manager.organizationId,
        row.assessmentId,
      );
      const content = await reportContentForAssessment(ctx, manager, assessment);
      await ctx.db.patch(row._id, {
        status: "reviewed",
        reviewDecision: "approved",
        reviewNotes,
        reviewedAt: now,
        reviewedByUserId: manager.userId,
        reviewedByLabel: manager.label,
        reviewedSnapshot: content,
        updatedAt: now,
      });
      await appendCyberEvent(ctx, {
        organizationId: manager.organizationId,
        assessmentId: row.assessmentId,
        type: "report_reviewed",
        fromStatus: row.status,
        toStatus: "reviewed",
        actorUserId: manager.userId,
        actorLabel: manager.label,
        summary: `Assurance report ${row.reference} v${row.version} independently approved by ${manager.label}`,
        reason: reviewNotes.slice(0, 240),
      });
      await logCyberAudit(ctx, manager, {
        action: "cyber.report_reviewed",
        entityType: "cyberTestReports",
        entityId: String(row._id),
        relatedEntityType: "securityAssessments",
        relatedEntityId: String(row.assessmentId),
        summary: `Independently approved assurance report ${row.reference} v${row.version}`,
      });
      return { status: "reviewed" as const };
    }

    // Rejection returns the report to its preparer; the reason is mandatory and
    // the rejected report can never be finalized.
    assertReportTransition(row.status, "draft", "reject");
    await ctx.db.patch(row._id, {
      status: "draft",
      reviewDecision: "rejected",
      reviewNotes,
      reviewedAt: now,
      reviewedByUserId: manager.userId,
      reviewedByLabel: manager.label,
      reviewedSnapshot: undefined,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_rejected",
      fromStatus: row.status,
      toStatus: "draft",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${row.reference} v${row.version} rejected by ${manager.label}`,
      reason: reviewNotes.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_rejected",
      entityType: "cyberTestReports",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Rejected assurance report ${row.reference} v${row.version}`,
    });
    return { status: "draft" as const };
  },
});

/** Withdraw / return a report to draft, clearing any recorded decision. */
export const returnReport = mutation({
  args: { reportId: v.id("cyberTestReports"), reviewNotes: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    assertReportTransition(row.status, "draft", "return to draft");
    const reviewNotes = requireNarrative(
      args.reviewNotes,
      "Review notes",
      CYBER_TEXT_MAX,
      REPORT_MIN,
    );
    await ctx.db.patch(row._id, {
      status: "draft",
      reviewNotes,
      reviewDecision: undefined,
      reviewedAt: undefined,
      reviewedByUserId: undefined,
      reviewedByLabel: undefined,
      reviewedSnapshot: undefined,
      updatedAt: Date.now(),
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_updated",
      fromStatus: row.status,
      toStatus: "draft",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${row.reference} returned for revision`,
      reason: reviewNotes.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_returned",
      entityType: "cyberTestReports",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Returned assurance report ${row.reference} to draft`,
    });
    return { status: "draft" as const };
  },
});

/**
 * Finalize an independently approved report: freeze the exact content the
 * reviewer approved. Finalization cannot be reached from a draft or an
 * in-review report, cannot use an approval given by the preparer, and refuses
 * when the recorded data changed after that approval.
 */
export const finalizeReport = mutation({
  args: {
    reportId: v.id("cyberTestReports"),
    reviewNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    if (row.status !== "reviewed") {
      throw new Error(
        "Finalization requires an approved independent review; the report is not in the reviewed state",
      );
    }
    assertReportTransition(row.status, "finalized", "finalize");
    if (
      row.reviewDecision !== "approved" ||
      row.reviewedByUserId === undefined ||
      row.reviewedSnapshot === undefined
    ) {
      throw new Error(
        "Finalization requires an approved independent review recorded against this version",
      );
    }
    if (row.reviewedByUserId === row.preparedByUserId) {
      throw new Error(
        "Finalization refused: the preparer's own approval is not an independent review",
      );
    }
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      row.assessmentId,
    );
    // The reviewer approved specific content. Recomputing now and comparing the
    // fingerprints means a late test, retest or remediation cannot be frozen
    // under an approval that never saw it.
    const current = await reportContentForAssessment(ctx, manager, assessment);
    const currentFingerprint = reportContentFingerprint(current);
    const approvedFingerprint = reportContentFingerprint(row.reviewedSnapshot);
    if (currentFingerprint !== approvedFingerprint) {
      let index = 0;
      while (
        index < currentFingerprint.length &&
        currentFingerprint[index] === approvedFingerprint[index]
      ) {
        index += 1;
      }
      throw new Error(
        `The recorded testing data changed after the independent review; a new review is required before finalization [at ${index}: now "${currentFingerprint.slice(
          Math.max(0, index - 80),
          index + 80,
        )}" vs approved "${approvedFingerprint.slice(
          Math.max(0, index - 80),
          index + 80,
        )}"]`,
      );
    }
    const notes = optionalText(
      args.reviewNotes,
      "Finalization notes",
      CYBER_TEXT_MAX,
    );
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: "finalized",
      // Exactly the copy the reviewer approved — never a fresh computation.
      snapshot: row.reviewedSnapshot,
      finalizedAt: now,
      finalizedByUserId: manager.userId,
      finalizedByLabel: manager.label,
      updatedAt: now,
    });
    if (row.revisionOf !== undefined) {
      const previous = await ctx.db.get(row.revisionOf);
      if (previous && previous.organizationId === manager.organizationId) {
        await ctx.db.patch(previous._id, {
          status: "superseded",
          supersededByReportId: row._id,
          updatedAt: now,
        });
      }
    }
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_finalized",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${row.reference} v${row.version} finalized from the approved review by ${row.reviewedByLabel ?? "an independent reviewer"}`,
      reason: notes?.slice(0, 240),
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_finalized",
      entityType: "cyberTestReports",
      entityId: String(row._id),
      relatedEntityType: "securityAssessments",
      relatedEntityId: String(row.assessmentId),
      summary: `Finalized assurance report ${row.reference} v${row.version}`,
    });
    return { status: "finalized" as const, version: row.version };
  },
});

/** Create the next draft version of a finalized report; the old one stays. */
export const reviseReport = mutation({
  args: { reportId: v.id("cyberTestReports") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const row = await requireOwnedReport(
      ctx,
      manager.organizationId,
      args.reportId,
    );
    if (row.status !== "finalized" && row.status !== "superseded") {
      throw new Error(
        "Only a finalized report can be revised; edit the existing draft instead",
      );
    }
    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "cyberTestReports",
      manager.organizationId,
      "STR",
    );
    const reportId = await ctx.db.insert("cyberTestReports", {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      reference,
      title: row.title,
      status: "draft",
      version: row.version + 1,
      revisionOf: row._id,
      conclusions: row.conclusions,
      recommendations: row.recommendations,
      limitations: row.limitations,
      untestedScope: row.untestedScope,
      preparedByUserId: manager.userId,
      preparedByLabel: manager.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: row.assessmentId,
      type: "report_revised",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assurance report ${reference} v${row.version + 1} opened as a revision of ${row.reference} v${row.version}`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.report_revised",
      entityType: "cyberTestReports",
      entityId: String(reportId),
      relatedEntityType: "cyberTestReports",
      relatedEntityId: String(row._id),
      summary: `Opened revision ${reference} v${row.version + 1}`,
    });
    return { reportId, reference, version: row.version + 1 };
  },
});

// ---------------------------------------------------------------------------
// Reporting hub and security posture summary (Phase 4A — Batch 3)
// ---------------------------------------------------------------------------

/**
 * Organization-scoped report discovery for `/reports/cybersecurity`.
 * Bounded like every other register: a 250-row scan window, at most 100 rows
 * returned, keyset cursor on `createdAt`, and a 2 000-row cap for the counts.
 */
export const reportHub = query({
  args: {
    status: v.optional(cyberReportStatusValidator),
    assessmentId: v.optional(v.id("securityAssessments")),
    search: v.optional(v.string()),
    /** Inclusive lower/upper bounds on the report's creation date (ms). */
    from: v.optional(v.number()),
    to: v.optional(v.number()),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    const search = args.search?.trim().toLowerCase() ?? "";
    if (args.assessmentId) {
      await requireOwnedAssessment(
        ctx,
        access.organizationId,
        args.assessmentId,
      );
    }
    const assessments = await ctx.db
      .query("securityAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const assessmentById = new Map(
      assessments.map((row) => [String(row._id), row]),
    );

    const scan = await ctx.db
      .query("cyberTestReports")
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
        args.assessmentId ? row.assessmentId === args.assessmentId : true,
      )
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => (args.from !== undefined ? row.createdAt >= args.from : true))
      .filter((row) => (args.to !== undefined ? row.createdAt <= args.to : true))
      .filter((row) => {
        if (!search) return true;
        const assessment = assessmentById.get(String(row.assessmentId));
        return [
          row.reference,
          row.title,
          row.preparedByLabel,
          row.reviewedByLabel ?? "",
          assessment?.name ?? "",
          assessment?.reference ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .filter((row) =>
        args.cursor !== undefined ? row.createdAt < args.cursor : true,
      );
    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);

    // Honest counts over a bounded scan: these are "at least" only when the cap
    // is reached, which the response states explicitly.
    const all = await ctx.db
      .query("cyberTestReports")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const counts = {
      total: all.length,
      draft: 0,
      inReview: 0,
      reviewed: 0,
      finalized: 0,
      superseded: 0,
      truncated: all.length === SCAN_LIMIT,
    };
    for (const row of all) {
      if (row.status === "draft") counts.draft += 1;
      if (row.status === "in_review") counts.inReview += 1;
      if (row.status === "reviewed") counts.reviewed += 1;
      if (row.status === "finalized") counts.finalized += 1;
      if (row.status === "superseded") counts.superseded += 1;
    }

    return {
      rows: page.map((row) => {
        const assessment = assessmentById.get(String(row.assessmentId));
        return {
          ...presentReport(row),
          assessmentId: row.assessmentId,
          assessmentName: assessment?.name ?? "Assessment no longer available",
          assessmentReference: assessment?.reference ?? null,
          assessmentStatus: assessment?.status ?? null,
          assessmentDate: assessment?.startedAt ?? assessment?.createdAt ?? null,
        };
      }),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      counts,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/**
 * Organization-scoped security posture summary built from recorded rows only.
 * It reports counts and deliberately exposes no "security score": a pass rate
 * of recorded tests is not organizational security effectiveness.
 */
export const postureSummary = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveCyberAccess(ctx);
    const tests = await ctx.db
      .query("cyberTestCases")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const vulnerabilities = await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const actions = await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const retests = await ctx.db
      .query("cyberRetests")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const reports = await ctx.db
      .query("cyberTestReports")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);

    const severity = { critical: 0, high: 0, medium: 0, low: 0, informational: 0 };
    let confirmed = 0;
    let awaitingVerification = 0;
    let awaitingClosure = 0;
    for (const row of vulnerabilities) {
      if (isConfirmedVulnerabilityStatus(row.status)) {
        confirmed += 1;
        severity[row.severity] += 1;
      }
      if (row.status === "remediated") awaitingVerification += 1;
      if (row.status === "verified") awaitingClosure += 1;
    }

    const testCounts = {
      total: tests.length,
      completed: 0,
      outstanding: 0,
      passed: 0,
      failed: 0,
      inconclusive: 0,
      notTested: 0,
    };
    for (const row of tests) {
      if (row.status === "completed") testCounts.completed += 1;
      if (row.status === "planned" || row.status === "in_progress") {
        testCounts.outstanding += 1;
      }
      if (row.outcome === "pass") testCounts.passed += 1;
      if (row.outcome === "fail") testCounts.failed += 1;
      if (row.outcome === "inconclusive") testCounts.inconclusive += 1;
      if (row.outcome === "not_tested") testCounts.notTested += 1;
    }

    return {
      generatedAt: Date.now(),
      tests: testCounts,
      vulnerabilities: {
        total: vulnerabilities.length,
        confirmed,
        open: vulnerabilities.filter((row) => isOpenVulnerabilityStatus(row.status))
          .length,
        awaitingVerification,
        awaitingClosure,
        bySeverity: severity,
      },
      remediation: {
        outstandingActions: actions.filter(
          (row) => row.status !== "closed" && row.status !== "cancelled",
        ).length,
      },
      retests: {
        total: retests.length,
        awaitingReview: retests.filter((row) => row.status === "completed").length,
        inFlight: retests.filter(
          (row) => row.status === "planned" || row.status === "in_progress",
        ).length,
        verified: retests.filter((row) => row.status === "reviewed").length,
        rejected: retests.filter((row) => row.status === "rejected").length,
      },
      reports: {
        total: reports.length,
        finalized: reports.filter((row) => row.status === "finalized").length,
        superseded: reports.filter((row) => row.status === "superseded").length,
        awaitingReview: reports.filter((row) => row.status === "in_review").length,
        drafts: reports.filter((row) => row.status === "draft").length,
      },
      truncated: {
        tests: tests.length === SCAN_LIMIT,
        vulnerabilities: vulnerabilities.length === SCAN_LIMIT,
        actions: actions.length === SCAN_LIMIT,
        retests: retests.length === SCAN_LIMIT,
        reports: reports.length === SCAN_LIMIT,
      },
      canManage: access.canManage,
    };
  },
});
