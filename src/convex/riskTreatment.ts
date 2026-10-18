import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  RISK_ACTION_REFERENCE_MAX,
  RISK_OWNER_MAX,
  RISK_TEXT_MAX,
  TREATMENT_STATUS_LABELS,
  TREATMENT_STRATEGY_LABELS,
  canTransitionTreatment,
  isTreatmentActionOverdue,
  riskBand,
  riskScore,
  treatmentProgress,
  treatmentStatusValidator,
  treatmentStrategyValidator,
  type TreatmentStatus,
} from "../lib/risk";

/**
 * Phase 3B — Batch 2B: ICT risk treatment plans and actions.
 * (Audit entries are written against the risk entity.)
 * =========================================================
 * A treatment plan documents HOW an assessed risk will be handled and carries
 * one or more separately stored actions. It deliberately does NOT reimplement
 * risk scoring: the plan shows the risk's CURRENT residual score by reading the
 * register row, and no mutation in this module patches `risks` at all.
 *
 * Two consequences are intentional and enforced:
 *   - Choosing the `accept` strategy records a proposal. It is not an approval
 *     and grants no permission the caller did not already hold.
 *   - Completing every action never marks the risk treated or lowers its
 *     residual score. Residual risk only changes through riskAssessments.ts,
 *     which preserves the historical evidence.
 *
 * Authorization mirrors the register: `risk.view` for reads, `risk.manage` plus
 * an active membership for writes, organization always from the resolved access
 * context, and every risk/plan/action id re-checked against it. Assigned owners
 * must be active members of the SAME organization when supplied as a user id.
 * Every mutation appends one immutable audit entry naming actor, organization,
 * risk and timestamp.
 */

const PLAN_LIST_LIMIT = 200;
const ACTION_LIST_LIMIT = 500;
const ASSESSMENT_SCAN_LIMIT = 2000;
const OVERDUE_SCAN_LIMIT = 200;
const OWNER_LIST_LIMIT = 200;
const DAY = 24 * 60 * 60 * 1000;

interface TreatmentAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
}

async function requireViewer(
  ctx: QueryCtx | MutationCtx,
): Promise<TreatmentAccess> {
  const access = await requirePermission(ctx, "risk.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  };
}

async function requireManager(ctx: MutationCtx): Promise<TreatmentAccess> {
  const access = await requirePermission(ctx, "risk.manage");
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
  };
}

function cleanText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return trimmed;
}

/** Resolve and validate the responsible owner (active same-organization member). */
async function resolveOwner(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  ownerUserId: Id<"users"> | undefined,
  ownerName: string | undefined,
): Promise<{ ownerUserId?: Id<"users">; ownerName: string }> {
  if (ownerUserId) {
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", ownerUserId))
      .unique();
    if (!profile || profile.organizationId !== organizationId) {
      throw new Error("Assigned owner is not a member of your organization");
    }
    if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
      throw new Error("Assigned owner membership is not active");
    }
    const user = await ctx.db.get(ownerUserId);
    if (!user) throw new Error("Assigned owner account no longer exists");
    return {
      ownerUserId,
      ownerName:
        user.name ?? user.email ?? (ownerName?.trim() || "Assigned owner"),
    };
  }
  const name = ownerName?.trim();
  if (!name || name.length < 2) {
    throw new Error("A responsible owner is required");
  }
  if (name.length > RISK_OWNER_MAX) {
    throw new Error(`Owner must be at most ${RISK_OWNER_MAX} characters`);
  }
  return { ownerName: name };
}

