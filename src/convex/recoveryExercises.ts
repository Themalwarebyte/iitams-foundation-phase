import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
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
  requireOwnedGap,
  requireOwnedPlan,
  requireOwnedStrategy,
  requireTitle,
  resolveBcmAccess,
} from "./bcmCore";
import {
  BCM_EXERCISE_STATUS_LABELS,
  BCM_EXERCISE_TYPE_DESCRIPTIONS,
  BCM_EXERCISE_TYPE_LABELS,
  BCM_FINDING_SEVERITY_LABELS,
  BCM_FINDING_STATUS_LABELS,
  BCM_MEASUREMENT_OBJECTIVE_LABELS,
  BCM_MEASUREMENT_OUTCOME_LABELS,
  BCM_MINUTES_MAX,
  BCM_PLAN_STATUS_LABELS,
  BCM_PRIORITY_LABELS,
  bcmExerciseTypeValidator,
  bcmFindingSeverityValidator,
  bcmFindingStatusValidator,
  bcmMeasurementObjectiveValidator,
  bcmMeasurementOutcomeValidator,
  canTransitionExercise,
  canTransitionFinding,
  evaluateStrategyCapability,
  exerciseAcceptsFindings,
  exercisePlanningEditable,
  exerciseResultsEditable,
  formatMinutes,
  measuredObjectiveDelta,
  measurementOutcomeIsConsistent,
  type BcmExerciseStatus,
  type BcmFindingStatus,
  type BcmMeasurementObjective,
  type BcmMeasurementOutcome,
} from "../lib/bcm";
import { effectiveMembershipStatus } from "../lib/membership";

/**
 * Business Continuity — Batch 4.3: recovery exercises, testing and validation.
 * ===========================================================================
 * An exercise is a RECORD: what was planned, what the team reported doing, what
 * an independent verifier confirmed, and what was measured. Nothing in this
 * module executes recovery, shuts anything down, triggers failover, restores a
 * backup or sends an emergency notification. Controlled technical recovery tests
 * are performed by responsible personnel under separate authorization; this
 * register only documents and reviews them.
 *
 * Invariants enforced here:
 *
 *  1. Reads require `bcm.view`; every write requires `bcm.manage` AND an active
 *     membership. The organization always comes from the access context, and
 *     every plan, strategy, gap, owner and participant id is re-checked against
 *     it, so a foreign id is indistinguishable from a missing one.
 *  2. An exercise can only be recorded against an APPROVED continuity plan
 *     version. Draft, in-review, superseded and archived plans are refused.
 *  3. The plan, its version and the analysis baseline are snapshotted at
 *     creation, so later revisions cannot rewrite what was tested.
 *  4. Planning data is only editable before the exercise starts. Observations,
 *     measurements and strategy coverage are only recordable while it is `in
 *     progress`. Once completed the reported record is frozen; a returned
 *     exercise is corrected by a new version, never by rewriting history.
 *  5. `performed` (reported) and `verified` (independently checked) are separate
 *     facts. A verifier can never verify their own report.
 *  6. A measurement must agree with its recorded outcome, and without an
 *     approved objective the only honest outcome is `not_assessed`. Objectives
 *     live on the linked BIA and are snapshotted, never modified from here.
 *  7. Independent review: a reviewer cannot be the owner, facilitator, preparer
 *     or the person who completed the exercise.
 *  8. Exercise findings never close a recovery gap automatically, and the
 *     strategy capability is derived: `exercise_verified` requires a reviewed
 *     exercise on the same plan version with performed steps, a measurement and
 *     no unverified high/critical deficiency.
 *  9. Every transition appends an immutable `continuityEvents` row and a
 *     `bcm.*` audit entry naming the real actor.
 */

