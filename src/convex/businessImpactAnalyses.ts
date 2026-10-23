import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import {
  BCM_BIA_STATUS_LABELS,
  BCM_CRITICALITY_RANK,
  BCM_IMPACT_CATEGORIES,
  BCM_IMPACT_CATEGORY_LABELS,
  BCM_IMPACT_SEVERITIES,
  BCM_MAX_REVIEW_INTERVAL_DAYS,
  BCM_MIN_REVIEW_INTERVAL_DAYS,
  BCM_NARRATIVE_MIN,
  BCM_PRIORITY_LABELS,
  BCM_REVIEW_DECISION_LABELS,
  BCM_TEXT_MAX,
  bcmBiaStatusValidator,
  bcmImpactsValidator,
  bcmPriorityValidator,
  bcmReviewDecisionValidator,
  canTransitionBia,
  formatMinutes,
  validateRecoveryObjectives,
  type BcmBiaStatus,
  type BcmImpacts,
  type BcmPriority,
} from "../lib/bcm";
import {
  appendContinuityEvent,
  logBcmAudit,
  nextBcmReference,
  optionalText,
  requireActiveMember,
  requireBcmManager,
  requireDate,
  requireNarrative,
  requireOwnedBia,
  requireOwnedService,
  requireTitle,
  resolveBcmAccess,
} from "./bcmCore";

/**
 * Business Impact Analysis (Phase 4A — Batch 4.1)
 * ===============================================
 * A BIA is a documented analysis of ONE business service: recorded impact
 * judgements, dependencies, assumptions and normalized recovery objectives. It
 * is not a continuity plan, not a recovery exercise, and never a resilience
 * score.
 *
 * Lifecycle: draft → in_review → approved, with a rejection returning the draft
 * for revision. Approved rows are never patched: a revision is a new versioned
 * row (`revisionOf`), and the earlier version becomes `superseded` only when
 * the revision is approved — its record and history stay readable.
 */

const SCAN_LIMIT = 2000;
const PAGE_SCAN_LIMIT = 250;
const PAGE_LIMIT_MAX = 100;
const IMPACT_NOTE_MIN = 10;
const DAY_MS = 24 * 60 * 60 * 1000;

