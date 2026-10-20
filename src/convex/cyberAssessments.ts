import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  CYBER_ASSESSMENT_STATUS_LABELS,
  CYBER_NARRATIVE_MIN,
  CYBER_REASON_MIN,
  CYBER_SCOPE_MAX,
  CYBER_TEXT_MAX,
  CYBER_TITLE_MAX,
  CYBER_TITLE_MIN,
  canTransitionAssessment,
  cyberAssessmentStatusValidator,
  cyberAssessmentTypeValidator,
  type CyberAssessmentStatus,
} from "../lib/cyber";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  appendCyberEvent,
  logCyberAudit,
  nextReference,
  optionalDate,
  optionalText,
  presentAssessment,
  presentCyberEvidence,
  presentEvent,
  presentVulnerability,
  requireCyberManager,
  requireNarrative,
  requireOwnedAssessment,
  requireText,
  resolveCyberAccess,
  resolveMemberLabel,
} from "./cyberCore";

/**
 * Cybersecurity assessment register (Phase 4A — Batch 1)
 * ======================================================
 * Lifecycle: planned (`scheduled`) → in progress → completed | cancelled.
 *
 * Deliberate properties:
 *  - An assessment is NEVER completed automatically. Completion requires an
 *    explicit transition by an authorized user AND a recorded outcome summary.
 *  - Linked vulnerability counts are DERIVED from the vulnerability register on
 *    read; the assessment row stores no counters, so no total can be invented.
 *  - Creating an assessment creates no findings or vulnerabilities.
 *  - Completed / cancelled assessments are terminal: corrections are a new
 *    assessment, keeping history readable. Every change is append-audited.
 */

const LIST_LIMIT = 500;
const VULN_SCAN_LIMIT = 1000;