function presentAction(action: Doc<"riskTreatmentActions">, now: number) {
  return {
    _id: action._id,
    description: action.description,
    ownerUserId: action.ownerUserId,
    ownerName: action.ownerName,
    dueDate: action.dueDate,
    status: action.status,
    completedAt: action.completedAt,
    completionNotes: action.completionNotes,
    reference: action.reference,
    overdue: isTreatmentActionOverdue(action, now),
    createdByLabel: action.createdByLabel,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

function presentPlan(
  plan: Doc<"riskTreatmentPlans">,
  actions: Doc<"riskTreatmentActions">[],
  now: number,
) {
  const progress = treatmentProgress(actions, now);
  return {
    _id: plan._id,
    riskId: plan.riskId,
    reference: plan.reference,
    strategy: plan.strategy,
    strategyLabel: TREATMENT_STRATEGY_LABELS[plan.strategy],
    objective: plan.objective,
    justification: plan.justification,
    ownerUserId: plan.ownerUserId,
    ownerName: plan.ownerName,
    targetDate: plan.targetDate,
    targetOverdue:
      plan.status !== "completed" &&
      plan.status !== "cancelled" &&
      plan.targetDate < now,
    status: plan.status,
    statusLabel: TREATMENT_STATUS_LABELS[plan.status],
    notes: plan.notes,
    completedAt: plan.completedAt,
    createdByLabel: plan.createdByLabel,
    createdAt: plan.createdAt,
    updatedAt: plan.updatedAt,
    progress,
    actions: actions
      .map((a) => presentAction(a, now))
      .sort((a, b) => a.dueDate - b.dueDate || a.createdAt - b.createdAt),
  };
}

async function actionsForPlan(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  planId: Id<"riskTreatmentPlans">,
): Promise<Doc<"riskTreatmentActions">[]> {
  return await ctx.db
    .query("riskTreatmentActions")
    .withIndex("by_organization_plan", (q) =>
      q.eq("organizationId", organizationId).eq("planId", planId),
    )
    .take(ACTION_LIST_LIMIT);
}

/** Next unique treatment-plan reference for the organization (TP-001…). */
async function nextPlanReference(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
): Promise<string> {
  const rows = await ctx.db
    .query("riskTreatmentPlans")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(PLAN_LIST_LIMIT);
  let max = 0;
  for (const row of rows) {
    const match = /^TP-(\d+)$/.exec(row.reference);
    if (match) max = Math.max(max, Number(match[1]));
  }
  let candidate = `TP-${String(max + 1).padStart(3, "0")}`;
  for (let i = 0; i < 1000; i += 1) {
    const clash = await ctx.db
      .query("riskTreatmentPlans")
      .withIndex("by_organization_reference", (q) =>
        q.eq("organizationId", organizationId).eq("reference", candidate),
      )
      .unique();
    if (!clash) return candidate;
    max += 1;
    candidate = `TP-${String(max + 1).padStart(3, "0")}`;
  }
  throw new Error("Could not allocate a unique treatment plan reference");
}

/**
 * Treatment plans for one risk (newest first) with their actions, progress and
 * the register's current residual score. `null` for a foreign risk id — the
 * same "not found" behaviour as the risk register.
 */
export const listForRisk = query({
  args: { riskId: v.id("risks") },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== viewer.organizationId) return null;

    const plans = await ctx.db
      .query("riskTreatmentPlans")
      .withIndex("by_organization_risk", (q) =>
        q.eq("organizationId", viewer.organizationId).eq("riskId", args.riskId),
      )
      .take(PLAN_LIST_LIMIT);

    const now = Date.now();
    const presented = await Promise.all(
      plans.map(async (plan) => {
        const actions = await actionsForPlan(
          ctx,
          viewer.organizationId,
          plan._id,
        );
        return presentPlan(plan, actions, now);
      }),
    );
    presented.sort((a, b) => b.createdAt - a.createdAt);

    const residualScore = riskScore(
      risk.residualLikelihood,
      risk.residualImpact,
    );
    const openPlans = presented.filter(
      (p) => p.status === "planned" || p.status === "in_progress",
    );
    return {
      risk: {
        _id: risk._id,
        code: risk.code,
        title: risk.title,
        status: risk.status,
        residualLikelihood: risk.residualLikelihood,
        residualImpact: risk.residualImpact,
        residualScore,
        residualBand: riskBand(residualScore),
        reviewDue: risk.reviewDue,
        reviewOverdue: risk.reviewDue !== undefined && risk.reviewDue < now,
      },
      plans: presented,
      summary: {
        total: presented.length,
        open: openPlans.length,
        inProgress: presented.filter((p) => p.status === "in_progress").length,
        completed: presented.filter((p) => p.status === "completed").length,
        actionsTotal: presented.reduce((n, p) => n + p.progress.total, 0),
        actionsCompleted: presented.reduce(
          (n, p) => n + p.progress.completed,
          0,
        ),
        actionsOverdue: presented.reduce((n, p) => n + p.progress.overdue, 0),
      },
    };
  },
});