function assertBiaTransition(
  from: BcmBiaStatus,
  to: BcmBiaStatus,
  action: string,
) {
  if (!canTransitionBia(from, to)) {
    throw new Error(
      `Cannot ${action}: ${BCM_BIA_STATUS_LABELS[from]} → ${BCM_BIA_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

/** Every impact category needs an explicit, validated judgement + rationale. */
function validateImpacts(input: BcmImpacts): BcmImpacts {
  const output = {} as BcmImpacts;
  for (const category of BCM_IMPACT_CATEGORIES) {
    const entry = input[category];
    if (!entry) {
      throw new Error(
        `${BCM_IMPACT_CATEGORY_LABELS[category]} impact must be recorded`,
      );
    }
    if (!BCM_IMPACT_SEVERITIES.includes(entry.severity)) {
      throw new Error(
        `${BCM_IMPACT_CATEGORY_LABELS[category]} impact severity is not recognised`,
      );
    }
    const notes = entry.notes.trim();
    if (notes.length < IMPACT_NOTE_MIN) {
      throw new Error(
        `${BCM_IMPACT_CATEGORY_LABELS[category]} impact rationale must be at least ${IMPACT_NOTE_MIN} characters`,
      );
    }
    if (notes.length > BCM_TEXT_MAX) {
      throw new Error(
        `${BCM_IMPACT_CATEGORY_LABELS[category]} impact rationale is too long`,
      );
    }
    output[category] = { severity: entry.severity, notes };
  }
  return output;
}

function validateDates(
  assessmentDate: number | undefined,
  reviewDueAt: number | undefined,
): { assessmentDate: number; reviewDueAt: number } {
  const assessed = requireDate(assessmentDate, "Assessment date");
  const due = requireDate(reviewDueAt, "Review due date");
  // An assessment is a record of work already performed; a future "assessment
  // date" would let a plan be presented as evidence it is not.
  if (assessed > Date.now() + DAY_MS) {
    throw new Error("Assessment date cannot be in the future");
  }
  const intervalDays = (due - assessed) / DAY_MS;
  if (intervalDays < BCM_MIN_REVIEW_INTERVAL_DAYS) {
    throw new Error("Review due date must be after the assessment date");
  }
  if (intervalDays > BCM_MAX_REVIEW_INTERVAL_DAYS) {
    throw new Error(
      `Review interval cannot exceed ${BCM_MAX_REVIEW_INTERVAL_DAYS} days`,
    );
  }
  return { assessmentDate: assessed, reviewDueAt: due };
}

type RecoveryFields = {
  rtoMinutes?: number;
  rpoMinutes?: number;
  mtpdMinutes?: number;
  minimumServiceLevel: string;
  recoveryPriority: BcmPriority;
  objectiveRationale: string;
  mtpdExceptionJustification?: string;
};

function recoveryFields(input: RecoveryFields) {
  return validateRecoveryObjectives({
    rtoMinutes: input.rtoMinutes,
    rpoMinutes: input.rpoMinutes,
    mtpdMinutes: input.mtpdMinutes,
    minimumServiceLevel: input.minimumServiceLevel,
    recoveryPriority: input.recoveryPriority,
    objectiveRationale: input.objectiveRationale,
    mtpdExceptionJustification: input.mtpdExceptionJustification,
  });
}

function presentBia(
  row: Doc<"businessImpactAnalyses">,
  service?: Doc<"businessServices"> | null,
) {
  return {
    _id: row._id,
    serviceId: row.serviceId,
    serviceName: service?.name ?? "Service no longer available",
    serviceReference: service?.reference ?? null,
    serviceCriticality: service?.criticality ?? null,
    reference: row.reference,
    title: row.title,
    version: row.version,
    revisionOf: row.revisionOf ?? null,
    supersededByBiaId: row.supersededByBiaId ?? null,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    assessmentDate: row.assessmentDate,
    reviewDueAt: row.reviewDueAt,
    overdue: row.reviewDueAt < Date.now() && row.status === "approved",
    disruptionScenario: row.disruptionScenario,
    scope: row.scope ?? null,
    impacts: row.impacts,
    keyDependencies: row.keyDependencies ?? null,
    singlePointsOfFailure: row.singlePointsOfFailure ?? null,
    existingRecoveryArrangements: row.existingRecoveryArrangements ?? null,
    assumptions: row.assumptions,
    limitations: row.limitations,
    criticalityRationale: row.criticalityRationale,
    rtoMinutes: row.rtoMinutes,
    rpoMinutes: row.rpoMinutes ?? null,
    mtpdMinutes: row.mtpdMinutes ?? null,
    rtoLabel: formatMinutes(row.rtoMinutes),
    rpoLabel: formatMinutes(row.rpoMinutes),
    mtpdLabel: formatMinutes(row.mtpdMinutes),
    minimumServiceLevel: row.minimumServiceLevel,
    recoveryPriority: row.recoveryPriority,
    recoveryPriorityLabel: BCM_PRIORITY_LABELS[row.recoveryPriority],
    objectiveRationale: row.objectiveRationale,
    mtpdExceptionJustification: row.mtpdExceptionJustification ?? null,
    status: row.status,
    statusLabel: BCM_BIA_STATUS_LABELS[row.status],
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
      ? BCM_REVIEW_DECISION_LABELS[row.reviewDecision]
      : null,
    reviewNotes: row.reviewNotes ?? null,
    approvedAt: row.approvedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Organization-scoped BIA list with search, filters and keyset pagination. */
export const listBias = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(bcmBiaStatusValidator),
    serviceId: v.optional(v.id("businessServices")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const limit = Math.min(Math.max(args.limit ?? 50, 1), PAGE_LIMIT_MAX);
    const search = args.search?.trim().toLowerCase() ?? "";
    if (args.serviceId) {
      await requireOwnedService(
        ctx,
        access.organizationId,
        args.serviceId,
      );
    }
    const services = await ctx.db
      .query("businessServices")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const serviceById = new Map(services.map((row) => [String(row._id), row]));

    const scan = await ctx.db
      .query("businessImpactAnalyses")
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
        args.serviceId ? row.serviceId === args.serviceId : true,
      )
      .filter((row) => (args.status ? row.status === args.status : true))
      .filter((row) =>
        args.cursor !== undefined ? row.createdAt < args.cursor : true,
      )
      .filter((row) => {
        if (!search) return true;
        const service = serviceById.get(String(row.serviceId));
        return [
          row.reference,
          row.title,
          row.ownerLabel,
          row.reviewedByLabel ?? "",
          service?.name ?? "",
          service?.reference ?? "",
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      });
    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);

    return {
      rows: page.map((row) =>
        presentBia(row, serviceById.get(String(row.serviceId))),
      ),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** One BIA with its service, version family and append-only history. */
export const getBia = query({
  args: { biaId: v.id("businessImpactAnalyses") },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const bia = await requireOwnedBia(ctx, access.organizationId, args.biaId);
    const service = await requireOwnedService(
      ctx,
      access.organizationId,
      bia.serviceId,
    );
    const family = await ctx.db
      .query("businessImpactAnalyses")
      .withIndex("by_organization_service", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("serviceId", bia.serviceId),
      )
      .take(100);
    const events = await ctx.db
      .query("continuityEvents")
      .withIndex("by_organization_bia", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("biaId", bia._id),
      )
      .take(200);
    return {
      bia: presentBia(bia, service),
      service: {
        _id: service._id,
        reference: service.reference,
        name: service.name,
        criticality: service.criticality,
        ownerLabel: service.ownerLabel,
      },
      versions: family
        .map((row) => ({
          _id: row._id,
          reference: row.reference,
          version: row.version,
          status: row.status,
          approvedAt: row.approvedAt ?? null,
        }))
        .sort((a, b) => b.version - a.version),
      history: events
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((event) => ({
          _id: event._id,
          type: event.type,
          summary: event.summary,
          reason: event.reason ?? null,
          actorLabel: event.actorLabel,
          createdAt: event.createdAt,
        })),
      canManage: access.canManage,
      currentUserId: access.userId,
      currentUserLabel: access.label,
    };
  },
});

const biaInputArgs = {
  serviceId: v.id("businessServices"),
  title: v.string(),
  ownerUserId: v.id("users"),
  assessmentDate: v.number(),
  reviewDueAt: v.number(),
  disruptionScenario: v.string(),
  scope: v.optional(v.string()),
  impacts: bcmImpactsValidator,
  keyDependencies: v.optional(v.string()),
  singlePointsOfFailure: v.optional(v.string()),
  existingRecoveryArrangements: v.optional(v.string()),
  assumptions: v.string(),
  limitations: v.string(),
  criticalityRationale: v.string(),
  rtoMinutes: v.number(),
  rpoMinutes: v.optional(v.number()),
  mtpdMinutes: v.optional(v.number()),
  minimumServiceLevel: v.string(),
  recoveryPriority: bcmPriorityValidator,
  objectiveRationale: v.string(),
  mtpdExceptionJustification: v.optional(v.string()),
};

/** Create a first draft BIA for a service. */
export const createBia = mutation({
  args: biaInputArgs,
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const service = await requireOwnedService(
      ctx,
      access.organizationId,
      args.serviceId,
    );
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Assessment owner",
    );
    const dates = validateDates(args.assessmentDate, args.reviewDueAt);
    const objectives = recoveryFields(args);
    const reference = await nextBcmReference(
      ctx,
      "businessImpactAnalyses",
      access.organizationId,
      "BIA",
    );
    const now = Date.now();
    const biaId = await ctx.db.insert("businessImpactAnalyses", {
      organizationId: access.organizationId,
      serviceId: service._id,
      reference,
      title: requireTitle(args.title, "BIA title"),
      version: 1,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      assessmentDate: dates.assessmentDate,
      reviewDueAt: dates.reviewDueAt,
      disruptionScenario: requireNarrative(
        args.disruptionScenario,
        "Disruption scenario",
      ),
      scope: optionalText(args.scope, "Assessment scope", BCM_TEXT_MAX),
      impacts: validateImpacts(args.impacts),
      keyDependencies: optionalText(
        args.keyDependencies,
        "Key dependencies",
        BCM_TEXT_MAX,
      ),
      singlePointsOfFailure: optionalText(
        args.singlePointsOfFailure,
        "Single points of failure",
        BCM_TEXT_MAX,
      ),
      existingRecoveryArrangements: optionalText(
        args.existingRecoveryArrangements,
        "Existing recovery arrangements",
        BCM_TEXT_MAX,
      ),
      assumptions: requireNarrative(args.assumptions, "Assumptions"),
      limitations: requireNarrative(args.limitations, "Limitations"),
      criticalityRationale: requireNarrative(
        args.criticalityRationale,
        "Criticality rationale",
      ),
      ...objectives,
      status: "draft",
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: service._id,
      biaId,
      type: "bia_created",
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `BIA ${reference} v1 created for ${service.reference}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.bia_created",
      entityType: "businessImpactAnalyses",
      entityId: String(biaId),
      relatedEntityType: "businessServices",
      relatedEntityId: String(service._id),
      summary: `Created BIA ${reference} v1`,
    });
    return { biaId, reference };
  },
});