function assertAssessmentTransition(
  from: CyberAssessmentStatus,
  to: CyberAssessmentStatus,
  action: string,
) {
  if (!canTransitionAssessment(from, to)) {
    throw new Error(
      `Cannot ${action}: ${CYBER_ASSESSMENT_STATUS_LABELS[from]} → ${CYBER_ASSESSMENT_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

async function vulnerabilitiesByAssessment(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
): Promise<Map<string, Doc<"vulnerabilities">[]>> {
  const rows = await ctx.db
    .query("vulnerabilities")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(VULN_SCAN_LIMIT);
  const grouped = new Map<string, Doc<"vulnerabilities">[]>();
  for (const row of rows) {
    if (!row.assessmentId) continue;
    const key = String(row.assessmentId);
    const list = grouped.get(key) ?? [];
    list.push(row);
    grouped.set(key, list);
  }
  return grouped;
}

/** Assessment register with derived vulnerability counts. */
export const listAssessments = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(cyberAssessmentStatusValidator),
    type: v.optional(cyberAssessmentTypeValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const now = Date.now();
    const limit = Math.min(Math.max(args.limit ?? 100, 1), LIST_LIMIT);
    const search = args.search?.trim().toLowerCase() ?? "";

    const assessments = await ctx.db
      .query("securityAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(LIST_LIMIT);
    const grouped = await vulnerabilitiesByAssessment(
      ctx,
      access.organizationId,
    );

    const rows = assessments
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) => (args.type ? row.type === args.type : true))
      .filter((row) => {
        if (!search) return true;
        return [
          row.reference ?? "",
          row.name,
          row.scope ?? "",
          row.relatedAssetOrService ?? "",
          row.ownerLabel ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      })
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit)
      .map((row) =>
        presentAssessment(row, {
          vulnerabilities: grouped.get(String(row._id)) ?? [],
          now,
        }),
      );

    const summary = {
      total: assessments.length,
      planned: assessments.filter((row) => row.status === "scheduled").length,
      inProgress: assessments.filter((row) => row.status === "in_progress")
        .length,
      completed: assessments.filter((row) => row.status === "completed").length,
      cancelled: assessments.filter((row) => row.status === "cancelled").length,
      canManage: access.canManage,
      currentUserId: access.userId,
    };

    return { rows, summary };
  },
});

/** One assessment with its linked vulnerabilities, history and evidence. */
export const getAssessment = query({
  args: { assessmentId: v.id("securityAssessments") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      access.organizationId,
      args.assessmentId,
    );
    const now = Date.now();

    const vulnerabilities = await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", args.assessmentId),
      )
      .take(VULN_SCAN_LIMIT);

    const actions = await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(1000);
    const actionsByVulnerability = new Map<
      string,
      Doc<"vulnerabilityRemediationActions">[]
    >();
    for (const action of actions) {
      const key = String(action.vulnerabilityId);
      const list = actionsByVulnerability.get(key) ?? [];
      list.push(action);
      actionsByVulnerability.set(key, list);
    }

    const events = await ctx.db
      .query("vulnerabilityEvents")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", args.assessmentId),
      )
      .take(200);

    const evidence = await ctx.db
      .query("cyberEvidence")
      .withIndex("by_organization_assessment", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("assessmentId", args.assessmentId),
      )
      .take(200);

    return {
      assessment: presentAssessment(assessment, { vulnerabilities, now }),
      vulnerabilities: vulnerabilities
        .slice()
        .sort((a, b) => a.discoveredAt - b.discoveredAt)
        .map((row) =>
          presentVulnerability(row, {
            actions: actionsByVulnerability.get(String(row._id)) ?? [],
            now,
          }),
        ),
      events: events
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(presentEvent),
      evidence: evidence.map(presentCyberEvidence),
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Select options for the register forms (org-scoped, active members only). */
export const cyberFormOptions = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveCyberAccess(ctx);
    const assessments = await ctx.db
      .query("securityAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(LIST_LIMIT);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(300);
    const members: Array<{
      userId: Id<"users">;
      label: string;
      role: string | null;
    }> = [];
    for (const profile of profiles) {
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
        continue;
      }
      const user = await ctx.db.get(profile.userId);
      members.push({
        userId: profile.userId,
        label: user?.name ?? user?.email ?? "Member",
        role: profile.role ?? null,
      });
    }
    const risks = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(LIST_LIMIT);

    return {
      assessments: assessments
        .slice()
        .sort((a, b) => (a.reference ?? a.name).localeCompare(b.reference ?? b.name))
        .map((row) => ({
          assessmentId: row._id,
          reference: row.reference ?? null,
          name: row.name,
          status: row.status,
          type: row.type,
        })),
      members,
      risks: risks.map((row) => ({
        riskId: row._id,
        code: row.code,
        title: row.title,
        status: row.status,
      })),
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** Create a PLANNED assessment. No findings, vulnerabilities or counters. */
export const createAssessment = mutation({
  args: {
    name: v.string(),
    type: cyberAssessmentTypeValidator,
    description: v.optional(v.string()),
    scope: v.optional(v.string()),
    objectives: v.optional(v.string()),
    relatedAssetOrService: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    plannedStartAt: v.optional(v.number()),
    plannedEndAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const name = requireText(args.name, "Assessment title", CYBER_TITLE_MAX, CYBER_TITLE_MIN);
    const description = optionalText(
      args.description,
      "Description",
      CYBER_TEXT_MAX,
    );
    const scope = optionalText(args.scope, "Scope", CYBER_SCOPE_MAX);
    const objectives = optionalText(
      args.objectives,
      "Objectives",
      CYBER_TEXT_MAX,
    );
    const asset = optionalText(
      args.relatedAssetOrService,
      "Related asset or service",
      CYBER_SCOPE_MAX,
    );
    const plannedStartAt = optionalDate(args.plannedStartAt, "Planned start");
    const plannedEndAt = optionalDate(args.plannedEndAt, "Planned end");
    if (
      plannedStartAt !== undefined &&
      plannedEndAt !== undefined &&
      plannedEndAt < plannedStartAt
    ) {
      throw new Error("The planned end date cannot precede the planned start");
    }
    const ownerLabel = await resolveMemberLabel(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      manager.label,
      "Assessment owner",
    );

    const now = Date.now();
    const reference = await nextReference(
      ctx,
      "securityAssessments",
      manager.organizationId,
      "CSA",
    );
    const assessmentId = await ctx.db.insert("securityAssessments", {
      organizationId: manager.organizationId,
      reference,
      name,
      type: args.type,
      status: "scheduled",
      description,
      scope,
      objectives,
      relatedAssetOrService: asset,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      plannedStartAt,
      plannedEndAt,
      createdAt: now,
      updatedAt: now,
    });

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId,
      type: "assessment_created",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assessment ${reference} planned (${name})`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.assessment_created",
      entityType: "securityAssessments",
      entityId: String(assessmentId),
      summary: `Planned cybersecurity assessment ${reference} (${name})`,
    });
    return { assessmentId, reference };
  },
});