/** One plan with its actions; `null` when it belongs to another organization. */
export const getPlan = query({
  args: { planId: v.id("riskTreatmentPlans") },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.organizationId !== viewer.organizationId) return null;
    const risk = await ctx.db.get(plan.riskId);
    if (!risk || risk.organizationId !== viewer.organizationId) return null;
    const actions = await actionsForPlan(ctx, viewer.organizationId, plan._id);
    const presented = presentPlan(plan, actions, Date.now());
    return {
      ...presented,
      risk: {
        _id: risk._id,
        code: risk.code,
        title: risk.title,
        residualScore: riskScore(
          risk.residualLikelihood,
          risk.residualImpact,
        ),
      },
    };
  },
});

/** Open treatment actions past their due date, organization-scoped. */
export const overdueActions = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();
    const rows = await ctx.db
      .query("riskTreatmentActions")
      .withIndex("by_organization_due", (q) =>
        q.eq("organizationId", viewer.organizationId).lt("dueDate", now),
      )
      .take(OVERDUE_SCAN_LIMIT);
    const open = rows.filter(
      (a) => a.status !== "completed" && a.status !== "cancelled",
    );

    const planCache = new Map<string, string>();
    const riskCache = new Map<string, string>();
    const items = [];
    for (const action of open) {
      let planReference = planCache.get(String(action.planId));
      if (!planReference) {
        const plan = await ctx.db.get(action.planId);
        planReference =
          plan && plan.organizationId === viewer.organizationId
            ? plan.reference
            : "—";
        planCache.set(String(action.planId), planReference);
      }
      let riskCode = riskCache.get(String(action.riskId));
      if (!riskCode) {
        const risk = await ctx.db.get(action.riskId);
        riskCode =
          risk && risk.organizationId === viewer.organizationId
            ? risk.code
            : "—";
        riskCache.set(String(action.riskId), riskCode);
      }
      items.push({
        ...presentAction(action, now),
        planReference,
        riskCode,
        planId: action.planId,
        riskId: action.riskId,
        daysOverdue: Math.max(
          0,
          Math.floor((now - action.dueDate) / DAY),
        ),
      });
    }
    return items.sort((a, b) => a.dueDate - b.dueDate);
  },
});

/**
 * Treatment progress for the module dashboard. Counts are derived from stored
 * plans/actions/assessments, so "assessed" never implies "treated" and a risk
 * only counts as reassessed when a SECOND assessment snapshot exists.
 */