/** Edit a draft only: an approved analysis is never silently rewritten. */
export const updateBia = mutation({
  args: { biaId: v.id("businessImpactAnalyses"), ...biaInputArgs },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const bia = await requireOwnedBia(ctx, access.organizationId, args.biaId);
    if (bia.status !== "draft") {
      throw new Error(
        "Only a draft BIA can be edited; an approved analysis must be revised as a new version",
      );
    }
    if (args.serviceId !== bia.serviceId) {
      throw new Error("A BIA cannot be moved to a different business service");
    }
    const service = await requireOwnedService(
      ctx,
      access.organizationId,
      bia.serviceId,
    );
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Assessment owner",
    );
    const dates = validateDates(args.assessmentDate, args.reviewDueAt);
    const objectives = recoveryFields(args);
    await ctx.db.patch(bia._id, {
      title: requireTitle(args.title, "BIA title"),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      assessmentDate: dates.assessmentDate,
      reviewDueAt: dates.reviewDueAt,
      disruptionScenario: requireNarrative(
        args.disruptionScenario,
        "Disruption scenario",
      ),
      scope: optionalText(args.scope, "Assessment scope", BCM_TEXT_MAX),
      impacts: validateImpacts(args.impacts),
      keyDependencies: optionalText(
        args.keyDependencies,
        "Key dependencies",
        BCM_TEXT_MAX,
      ),
      singlePointsOfFailure: optionalText(
        args.singlePointsOfFailure,
        "Single points of failure",
        BCM_TEXT_MAX,
      ),
      existingRecoveryArrangements: optionalText(
        args.existingRecoveryArrangements,
        "Existing recovery arrangements",
        BCM_TEXT_MAX,
      ),
      assumptions: requireNarrative(args.assumptions, "Assumptions"),
      limitations: requireNarrative(args.limitations, "Limitations"),
      criticalityRationale: requireNarrative(
        args.criticalityRationale,
        "Criticality rationale",
      ),
      ...objectives,
      updatedAt: Date.now(),
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: service._id,
      biaId: bia._id,
      type: "bia_updated",
      fromStatus: "draft",
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Draft BIA ${bia.reference} v${bia.version} updated`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.bia_updated",
      entityType: "businessImpactAnalyses",
      entityId: String(bia._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(service._id),
      summary: `Updated draft BIA ${bia.reference} v${bia.version}`,
    });
    return { biaId: bia._id };
  },
});

/** Submit a complete draft for independent review. */
export const submitBia = mutation({
  args: { biaId: v.id("businessImpactAnalyses") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const bia = await requireOwnedBia(ctx, access.organizationId, args.biaId);
    if (bia.status !== "draft") {
      throw new Error(
        "Only a draft BIA can be submitted; an approved analysis is revised as a new version",
      );
    }
    assertBiaTransition(bia.status, "in_review", "submit for review");
    const now = Date.now();
    await ctx.db.patch(bia._id, {
      status: "in_review",
      reviewDecision: undefined,
      reviewNotes: undefined,
      reviewedAt: undefined,
      reviewedByUserId: undefined,
      reviewedByLabel: undefined,
      submittedAt: now,
      submittedByUserId: access.userId,
      submittedByLabel: access.label,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: bia.serviceId,
      biaId: bia._id,
      type: "bia_submitted",
      fromStatus: bia.status,
      toStatus: "in_review",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `BIA ${bia.reference} v${bia.version} submitted for independent review`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.bia_submitted",
      entityType: "businessImpactAnalyses",
      entityId: String(bia._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(bia.serviceId),
      summary: `Submitted BIA ${bia.reference} v${bia.version}`,
    });
    return { status: "in_review" as const };
  },
});

/**
 * Independent review. The reviewer must be a different active member with
 * `bcm.manage`; approval is recorded server-side, rejection returns the BIA to
 * draft with the reason preserved in the append-only history.
 */
export const reviewBia = mutation({
  args: {
    biaId: v.id("businessImpactAnalyses"),
    decision: bcmReviewDecisionValidator,
    reviewNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const bia = await requireOwnedBia(ctx, access.organizationId, args.biaId);
    if (bia.status !== "in_review") {
      throw new Error("Only a BIA submitted for review can be reviewed");
    }
    if (bia.preparedByUserId === access.userId) {
      throw new Error(
        "Independent review required: the preparer cannot review their own analysis",
      );
    }
    const reviewNotes = requireNarrative(
      args.reviewNotes,
      "Review notes",
      BCM_TEXT_MAX,
      BCM_NARRATIVE_MIN,
    );
    const now = Date.now();
    if (args.decision === "approved") {
      assertBiaTransition(bia.status, "approved", "approve");
      await ctx.db.patch(bia._id, {
        status: "approved",
        reviewDecision: "approved",
        reviewNotes,
        reviewedAt: now,
        reviewedByUserId: access.userId,
        reviewedByLabel: access.label,
        approvedAt: now,
        updatedAt: now,
      });
      if (bia.revisionOf !== undefined) {
        const previous = await ctx.db.get(bia.revisionOf);
        if (previous && previous.organizationId === access.organizationId) {
          await ctx.db.patch(previous._id, {
            status: "superseded",
            supersededByBiaId: bia._id,
            updatedAt: now,
          });
        }
      }
      await appendContinuityEvent(ctx, {
        organizationId: access.organizationId,
        serviceId: bia.serviceId,
        biaId: bia._id,
        type: "bia_approved",
        fromStatus: bia.status,
        toStatus: "approved",
        actorUserId: access.userId,
        actorLabel: access.label,
        summary: `BIA ${bia.reference} v${bia.version} independently approved by ${access.label}`,
        reason: reviewNotes.slice(0, 240),
      });
      await logBcmAudit(ctx, access, {
        action: "bcm.bia_approved",
        entityType: "businessImpactAnalyses",
        entityId: String(bia._id),
        relatedEntityType: "businessServices",
        relatedEntityId: String(bia.serviceId),
        summary: `Approved BIA ${bia.reference} v${bia.version}`,
      });
      return { status: "approved" as const };
    }

    assertBiaTransition(bia.status, "draft", "return for revision");
    await ctx.db.patch(bia._id, {
      status: "draft",
      reviewDecision: "rejected",
      reviewNotes,
      reviewedAt: now,
      reviewedByUserId: access.userId,
      reviewedByLabel: access.label,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: bia.serviceId,
      biaId: bia._id,
      type: "bia_returned",
      fromStatus: bia.status,
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `BIA ${bia.reference} v${bia.version} returned for revision by ${access.label}`,
      reason: reviewNotes.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.bia_returned",
      entityType: "businessImpactAnalyses",
      entityId: String(bia._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(bia.serviceId),
      summary: `Returned BIA ${bia.reference} v${bia.version} for revision`,
    });
    return { status: "draft" as const };
  },
});

/** Open the next draft version of an approved BIA; the old one stays. */
export const reviseBia = mutation({
  args: { biaId: v.id("businessImpactAnalyses") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const bia = await requireOwnedBia(ctx, access.organizationId, args.biaId);
    if (bia.status !== "approved" && bia.status !== "superseded") {
      throw new Error(
        "Only an approved BIA can be revised; edit the existing draft instead",
      );
    }
    const openDraft = await ctx.db
      .query("businessImpactAnalyses")
      .withIndex("by_organization_service", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("serviceId", bia.serviceId),
      )
      .take(100);
    if (
      openDraft.some(
        (row) => row.status === "draft" && row.revisionOf === bia._id,
      )
    ) {
      throw new Error(
        "A draft revision of this BIA is already open; complete it before opening another",
      );
    }
    const reference = await nextBcmReference(
      ctx,
      "businessImpactAnalyses",
      access.organizationId,
      "BIA",
    );
    const now = Date.now();
    const biaId = await ctx.db.insert("businessImpactAnalyses", {
      organizationId: access.organizationId,
      serviceId: bia.serviceId,
      reference,
      title: bia.title,
      version: bia.version + 1,
      revisionOf: bia._id,
      ownerUserId: bia.ownerUserId,
      ownerLabel: bia.ownerLabel,
      assessmentDate: bia.assessmentDate,
      reviewDueAt: bia.reviewDueAt,
      disruptionScenario: bia.disruptionScenario,
      scope: bia.scope,
      impacts: bia.impacts,
      keyDependencies: bia.keyDependencies,
      singlePointsOfFailure: bia.singlePointsOfFailure,
      existingRecoveryArrangements: bia.existingRecoveryArrangements,
      assumptions: bia.assumptions,
      limitations: bia.limitations,
      criticalityRationale: bia.criticalityRationale,
      rtoMinutes: bia.rtoMinutes,
      rpoMinutes: bia.rpoMinutes,
      mtpdMinutes: bia.mtpdMinutes,
      minimumServiceLevel: bia.minimumServiceLevel,
      recoveryPriority: bia.recoveryPriority,
      objectiveRationale: bia.objectiveRationale,
      mtpdExceptionJustification: bia.mtpdExceptionJustification,
      status: "draft",
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      serviceId: bia.serviceId,
      biaId,
      type: "bia_revised",
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `BIA ${reference} v${bia.version + 1} opened as a revision of ${bia.reference} v${bia.version}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.bia_revised",
      entityType: "businessImpactAnalyses",
      entityId: String(biaId),
      relatedEntityType: "businessImpactAnalyses",
      relatedEntityId: String(bia._id),
      summary: `Opened BIA revision ${reference} v${bia.version + 1}`,
    });
    return { biaId, reference, version: bia.version + 1 };
  },
});

