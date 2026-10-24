import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
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
  requireOwnedGap,
  requireOwnedPlan,
  requireOwnedService,
  requireOwnedStrategy,
  requireTitle,
  resolveBcmAccess,
} from "./bcmCore";
import {
  BCM_CAPABILITY_EVIDENCE_LABELS,
  BCM_GAP_SEVERITY_LABELS,
  BCM_GAP_STATUS_LABELS,
  BCM_MAX_ADDITIONAL_SERVICES,
  BCM_MAX_REVIEW_INTERVAL_DAYS,
  BCM_MINUTES_MAX,
  BCM_MIN_REVIEW_INTERVAL_DAYS,
  BCM_NARRATIVE_MIN,
  BCM_PLAN_STATUS_LABELS,
  BCM_PRIORITY_LABELS,
  BCM_STRATEGY_STATUS_LABELS,
  bcmCapabilityEvidenceValidator,
  bcmGapSeverityValidator,
  bcmGapStatusValidator,
  bcmPriorityValidator,
  bcmStrategyStatusValidator,
  canTransitionGap,
  canTransitionPlan,
  canTransitionStrategy,
  formatMinutes,
  planIsEditable,
  recoveryCapabilityDelta,
  type BcmPlanStatus,
} from "../lib/bcm";
import { effectiveMembershipStatus } from "../lib/membership";
import { planStrategyCapabilities } from "./recoveryExercises";

/**
 * Business Continuity — Batch 4.2: continuity plans, recovery strategies and
 * recovery gaps.
 * ===========================================================================
 * A continuity plan is a controlled governance record describing HOW a service
 * would be recovered — never a claim that recovery has been achieved or tested.
 *
 * Invariants enforced here (the same ones as the rest of the BCM module):
 *
 *  1. Reads require `bcm.view`; every write requires `bcm.manage` AND an active
 *     membership, so a suspended member or a demo guest can never author or
 *     approve a plan.
 *  2. The organization always comes from the access context. Every referenced
 *     service, BIA, plan, strategy and gap id is re-checked against it, so a
 *     foreign id is indistinguishable from a missing one.
 *  3. Approved plan versions are immutable: plan content and strategies can
 *     only be written while the plan is a draft or has been returned for
 *     revision. Corrections open a numbered revision that must be reviewed
 *     again, and supersession only happens on approval.
 *  4. The preparer can never review their own plan.
 *  5. The BIA a version relied upon is snapshotted (reference, version, status),
 *     so a later BIA revision cannot silently rewrite an approved baseline. A
 *     plan that relies on an unapproved BIA is flagged, never presented as
 *     approved baseline evidence.
 *  6. A strategy's recovery capability is an ESTIMATE. `exercise_verified` is
 *     refused until recovery exercises exist, so an estimate can never be
 *     displayed as validated.
 *  7. Recording a strategy never resolves a gap: gaps carry their own owner,
 *     target date and append-only transition history.
 *  8. Every transition appends an immutable `continuityEvents` row and a
 *     `bcm.*` audit entry naming the real actor.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAGE_LIMIT_MAX = 50;
const PAGE_SCAN_LIMIT = 250;
const COUNT_SCAN_LIMIT = 1000;
const RELATED_SCAN_LIMIT = 300;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertPlanTransition(
  from: BcmPlanStatus,
  to: BcmPlanStatus,
  action: string,
): void {
  if (!canTransitionPlan(from, to)) {
    throw new Error(
      `Cannot ${action}: ${BCM_PLAN_STATUS_LABELS[from]} → ${BCM_PLAN_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
}

function validateReviewDue(input: number | undefined): number {
  const due = requireDate(input, "Plan review date");
  const now = Date.now();
  if (due - now < BCM_MIN_REVIEW_INTERVAL_DAYS * DAY_MS) {
    throw new Error("Plan review date must be in the future");
  }
  if (due - now > BCM_MAX_REVIEW_INTERVAL_DAYS * DAY_MS) {
    throw new Error(
      `Plan review date cannot be more than ${BCM_MAX_REVIEW_INTERVAL_DAYS} days away`,
    );
  }
  return due;
}

function optionalMinutes(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive whole number of minutes`);
  }
  if (value > BCM_MINUTES_MAX) {
    throw new Error(`${field} cannot exceed one year (525 600 minutes)`);
  }
  return value;
}

/** One primary service plus validated additional services, all in the org. */
async function resolvePlanServices(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  primaryServiceId: Id<"businessServices">,
  additionalServiceIds: Id<"businessServices">[] | undefined,
): Promise<{
  primary: Doc<"businessServices">;
  additional: Array<Doc<"businessServices">>;
}> {
  const primary = await requireOwnedService(ctx, organizationId, primaryServiceId);
  const raw = additionalServiceIds ?? [];
  const seen = new Set<string>([String(primaryServiceId)]);
  for (const id of raw) {
    const key = String(id);
    if (seen.has(key)) {
      // Also catches the primary listed twice.
      throw new Error("A business service can only be linked to a plan once");
    }
    seen.add(key);
  }
  if (raw.length > BCM_MAX_ADDITIONAL_SERVICES) {
    throw new Error(
      `A plan can list at most ${BCM_MAX_ADDITIONAL_SERVICES} additional business services`,
    );
  }
  const additional: Array<Doc<"businessServices">> = [];
  for (const id of raw) {
    additional.push(await requireOwnedService(ctx, organizationId, id));
  }
  return { primary, additional };
}

/**
 * A linked BIA must be one of the plan's own services. The snapshot it returns
 * (reference/version/status) is stored on the plan so later revisions of the
 * analysis cannot rewrite what the plan was reviewed against.
 */