const PAGE_LIMIT_MAX = 50;
const PAGE_SCAN_LIMIT = 250;
const COUNT_SCAN_LIMIT = 1000;
const RELATED_SCAN_LIMIT = 300;
const MAX_PARTICIPANTS = 25;
const MAX_EXERCISE_DAYS = 366;

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function assertExerciseTransition(
  from: BcmExerciseStatus,
  to: BcmExerciseStatus,
  action: string,
): void {
  if (!canTransitionExercise(from, to)) {
    throw new Error(
      `Cannot ${action}: ${BCM_EXERCISE_STATUS_LABELS[from]} → ${BCM_EXERCISE_STATUS_LABELS[to]} is not a permitted transition`,
    );
  }
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

async function requireOwnedExercise(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  exerciseId: Id<"recoveryExercises">,
): Promise<Doc<"recoveryExercises">> {
  const row = await ctx.db.get(exerciseId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Recovery exercise not found in your organization");
  }
  return row;
}

async function requireOwnedFinding(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  findingId: Id<"recoveryExerciseFindings">,
): Promise<Doc<"recoveryExerciseFindings">> {
  const row = await ctx.db.get(findingId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Exercise finding not found in your organization");
  }
  return row;
}

/** Active members of the caller's organization, as `{userId, label}`. */
async function loadMembers(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  limit = 200,
): Promise<Array<{ userId: Id<"users">; label: string }>> {
  const profiles = await ctx.db
    .query("userProfiles")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(limit);
  const members: Array<{ userId: Id<"users">; label: string }> = [];
  for (const profile of profiles) {
    if (effectiveMembershipStatus(profile.membershipStatus) !== "active") continue;
    const user = await ctx.db.get(profile.userId);
    if (!user) continue;
    members.push({
      userId: profile.userId,
      label: user.name ?? user.email ?? "Member",
    });
  }
  return members.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Participants are resolved to active members here, so the stored array carries
 * the labels as they were when the exercise was recorded.
 */
async function resolveParticipants(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  participants: Array<{ userId: Id<"users">; role: string }> | undefined,
): Promise<Array<{ userId: Id<"users">; label: string; role: string }>> {
  const raw = participants ?? [];
  if (raw.length > MAX_PARTICIPANTS) {
    throw new Error(`An exercise can list at most ${MAX_PARTICIPANTS} participants`);
  }
  const seen = new Set<string>();
  const resolved: Array<{ userId: Id<"users">; label: string; role: string }> = [];
  for (const entry of raw) {
    const key = String(entry.userId);
    if (seen.has(key)) {
      throw new Error("A participant can only be listed once");
    }
    seen.add(key);
    const label = await requireActiveMember(
      ctx,
      organizationId,
      entry.userId,
      "Participant",
    );
    resolved.push({
      userId: entry.userId,
      label,
      role: requireNarrative(entry.role, "Participant role", 160, 2),
    });
  }
  return resolved;
}

function validateSchedule(plannedStartAt: number, plannedEndAt: number): {
  start: number;
  end: number;
} {
  const start = requireDate(plannedStartAt, "Planned start");
  const end = requireDate(plannedEndAt, "Planned end");
  if (end <= start) {
    throw new Error("Planned end must be after the planned start");
  }
  if (end - start > MAX_EXERCISE_DAYS * 24 * 60 * 60 * 1000) {
    throw new Error(
      `An exercise cannot be planned to span more than ${MAX_EXERCISE_DAYS} days`,
    );
  }
  if (end < Date.now() - 24 * 60 * 60 * 1000) {
    throw new Error("An exercise cannot be planned entirely in the past");
  }
  return { start, end };
}

function assertFutureTarget(value: number): number {
  const target = requireDate(value, "Target resolution date");
  if (target <= Date.now()) {
    throw new Error("Target resolution date must be in the future");
  }
  return target;
}

// ---------------------------------------------------------------------------
// Presentation
// ---------------------------------------------------------------------------

function presentExercise(
  row: Doc<"recoveryExercises">,
  counts: {
    activities: number;
    performedActivities: number;
    measurements: number;
    strategies: number;
    findings: number;
    openFindings: number;
  },
) {
  return {
    _id: row._id,
    reference: row.reference,
    title: row.title,
    objectives: row.objectives,
    version: row.version,
    revisionOf: row.revisionOf ?? null,
    supersededByExerciseId: row.supersededByExerciseId ?? null,
    type: row.type,
    typeLabel: BCM_EXERCISE_TYPE_LABELS[row.type],
    typeDescription: BCM_EXERCISE_TYPE_DESCRIPTIONS[row.type],
    status: row.status,
    statusLabel: BCM_EXERCISE_STATUS_LABELS[row.status],
    planningEditable: exercisePlanningEditable(row.status),
    resultsEditable: exerciseResultsEditable(row.status),
    acceptsFindings: exerciseAcceptsFindings(row.status),
    planId: row.planId,
    planReference: row.planReference,
    planVersion: row.planVersion,
    planStatusAtLink: row.planStatusAtLink,
    baseline: {
      biaId: row.biaId ?? null,
      biaReference: row.biaReference ?? null,
      biaVersion: row.biaVersion ?? null,
      biaStatusAtLink: row.biaStatusAtLink ?? null,
      rtoMinutes: row.biaRtoMinutes ?? null,
      rtoLabel: formatMinutes(row.biaRtoMinutes),
      rpoMinutes: row.biaRpoMinutes ?? null,
      rpoLabel: formatMinutes(row.biaRpoMinutes),
      mtpdMinutes: row.biaMtpdMinutes ?? null,
      mtpdLabel: formatMinutes(row.biaMtpdMinutes),
      approved: row.biaStatusAtLink === "approved",
    },
    scope: row.scope,
    exclusions: row.exclusions,
    scenario: row.scenario,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    facilitatorUserId: row.facilitatorUserId,
    facilitatorLabel: row.facilitatorLabel,
    participants: row.participants,
    plannedStartAt: row.plannedStartAt,
    plannedEndAt: row.plannedEndAt,
    actualStartAt: row.actualStartAt ?? null,
    actualEndAt: row.actualEndAt ?? null,
    methodology: row.methodology,
    requiredResources: row.requiredResources,
    constraints: row.constraints,
    evidenceReferences: row.evidenceReferences ?? null,
    outcomeSummary: row.outcomeSummary ?? null,
    outcomeJustification: row.outcomeJustification ?? null,
    preparedByUserId: row.preparedByUserId,
    preparedByLabel: row.preparedByLabel,
    preparedAt: row.preparedAt,
    completedAt: row.completedAt ?? null,
    completedByUserId: row.completedByUserId ?? null,
    completedByLabel: row.completedByLabel ?? null,
    submittedAt: row.submittedAt ?? null,
    submittedByLabel: row.submittedByLabel ?? null,
    reviewedAt: row.reviewedAt ?? null,
    reviewedByUserId: row.reviewedByUserId ?? null,
    reviewedByLabel: row.reviewedByLabel ?? null,
    reviewDecision: row.reviewDecision ?? null,
    reviewNotes: row.reviewNotes ?? null,
    cancelledAt: row.cancelledAt ?? null,
    cancelledByLabel: row.cancelledByLabel ?? null,
    cancelReason: row.cancelReason ?? null,
    counts,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentActivity(row: Doc<"recoveryExerciseActivities">) {
  return {
    _id: row._id,
    sequence: row.sequence,
    plannedActivity: row.plannedActivity,
    expectedResponse: row.expectedResponse,
    performed: row.performed,
    evidenceState: row.verified
      ? "verified"
      : row.performed
        ? "reported"
        : "planned",
    actualObservation: row.actualObservation ?? null,
    deviation: row.deviation ?? null,
    evidenceReference: row.evidenceReference ?? null,
    limitations: row.limitations ?? null,
    performedByLabel: row.performedByLabel ?? null,
    performedAt: row.performedAt ?? null,
    verified: row.verified,
    verifiedByLabel: row.verifiedByLabel ?? null,
    verifiedAt: row.verifiedAt ?? null,
    verificationNotes: row.verificationNotes ?? null,
    recordedByLabel: row.recordedByLabel,
    createdAt: row.createdAt,
  };
}

function presentMeasurement(row: Doc<"recoveryExerciseMeasurements">) {
  return {
    _id: row._id,
    strategyId: row.strategyId ?? null,
    objective: row.objective,
    objectiveLabel: BCM_MEASUREMENT_OBJECTIVE_LABELS[row.objective],
    measuredMinutes: row.measuredMinutes ?? null,
    measuredLabel: formatMinutes(row.measuredMinutes ?? null),
    observedValue: row.observedValue,
    objectiveMinutes: row.objectiveMinutes ?? null,
    objectiveLabelValue: formatMinutes(row.objectiveMinutes ?? null),
    objectiveReference: row.objectiveReference ?? null,
    outcome: row.outcome,
    outcomeLabel: BCM_MEASUREMENT_OUTCOME_LABELS[row.outcome],
    deltaMinutes: measuredObjectiveDelta({
      objectiveMinutes: row.objectiveMinutes,
      measuredMinutes: row.measuredMinutes,
    }) ?? null,
    justification: row.justification,
    evidenceReference: row.evidenceReference,
    limitations: row.limitations,
    recordedByLabel: row.recordedByLabel,
    createdAt: row.createdAt,
  };
}

function presentCoverage(
  row: Doc<"recoveryExerciseStrategies">,
  strategy: Doc<"recoveryStrategies"> | null,
  capability: { verified: boolean; reasons: string[]; exerciseReference?: string },
) {
  return {
    _id: row._id,
    strategyId: row.strategyId,
    strategyReference: strategy?.reference ?? null,
    strategyTitle: strategy?.title ?? null,
    stepsRecorded: row.stepsRecorded,
    stepsPerformed: row.stepsPerformed,
    observation: row.observation,
    limitations: row.limitations ?? null,
    recordedByLabel: row.recordedByLabel,
    createdAt: row.createdAt,
    capabilityVerified: capability.verified,
    capabilityReasons: capability.reasons,
  };
}

function presentFinding(
  row: Doc<"recoveryExerciseFindings">,
  strategyReference: string | null,
  gapReference: string | null,
) {
  const now = Date.now();
  return {
    _id: row._id,
    reference: row.reference,
    description: row.description,
    severity: row.severity,
    severityLabel: BCM_FINDING_SEVERITY_LABELS[row.severity],
    relatedObjective: row.relatedObjective ?? null,
    relatedObjectiveLabel: row.relatedObjective
      ? BCM_MEASUREMENT_OBJECTIVE_LABELS[row.relatedObjective]
      : null,
    strategyId: row.strategyId ?? null,
    strategyReference,
    recoveryGapId: row.recoveryGapId ?? null,
    recoveryGapReference: gapReference,
    ownerUserId: row.ownerUserId,
    ownerLabel: row.ownerLabel,
    targetResolutionDate: row.targetResolutionDate,
    overdue:
      row.status !== "verified" &&
      row.status !== "accepted" &&
      row.targetResolutionDate < now,
    correctiveAction: row.correctiveAction,
    status: row.status,
    statusLabel: BCM_FINDING_STATUS_LABELS[row.status],
    resolutionNotes: row.resolutionNotes ?? null,
    resolutionEvidence: row.resolutionEvidence ?? null,
    resolvedAt: row.resolvedAt ?? null,
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedByLabel: row.resolvedByLabel ?? null,
    verificationNotes: row.verificationNotes ?? null,
    verifiedAt: row.verifiedAt ?? null,
    verifiedByLabel: row.verifiedByLabel ?? null,
    acceptedAt: row.acceptedAt ?? null,
    acceptedByLabel: row.acceptedByLabel ?? null,
    acceptanceRationale: row.acceptanceRationale ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function presentHistory(event: Doc<"continuityEvents">) {
  return {
    _id: event._id,
    type: event.type,
    summary: event.summary,
    reason: event.reason ?? null,
    actorLabel: event.actorLabel,
    createdAt: event.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Capability derivation (shared with continuity plan detail)
// ---------------------------------------------------------------------------

export type StrategyCapability = {
  verified: boolean;
  reasons: string[];
  exerciseReference?: string;
};

/**
 * Derives each strategy's capability from reviewed exercises on the exact plan
 * version. It never writes to the strategy: an approved plan stays immutable,
 * and the label is evidence recomputed from the exercise record.
 */
export async function planStrategyCapabilities(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  plan: Doc<"continuityPlans">,
): Promise<Map<string, StrategyCapability>> {
  const strategies = await ctx.db
    .query("recoveryStrategies")
    .withIndex("by_organization_plan", (q) =>
      q.eq("organizationId", organizationId).eq("planId", plan._id),
    )
    .take(100);
  const exercises = await ctx.db
    .query("recoveryExercises")
    .withIndex("by_organization_plan", (q) =>
      q.eq("organizationId", organizationId).eq("planId", plan._id),
    )
    .take(200);
  const reviewed = exercises.filter((row) => row.status === "reviewed");
  const reviewedIds = new Set(reviewed.map((row) => String(row._id)));

  const coverage =
    reviewedIds.size > 0
      ? (
          await ctx.db
            .query("recoveryExerciseStrategies")
            .withIndex("by_organization", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(COUNT_SCAN_LIMIT)
        ).filter((row) => reviewedIds.has(String(row.exerciseId)))
      : [];
  const measurements =
    reviewedIds.size > 0
      ? (
          await ctx.db
            .query("recoveryExerciseMeasurements")
            .withIndex("by_organization", (q) =>
              q.eq("organizationId", organizationId),
            )
            .take(COUNT_SCAN_LIMIT)
        ).filter((row) => reviewedIds.has(String(row.exerciseId)))
      : [];
  const findings = await ctx.db
    .query("recoveryExerciseFindings")
    .withIndex("by_organization_plan", (q) =>
      q.eq("organizationId", organizationId).eq("planId", plan._id),
    )
    .take(RELATED_SCAN_LIMIT);

  // A measurement may only support the strategy it is attributed to. When the
  // exercise covers exactly one strategy an unattributed measurement is
  // unambiguous and counts for that strategy; with several strategies covered
  // an unattributed measurement cannot be pinned to one, so it supports none.
  const coveredPerExercise = new Map<string, number>();
  for (const row of coverage) {
    const key = String(row.exerciseId);
    coveredPerExercise.set(key, (coveredPerExercise.get(key) ?? 0) + 1);
  }
  const measurementCount = new Map<string, number>();
  const assessedCount = new Map<string, number>();
  const missedObjectives = new Map<string, Set<string>>();
  for (const row of measurements) {
    const exerciseKey = String(row.exerciseId);
    const attributed =
      row.strategyId !== undefined
        ? String(row.strategyId)
        : (coveredPerExercise.get(exerciseKey) ?? 0) === 1
          ? String(
              coverage.find((entry) => entry.exerciseId === row.exerciseId)
                ?.strategyId ?? "",
            )
          : "";
    if (!attributed) continue;
    const key = `${exerciseKey}:${attributed}`;
    measurementCount.set(key, (measurementCount.get(key) ?? 0) + 1);
    if (row.outcome === "met" || row.outcome === "missed") {
      assessedCount.set(key, (assessedCount.get(key) ?? 0) + 1);
    }
    if (row.outcome === "missed") {
      const set = missedObjectives.get(key) ?? new Set<string>();
      set.add(row.objective);
      missedObjectives.set(key, set);
    }
  }

  const result = new Map<string, StrategyCapability>();
  for (const strategy of strategies) {
    const evidence = coverage
      .filter((row) => row.strategyId === strategy._id)
      .map((row) => {
        const exercise = reviewed.find((e) => e._id === row.exerciseId);
        const key = `${row.exerciseId}:${strategy._id}`;
        return {
          exerciseId: String(row.exerciseId),
          exerciseReference: exercise?.reference ?? "Unknown exercise",
          exerciseStatus: exercise?.status ?? "unknown",
          planId: String(row.planId),
          planVersion: exercise?.planVersion ?? -1,
          biaVersion: exercise?.biaVersion,
          stepsPerformed: row.stepsPerformed,
          strategyMeasurements: measurementCount.get(key) ?? 0,
          assessedMeasurements: assessedCount.get(key) ?? 0,
        };
      });
    const relevantFindings = findings.filter(
      (row) => row.strategyId === strategy._id,
    );
    const disclosedObjectives = new Set<string>(
      relevantFindings
        .map((row) => row.relatedObjective)
        .filter((value): value is NonNullable<typeof value> => value !== undefined),
    );
    const evidenceForStrategy = evidence.map((row) => {
      const missed = missedObjectives.get(`${row.exerciseId}:${strategy._id}`);
      const undisclosed = [...(missed ?? [])].filter(
        (objective) => !disclosedObjectives.has(objective),
      ).length;
      return { ...row, undisclosedMisses: undisclosed };
    });
    result.set(
      String(strategy._id),
      evaluateStrategyCapability({
        strategyId: String(strategy._id),
        planVersion: plan.version,
        biaVersion: plan.biaVersion,
        exercises: evidenceForStrategy,
        findings: relevantFindings.map((row) => ({
          severity: row.severity,
          status: row.status,
        })),
      }),
    );
  }
  return result;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Approved plans, their strategies and active members, for the exercise form. */
export const exerciseFormOptions = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveBcmAccess(ctx);
    const [plans, strategies, members] = await Promise.all([
      ctx.db
        .query("continuityPlans")
        .withIndex("by_organization_status", (q) =>
          q.eq("organizationId", access.organizationId).eq("status", "approved"),
        )
        .take(RELATED_SCAN_LIMIT),
      ctx.db
        .query("recoveryStrategies")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(RELATED_SCAN_LIMIT),
      loadMembers(ctx, access.organizationId),
    ]);

    return {
      plans: plans
        .map((row) => ({
          _id: row._id,
          reference: row.reference,
          title: row.title,
          version: row.version,
          recoveryPriorityLabel: BCM_PRIORITY_LABELS[row.recoveryPriority],
          biaReference: row.biaReference ?? null,
          biaVersion: row.biaVersion ?? null,
          biaStatusAtLink: row.biaStatusAtLink ?? null,
          reviewDueAt: row.reviewDueAt,
          strategies: strategies
            .filter((strategy) => strategy.planId === row._id)
            .map((strategy) => ({
              _id: strategy._id,
              reference: strategy.reference,
              title: strategy.title,
            }))
            .sort((a, b) => a.reference.localeCompare(b.reference)),
        }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
      members,
      canManage: access.canManage,
      currentUserId: access.userId,
      truncated: plans.length === RELATED_SCAN_LIMIT,
    };
  },
});

/** Organization-scoped exercise register with search, filters and paging. */
export const listExercises = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(v.string()),
    type: v.optional(bcmExerciseTypeValidator),
    planId: v.optional(v.id("continuityPlans")),
    limit: v.optional(v.number()),
    cursor: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const limit = Math.min(
      Math.max(Math.floor(args.limit ?? 25), 1),
      PAGE_LIMIT_MAX,
    );
    const search = args.search?.trim().toLowerCase() ?? "";
    const statusFilter = args.status?.trim();

    const scan = await ctx.db
      .query("recoveryExercises")
      .withIndex("by_organization_created", (q) => {
        const scoped = q.eq("organizationId", access.organizationId);
        return args.cursor !== undefined
          ? scoped.lt("createdAt", args.cursor)
          : scoped;
      })
      .order("desc")
      .take(PAGE_SCAN_LIMIT);

    const filtered = scan
      .filter((row) => (statusFilter ? row.status === statusFilter : true))
      .filter((row) => (args.type ? row.type === args.type : true))
      .filter((row) => (args.planId ? row.planId === args.planId : true))
      .filter((row) => {
        if (!search) return true;
        return [
          row.reference,
          row.title,
          row.objectives,
          row.planReference,
          row.ownerLabel,
          row.facilitatorLabel,
        ]
          .join(" ")
          .toLowerCase()
          .includes(search);
      });

    const page = filtered.slice(0, limit);
    const hasMore =
      page.length > 0 &&
      (filtered.length > limit || scan.length === PAGE_SCAN_LIMIT);

    const [all, activities, measurements, coverage, findings] = await Promise.all([
      ctx.db
        .query("recoveryExercises")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(COUNT_SCAN_LIMIT),
      ctx.db
        .query("recoveryExerciseActivities")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(COUNT_SCAN_LIMIT),
      ctx.db
        .query("recoveryExerciseMeasurements")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(COUNT_SCAN_LIMIT),
      ctx.db
        .query("recoveryExerciseStrategies")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(COUNT_SCAN_LIMIT),
      ctx.db
        .query("recoveryExerciseFindings")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId),
        )
        .take(COUNT_SCAN_LIMIT),
    ]);

    const countBy = <T extends { exerciseId: Id<"recoveryExercises"> }>(
      rows: T[],
      predicate?: (row: T) => boolean,
    ) => {
      const map = new Map<string, number>();
      for (const row of rows) {
        if (predicate && !predicate(row)) continue;
        const key = String(row.exerciseId);
        map.set(key, (map.get(key) ?? 0) + 1);
      }
      return map;
    };

    const activityCounts = countBy(activities);
    const performedCounts = countBy(activities, (row) => row.performed);
    const measurementCounts = countBy(measurements);
    const strategyCounts = countBy(coverage);
    const findingCounts = countBy(findings);
    const openFindingCounts = countBy(
      findings,
      (row) =>
        row.status === "open" ||
        row.status === "in_progress" ||
        row.status === "resolved",
    );

    const statusCount = (status: BcmExerciseStatus) =>
      all.filter((row) => row.status === status).length;

    return {
      rows: page.map((row) =>
        presentExercise(row, {
          activities: activityCounts.get(String(row._id)) ?? 0,
          performedActivities: performedCounts.get(String(row._id)) ?? 0,
          measurements: measurementCounts.get(String(row._id)) ?? 0,
          strategies: strategyCounts.get(String(row._id)) ?? 0,
          findings: findingCounts.get(String(row._id)) ?? 0,
          openFindings: openFindingCounts.get(String(row._id)) ?? 0,
        }),
      ),
      nextCursor: hasMore ? page[page.length - 1].createdAt : null,
      hasMore,
      counts: {
        total: all.length,
        planned: statusCount("planned"),
        scheduled: statusCount("scheduled"),
        inProgress: statusCount("in_progress"),
        completed: statusCount("completed"),
        inReview: statusCount("in_review"),
        reviewed: statusCount("reviewed"),
        returned: statusCount("returned"),
        cancelled: statusCount("cancelled"),
        openFindings: openFindingCounts.size
          ? [...openFindingCounts.values()].reduce((a, b) => a + b, 0)
          : 0,
        truncated: all.length === COUNT_SCAN_LIMIT,
      },
      canManage: access.canManage,
      currentUserId: access.userId,
    };
  },
});

/** One exercise with activities, measurements, coverage, findings and history. */
export const getExercise = query({
  args: { exerciseId: v.id("recoveryExercises") },
  handler: async (ctx, args) => {
    const access = await resolveBcmAccess(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    const plan = await requireOwnedPlan(ctx, access.organizationId, exercise.planId);

    const [activities, measurements, coverage, findings, events, planStrategies, members] =
      await Promise.all([
        ctx.db
          .query("recoveryExerciseActivities")
          .withIndex("by_organization_exercise", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("exerciseId", exercise._id),
          )
          .take(200),
        ctx.db
          .query("recoveryExerciseMeasurements")
          .withIndex("by_organization_exercise", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("exerciseId", exercise._id),
          )
          .take(100),
        ctx.db
          .query("recoveryExerciseStrategies")
          .withIndex("by_organization_exercise", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("exerciseId", exercise._id),
          )
          .take(100),
        ctx.db
          .query("recoveryExerciseFindings")
          .withIndex("by_organization_exercise", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("exerciseId", exercise._id),
          )
          .take(200),
        ctx.db
          .query("continuityEvents")
          .withIndex("by_organization_exercise", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("exerciseId", exercise._id),
          )
          .take(200),
        ctx.db
          .query("recoveryStrategies")
          .withIndex("by_organization_plan", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("planId", exercise.planId),
          )
          .take(100),
        loadMembers(ctx, access.organizationId),
      ]);

    const [strategyMap, gapIds] = await Promise.all([
      planStrategyCapabilities(ctx, access.organizationId, plan),
      Promise.all(
        findings
          .filter((row) => row.recoveryGapId !== undefined)
          .map((row) =>
            requireOwnedGap(ctx, access.organizationId, row.recoveryGapId!)
              .then((gap) => ({ id: String(row._id), reference: gap.reference }))
              .catch(() => ({ id: String(row._id), reference: null })),
          ),
      ),
    ]);
    const gapReferenceById = new Map(gapIds.map((row) => [row.id, row.reference]));
    const strategyById = new Map(
      planStrategies.map((row) => [String(row._id), row]),
    );

    const openFindings = findings.filter(
      (row) =>
        row.status === "open" ||
        row.status === "in_progress" ||
        row.status === "resolved",
    );

    const blockedReviewReasons: string[] = [];
    if (exercise.ownerUserId === access.userId) {
      blockedReviewReasons.push("You own this exercise");
    }
    if (exercise.facilitatorUserId === access.userId) {
      blockedReviewReasons.push("You facilitated this exercise");
    }
    if (exercise.preparedByUserId === access.userId) {
      blockedReviewReasons.push("You recorded this exercise");
    }
    if (exercise.completedByUserId === access.userId) {
      blockedReviewReasons.push("You completed this exercise");
    }

    return {
      exercise: presentExercise(exercise, {
        activities: activities.length,
        performedActivities: activities.filter((row) => row.performed).length,
        measurements: measurements.length,
        strategies: coverage.length,
        findings: findings.length,
        openFindings: openFindings.length,
      }),
      plan: {
        _id: plan._id,
        reference: plan.reference,
        title: plan.title,
        version: plan.version,
        status: plan.status,
        statusLabel: BCM_PLAN_STATUS_LABELS[plan.status],
        recoveryPriorityLabel: BCM_PRIORITY_LABELS[plan.recoveryPriority],
      },
      // A missing or unapproved baseline is a state, not an error — disclosed
      // here so a measurement can never be presented against objectives that
      // were never approved.
      baselineWarning:
        exercise.biaStatusAtLink === undefined
          ? "This exercise tested a plan version with no linked business impact analysis, so no approved recovery objectives underpin its measurements."
          : exercise.biaStatusAtLink !== "approved"
            ? "This exercise tested a plan version whose linked analysis was not approved, so its measurements cannot be assessed against approved objectives."
            : null,
      activities: activities
        .sort((a, b) => a.sequence - b.sequence)
        .map(presentActivity),
      measurements: measurements
        .sort((a, b) => a.createdAt - b.createdAt)
        .map(presentMeasurement),
      strategies: planStrategies
        .map((row) => ({
          _id: row._id,
          reference: row.reference,
          title: row.title,
          status: row.status,
        }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
      coverage: coverage
        .map((row) =>
          presentCoverage(
            row,
            strategyById.get(String(row.strategyId)) ?? null,
            strategyMap.get(String(row.strategyId)) ?? {
              verified: false,
              reasons: ["No reviewed exercise covers this strategy yet"],
            },
          ),
        )
        .sort((a, b) => a.createdAt - b.createdAt),
      findings: findings
        .map((row) =>
          presentFinding(
            row,
            row.strategyId
              ? (strategyById.get(String(row.strategyId))?.reference ?? null)
              : null,
            row.recoveryGapId
              ? (gapReferenceById.get(String(row._id)) ?? null)
              : null,
          ),
        )
        .sort((a, b) => b.createdAt - a.createdAt),
      history: events
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(presentHistory),
      members,
      canManage: access.canManage,
      currentUserId: access.userId,
      currentUserLabel: access.label,
      reviewBlockedReasons: blockedReviewReasons,
    };
  },
});

// ---------------------------------------------------------------------------
// Exercise lifecycle
// ---------------------------------------------------------------------------

const exerciseInputArgs = {
  title: v.string(),
  objectives: v.string(),
  planId: v.id("continuityPlans"),
  type: bcmExerciseTypeValidator,
  scope: v.string(),
  exclusions: v.string(),
  scenario: v.string(),
  ownerUserId: v.id("users"),
  facilitatorUserId: v.id("users"),
  participants: v.optional(
    v.array(
      v.object({
        userId: v.id("users"),
        role: v.string(),
      }),
    ),
  ),
  plannedStartAt: v.number(),
  plannedEndAt: v.number(),
  methodology: v.string(),
  requiredResources: v.string(),
  constraints: v.string(),
  evidenceReferences: v.optional(v.string()),
};

/** Only an approved plan version can be the subject of an exercise. */
async function requireExercisablePlan(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  planId: Id<"continuityPlans">,
): Promise<Doc<"continuityPlans">> {
  const plan = await requireOwnedPlan(ctx, organizationId, planId);
  if (plan.status !== "approved") {
    throw new Error(
      `A recovery exercise can only test an approved continuity plan; ${plan.reference} v${plan.version} is ${BCM_PLAN_STATUS_LABELS[plan.status]}`,
    );
  }
  return plan;
}

async function resolveBaseline(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  plan: Doc<"continuityPlans">,
) {
  if (!plan.biaId) {
    return {
      biaId: undefined,
      biaReference: undefined,
      biaVersion: undefined,
      biaStatusAtLink: undefined,
      biaRtoMinutes: undefined,
      biaRpoMinutes: undefined,
      biaMtpdMinutes: undefined,
    };
  }
  const bia = await ctx.db.get(plan.biaId);
  if (!bia || bia.organizationId !== organizationId) {
    return {
      biaId: undefined,
      biaReference: undefined,
      biaVersion: undefined,
      biaStatusAtLink: undefined,
      biaRtoMinutes: undefined,
      biaRpoMinutes: undefined,
      biaMtpdMinutes: undefined,
    };
  }
  return {
    biaId: bia._id,
    biaReference: bia.reference,
    biaVersion: bia.version,
    biaStatusAtLink: bia.status,
    // Objectives are only carried across when the analysis was approved; a
    // draft's numbers are not an approved objective and are not used.
    biaRtoMinutes: bia.status === "approved" ? bia.rtoMinutes : undefined,
    biaRpoMinutes: bia.status === "approved" ? bia.rpoMinutes : undefined,
    biaMtpdMinutes: bia.status === "approved" ? bia.mtpdMinutes : undefined,
  };
}

/** Record a planned exercise against an approved plan version. */
export const createExercise = mutation({
  args: exerciseInputArgs,
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const plan = await requireExercisablePlan(ctx, access.organizationId, args.planId);
    const { start, end } = validateSchedule(args.plannedStartAt, args.plannedEndAt);
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Exercise owner",
    );
    const facilitatorLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.facilitatorUserId,
      "Exercise facilitator",
    );
    const participants = await resolveParticipants(
      ctx,
      access.organizationId,
      args.participants,
    );
    const baseline = await resolveBaseline(ctx, access.organizationId, plan);
    const reference = await nextBcmReference(
      ctx,
      "recoveryExercises",
      access.organizationId,
      "EXR",
    );
    const now = Date.now();
    const exerciseId = await ctx.db.insert("recoveryExercises", {
      organizationId: access.organizationId,
      reference,
      title: requireTitle(args.title, "Exercise title"),
      objectives: requireNarrative(args.objectives, "Exercise objectives"),
      planId: plan._id,
      planReference: plan.reference,
      planVersion: plan.version,
      planStatusAtLink: plan.status,
      ...baseline,
      type: args.type,
      scope: requireNarrative(args.scope, "Exercise scope"),
      exclusions: requireNarrative(args.exclusions, "Exercise exclusions"),
      scenario: requireNarrative(args.scenario, "Exercise scenario"),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      facilitatorUserId: args.facilitatorUserId,
      facilitatorLabel,
      participants,
      plannedStartAt: start,
      plannedEndAt: end,
      status: "planned",
      methodology: requireNarrative(args.methodology, "Exercise methodology"),
      requiredResources: requireNarrative(
        args.requiredResources,
        "Required resources",
      ),
      constraints: requireNarrative(
        args.constraints,
        "Safety and operational constraints",
      ),
      evidenceReferences: optionalText(
        args.evidenceReferences,
        "Evidence and documentation references",
      ),
      version: 1,
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      exerciseId,
      type: "exercise_created",
      toStatus: "planned",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${reference} v1 planned for ${plan.reference} v${plan.version} (${BCM_EXERCISE_TYPE_LABELS[args.type]})${baseline.biaStatusAtLink === "approved" ? ` against ${baseline.biaReference} v${baseline.biaVersion}` : " with no approved analysis baseline"}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_created",
      entityType: "recoveryExercises",
      entityId: String(exerciseId),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(plan._id),
      summary: `Planned recovery exercise ${reference} v1 for ${plan.reference} v${plan.version}`,
    });

    return { exerciseId, reference };
  },
});

/** Amend planning detail before the exercise starts. */
export const updateExercise = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    ...exerciseInputArgs,
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (!exercisePlanningEditable(exercise.status)) {
      throw new Error(
        "Planning detail can only be amended before the exercise starts; reported results are never rewritten",
      );
    }
    if (args.planId !== exercise.planId) {
      throw new Error(
        "The continuity plan an exercise tests cannot be changed after it is recorded; record a new exercise instead",
      );
    }
    const plan = await requireExercisablePlan(ctx, access.organizationId, exercise.planId);
    const { start, end } = validateSchedule(args.plannedStartAt, args.plannedEndAt);
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Exercise owner",
    );
    const facilitatorLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.facilitatorUserId,
      "Exercise facilitator",
    );
    const participants = await resolveParticipants(
      ctx,
      access.organizationId,
      args.participants,
    );
    await ctx.db.patch(exercise._id, {
      title: requireTitle(args.title, "Exercise title"),
      objectives: requireNarrative(args.objectives, "Exercise objectives"),
      type: args.type,
      scope: requireNarrative(args.scope, "Exercise scope"),
      exclusions: requireNarrative(args.exclusions, "Exercise exclusions"),
      scenario: requireNarrative(args.scenario, "Exercise scenario"),
      ownerUserId: args.ownerUserId,
      ownerLabel,
      facilitatorUserId: args.facilitatorUserId,
      facilitatorLabel,
      participants,
      plannedStartAt: start,
      plannedEndAt: end,
      methodology: requireNarrative(args.methodology, "Exercise methodology"),
      requiredResources: requireNarrative(
        args.requiredResources,
        "Required resources",
      ),
      constraints: requireNarrative(
        args.constraints,
        "Safety and operational constraints",
      ),
      evidenceReferences: optionalText(
        args.evidenceReferences,
        "Evidence and documentation references",
      ),
      updatedAt: Date.now(),
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_updated",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} v${exercise.version} planning detail updated (${plan.reference} v${plan.version})`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_updated",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Updated recovery exercise ${exercise.reference} v${exercise.version}`,
    });
    return { ok: true as const };
  },
});

/** Mark a planned exercise as scheduled. */
export const scheduleExercise = mutation({
  args: { exerciseId: v.id("recoveryExercises") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    assertExerciseTransition(exercise.status, "scheduled", "schedule");
    const now = Date.now();
    await ctx.db.patch(exercise._id, { status: "scheduled", updatedAt: now });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_scheduled",
      fromStatus: exercise.status,
      toStatus: "scheduled",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} scheduled for ${new Date(exercise.plannedStartAt).toISOString().slice(0, 10)}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_scheduled",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Scheduled recovery exercise ${exercise.reference}`,
    });
    return { status: "scheduled" as const };
  },
});