/** Recovery objectives by service, with overdue-review flags (bounded). */
export const recoveryObjectives = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveBcmAccess(ctx);
    const services = await ctx.db
      .query("businessServices")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const serviceById = new Map(services.map((row) => [String(row._id), row]));
    const rows = await ctx.db
      .query("businessImpactAnalyses")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const latest = new Map<string, Doc<"businessImpactAnalyses">>();
    for (const row of rows) {
      if (row.status === "superseded") continue;
      const key = String(row.serviceId);
      const current = latest.get(key);
      if (!current || row.version > current.version) latest.set(key, row);
    }
    const now = Date.now();
    const objectives = [...latest.values()]
      .map((row) => {
        const service = serviceById.get(String(row.serviceId));
        return {
          biaId: row._id,
          serviceId: row.serviceId,
          serviceReference: service?.reference ?? null,
          serviceName: service?.name ?? "Service no longer available",
          criticality: service?.criticality ?? null,
          reference: row.reference,
          version: row.version,
          status: row.status,
          rtoMinutes: row.rtoMinutes,
          rtoLabel: formatMinutes(row.rtoMinutes),
          rpoMinutes: row.rpoMinutes ?? null,
          rpoLabel: formatMinutes(row.rpoMinutes),
          mtpdMinutes: row.mtpdMinutes ?? null,
          mtpdLabel: formatMinutes(row.mtpdMinutes),
          minimumServiceLevel: row.minimumServiceLevel,
          recoveryPriority: row.recoveryPriority,
          recoveryPriorityLabel: BCM_PRIORITY_LABELS[row.recoveryPriority],
          reviewDueAt: row.reviewDueAt,
          overdue: row.status === "approved" && row.reviewDueAt < now,
        };
      })
      .sort((a, b) => {
        const rank =
          BCM_CRITICALITY_RANK[(b.criticality ?? "low") as keyof typeof BCM_CRITICALITY_RANK] -
          BCM_CRITICALITY_RANK[(a.criticality ?? "low") as keyof typeof BCM_CRITICALITY_RANK];
        if (rank !== 0) return rank;
        return a.rtoMinutes - b.rtoMinutes;
      });
    return {
      objectives,
      counts: {
        servicesWithObjectives: objectives.length,
        overdue: objectives.filter((row) => row.overdue).length,
        p1: objectives.filter((row) => row.recoveryPriority === "p1").length,
        rpoRecorded: objectives.filter((row) => row.rpoMinutes !== null).length,
      },
      truncated: rows.length === SCAN_LIMIT || services.length === SCAN_LIMIT,
      canManage: access.canManage,
    };
  },
});