async function resolveBiaLink(
  ctx: QueryCtx,
  organizationId: Id<"organizations">,
  biaId: Id<"businessImpactAnalyses"> | undefined,
  serviceIds: Id<"businessServices">[],
): Promise<Doc<"businessImpactAnalyses"> | null> {
  if (biaId === undefined) return null;
  const bia = await requireOwnedBia(ctx, organizationId, biaId);
  if (!serviceIds.some((id) => id === bia.serviceId)) {
    throw new Error(
      "The linked business impact analysis must belong to one of the plan's business services",
    );
  }
  return bia;
}

function biaSnapshot(bia: Doc<"businessImpactAnalyses"> | null) {
  if (!bia) {
    return {
      biaId: undefined,
      biaReference: undefined,
      biaVersion: undefined,
      biaStatusAtLink: undefined,
    };
  }
  return {
    biaId: bia._id,
    biaReference: bia.reference,
    biaVersion: bia.version,
    biaStatusAtLink: bia.status,
  };
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function presentService(row: Doc<"businessServices">) {
  return {
    _id: row._id,
    reference: row.reference,
    name: row.name,
    criticality: row.criticality,
    operationalStatus: row.operationalStatus,
    ownerLabel: row.ownerLabel,
  };
}

function presentPlan(
  row: Doc<"continuityPlans">,
  primary: Doc<"businessServices"> | null,
  additional: Array<Doc<"businessServices">>,
  counts: { strategies: number; openGaps: number },
) {
  const now = Date.now();
  return {
    _id: row._id,
    reference: row.reference,
    title: row.title,
    purpose: row.purpose,
    version: row.version,
    revisionOf: row.revisionOf ?? null,
    supersededByPlanId: row.supersededByPlanId ?? null,
    status: row.status,
    statusLabel: BCM_PLAN_STATUS_LABELS[row.status],
    editable: planIsEditable(row.status),
    primaryServiceId: row.primaryServiceId,
    primaryService: primary ? presentService(primary) : null,
    additionalServices: additional.map(presentService),
    serviceCount: 1 + additional.length,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    recoveryPriority: row.recoveryPriority,
    recoveryPriorityLabel: BCM_PRIORITY_LABELS[row.recoveryPriority],
    disruptionScenarios: row.disruptionScenarios,
    scope: row.scope,
    exclusions: row.exclusions,
    assumptions: row.assumptions,
    reviewDueAt: row.reviewDueAt,
    reviewOverdue: row.reviewDueAt < now && row.status === "approved",
    // The baseline the plan was written against, plus whether it is currently
    // an approved BIA. A draft baseline is flagged, never implied to be one.
    baseline: {
      biaId: row.biaId ?? null,
      biaReference: row.biaReference ?? null,
      biaVersion: row.biaVersion ?? null,
      biaStatusAtLink: row.biaStatusAtLink ?? null,
      biaStatusAtApproval: row.biaStatusAtApproval ?? null,
    },
    preparedByUserId: row.preparedByUserId,
    preparedByLabel: row.preparedByLabel,
    preparedAt: row.preparedAt,
    submittedAt: row.submittedAt ?? null,
    submittedByLabel: row.submittedByLabel ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedByLabel: row.reviewedByLabel ?? null,
    reviewDecision: row.reviewDecision ?? null,
    reviewNotes: row.reviewNotes ?? null,
    approvedAt: row.approvedAt ?? null,
    archivedAt: row.archivedAt ?? null,
    archivedByLabel: row.archivedByLabel ?? null,
    archiveReason: row.archiveReason ?? null,
    strategies: counts.strategies,
    openGaps: counts.openGaps,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentStrategy(
  row: Doc<"recoveryStrategies">,
  baseline: Doc<"businessImpactAnalyses"> | null,
  // Derived from reviewed recovery exercises (Batch 4.3). It is recomputed
  // evidence, never a stored edit to the frozen plan version.
  capability?: { verified: boolean; reasons: string[]; exerciseReference?: string },
) {
  return {
    _id: row._id,
    planId: row.planId,
    reference: row.reference,
    title: row.title,
    objective: row.objective,
    disruptionScenario: row.disruptionScenario,
    recoveryApproach: row.recoveryApproach,
    alternativeArrangements: row.alternativeArrangements ?? null,
    manualFallback: row.manualFallback ?? null,
    personnelRequirements: row.personnelRequirements,
    ictDependencies: row.ictDependencies ?? null,
    vendorDependencies: row.vendorDependencies ?? null,
    facilitiesRequirements: row.facilitiesRequirements ?? null,
    minimumServiceLevel: row.minimumServiceLevel,
    expectedRecoveryMinutes: row.expectedRecoveryMinutes ?? null,
    expectedRecoveryLabel: formatMinutes(row.expectedRecoveryMinutes),
    targetRtoMinutes: row.targetRtoMinutes ?? null,
    targetRtoLabel: formatMinutes(row.targetRtoMinutes),
    targetRpoMinutes: row.targetRpoMinutes ?? null,
    targetRpoLabel: formatMinutes(row.targetRpoMinutes),
    targetMtpdMinutes: row.targetMtpdMinutes ?? null,
    targetMtpdLabel: formatMinutes(row.targetMtpdMinutes),
    capabilityEvidence: row.capabilityEvidence,
    capabilityEvidenceLabel: BCM_CAPABILITY_EVIDENCE_LABELS[row.capabilityEvidence],
    capabilityRationale: row.capabilityRationale,
    exerciseVerified: capability?.verified ?? false,
    exerciseVerificationReasons: capability?.reasons ?? [
      "No reviewed recovery exercise covers this strategy",
    ],
    exerciseVerifiedBy: capability?.exerciseReference ?? null,
    // Arithmetic only. A positive delta means the ESTIMATE is longer than the
    // approved objective — it says nothing about what recovery would achieve.
    rtoDeltaMinutes: baseline
      ? recoveryCapabilityDelta({
          objectiveMinutes: baseline.rtoMinutes,
          expectedMinutes: row.expectedRecoveryMinutes,
        }) ?? null
      : null,
    baselineRtoMinutes: baseline?.rtoMinutes ?? null,
    baselineRtoLabel: baseline ? formatMinutes(baseline.rtoMinutes) : null,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    status: row.status,
    statusLabel: BCM_STRATEGY_STATUS_LABELS[row.status],
    statusRationale: row.statusRationale,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentGap(row: Doc<"recoveryGaps">, strategyReference: string | null) {
  const now = Date.now();
  return {
    _id: row._id,
    planId: row.planId,
    strategyId: row.strategyId ?? null,
    strategyReference,
    reference: row.reference,
    description: row.description,
    severity: row.severity,
    severityLabel: BCM_GAP_SEVERITY_LABELS[row.severity],
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    targetResolutionDate: row.targetResolutionDate,
    overdue:
      row.status !== "resolved" &&
      row.status !== "accepted" &&
      row.targetResolutionDate < now,
    mitigationRecommendation: row.mitigationRecommendation,
    status: row.status,
    statusLabel: BCM_GAP_STATUS_LABELS[row.status],
    statusRationale: row.statusRationale ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolvedByLabel: row.resolvedByLabel ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Bounded per-organization lookup maps used by the register. */
async function loadRegisterMeta(ctx: QueryCtx, organizationId: Id<"organizations">) {
  const [services, strategies, gaps] = await Promise.all([
    ctx.db
      .query("businessServices")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(RELATED_SCAN_LIMIT),
    ctx.db
      .query("recoveryStrategies")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(RELATED_SCAN_LIMIT),
    ctx.db
      .query("recoveryGaps")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(RELATED_SCAN_LIMIT),
  ]);
  const serviceById = new Map(services.map((row) => [String(row._id), row]));
  const strategyCount = new Map<string, number>();
  for (const row of strategies) {
    const key = String(row.planId);
    strategyCount.set(key, (strategyCount.get(key) ?? 0) + 1);
  }
  const openGapCount = new Map<string, number>();
  for (const row of gaps) {
    if (row.status !== "open" && row.status !== "in_progress") continue;
    const key = String(row.planId);
    openGapCount.set(key, (openGapCount.get(key) ?? 0) + 1);
  }
  return {
    serviceById,
    strategyCount,
    openGapCount,
    servicesTruncated: services.length === RELATED_SCAN_LIMIT,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Services (with their BIA state) and active members a plan form can use. */
export const planFormOptions = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveBcmAccess(ctx);
    const [services, bias, profiles] = await Promise.all([
      ctx.db
        .query("businessServices")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(RELATED_SCAN_LIMIT),
      ctx.db
        .query("businessImpactAnalyses")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(RELATED_SCAN_LIMIT),
      ctx.db
        .query("userProfiles")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(200),
    ]);

    const members: Array<{ userId: Id<"users">; label: string }> = [];
    for (const profile of profiles) {
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
        continue;
      }
      const user = await ctx.db.get(profile.userId);
      if (!user) continue;
      members.push({
        userId: profile.userId,
        label: user.name ?? user.email ?? "Member",
      });
    }
    members.sort((a, b) => a.label.localeCompare(b.label));

    // Latest version per service, and whether an approved version exists at all.
    const latestByService = new Map<
      string,
      { reference: string; version: number; status: string; id: Id<"businessImpactAnalyses"> }
    >();
    const approvedByService = new Set<string>();
    for (const row of bias) {
      const key = String(row.serviceId);
      if (row.status === "approved") approvedByService.add(key);
      const current = latestByService.get(key);
      if (!current || row.version > current.version) {
        latestByService.set(key, {
          id: row._id,
          reference: row.reference,
          version: row.version,
          status: row.status,
        });
      }
    }

    return {
      services: services
        .map((row) => ({
          ...presentService(row),
          latestBia: latestByService.get(String(row._id)) ?? null,
          hasApprovedBia: approvedByService.has(String(row._id)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      // Every analysis version a plan may link to, so the form can offer the
      // approved baseline (and reveal when only a draft exists).
      bias: bias
        .map((row) => ({
          _id: row._id,
          serviceId: row.serviceId,
          reference: row.reference,
          title: row.title,
          version: row.version,
          status: row.status,
          approved: row.status === "approved",
        }))
        .sort((a, b) =>
          `${a.reference}-${a.version}`.localeCompare(`${b.reference}-${b.version}`),
        ),
      members,
      canManage: access.canManage,
      currentUserId: access.userId,
      truncated: services.length === RELATED_SCAN_LIMIT,
    };
  },
});

/** Organization-scoped plan register with search, filters and paging. */
export const listPlans = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    priority: v.optional(bcmPriorityValidator),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const limit = Math.min(Math.max(Math.floor(args.limit ?? 25), 1), PAGE_LIMIT_MAX);
    const search = args.search?.trim().toLowerCase() ?? "";
    const statusFilter = args.status?.trim();

    const scan = await ctx.db
      .query("continuityPlans")
      .withIndex("by_organization_created", (q) => {
        const scoped = q.eq("organizationId", access.organizationId);
        return args.cursor !== undefined ? scoped.lt("createdAt", args.cursor) : scoped;
      })
      .order("desc")
      .take(PAGE_SCAN_LIMIT);

    const meta = await loadRegisterMeta(ctx, access.organizationId);

    const filtered = scan
      .filter((row) => (args.cursor !== undefined ? row.createdAt < args.cursor : true))
      .filter((row) => (statusFilter ? row.status === statusFilter : true))
      .filter((row) => (args.priority ? row.recoveryPriority === args.priority : true))
      .filter((row) => {
        if (!search) return true;
        const primary = meta.serviceById.get(String(row.primaryServiceId));
        return [row.reference, row.title, row.purpose, row.ownerLabel, primary?.name ?? ""]
          .join(" ")
          .toLowerCase()
          .includes(search);
      });

    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 && (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);

    const all = await ctx.db
      .query("continuityPlans")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(COUNT_SCAN_LIMIT);

    return {
      rows: page.map((row) =>
        presentPlan(
          row,
          meta.serviceById.get(String(row.primaryServiceId)) ?? null,
          (row.additionalServiceIds ?? [])
            .map((id) => meta.serviceById.get(String(id)))
            .filter((doc): doc is Doc<"businessServices"> => doc !== undefined),
          {
            strategies: meta.strategyCount.get(String(row._id)) ?? 0,
            openGaps: meta.openGapCount.get(String(row._id)) ?? 0,
          },
        ),
      ),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      counts: {
        total: all.length,
        approved: all.filter((row) => row.status === "approved").length,
        inReview: all.filter((row) => row.status === "in_review").length,
        returned: all.filter((row) => row.status === "returned").length,
        draft: all.filter((row) => row.status === "draft").length,
        superseded: all.filter((row) => row.status === "superseded").length,
        archived: all.filter((row) => row.status === "archived").length,
        openGaps: [...meta.openGapCount.values()].reduce((a, b) => a + b, 0),
        truncated: all.length === COUNT_SCAN_LIMIT,
      },
      canManage: access.canManage,
      currentUserId: access.userId,
      servicesTruncated: meta.servicesTruncated,
    };
  },
});

/** One plan with its baseline, versions, strategies, gaps and history. */
export const getPlan = query({
  args: { planId: v.id("continuityPlans") },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    const primary = await requireOwnedService(
      ctx,
      access.organizationId,
      plan.primaryServiceId,
    );
    const additional: Array<Doc<"businessServices">> = [];
    for (const id of plan.additionalServiceIds ?? []) {
      additional.push(await requireOwnedService(ctx, access.organizationId, id));
    }

    const baseline = plan.biaId
      ? await requireOwnedBia(ctx, access.organizationId, plan.biaId).catch(() => null)
      : null;

    const [strategies, gaps, events, orgPlans] = await Promise.all([
      ctx.db
        .query("recoveryStrategies")
        .withIndex("by_organization_plan", (q) =>
          q.eq("organizationId", access.organizationId).eq("planId", plan._id),
        )
        .take(100),
      ctx.db
        .query("recoveryGaps")
        .withIndex("by_organization_plan", (q) =>
          q.eq("organizationId", access.organizationId).eq("planId", plan._id),
        )
        .take(200),
      ctx.db
        .query("continuityEvents")
        .withIndex("by_organization_plan", (q) =>
          q.eq("organizationId", access.organizationId).eq("planId", plan._id),
        )
        .take(200),
      ctx.db
        .query("continuityPlans")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(RELATED_SCAN_LIMIT),
    ]);

    // Version family: walk revision links to the root, then collect every row
    // whose chain reaches that root. Bounded by the organization scan above.
    let root = plan;
    for (let i = 0; i < 50 && root.revisionOf; i += 1) {
      const parent = orgPlans.find((row) => row._id === root.revisionOf);
      if (!parent) break;
      root = parent;
    }
    const inFamily = (row: Doc<"continuityPlans">): boolean => {
      let current: Doc<"continuityPlans"> | undefined = row;
      for (let i = 0; i < 50 && current; i += 1) {
        if (current._id === root._id) return true;
        current = current.revisionOf
          ? orgPlans.find((candidate) => candidate._id === current!.revisionOf)
          : undefined;
      }
      return false;
    };

    const strategyById = new Map(strategies.map((row) => [String(row._id), row]));
    const openGaps = gaps.filter(
      (row) => row.status === "open" || row.status === "in_progress",
    );
    const capabilities = await planStrategyCapabilities(
      ctx,
      access.organizationId,
      plan,
    );

    return {
      plan: presentPlan(plan, primary, additional, {
        strategies: strategies.length,
        openGaps: openGaps.length,
      }),
      primaryService: presentService(primary),
      additionalServices: additional.map(presentService),
      baseline: baseline
        ? {
            _id: baseline._id,
            reference: baseline.reference,
            title: baseline.title,
            version: baseline.version,
            status: baseline.status,
            approved: baseline.status === "approved",
            approvedAt: baseline.approvedAt ?? null,
            rtoMinutes: baseline.rtoMinutes,
            rtoLabel: formatMinutes(baseline.rtoMinutes),
            rpoMinutes: baseline.rpoMinutes ?? null,
            rpoLabel: formatMinutes(baseline.rpoMinutes),
            mtpdMinutes: baseline.mtpdMinutes ?? null,
            mtpdLabel: formatMinutes(baseline.mtpdMinutes),
            minimumServiceLevel: baseline.minimumServiceLevel,
            recoveryPriority: baseline.recoveryPriority,
            recoveryPriorityLabel: BCM_PRIORITY_LABELS[baseline.recoveryPriority],
            reviewDueAt: baseline.reviewDueAt,
          }
        : null,
      // "No approved baseline" is a state, not an error: a draft plan may be
      // written before its BIA is approved. It is always disclosed.
      baselineWarning: !plan.biaId
        ? "No business impact analysis is linked to this plan, so no approved recovery objectives underpin it."
        : baseline && baseline.status !== "approved"
          ? `The linked analysis ${baseline.reference} v${baseline.version} is ${baseline.status.replace("_", " ")}, not approved. The plan does not rest on an approved recovery baseline.`
          : null,
      versions: orgPlans
        .filter(inFamily)
        .map((row) => ({
          _id: row._id,
          reference: row.reference,
          version: row.version,
          status: row.status,
          approvedAt: row.approvedAt ?? null,
          reviewDueAt: row.reviewDueAt,
          biaReference: row.biaReference ?? null,
          biaVersion: row.biaVersion ?? null,
        }))
        .sort((a, b) => b.version - a.version),
      strategies: strategies
        .map((row) =>
          presentStrategy(row, baseline, capabilities.get(String(row._id))),
        )
        .sort((a, b) => a.reference.localeCompare(b.reference)),
      // Only strategies that a reviewed exercise actually evidenced are counted;
      // a plan is never presented as exercise-verified as a whole.
      strategyCapabilitySummary: {
        total: strategies.length,
        exerciseVerified: strategies.filter(
          (row) => capabilities.get(String(row._id))?.verified,
        ).length,
      },
      gaps: gaps
        .map((row) =>
          presentGap(
            row,
            row.strategyId
              ? (strategyById.get(String(row.strategyId))?.reference ?? null)
              : null,
          ),
        )
        .sort((a, b) => a.reference.localeCompare(b.reference)),
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

// ---------------------------------------------------------------------------
// Plan mutations
// ---------------------------------------------------------------------------

const planInputArgs = {
  title: v.string(),
  purpose: v.string(),
  primaryServiceId: v.id("businessServices"),
  additionalServiceIds: v.optional(v.array(v.id("businessServices"))),
  ownerUserId: v.id("users"),
  biaId: v.optional(v.id("businessImpactAnalyses")),
  disruptionScenarios: v.string(),
  recoveryPriority: bcmPriorityValidator,
  scope: v.string(),
  exclusions: v.string(),
  assumptions: v.string(),
  reviewDueAt: v.number(),
};

/** Create a first draft continuity plan for one or more services. */
export const createPlan = mutation({
  args: planInputArgs,
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const { primary, additional } = await resolvePlanServices(
      ctx,
      access.organizationId,
      args.primaryServiceId,
      args.additionalServiceIds,
    );
    const serviceIds = [primary._id, ...additional.map((row) => row._id)];
    const bia = await resolveBiaLink(
      ctx,
      access.organizationId,
      args.biaId,
      serviceIds,
    );
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Plan owner",
    );
    const reviewDueAt = validateReviewDue(args.reviewDueAt);
    const reference = await nextBcmReference(
      ctx,
      "continuityPlans",
      access.organizationId,
      "BCP",
    );
    const now = Date.now();
    const planId = await ctx.db.insert("continuityPlans", {
      organizationId: access.organizationId,
      reference,
      title: requireTitle(args.title, "Plan title"),
      purpose: requireNarrative(args.purpose, "Plan purpose"),
      primaryServiceId: primary._id,
      additionalServiceIds: additional.map((row) => row._id),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      ...biaSnapshot(bia),
      disruptionScenarios: requireNarrative(
        args.disruptionScenarios,
        "Disruption scenarios",
      ),
      recoveryPriority: args.recoveryPriority,
      scope: requireNarrative(args.scope, "Plan scope"),
      exclusions: requireNarrative(args.exclusions, "Plan exclusions"),
      assumptions: requireNarrative(args.assumptions, "Plan assumptions"),
      reviewDueAt,
      status: "draft",
      version: 1,
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId,
      serviceId: primary._id,
      biaId: bia?._id,
      type: "plan_created",
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${reference} v1 created for ${primary.reference} (${primary.name})${bia ? ` against ${bia.reference} v${bia.version} (${bia.status})` : " with no linked analysis"}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_created",
      entityType: "continuityPlans",
      entityId: String(planId),
      relatedEntityType: "businessServices",
      relatedEntityId: String(primary._id),
      summary: `Created continuity plan ${reference} v1`,
    });

    return { planId, reference };
  },
});

/** Edit a draft or returned plan; an approved version must be revised instead. */
export const updatePlan = mutation({
  args: { planId: v.id("continuityPlans"), ...planInputArgs },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (!planIsEditable(plan.status)) {
      throw new Error(
        "Only a draft or returned plan can be edited; an approved plan must be revised as a new version",
      );
    }
    const { primary, additional } = await resolvePlanServices(
      ctx,
      access.organizationId,
      args.primaryServiceId,
      args.additionalServiceIds,
    );
    const serviceIds = [primary._id, ...additional.map((row) => row._id)];
    const bia = await resolveBiaLink(
      ctx,
      access.organizationId,
      args.biaId,
      serviceIds,
    );
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Plan owner",
    );
    const reviewDueAt = validateReviewDue(args.reviewDueAt);

    await ctx.db.patch(plan._id, {
      title: requireTitle(args.title, "Plan title"),
      purpose: requireNarrative(args.purpose, "Plan purpose"),
      primaryServiceId: primary._id,
      additionalServiceIds: additional.map((row) => row._id),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      ...biaSnapshot(bia),
      disruptionScenarios: requireNarrative(
        args.disruptionScenarios,
        "Disruption scenarios",
      ),
      recoveryPriority: args.recoveryPriority,
      scope: requireNarrative(args.scope, "Plan scope"),
      exclusions: requireNarrative(args.exclusions, "Plan exclusions"),
      assumptions: requireNarrative(args.assumptions, "Plan assumptions"),
      reviewDueAt,
      updatedAt: Date.now(),
    });

    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      serviceId: primary._id,
      biaId: bia?._id,
      type: "plan_updated",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${plan.reference} v${plan.version} updated (${plan.status === "returned" ? "after revision request" : "draft"})`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_updated",
      entityType: "continuityPlans",
      entityId: String(plan._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(primary._id),
      summary: `Updated continuity plan ${plan.reference} v${plan.version}`,
    });

    return { ok: true as const };
  },
});

/** Submit a draft (or a returned plan) for independent review. */
export const submitPlan = mutation({
  args: { planId: v.id("continuityPlans") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (plan.status !== "draft" && plan.status !== "returned") {
      throw new Error(
        "Only a draft or returned plan can be submitted; an approved plan is revised as a new version",
      );
    }
    assertPlanTransition(plan.status, "in_review", "submit for review");
    const now = Date.now();
    await ctx.db.patch(plan._id, {
      status: "in_review",
      submittedAt: now,
      submittedByUserId: access.userId,
      submittedByLabel: access.label,
      // A resubmission starts a clean review: earlier decisions stay in the
      // append-only history, not on the live record.
      reviewDecision: undefined,
      reviewNotes: undefined,
      reviewedAt: undefined,
      reviewedByUserId: undefined,
      reviewedByLabel: undefined,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      serviceId: plan.primaryServiceId,
      type: "plan_submitted",
      fromStatus: plan.status,
      toStatus: "in_review",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${plan.reference} v${plan.version} submitted for independent review`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_submitted",
      entityType: "continuityPlans",
      entityId: String(plan._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(plan.primaryServiceId),
      summary: `Submitted continuity plan ${plan.reference} v${plan.version}`,
    });
    return { status: "in_review" as const };
  },
});

/**
 * Independent review: approve (freezing the version) or return for revision.
 * The preparer can never review their own plan, and an approval records the
 * status of the linked BIA so a draft baseline is visible in the history.
 */
export const reviewPlan = mutation({
  args: {
    planId: v.id("continuityPlans"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reviewNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (plan.status !== "in_review") {
      throw new Error("Only a plan submitted for review can be reviewed");
    }
    if (plan.preparedByUserId === access.userId) {
      throw new Error(
        "Independent review required: the preparer cannot review their own continuity plan",
      );
    }
    const reviewNotes = requireNarrative(
      args.reviewNotes,
      "Review notes",
      undefined,
      BCM_NARRATIVE_MIN,
    );
    const now = Date.now();

    if (args.decision === "approved") {
      assertPlanTransition(plan.status, "approved", "approve");
      const baseline = plan.biaId
        ? await requireOwnedBia(ctx, access.organizationId, plan.biaId).catch(() => null)
        : null;
      await ctx.db.patch(plan._id, {
        status: "approved",
        reviewDecision: "approved",
        reviewNotes,
        reviewedAt: now,
        reviewedByUserId: access.userId,
        reviewedByLabel: access.label,
        approvedAt: now,
        biaStatusAtApproval: baseline?.status,
        updatedAt: now,
      });
      if (plan.revisionOf !== undefined) {
        const previous = await ctx.db.get(plan.revisionOf);
        if (previous && previous.organizationId === access.organizationId) {
          await ctx.db.patch(previous._id, {
            status: "superseded",
            supersededByPlanId: plan._id,
            updatedAt: now,
          });
        }
      }
      await appendContinuityEvent(ctx, {
        organizationId: access.organizationId,
        planId: plan._id,
        serviceId: plan.primaryServiceId,
        type: "plan_approved",
        fromStatus: plan.status,
        toStatus: "approved",
        actorUserId: access.userId,
        actorLabel: access.label,
        summary: `Continuity plan ${plan.reference} v${plan.version} independently approved by ${access.label}${plan.biaId ? ` (baseline ${plan.biaReference} v${plan.biaVersion}, ${baseline?.status ?? "unavailable"})` : " (no linked analysis)"}`,
        reason: reviewNotes.slice(0, 240),
      });
      await logBcmAudit(ctx, access, {
        action: "bcm.plan_approved",
        entityType: "continuityPlans",
        entityId: String(plan._id),
        relatedEntityType: "businessServices",
        relatedEntityId: String(plan.primaryServiceId),
        summary: `Approved continuity plan ${plan.reference} v${plan.version}`,
      });
      return { status: "approved" as const };
    }

    assertPlanTransition(plan.status, "returned", "return for revision");
    await ctx.db.patch(plan._id, {
      status: "returned",
      reviewDecision: "rejected",
      reviewNotes,
      reviewedAt: now,
      reviewedByUserId: access.userId,
      reviewedByLabel: access.label,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      serviceId: plan.primaryServiceId,
      type: "plan_returned",
      fromStatus: plan.status,
      toStatus: "returned",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${plan.reference} v${plan.version} returned for revision by ${access.label}`,
      reason: reviewNotes.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_returned",
      entityType: "continuityPlans",
      entityId: String(plan._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(plan.primaryServiceId),
      summary: `Returned continuity plan ${plan.reference} v${plan.version} for revision`,
    });
    return { status: "returned" as const };
  },
});

/** Open the next draft version of an approved plan; the old version stays. */
export const revisePlan = mutation({
  args: { planId: v.id("continuityPlans") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (plan.status !== "approved" && plan.status !== "superseded") {
      throw new Error(
        "Only an approved plan can be revised; edit the existing draft instead",
      );
    }
    const family = await ctx.db
      .query("continuityPlans")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId),
      )
      .take(RELATED_SCAN_LIMIT);
    if (
      family.some(
        (row) =>
          row.revisionOf === plan._id &&
          (row.status === "draft" ||
            row.status === "in_review" ||
            row.status === "returned"),
      )
    ) {
      throw new Error(
        "A revision of this plan is already open; complete it before opening another",
      );
    }
    const reference = await nextBcmReference(
      ctx,
      "continuityPlans",
      access.organizationId,
      "BCP",
    );
    const now = Date.now();
    const planId = await ctx.db.insert("continuityPlans", {
      organizationId: access.organizationId,
      reference,
      title: plan.title,
      purpose: plan.purpose,
      primaryServiceId: plan.primaryServiceId,
      additionalServiceIds: plan.additionalServiceIds,
      ownerUserId: plan.ownerUserId,
      ownerLabel: plan.ownerLabel,
      biaId: plan.biaId,
      biaReference: plan.biaReference,
      biaVersion: plan.biaVersion,
      biaStatusAtLink: plan.biaStatusAtLink,
      disruptionScenarios: plan.disruptionScenarios,
      recoveryPriority: plan.recoveryPriority,
      scope: plan.scope,
      exclusions: plan.exclusions,
      assumptions: plan.assumptions,
      reviewDueAt: plan.reviewDueAt,
      status: "draft",
      version: plan.version + 1,
      revisionOf: plan._id,
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId,
      serviceId: plan.primaryServiceId,
      type: "plan_revised",
      toStatus: "draft",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${reference} v${plan.version + 1} opened as a revision of ${plan.reference} v${plan.version}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_revised",
      entityType: "continuityPlans",
      entityId: String(planId),
      relatedEntityType: "businessServices",
      relatedEntityId: String(plan.primaryServiceId),
      summary: `Opened revision ${reference} v${plan.version + 1} of ${plan.reference}`,
    });
    return { planId, reference, version: plan.version + 1 };
  },
});

/** Retire a plan from active use without deleting its history. */
export const archivePlan = mutation({
  args: { planId: v.id("continuityPlans"), reason: v.string() },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    assertPlanTransition(plan.status, "archived", "archive");
    const reason = requireNarrative(args.reason, "Archive reason");
    const now = Date.now();
    await ctx.db.patch(plan._id, {
      status: "archived",
      archivedAt: now,
      archivedByUserId: access.userId,
      archivedByLabel: access.label,
      archiveReason: reason,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      serviceId: plan.primaryServiceId,
      type: "plan_archived",
      fromStatus: plan.status,
      toStatus: "archived",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Continuity plan ${plan.reference} v${plan.version} archived by ${access.label}`,
      reason: reason.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.plan_archived",
      entityType: "continuityPlans",
      entityId: String(plan._id),
      relatedEntityType: "businessServices",
      relatedEntityId: String(plan.primaryServiceId),
      summary: `Archived continuity plan ${plan.reference} v${plan.version}`,
    });
    return { status: "archived" as const };
  },
});

// ---------------------------------------------------------------------------
// Recovery strategies
// ---------------------------------------------------------------------------

const strategyInputArgs = {
  title: v.string(),
  objective: v.string(),
  disruptionScenario: v.string(),
  recoveryApproach: v.string(),
  alternativeArrangements: v.optional(v.string()),
  manualFallback: v.optional(v.string()),
  personnelRequirements: v.string(),
  ictDependencies: v.optional(v.string()),
  vendorDependencies: v.optional(v.string()),
  facilitiesRequirements: v.optional(v.string()),
  minimumServiceLevel: v.string(),
  expectedRecoveryMinutes: v.optional(v.number()),
  targetRtoMinutes: v.optional(v.number()),
  targetRpoMinutes: v.optional(v.number()),
  targetMtpdMinutes: v.optional(v.number()),
  capabilityEvidence: bcmCapabilityEvidenceValidator,
  capabilityRationale: v.string(),
  ownerUserId: v.id("users"),
  statusRationale: v.string(),
};

/** Document a recovery strategy for a plan that is still being authored. */
export const createStrategy = mutation({
  args: { planId: v.id("continuityPlans"), ...strategyInputArgs },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (!planIsEditable(plan.status)) {
      throw new Error(
        "Recovery strategies can only be documented while the plan is a draft or returned for revision; an approved plan is frozen",
      );
    }
    if (args.capabilityEvidence === "exercise_verified") {
      throw new Error(
        "Recovery exercises are not part of this module yet, so a strategy can only record an estimated capability",
      );
    }
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Strategy owner",
    );
    const expectedRecoveryMinutes = optionalMinutes(
      args.expectedRecoveryMinutes,
      "Expected recovery time",
    );
    const targetRtoMinutes = optionalMinutes(args.targetRtoMinutes, "Target RTO");
    const targetRpoMinutes = optionalMinutes(args.targetRpoMinutes, "Target RPO");
    const targetMtpdMinutes = optionalMinutes(args.targetMtpdMinutes, "Target MTPD");
    const reference = await nextBcmReference(
      ctx,
      "recoveryStrategies",
      access.organizationId,
      "BRS",
    );
    const now = Date.now();
    const strategyId = await ctx.db.insert("recoveryStrategies", {
      organizationId: access.organizationId,
      planId: plan._id,
      reference,
      title: requireTitle(args.title, "Strategy title"),
      objective: requireNarrative(args.objective, "Strategy objective"),
      disruptionScenario: requireNarrative(
        args.disruptionScenario,
        "Strategy disruption scenario",
      ),
      recoveryApproach: requireNarrative(
        args.recoveryApproach,
        "Recovery approach",
      ),
      alternativeArrangements: optionalText(
        args.alternativeArrangements,
        "Alternative work arrangements",
      ),
      manualFallback: optionalText(args.manualFallback, "Manual fallback"),
      personnelRequirements: requireNarrative(
        args.personnelRequirements,
        "Personnel and resource requirements",
      ),
      ictDependencies: optionalText(args.ictDependencies, "ICT dependencies"),
      vendorDependencies: optionalText(args.vendorDependencies, "Vendor dependencies"),
      facilitiesRequirements: optionalText(
        args.facilitiesRequirements,
        "Facilities and equipment",
      ),
      minimumServiceLevel: requireNarrative(
        args.minimumServiceLevel,
        "Minimum service level during disruption",
      ),
      expectedRecoveryMinutes,
      targetRtoMinutes,
      targetRpoMinutes,
      targetMtpdMinutes,
      capabilityEvidence: args.capabilityEvidence,
      capabilityRationale: requireNarrative(
        args.capabilityRationale,
        "Capability rationale",
      ),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      status: "proposed",
      statusRationale: requireNarrative(args.statusRationale, "Status rationale"),
      createdAt: now,
      updatedAt: now,
    });

    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      strategyId,
      serviceId: plan.primaryServiceId,
      type: "strategy_created",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery strategy ${reference} documented for ${plan.reference} v${plan.version}${expectedRecoveryMinutes ? ` (estimated ${formatMinutes(expectedRecoveryMinutes)})` : ""}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.strategy_created",
      entityType: "recoveryStrategies",
      entityId: String(strategyId),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(plan._id),
      summary: `Documented recovery strategy ${reference} for ${plan.reference}`,
    });

    return { strategyId, reference };
  },
});

/** Adopt or retire a documented strategy (controlled transitions only). */
export const updateStrategyStatus = mutation({
  args: {
    strategyId: v.id("recoveryStrategies"),
    status: bcmStrategyStatusValidator,
    rationale: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const strategy = await requireOwnedStrategy(
      ctx,
      access.organizationId,
      args.strategyId,
    );
    const plan = await requireOwnedPlan(ctx, access.organizationId, strategy.planId);
    if (!planIsEditable(plan.status)) {
      throw new Error(
        "A strategy of an approved plan is frozen; revise the plan to change its strategies",
      );
    }
    if (!canTransitionStrategy(strategy.status, args.status)) {
      throw new Error(
        `Cannot change strategy status: ${BCM_STRATEGY_STATUS_LABELS[strategy.status]} → ${BCM_STRATEGY_STATUS_LABELS[args.status]} is not a permitted transition`,
      );
    }
    const rationale = requireNarrative(args.rationale, "Status rationale");
    const now = Date.now();
    await ctx.db.patch(strategy._id, {
      status: args.status,
      statusRationale: rationale,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      strategyId: strategy._id,
      serviceId: plan.primaryServiceId,
      type: "strategy_status_changed",
      fromStatus: strategy.status,
      toStatus: args.status,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery strategy ${strategy.reference} set to ${BCM_STRATEGY_STATUS_LABELS[args.status]} by ${access.label}`,
      reason: rationale.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.strategy_status_changed",
      entityType: "recoveryStrategies",
      entityId: String(strategy._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(plan._id),
      summary: `Strategy ${strategy.reference} → ${args.status}`,
    });
    return { status: args.status };
  },
});

// ---------------------------------------------------------------------------
// Recovery gaps
// ---------------------------------------------------------------------------

/**
 * Record a gap between the approved objectives and documented capability.
 * Gaps are independent records: documenting a strategy never resolves one, and
 * accepting a gap is an explicit, attributed decision.
 */
export const createGap = mutation({
  args: {
    planId: v.id("continuityPlans"),
    strategyId: v.optional(v.id("recoveryStrategies")),
    description: v.string(),
    severity: bcmGapSeverityValidator,
    ownerUserId: v.id("users"),
    targetResolutionDate: v.number(),
    mitigationRecommendation: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireOwnedPlan(ctx, access.organizationId, args.planId);
    if (plan.status === "archived") {
      throw new Error("An archived plan accepts no new recovery gaps");
    }
    let strategy: Doc<"recoveryStrategies"> | null = null;
    if (args.strategyId !== undefined) {
      strategy = await requireOwnedStrategy(ctx, access.organizationId, args.strategyId);
      if (strategy.planId !== plan._id) {
        throw new Error("The strategy does not belong to this continuity plan");
      }
    }
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Gap owner",
    );
    const target = requireDate(args.targetResolutionDate, "Target resolution date");
    if (target <= Date.now()) {
      throw new Error("Target resolution date must be in the future");
    }
    const reference = await nextBcmReference(
      ctx,
      "recoveryGaps",
      access.organizationId,
      "GAP",
    );
    const now = Date.now();
    const gapId = await ctx.db.insert("recoveryGaps", {
      organizationId: access.organizationId,
      planId: plan._id,
      strategyId: strategy?._id,
      reference,
      description: requireNarrative(args.description, "Gap description"),
      severity: args.severity,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      targetResolutionDate: target,
      mitigationRecommendation: requireNarrative(
        args.mitigationRecommendation,
        "Mitigation recommendation",
      ),
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      gapId,
      strategyId: strategy?._id,
      serviceId: plan.primaryServiceId,
      type: "gap_recorded",
      toStatus: "open",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery gap ${reference} recorded for ${plan.reference} v${plan.version} (${BCM_GAP_SEVERITY_LABELS[args.severity]})`,
      reason: args.description.trim().slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.gap_recorded",
      entityType: "recoveryGaps",
      entityId: String(gapId),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(plan._id),
      summary: `Recorded recovery gap ${reference} for ${plan.reference}`,
    });
    return { gapId, reference };
  },
});

/** Move a gap through its lifecycle; resolution is always attributed. */
export const updateGapStatus = mutation({
  args: {
    gapId: v.id("recoveryGaps"),
    status: bcmGapStatusValidator,
    rationale: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const gap = await requireOwnedGap(ctx, access.organizationId, args.gapId);
    if (!canTransitionGap(gap.status, args.status)) {
      throw new Error(
        `Cannot change gap status: ${BCM_GAP_STATUS_LABELS[gap.status]} → ${BCM_GAP_STATUS_LABELS[args.status]} is not a permitted transition`,
      );
    }
    const rationale = args.rationale?.trim()
      ? requireNarrative(args.rationale, "Status rationale")
      : undefined;
    if (args.status === "resolved" && rationale === undefined) {
      throw new Error(
        "Resolving a recovery gap requires a stated resolution rationale",
      );
    }
    if (args.status === "accepted" && rationale === undefined) {
      throw new Error(
        "Accepting a recovery gap requires a stated acceptance rationale",
      );
    }
    const now = Date.now();
    const patch: Record<string, unknown> = {
      status: args.status,
      statusRationale: rationale,
      updatedAt: now,
    };
    if (args.status === "resolved") {
      patch.resolvedAt = now;
      patch.resolvedByUserId = access.userId;
      patch.resolvedByLabel = access.label;
    }
    await ctx.db.patch(gap._id, patch);
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: gap.planId,
      gapId: gap._id,
      strategyId: gap.strategyId,
      type: "gap_status_changed",
      fromStatus: gap.status,
      toStatus: args.status,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery gap ${gap.reference} set to ${BCM_GAP_STATUS_LABELS[args.status]} by ${access.label}`,
      reason: rationale?.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.gap_status_changed",
      entityType: "recoveryGaps",
      entityId: String(gap._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(gap.planId),
      summary: `Recovery gap ${gap.reference} → ${args.status}`,
    });
    return { status: args.status };
  },
});