/** Begin the exercise. This records a start time; it does not run anything. */
export const startExercise = mutation({
  args: { exerciseId: v.id("recoveryExercises") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    assertExerciseTransition(exercise.status, "in_progress", "start");
    const now = Date.now();
    await ctx.db.patch(exercise._id, {
      status: "in_progress",
      actualStartAt: now,
      startedAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_started",
      fromStatus: exercise.status,
      toStatus: "in_progress",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} started by ${access.label}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_started",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Started recovery exercise ${exercise.reference}`,
    });
    return { status: "in_progress" as const };
  },
});

/**
 * Complete the exercise. Completion is a RECORD of what was done: it requires a
 * reported performed activity and a stated outcome, and it executes nothing.
 */
export const completeExercise = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    outcomeSummary: v.string(),
    outcomeJustification: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    assertExerciseTransition(exercise.status, "completed", "complete");
    if (exercise.actualStartAt === undefined) {
      throw new Error("An exercise must be started before it can be completed");
    }
    const activities = await ctx.db
      .query("recoveryExerciseActivities")
      .withIndex("by_organization_exercise", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("exerciseId", exercise._id),
      )
      .take(200);
    if (!activities.some((row) => row.performed)) {
      throw new Error(
        "Completion requires at least one activity recorded as performed; a planned activity alone is not a result",
      );
    }
    const now = Date.now();
    const outcomeSummary = requireNarrative(args.outcomeSummary, "Exercise outcome");
    const outcomeJustification = requireNarrative(
      args.outcomeJustification,
      "Outcome justification",
    );
    await ctx.db.patch(exercise._id, {
      status: "completed",
      actualEndAt: now,
      completedAt: now,
      completedByUserId: access.userId,
      completedByLabel: access.label,
      outcomeSummary,
      outcomeJustification,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_completed",
      fromStatus: exercise.status,
      toStatus: "completed",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} completed by ${access.label} — ${activities.filter((row) => row.performed).length} performed activity(ies), awaiting review`,
      reason: outcomeSummary.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_completed",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Completed recovery exercise ${exercise.reference}`,
    });
    return { status: "completed" as const };
  },
});