/**
 * Continuity coverage summary. Counts are recorded facts; none of them imply
 * that a service is resilient, and no readiness score is derived.
 */
export const continuitySummary = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveBcmAccess(ctx);
    const services = await ctx.db
      .query("businessServices")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const bias = await ctx.db
      .query("businessImpactAnalyses")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(SCAN_LIMIT);
    const now = Date.now();
    const approvedByService = new Set(
      bias
        .filter((row) => row.status === "approved")
        .map((row) => String(row.serviceId)),
    );
    const openByService = new Set(
      bias
        .filter((row) => row.status === "draft" || row.status === "in_review")
        .map((row) => String(row.serviceId)),
    );
    const activeServices = services.filter(
      (row) => row.operationalStatus !== "retired",
    );
    return {
      generatedAt: now,
      services: {
        total: services.length,
        active: activeServices.length,
        critical: services.filter((row) => row.criticality === "critical").length,
        high: services.filter((row) => row.criticality === "high").length,
        retired: services.filter((row) => row.operationalStatus === "retired")
          .length,
      },
      coverage: {
        withApprovedBia: activeServices.filter((row) =>
          approvedByService.has(String(row._id)),
        ).length,
        withOpenBiaOnly: activeServices.filter(
          (row) =>
            !approvedByService.has(String(row._id)) &&
            openByService.has(String(row._id)),
        ).length,
        missingBia: activeServices.filter(
          (row) =>
            !approvedByService.has(String(row._id)) &&
            !openByService.has(String(row._id)),
        ).length,
      },
      review: {
        awaitingReview: bias.filter((row) => row.status === "in_review").length,
        overdueReassessment: bias.filter(
          (row) => row.status === "approved" && row.reviewDueAt < now,
        ).length,
        approvedTotal: bias.filter((row) => row.status === "approved").length,
      },
      truncated: {
        services: services.length === SCAN_LIMIT,
        bias: bias.length === SCAN_LIMIT,
      },
      canManage: access.canManage,
    };
  },
});