export const treatmentSummary = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();
    const plans = await ctx.db
      .query("riskTreatmentPlans")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(PLAN_LIST_LIMIT);
    const actions = await ctx.db
      .query("riskTreatmentActions")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(ASSESSMENT_SCAN_LIMIT);
    const assessments = await ctx.db
      .query("riskAssessments")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(ASSESSMENT_SCAN_LIMIT);

    const assessmentsByRisk = new Map<string, number>();
    for (const row of assessments) {
      const key = String(row.riskId);
      assessmentsByRisk.set(key, (assessmentsByRisk.get(key) ?? 0) + 1);
    }

    const strategyCounts: Record<string, number> = {};
    for (const plan of plans) {
      strategyCounts[plan.strategy] = (strategyCounts[plan.strategy] ?? 0) + 1;
    }
    const actionStatusCounts: Record<string, number> = {};
    let overdue = 0;
    for (const action of actions) {
      actionStatusCounts[action.status] =
        (actionStatusCounts[action.status] ?? 0) + 1;
      if (isTreatmentActionOverdue(action, now)) overdue += 1;
    }

    return {
      risksAssessed: assessmentsByRisk.size,
      risksReassessed: [...assessmentsByRisk.values()].filter((n) => n >= 2)
        .length,
      treatmentPlanned: plans.filter((p) => p.status === "planned").length,
      treatmentInProgress: plans.filter((p) => p.status === "in_progress")
        .length,
      treatmentCompleted: plans.filter((p) => p.status === "completed").length,
      plansTotal: plans.length,
      actionsTotal: actions.length,
      actionsCompleted: actions.filter((a) => a.status === "completed").length,
      actionsOverdue: overdue,
      strategyCounts,
      actionStatusCounts,
      sampled:
        plans.length === PLAN_LIST_LIMIT ||
        actions.length === ASSESSMENT_SCAN_LIMIT ||
        assessments.length === ASSESSMENT_SCAN_LIMIT,
    };
  },
});

/** Active same-organization members who can be assigned as an owner. */
export const listAssignableOwners = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(OWNER_LIST_LIMIT);
    const owners = [];
    for (const profile of profiles) {
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
        continue;
      }
      const user = await ctx.db.get(profile.userId);
      if (!user || user.isAnonymous === true) continue;
      owners.push({
        userId: profile.userId,
        label: user.name ?? user.email ?? "Member",
        role: profile.role ?? "user",
      });
    }
    return owners.sort((a, b) => a.label.localeCompare(b.label));
  },
});

/** Create a treatment plan for an existing organization-scoped risk. */
export const createPlan = mutation({
  args: {
    riskId: v.id("risks"),
    strategy: treatmentStrategyValidator,
    objective: v.string(),
    justification: v.string(),
    ownerUserId: v.optional(v.id("users")),
    ownerName: v.optional(v.string()),
    targetDate: v.number(),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const risk = await ctx.db.get(args.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }

    const objective = args.objective.trim();
    if (objective.length < 10) {
      throw new Error("Treatment objective must be at least 10 characters");
    }
    if (objective.length > RISK_TEXT_MAX) {
      throw new Error(
        `Treatment objective must be at most ${RISK_TEXT_MAX} characters`,
      );
    }
    const justification = args.justification.trim();
    if (justification.length < 10) {
      throw new Error("Treatment justification must be at least 10 characters");
    }
    if (justification.length > RISK_TEXT_MAX) {
      throw new Error(
        `Treatment justification must be at most ${RISK_TEXT_MAX} characters`,
      );
    }
    if (!Number.isFinite(args.targetDate)) {
      throw new Error("Target completion date must be a valid date");
    }
    const now = Date.now();
    if (args.targetDate <= now) {
      throw new Error("Target completion date must be in the future");
    }
    const notes = cleanText(args.notes, "Notes", RISK_TEXT_MAX);
    const owner = await resolveOwner(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      args.ownerName,
    );

    const reference = await nextPlanReference(ctx, manager.organizationId);
    const planId = await ctx.db.insert("riskTreatmentPlans", {
      organizationId: manager.organizationId,
      riskId: risk._id,
      reference,
      strategy: args.strategy,
      objective,
      justification,
      ownerUserId: owner.ownerUserId,
      ownerName: owner.ownerName,
      targetDate: args.targetDate,
      status: "planned",
      notes,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      isDemo: risk.isDemo,
      createdAt: now,
      updatedAt: now,
    });

    const proposalNote =
      args.strategy === "accept"
        ? "; acceptance is recorded as a proposal only and does not approve the risk"
        : "";
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: risk.ownerUserId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.treatment_plan_created",
      // Recorded on the RISK entity so the register's per-record audit trail
      // stays complete; the summary names the plan reference explicitly.
      entityType: "risks",
      entityId: String(risk._id),
      relatedEntityType: "riskTreatmentPlans",
      relatedEntityId: String(planId),
      summary: `${reference} created for ${risk.code} (${TREATMENT_STRATEGY_LABELS[args.strategy]}); owner ${owner.ownerName}, target ${new Date(args.targetDate).toISOString().slice(0, 10)}${proposalNote}`,
    });

    return { ok: true as const, planId, reference };
  },
});