/** Cancel an exercise that never produced a completed record. */
export const cancelExercise = mutation({
  args: { exerciseId: v.id("recoveryExercises"), reason: v.string() },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    assertExerciseTransition(exercise.status, "cancelled", "cancel");
    const reason = requireNarrative(args.reason, "Cancellation reason");
    const now = Date.now();
    await ctx.db.patch(exercise._id, {
      status: "cancelled",
      cancelledAt: now,
      cancelledByUserId: access.userId,
      cancelledByLabel: access.label,
      cancelReason: reason,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_cancelled",
      fromStatus: exercise.status,
      toStatus: "cancelled",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} cancelled by ${access.label}`,
      reason: reason.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_cancelled",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Cancelled recovery exercise ${exercise.reference}`,
    });
    return { status: "cancelled" as const };
  },
});

/** Submit a completed exercise for independent review. */
export const submitExercise = mutation({
  args: { exerciseId: v.id("recoveryExercises") },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    assertExerciseTransition(exercise.status, "in_review", "submit for review");
    const now = Date.now();
    await ctx.db.patch(exercise._id, {
      status: "in_review",
      submittedAt: now,
      submittedByUserId: access.userId,
      submittedByLabel: access.label,
      reviewDecision: undefined,
      reviewNotes: undefined,
      reviewedAt: undefined,
      reviewedByUserId: undefined,
      reviewedByLabel: undefined,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_submitted",
      fromStatus: exercise.status,
      toStatus: "in_review",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${exercise.reference} submitted for independent review`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_submitted",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary: `Submitted recovery exercise ${exercise.reference}`,
    });
    return { status: "in_review" as const };
  },
});

/**
 * Independent review. The reviewer cannot own, facilitate, record or complete
 * the exercise whose results they are accepting.
 */
export const reviewExercise = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    decision: v.union(v.literal("approved"), v.literal("rejected")),
    reviewNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (exercise.status !== "in_review") {
      throw new Error("Only an exercise submitted for review can be reviewed");
    }
    const conflicts: string[] = [];
    if (exercise.ownerUserId === access.userId) conflicts.push("own the exercise");
    if (exercise.facilitatorUserId === access.userId)
      conflicts.push("facilitate the exercise");
    if (exercise.preparedByUserId === access.userId)
      conflicts.push("recorded the exercise");
    if (exercise.completedByUserId === access.userId)
      conflicts.push("completed the exercise");
    if (conflicts.length > 0) {
      throw new Error(
        `Independent review required: you cannot review an exercise you ${conflicts.join(", ")}`,
      );
    }
    const reviewNotes = requireNarrative(args.reviewNotes, "Review notes");
    const now = Date.now();
    const to: BcmExerciseStatus =
      args.decision === "approved" ? "reviewed" : "returned";
    assertExerciseTransition(exercise.status, to, args.decision === "approved" ? "accept" : "return for correction");

    await ctx.db.patch(exercise._id, {
      status: to,
      reviewDecision: args.decision,
      reviewNotes,
      reviewedAt: now,
      reviewedByUserId: access.userId,
      reviewedByLabel: access.label,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: to === "reviewed" ? "exercise_reviewed" : "exercise_returned",
      fromStatus: exercise.status,
      toStatus: to,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary:
        to === "reviewed"
          ? `Recovery exercise ${exercise.reference} accepted by ${access.label} after independent review`
          : `Recovery exercise ${exercise.reference} returned by ${access.label}; a corrected version must be recorded`,
      reason: reviewNotes.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: to === "reviewed" ? "bcm.exercise_reviewed" : "bcm.exercise_returned",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "continuityPlans",
      relatedEntityId: String(exercise.planId),
      summary:
        to === "reviewed"
          ? `Accepted recovery exercise ${exercise.reference}`
          : `Returned recovery exercise ${exercise.reference}`,
    });
    return { status: to };
  },
});

/**
 * Correct a reviewed or returned exercise by opening a new version. The earlier
 * record keeps its results, review and history untouched.
 */
export const supersedeExercise = mutation({
  args: { exerciseId: v.id("recoveryExercises"), reason: v.string() },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const previous = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (previous.status !== "reviewed" && previous.status !== "returned") {
      throw new Error(
        "Only a reviewed or returned exercise can be superseded; amend the planning detail of an open exercise instead",
      );
    }
    const reason = requireNarrative(args.reason, "Supersession reason");
    const plan = await requireExercisablePlan(
      ctx,
      access.organizationId,
      previous.planId,
    );
    const reference = await nextBcmReference(
      ctx,
      "recoveryExercises",
      access.organizationId,
      "EXR",
    );
    const now = Date.now();
    const exerciseId = await ctx.db.insert("recoveryExercises", {
      organizationId: access.organizationId,
      reference,
      title: previous.title,
      objectives: previous.objectives,
      planId: plan._id,
      planReference: plan.reference,
      planVersion: plan.version,
      planStatusAtLink: plan.status,
      biaId: previous.biaId,
      biaReference: previous.biaReference,
      biaVersion: previous.biaVersion,
      biaStatusAtLink: previous.biaStatusAtLink,
      biaRtoMinutes: previous.biaRtoMinutes,
      biaRpoMinutes: previous.biaRpoMinutes,
      biaMtpdMinutes: previous.biaMtpdMinutes,
      type: previous.type,
      scope: previous.scope,
      exclusions: previous.exclusions,
      scenario: previous.scenario,
      ownerUserId: previous.ownerUserId,
      ownerLabel: previous.ownerLabel,
      facilitatorUserId: previous.facilitatorUserId,
      facilitatorLabel: previous.facilitatorLabel,
      participants: previous.participants,
      plannedStartAt: previous.plannedStartAt,
      plannedEndAt: previous.plannedEndAt,
      status: "planned",
      methodology: previous.methodology,
      requiredResources: previous.requiredResources,
      constraints: previous.constraints,
      evidenceReferences: previous.evidenceReferences,
      version: previous.version + 1,
      revisionOf: previous._id,
      preparedByUserId: access.userId,
      preparedByLabel: access.label,
      preparedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.patch(previous._id, {
      supersededByExerciseId: exerciseId,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      exerciseId,
      type: "exercise_superseded",
      toStatus: "planned",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Recovery exercise ${reference} v${previous.version + 1} opened to supersede ${previous.reference} v${previous.version}`,
      reason: reason.slice(0, 240),
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: plan._id,
      exerciseId: previous._id,
      type: "exercise_superseded_by_new_version",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `${previous.reference} v${previous.version} superseded by ${reference} v${previous.version + 1}`,
      reason: reason.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_superseded",
      entityType: "recoveryExercises",
      entityId: String(exerciseId),
      relatedEntityType: "recoveryExercises",
      relatedEntityId: String(previous._id),
      summary: `Opened exercise ${reference} v${previous.version + 1} superseding ${previous.reference}`,
    });
    return { exerciseId, reference, version: previous.version + 1 };
  },
});