/** Edit a PLANNED assessment. Terminal assessments are never patched. */
export const updateAssessment = mutation({
  args: {
    assessmentId: v.id("securityAssessments"),
    name: v.optional(v.string()),
    type: v.optional(cyberAssessmentTypeValidator),
    description: v.optional(v.string()),
    scope: v.optional(v.string()),
    objectives: v.optional(v.string()),
    relatedAssetOrService: v.optional(v.string()),
    ownerUserId: v.optional(v.id("users")),
    plannedStartAt: v.optional(v.number()),
    plannedEndAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    if (assessment.status !== "scheduled") {
      throw new Error(
        "Only a planned assessment can be edited; completed and cancelled assessments are immutable",
      );
    }
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      patch.name = requireText(
        args.name,
        "Assessment title",
        CYBER_TITLE_MAX,
        CYBER_TITLE_MIN,
      );
    }
    if (args.type !== undefined) patch.type = args.type;
    if (args.description !== undefined) {
      patch.description = optionalText(
        args.description,
        "Description",
        CYBER_TEXT_MAX,
      );
    }
    if (args.scope !== undefined) {
      patch.scope = optionalText(args.scope, "Scope", CYBER_SCOPE_MAX);
    }
    if (args.objectives !== undefined) {
      patch.objectives = optionalText(
        args.objectives,
        "Objectives",
        CYBER_TEXT_MAX,
      );
    }
    if (args.relatedAssetOrService !== undefined) {
      patch.relatedAssetOrService = optionalText(
        args.relatedAssetOrService,
        "Related asset or service",
        CYBER_SCOPE_MAX,
      );
    }
    if (args.ownerUserId !== undefined) {
      patch.ownerUserId = args.ownerUserId;
      patch.ownerLabel = await resolveMemberLabel(
        ctx,
        manager.organizationId,
        args.ownerUserId,
        manager.label,
        "Assessment owner",
      );
    }
    const plannedStartAt =
      args.plannedStartAt !== undefined
        ? optionalDate(args.plannedStartAt, "Planned start")
        : assessment.plannedStartAt;
    const plannedEndAt =
      args.plannedEndAt !== undefined
        ? optionalDate(args.plannedEndAt, "Planned end")
        : assessment.plannedEndAt;
    if (
      plannedStartAt !== undefined &&
      plannedEndAt !== undefined &&
      plannedEndAt < plannedStartAt
    ) {
      throw new Error("The planned end date cannot precede the planned start");
    }
    if (args.plannedStartAt !== undefined) patch.plannedStartAt = plannedStartAt;
    if (args.plannedEndAt !== undefined) patch.plannedEndAt = plannedEndAt;

    await ctx.db.patch(assessment._id, patch);
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "assessment_updated",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assessment ${assessment.reference ?? assessment.name} details updated`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.assessment_updated",
      entityType: "securityAssessments",
      entityId: String(assessment._id),
      summary: `Updated planned assessment ${assessment.reference ?? assessment.name}`,
    });
    return { assessmentId: assessment._id };
  },
});

/** planned → in progress (explicit start). */
export const startAssessment = mutation({
  args: { assessmentId: v.id("securityAssessments") },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    assertAssessmentTransition(assessment.status, "in_progress", "start");
    const now = Date.now();
    await ctx.db.patch(assessment._id, {
      status: "in_progress",
      startedAt: now,
      startedByUserId: manager.userId,
      startedByLabel: manager.label,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "assessment_started",
      fromStatus: assessment.status,
      toStatus: "in_progress",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assessment ${assessment.reference ?? assessment.name} started`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.assessment_started",
      entityType: "securityAssessments",
      entityId: String(assessment._id),
      summary: `Started cybersecurity assessment ${assessment.reference ?? assessment.name}`,
    });
    return { status: "in_progress" as const };
  },
});

/**
 * in progress → completed. Requires an outcome summary; NEVER triggered by the
 * presence of vulnerabilities, and never writes vulnerability counts.
 */
export const completeAssessment = mutation({
  args: {
    assessmentId: v.id("securityAssessments"),
    outcomeSummary: v.string(),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    assertAssessmentTransition(assessment.status, "completed", "complete");
    const outcomeSummary = requireNarrative(
      args.outcomeSummary,
      "Outcome summary",
      CYBER_TEXT_MAX,
      CYBER_NARRATIVE_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(assessment._id, {
      status: "completed",
      completedAt: now,
      completedByUserId: manager.userId,
      completedByLabel: manager.label,
      outcomeSummary,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "assessment_completed",
      fromStatus: assessment.status,
      toStatus: "completed",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assessment ${assessment.reference ?? assessment.name} completed`,
      reason: outcomeSummary,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.assessment_completed",
      entityType: "securityAssessments",
      entityId: String(assessment._id),
      summary: `Completed cybersecurity assessment ${assessment.reference ?? assessment.name}`,
    });
    return { status: "completed" as const };
  },
});

export const cancelAssessment = mutation({
  args: { assessmentId: v.id("securityAssessments"), reason: v.string() },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    const assessment = await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
    assertAssessmentTransition(assessment.status, "cancelled", "cancel");
    const reason = requireNarrative(
      args.reason,
      "Cancellation reason",
      CYBER_TEXT_MAX,
      CYBER_REASON_MIN,
    );
    const now = Date.now();
    await ctx.db.patch(assessment._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelledByUserId: manager.userId,
      cancelledByLabel: manager.label,
      cancelReason: reason,
      lastTransitionAt: now,
      updatedAt: now,
    });
    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      assessmentId: assessment._id,
      type: "assessment_cancelled",
      fromStatus: assessment.status,
      toStatus: "cancelled",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Assessment ${assessment.reference ?? assessment.name} cancelled`,
      reason,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.assessment_cancelled",
      entityType: "securityAssessments",
      entityId: String(assessment._id),
      summary: `Cancelled cybersecurity assessment ${assessment.reference ?? assessment.name}`,
    });
    return { status: "cancelled" as const };
  },
});