/** Move a plan through its controlled states (never touches the risk row). */
export const updatePlanStatus = mutation({
  args: {
    planId: v.id("riskTreatmentPlans"),
    status: treatmentStatusValidator,
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.organizationId !== manager.organizationId) {
      throw new Error("Treatment plan not found in your organization");
    }
    const risk = await ctx.db.get(plan.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }
    if (plan.status === args.status) {
      return { ok: true as const, changed: false, status: plan.status };
    }
    if (!canTransitionTreatment(plan.status, args.status)) {
      throw new Error(
        `Invalid status transition: ${TREATMENT_STATUS_LABELS[plan.status]} → ${TREATMENT_STATUS_LABELS[args.status]}`,
      );
    }

    // A plan is "completed" only when its work is genuinely done. Unresolved
    // actions block completion, so a plan can never claim success while its
    // corrective work is still open.
    if (args.status === "completed") {
      const actions = await actionsForPlan(
        ctx,
        manager.organizationId,
        plan._id,
      );
      const unresolved = actions.filter(
        (a) => a.status === "planned" || a.status === "in_progress",
      );
      if (unresolved.length > 0) {
        throw new Error(
          `Cannot complete a treatment plan with ${unresolved.length} unresolved action(s)`,
        );
      }
      // Explicit zero-action policy: a recorded acceptance proposal is the
      // deliverable of an `accept` plan, so it may close without actions. Any
      // other strategy with no actions has no evidence of treatment work and
      // must be cancelled instead of marked completed.
      if (actions.length === 0 && plan.strategy !== "accept") {
        throw new Error(
          "Record at least one treatment action before completing this plan, or cancel it",
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(plan._id, {
      status: args.status,
      completedAt: args.status === "completed" ? now : undefined,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: risk.ownerUserId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.treatment_plan_status_changed",
      entityType: "risks",
      entityId: String(risk._id),
      relatedEntityType: "riskTreatmentPlans",
      relatedEntityId: String(plan._id),
      summary: `${plan.reference} (${risk.code}) status ${TREATMENT_STATUS_LABELS[plan.status]} → ${TREATMENT_STATUS_LABELS[args.status]}; completing treatment does not change the risk's residual score`,
    });

    return { ok: true as const, changed: true, status: args.status };
  },
});

/** Append one action to a plan. Actions are separate records, never edits. */
export const addAction = mutation({
  args: {
    planId: v.id("riskTreatmentPlans"),
    description: v.string(),
    ownerUserId: v.optional(v.id("users")),
    ownerName: v.optional(v.string()),
    dueDate: v.number(),
    reference: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.organizationId !== manager.organizationId) {
      throw new Error("Treatment plan not found in your organization");
    }
    const risk = await ctx.db.get(plan.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }
    if (plan.status === "completed" || plan.status === "cancelled") {
      throw new Error(
        `Cannot add actions to a ${TREATMENT_STATUS_LABELS[plan.status].toLowerCase()} treatment plan`,
      );
    }

    const description = args.description.trim();
    if (description.length < 5) {
      throw new Error("Action description must be at least 5 characters");
    }
    if (description.length > RISK_TEXT_MAX) {
      throw new Error(
        `Action description must be at most ${RISK_TEXT_MAX} characters`,
      );
    }
    if (!Number.isFinite(args.dueDate)) {
      throw new Error("Due date must be a valid date");
    }
    const now = Date.now();
    if (args.dueDate < plan.createdAt - 365 * DAY) {
      throw new Error("Due date cannot precede the treatment plan by over a year");
    }
    if (args.dueDate > now + 10 * 365 * DAY) {
      throw new Error("Due date is too far in the future");
    }
    const reference = cleanText(
      args.reference,
      "Action reference",
      RISK_ACTION_REFERENCE_MAX,
    );
    const owner = await resolveOwner(
      ctx,
      manager.organizationId,
      args.ownerUserId,
      args.ownerName,
    );

    const actionId = await ctx.db.insert("riskTreatmentActions", {
      organizationId: manager.organizationId,
      riskId: plan.riskId,
      planId: plan._id,
      description,
      ownerUserId: owner.ownerUserId,
      ownerName: owner.ownerName,
      dueDate: args.dueDate,
      status: "planned",
      reference,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      isDemo: plan.isDemo,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: risk.ownerUserId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.treatment_action_added",
      entityType: "risks",
      entityId: String(risk._id),
      relatedEntityType: "riskTreatmentActions",
      relatedEntityId: String(actionId),
      summary: `Action added to ${plan.reference} (${risk.code}) for ${owner.ownerName}, due ${new Date(args.dueDate).toISOString().slice(0, 10)}: ${description.slice(0, 120)}`,
    });

    return { ok: true as const, actionId };
  },
});

/**
 * Update one action's controlled status. Completion requires notes and records
 * a timestamp; nothing here changes the risk's residual score or status.
 */
export const updateActionStatus = mutation({
  args: {
    actionId: v.id("riskTreatmentActions"),
    status: treatmentStatusValidator,
    completionNotes: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const action = await ctx.db.get(args.actionId);
    if (!action || action.organizationId !== manager.organizationId) {
      throw new Error("Treatment action not found in your organization");
    }
    const plan = await ctx.db.get(action.planId);
    if (!plan || plan.organizationId !== manager.organizationId) {
      throw new Error("Treatment plan not found in your organization");
    }
    const risk = await ctx.db.get(action.riskId);
    if (!risk || risk.organizationId !== manager.organizationId) {
      throw new Error("Risk not found in your organization");
    }
    // A cancelled plan is closed evidence: its actions are read-only so a late
    // edit cannot silently revive work that management cancelled.
    if (plan.status === "cancelled") {
      throw new Error(
        "Cannot update actions on a cancelled treatment plan",
      );
    }
    if (action.status === args.status) {
      return {
        ok: true as const,
        changed: false,
        status: action.status,
      };
    }
    if (!canTransitionTreatment(action.status, args.status)) {
      throw new Error(
        `Invalid status transition: ${TREATMENT_STATUS_LABELS[action.status]} → ${TREATMENT_STATUS_LABELS[args.status]}`,
      );
    }

    let completionNotes: string | undefined;
    if (args.status === "completed") {
      completionNotes = args.completionNotes?.trim();
      if (!completionNotes || completionNotes.length < 5) {
        throw new Error(
          "Completion notes of at least 5 characters are required to complete an action",
        );
      }
      if (completionNotes.length > RISK_TEXT_MAX) {
        throw new Error(
          `Completion notes must be at most ${RISK_TEXT_MAX} characters`,
        );
      }
    }

    const now = Date.now();
    await ctx.db.patch(action._id, {
      status: args.status,
      completedAt: args.status === "completed" ? now : undefined,
      completionNotes,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: risk.ownerUserId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "risk.treatment_action_status_changed",
      entityType: "risks",
      entityId: String(risk._id),
      relatedEntityType: "riskTreatmentActions",
      relatedEntityId: String(action._id),
      summary: `${plan.reference} (${risk.code}) action status ${TREATMENT_STATUS_LABELS[action.status]} → ${TREATMENT_STATUS_LABELS[args.status]}: ${action.description.slice(0, 100)}; residual score unchanged`,
    });

    return {
      ok: true as const,
      changed: true,
      status: args.status as TreatmentStatus,
      completedAt: args.status === "completed" ? now : null,
    };
  },
});