// ---------------------------------------------------------------------------
// Activities (timeline)
// ---------------------------------------------------------------------------

/** Add a planned or reported activity. Reporting is not verification. */
export const addExerciseActivity = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    plannedActivity: v.string(),
    expectedResponse: v.string(),
    performed: v.optional(v.boolean()),
    actualObservation: v.optional(v.string()),
    deviation: v.optional(v.string()),
    evidenceReference: v.optional(v.string()),
    limitations: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (
      !exercisePlanningEditable(exercise.status) &&
      !exerciseResultsEditable(exercise.status)
    ) {
      throw new Error(
        "Activities can only be recorded while the exercise is being planned or is in progress; a completed record is frozen",
      );
    }
    const performed = args.performed ?? false;
    if (performed && exercise.status !== "in_progress") {
      throw new Error(
        "Only an exercise in progress can record an activity as performed",
      );
    }
    const observation = performed
      ? requireNarrative(args.actualObservation ?? "", "Actual observation")
      : optionalText(args.actualObservation, "Actual observation");
    const existing = await ctx.db
      .query("recoveryExerciseActivities")
      .withIndex("by_organization_exercise", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("exerciseId", exercise._id),
      )
      .take(200);
    const sequence =
      existing.reduce((max, row) => Math.max(max, row.sequence), 0) + 1;
    const now = Date.now();
    const activityId = await ctx.db.insert("recoveryExerciseActivities", {
      organizationId: access.organizationId,
      exerciseId: exercise._id,
      sequence,
      plannedActivity: requireNarrative(args.plannedActivity, "Planned activity"),
      expectedResponse: requireNarrative(args.expectedResponse, "Expected response"),
      performed,
      actualObservation: observation,
      deviation: optionalText(args.deviation, "Deviation from the plan"),
      evidenceReference: optionalText(args.evidenceReference, "Evidence reference"),
      limitations: optionalText(args.limitations, "Limitations"),
      performedByUserId: performed ? access.userId : undefined,
      performedByLabel: performed ? access.label : undefined,
      performedAt: performed ? now : undefined,
      verified: false,
      recordedByUserId: access.userId,
      recordedByLabel: access.label,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: performed ? "exercise_activity_reported" : "exercise_activity_planned",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Activity #${sequence} ${performed ? "reported performed" : "added to the plan"} on ${exercise.reference}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_activity_recorded",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "recoveryExerciseActivities",
      relatedEntityId: String(activityId),
      summary: `Activity #${sequence} recorded on ${exercise.reference}`,
    });
    return { activityId, sequence };
  },
});

/** Independent verification of a REPORTED activity. */
export const verifyExerciseActivity = mutation({
  args: {
    activityId: v.id("recoveryExerciseActivities"),
    verificationNotes: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const activity = await ctx.db.get(args.activityId);
    if (!activity || activity.organizationId !== access.organizationId) {
      throw new Error("Exercise activity not found in your organization");
    }
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      activity.exerciseId,
    );
    if (
      exercise.status !== "in_progress" &&
      exercise.status !== "completed" &&
      exercise.status !== "in_review"
    ) {
      throw new Error(
        "Activities can only be verified before the exercise review is decided",
      );
    }
    if (!activity.performed) {
      throw new Error(
        "Only an activity reported as performed can be independently verified",
      );
    }
    if (activity.performedByUserId === access.userId) {
      throw new Error(
        "Independent verification required: the person who reported the activity cannot verify it",
      );
    }
    const notes = requireNarrative(args.verificationNotes, "Verification notes");
    const now = Date.now();
    await ctx.db.patch(activity._id, {
      verified: true,
      verifiedAt: now,
      verifiedByUserId: access.userId,
      verifiedByLabel: access.label,
      verificationNotes: notes,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      type: "exercise_activity_verified",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Activity #${activity.sequence} on ${exercise.reference} independently verified by ${access.label}`,
      reason: notes.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_activity_verified",
      entityType: "recoveryExerciseActivities",
      entityId: String(activity._id),
      relatedEntityType: "recoveryExercises",
      relatedEntityId: String(exercise._id),
      summary: `Verified activity #${activity.sequence} on ${exercise.reference}`,
    });
    return { ok: true as const };
  },
});

// ---------------------------------------------------------------------------
// Measurements (recovery objective validation)
// ---------------------------------------------------------------------------

/** Record measured recovery performance against the snapshotted objective. */
export const recordExerciseMeasurement = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    /** Strategy the observation measures. Inferred when the exercise covers one strategy. */
    strategyId: v.optional(v.id("recoveryStrategies")),
    objective: bcmMeasurementObjectiveValidator,
    measuredMinutes: v.optional(v.number()),
    observedValue: v.string(),
    outcome: bcmMeasurementOutcomeValidator,
    justification: v.string(),
    evidenceReference: v.string(),
    limitations: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (!exerciseResultsEditable(exercise.status)) {
      throw new Error(
        "Measurements can only be recorded while the exercise is in progress; a completed record is frozen",
      );
    }
    const baselineApproved =
      exercise.biaStatusAtLink === "approved" && exercise.biaId !== undefined;
    const objectiveMinutes = baselineApproved
      ? args.objective === "rto"
        ? exercise.biaRtoMinutes
        : args.objective === "rpo"
          ? exercise.biaRpoMinutes
          : undefined
      : undefined;
    const measuredMinutes = optionalMinutes(
      args.measuredMinutes,
      "Measured recovery performance",
    );
    if (args.objective === "service_level") {
      if (measuredMinutes !== undefined) {
        throw new Error(
          "A minimum service level is recorded as an observation, not a number of minutes",
        );
      }
    } else if (measuredMinutes === undefined) {
      throw new Error(
        "A recovery time or recovery point measurement must record the measured number of minutes",
      );
    }
    // A service level is a recorded observation, not a numeric threshold, so the
    // minute-based consistency rule applies to RTO/RPO measurements only.
    if (
      args.objective !== "service_level" &&
      !measurementOutcomeIsConsistent({
        objectiveMinutes,
        measuredMinutes,
        outcome: args.outcome as BcmMeasurementOutcome,
      })
    ) {
      throw new Error(
        objectiveMinutes === undefined
          ? "Without an approved objective the only honest outcome is 'not assessed'"
          : "The recorded outcome does not agree with the measured performance against the objective",
      );
    }
    const objectiveReference =
      baselineApproved && exercise.biaReference !== undefined
        ? `${exercise.biaReference} v${exercise.biaVersion}`
        : undefined;
    // Attribute the measurement to a strategy so capability is claimed only for
    // what was actually measured, never for every strategy the exercise covered.
    const covered = await ctx.db
      .query("recoveryExerciseStrategies")
      .withIndex("by_organization_exercise", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("exerciseId", exercise._id),
      )
      .take(100);
    let strategyId = args.strategyId;
    if (strategyId !== undefined) {
      const strategy = await requireOwnedStrategy(
        ctx,
        access.organizationId,
        strategyId,
      );
      if (strategy.planId !== exercise.planId) {
        throw new Error(
          "The measured strategy does not belong to the plan version this exercise tested",
        );
      }
      if (!covered.some((row) => row.strategyId === strategyId)) {
        throw new Error(
          "Record which strategy steps were walked before measuring that strategy",
        );
      }
    } else if (covered.length === 1) {
      strategyId = covered[0].strategyId;
    }
    const now = Date.now();
    const measurementId = await ctx.db.insert("recoveryExerciseMeasurements", {
      organizationId: access.organizationId,
      exerciseId: exercise._id,
      strategyId,
      objective: args.objective,
      measuredMinutes,
      observedValue: requireNarrative(args.observedValue, "Observed capability"),
      objectiveMinutes:
        args.objective === "service_level" ? undefined : objectiveMinutes,
      objectiveReference,
      outcome: args.outcome,
      justification: requireNarrative(args.justification, "Measurement justification"),
      evidenceReference: requireNarrative(
        args.evidenceReference,
        "Measurement evidence",
        400,
        3,
      ),
      limitations: requireNarrative(args.limitations, "Measurement limitations"),
      recordedByUserId: access.userId,
      recordedByLabel: access.label,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      strategyId,
      type: "exercise_measurement_recorded",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `${BCM_MEASUREMENT_OBJECTIVE_LABELS[args.objective as BcmMeasurementObjective]} measured on ${exercise.reference}: ${measuredMinutes !== undefined ? formatMinutes(measuredMinutes) : args.observedValue.slice(0, 80)} → ${BCM_MEASUREMENT_OUTCOME_LABELS[args.outcome as BcmMeasurementOutcome]}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_measurement_recorded",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "recoveryExerciseMeasurements",
      relatedEntityId: String(measurementId),
      summary: `Recorded ${args.objective} measurement on ${exercise.reference}`,
    });
    return { measurementId };
  },
});

/** Record which documented strategy steps the exercise actually walked. */
export const recordStrategyCoverage = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    strategyId: v.id("recoveryStrategies"),
    stepsRecorded: v.string(),
    stepsPerformed: v.boolean(),
    observation: v.string(),
    limitations: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (!exerciseResultsEditable(exercise.status)) {
      throw new Error(
        "Strategy coverage can only be recorded while the exercise is in progress",
      );
    }
    const strategy = await requireOwnedStrategy(
      ctx,
      access.organizationId,
      args.strategyId,
    );
    if (strategy.planId !== exercise.planId) {
      throw new Error(
        "The recovery strategy does not belong to the plan version this exercise tested",
      );
    }
    const existing = await ctx.db
      .query("recoveryExerciseStrategies")
      .withIndex("by_organization_exercise", (q) =>
        q
          .eq("organizationId", access.organizationId)
          .eq("exerciseId", exercise._id),
      )
      .take(100);
    if (existing.some((row) => row.strategyId === strategy._id)) {
      throw new Error(
        "This exercise already records coverage for that strategy",
      );
    }
    const now = Date.now();
    const coverageId = await ctx.db.insert("recoveryExerciseStrategies", {
      organizationId: access.organizationId,
      exerciseId: exercise._id,
      planId: exercise.planId,
      strategyId: strategy._id,
      stepsRecorded: requireNarrative(args.stepsRecorded, "Recovery steps recorded"),
      stepsPerformed: args.stepsPerformed,
      observation: requireNarrative(args.observation, "Coverage observation"),
      limitations: optionalText(args.limitations, "Coverage limitations"),
      recordedByUserId: access.userId,
      recordedByLabel: access.label,
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      strategyId: strategy._id,
      type: "exercise_strategy_covered",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `${strategy.reference} ${args.stepsPerformed ? "walked through" : "reviewed without performing the steps"} during ${exercise.reference}`,
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_strategy_covered",
      entityType: "recoveryExercises",
      entityId: String(exercise._id),
      relatedEntityType: "recoveryStrategies",
      relatedEntityId: String(strategy._id),
      summary: `Recorded ${strategy.reference} coverage on ${exercise.reference}`,
    });
    return { coverageId };
  },
});

// ---------------------------------------------------------------------------
// Findings and remediation
// ---------------------------------------------------------------------------

/** Raise a deficiency found during the exercise (never an automatic gap). */
export const createExerciseFinding = mutation({
  args: {
    exerciseId: v.id("recoveryExercises"),
    description: v.string(),
    severity: bcmFindingSeverityValidator,
    strategyId: v.optional(v.id("recoveryStrategies")),
    recoveryGapId: v.optional(v.id("recoveryGaps")),
    relatedObjective: v.optional(bcmMeasurementObjectiveValidator),
    ownerUserId: v.id("users"),
    targetResolutionDate: v.number(),
    correctiveAction: v.string(),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      args.exerciseId,
    );
    if (!exerciseAcceptsFindings(exercise.status)) {
      throw new Error(
        "Findings can be raised from the moment an exercise is running; a planned or cancelled exercise has no results to report",
      );
    }
    if (args.strategyId !== undefined) {
      const strategy = await requireOwnedStrategy(
        ctx,
        access.organizationId,
        args.strategyId,
      );
      if (strategy.planId !== exercise.planId) {
        throw new Error(
          "The strategy a finding relates to must belong to the plan version tested",
        );
      }
    }
    if (args.recoveryGapId !== undefined) {
      const gap = await requireOwnedGap(
        ctx,
        access.organizationId,
        args.recoveryGapId,
      );
      if (gap.planId !== exercise.planId) {
        throw new Error(
          "The linked recovery gap must belong to the plan version tested",
        );
      }
    }
    const ownerLabel = await requireActiveMember(
      ctx,
      access.organizationId,
      args.ownerUserId,
      "Finding owner",
    );
    const target = assertFutureTarget(args.targetResolutionDate);
    const reference = await nextBcmReference(
      ctx,
      "recoveryExerciseFindings",
      access.organizationId,
      "EXF",
    );
    const now = Date.now();
    const findingId = await ctx.db.insert("recoveryExerciseFindings", {
      organizationId: access.organizationId,
      exerciseId: exercise._id,
      planId: exercise.planId,
      strategyId: args.strategyId,
      recoveryGapId: args.recoveryGapId,
      reference,
      description: requireNarrative(args.description, "Finding description"),
      severity: args.severity,
      relatedObjective: args.relatedObjective,
      ownerUserId: args.ownerUserId,
      ownerLabel,
      targetResolutionDate: target,
      correctiveAction: requireNarrative(
        args.correctiveAction,
        "Recommended corrective action",
      ),
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: exercise.planId,
      exerciseId: exercise._id,
      findingId,
      strategyId: args.strategyId,
      type: "exercise_finding_raised",
      toStatus: "open",
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Exercise finding ${reference} raised on ${exercise.reference} (${BCM_FINDING_SEVERITY_LABELS[args.severity]})`,
      reason: args.description.trim().slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_finding_raised",
      entityType: "recoveryExerciseFindings",
      entityId: String(findingId),
      relatedEntityType: "recoveryExercises",
      relatedEntityId: String(exercise._id),
      summary: `Raised exercise finding ${reference} on ${exercise.reference}`,
    });
    return { findingId, reference };
  },
});

/**
 * Move a finding through remediation. Verification is attributed and must be
 * independent of the resolver, and closing a finding never closes a recovery
 * gap — that workflow keeps its own evidence requirements.
 */
export const updateExerciseFindingStatus = mutation({
  args: {
    findingId: v.id("recoveryExerciseFindings"),
    status: bcmFindingStatusValidator,
    note: v.optional(v.string()),
    evidenceReference: v.optional(v.string()),
    acceptanceRationale: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requireBcmManager(ctx);
    const finding = await requireOwnedFinding(
      ctx,
      access.organizationId,
      args.findingId,
    );
    if (!canTransitionFinding(finding.status, args.status)) {
      throw new Error(
        `Cannot change finding status: ${BCM_FINDING_STATUS_LABELS[finding.status]} → ${BCM_FINDING_STATUS_LABELS[args.status as BcmFindingStatus]} is not a permitted transition`,
      );
    }
    const exercise = await requireOwnedExercise(
      ctx,
      access.organizationId,
      finding.exerciseId,
    );
    if (exercise.status === "cancelled" || exercise.status === "planned") {
      throw new Error(
        "A finding cannot be progressed on an exercise that never ran",
      );
    }
    const now = Date.now();
    const patch: Record<string, unknown> = {
      status: args.status,
      updatedAt: now,
    };
    if (args.status === "in_progress") {
      const note = requireNarrative(args.note ?? "", "Status note");
      patch.resolutionNotes = note;
    }
    if (args.status === "resolved") {
      const note = requireNarrative(args.note ?? "", "Resolution notes");
      const evidence = requireNarrative(
        args.evidenceReference ?? "",
        "Resolution evidence",
        400,
        3,
      );
      patch.resolutionNotes = note;
      patch.resolutionEvidence = evidence;
      patch.resolvedAt = now;
      patch.resolvedByUserId = access.userId;
      patch.resolvedByLabel = access.label;
    }
    if (args.status === "verified") {
      if (finding.resolvedByUserId === access.userId) {
        throw new Error(
          "Independent verification required: the person who resolved the finding cannot verify it",
        );
      }
      const notes = requireNarrative(args.note ?? "", "Verification notes");
      patch.verificationNotes = notes;
      patch.verifiedAt = now;
      patch.verifiedByUserId = access.userId;
      patch.verifiedByLabel = access.label;
    }
    if (args.status === "accepted") {
      const rationale = requireNarrative(
        args.acceptanceRationale ?? args.note ?? "",
        "Acceptance rationale",
      );
      patch.acceptanceRationale = rationale;
      patch.acceptedAt = now;
      patch.acceptedByUserId = access.userId;
      patch.acceptedByLabel = access.label;
    }
    await ctx.db.patch(finding._id, patch);
    await appendContinuityEvent(ctx, {
      organizationId: access.organizationId,
      planId: finding.planId,
      exerciseId: finding.exerciseId,
      findingId: finding._id,
      strategyId: finding.strategyId,
      type: "exercise_finding_status_changed",
      fromStatus: finding.status,
      toStatus: args.status,
      actorUserId: access.userId,
      actorLabel: access.label,
      summary: `Exercise finding ${finding.reference} set to ${BCM_FINDING_STATUS_LABELS[args.status as BcmFindingStatus]} by ${access.label}`,
      reason: (args.note ?? args.acceptanceRationale)?.slice(0, 240),
    });
    await logBcmAudit(ctx, access, {
      action: "bcm.exercise_finding_status_changed",
      entityType: "recoveryExerciseFindings",
      entityId: String(finding._id),
      relatedEntityType: "recoveryExercises",
      relatedEntityId: String(finding.exerciseId),
      summary: `Exercise finding ${finding.reference} → ${args.status}`,
    });
    return { status: args.status };
  },
});
