import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  criticalityLevelValidator,
  planItemStatusValidator,
  priorityBandValidator,
} from "./schema";
import { requirePermission, logAudit, notify } from "./auditAccess";
import {
  computePriorityScore,
  priorityBand,
  scoringInputsFromUniverse,
  type ScoringInputs,
} from "../lib/auditScoring";

/**
 * Module 2 — Risk-based Audit Planning.
 * Annual/multi-year plans with universe-item line items. Priority scores are
 * computed SERVER-SIDE from configurable weighted inputs (never trusted from
 * the client) and banded Low / Medium / High / Critical. All reads/writes are
 * organization-scoped; plan approval requires audit.manage and is audited.
 */

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

export const listPlans = query({
  args: {
    status: v.optional(
      v.union(
        v.literal("draft"),
        v.literal("approved"),
        v.literal("in_execution"),
        v.literal("closed"),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    let rows = await ctx.db
      .query("auditPlans")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    if (args.status) rows = rows.filter((r) => r.status === args.status);
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  },
});

export const getPlan = query({
  args: { id: v.id("auditPlans") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;
    const plan = await ctx.db.get(args.id);
    if (!plan || plan.organizationId !== access.organizationId) return null;
    return plan;
  },
});

export const createPlan = mutation({
  args: {
    name: v.string(),
    fiscalYear: v.string(),
    period: v.optional(v.string()),
    description: v.optional(v.string()),
    coverageObjective: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const now = Date.now();

    const id = await ctx.db.insert("auditPlans", {
      organizationId: access.organizationId,
      name: args.name,
      fiscalYear: args.fiscalYear,
      period: args.period,
      description: args.description,
      coverageObjective: args.coverageObjective,
      status: "draft",
      totalEngagements: 0,
      completedEngagements: 0,
      createdById: access.user?._id,
      isDemo: false,
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.created",
      entityType: "auditPlans",
      entityId: id,
      summary: `${args.name} (${args.fiscalYear}) created`,
    });

    return { id };
  },
});

/** Approve a plan (locks it into execution; audited + notifies auditors). */
export const approvePlan = mutation({
  args: { id: v.id("auditPlans") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const plan = await ctx.db.get(args.id);
    if (!plan || plan.organizationId !== access.organizationId) {
      throw new Error("Audit plan not found");
    }
    if (plan.status !== "draft") {
      throw new Error("Only draft plans can be approved");
    }

    await ctx.db.patch(args.id, {
      status: "approved",
      approvedById: access.user?._id,
      approvedByName: access.user?.name ?? access.user?.email ?? undefined,
      approvalDate: Date.now(),
      updatedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.approved",
      entityType: "auditPlans",
      entityId: args.id,
      summary: `${plan.name} approved for execution`,
    });

    await notify(ctx, {
      organizationId: access.organizationId,
      title: "Audit plan approved",
      body: `${plan.name} (${plan.fiscalYear}) is now approved and can generate engagements.`,
      severity: "success",
      href: "/audit/plans",
    });

    return { ok: true };
  },
});

export const updatePlanStatus = mutation({
  args: {
    id: v.id("auditPlans"),
    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("in_execution"),
      v.literal("closed"),
    ),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const plan = await ctx.db.get(args.id);
    if (!plan || plan.organizationId !== access.organizationId) {
      throw new Error("Audit plan not found");
    }
    await ctx.db.patch(args.id, { status: args.status, updatedAt: Date.now() });
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.status_changed",
      entityType: "auditPlans",
      entityId: args.id,
      summary: `${plan.name} → ${args.status}`,
    });
    return { ok: true };
  },
});

// ---------------------------------------------------------------------------
// Plan items (universe coverage with server-computed priority)
// ---------------------------------------------------------------------------

/** Plan line items joined with their universe item for display. */
export const listPlanItems = query({
  args: { planId: v.id("auditPlans") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    const plan = await ctx.db.get(args.planId);
    if (!plan || plan.organizationId !== access.organizationId) return [];

    const items = await ctx.db
      .query("auditPlanItems")
      .withIndex("by_plan", (q) => q.eq("auditPlanId", args.planId))
      .collect();

    const universe = await ctx.db
      .query("auditUniverseItems")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    const byId = new Map(universe.map((u) => [u._id, u]));

    return items
      .map((item) => {
        const u = byId.get(item.auditUniverseItemId);
        return {
          ...item,
          universeName: u?.name ?? "(deleted)",
          universeCode: u?.code ?? "—",
          universeCategory: u?.category ?? null,
          universeCriticality: u?.criticality ?? null,
          universeClassification: u?.dataClassification ?? null,
        };
      })
      .sort((a, b) => b.priorityScore - a.priorityScore);
  },
});

/** Preview the computed score for a universe item (before adding). */
export const previewScore = query({
  args: {
    auditUniverseItemId: v.id("auditUniverseItems"),
    previousFindings: v.optional(v.number()),
    changeFrequency: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;
    const item = await ctx.db.get(args.auditUniverseItemId);
    if (!item || item.organizationId !== access.organizationId) return null;

    const inputs: Partial<ScoringInputs> = {
      ...scoringInputsFromUniverse({
        criticality: item.criticality,
        dataClassification: item.dataClassification,
        regulatoryImportance: item.regulatoryImportance,
        securityExposure: item.securityExposure,
      }),
      previousFindings: args.previousFindings ?? 0,
      changeFrequency: args.changeFrequency ?? 0,
    };
    const score = computePriorityScore(inputs);
    return { score, band: priorityBand(score), inputs };
  },
});

/**
 * Add a universe item to a plan. The priority score and band are recomputed
 * on the server from the item's attributes (client values are never used).
 */
export const addPlanItem = mutation({
  args: {
    auditPlanId: v.id("auditPlans"),
    auditUniverseItemId: v.id("auditUniverseItems"),
    previousFindings: v.optional(v.number()),
    changeFrequency: v.optional(v.number()),
    plannedStartDate: v.optional(v.number()),
    plannedEndDate: v.optional(v.number()),
    estimatedEffortDays: v.optional(v.number()),
    assignedManagerId: v.optional(v.id("users")),
    assignedManagerName: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    const plan = await ctx.db.get(args.auditPlanId);
    if (!plan || plan.organizationId !== access.organizationId) {
      throw new Error("Audit plan not found");
    }
    const item = await ctx.db.get(args.auditUniverseItemId);
    if (!item || item.organizationId !== access.organizationId) {
      throw new Error("Audit universe item not found");
    }

    const duplicate = await ctx.db
      .query("auditPlanItems")
      .withIndex("by_plan", (q) => q.eq("auditPlanId", args.auditPlanId))
      .filter((q) =>
        q.eq(q.field("auditUniverseItemId"), args.auditUniverseItemId),
      )
      .first();
    if (duplicate) {
      throw new Error("This universe item is already in the plan");
    }

    const inputs: ScoringInputs = {
      ...scoringInputsFromUniverse({
        criticality: item.criticality,
        dataClassification: item.dataClassification,
        regulatoryImportance: item.regulatoryImportance,
        securityExposure: item.securityExposure,
      }),
      previousFindings: args.previousFindings ?? 0,
      changeFrequency: args.changeFrequency ?? 0,
    };
    const score = computePriorityScore(inputs);

    const now = Date.now();
    const id = await ctx.db.insert("auditPlanItems", {
      organizationId: access.organizationId,
      auditPlanId: args.auditPlanId,
      auditUniverseItemId: args.auditUniverseItemId,
      priorityScore: score,
      priorityBand: priorityBand(score),
      scoringInputs: inputs,
      plannedStartDate: args.plannedStartDate,
      plannedEndDate: args.plannedEndDate,
      estimatedEffortDays: args.estimatedEffortDays,
      assignedManagerId: args.assignedManagerId,
      assignedManagerName: args.assignedManagerName,
      status: "planned",
      isDemo: false,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.db.patch(args.auditPlanId, {
      totalEngagements: plan.totalEngagements + 1,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.item_added",
      entityType: "auditPlanItems",
      entityId: id,
      summary: `${item.code} ${item.name} scheduled into ${plan.name} (priority ${score})`,
    });

    return { id, priorityScore: score, priorityBand: priorityBand(score) };
  },
});

export const updatePlanItem = mutation({
  args: {
    id: v.id("auditPlanItems"),
    plannedStartDate: v.optional(v.number()),
    plannedEndDate: v.optional(v.number()),
    estimatedEffortDays: v.optional(v.number()),
    assignedManagerId: v.optional(v.id("users")),
    assignedManagerName: v.optional(v.string()),
    status: v.optional(planItemStatusValidator),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) {
      throw new Error("Plan item not found");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of [
      "plannedStartDate",
      "plannedEndDate",
      "estimatedEffortDays",
      "assignedManagerId",
      "assignedManagerName",
      "status",
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.item_updated",
      entityType: "auditPlanItems",
      entityId: args.id,
      summary: `Plan item updated${args.status ? ` → ${args.status}` : ""}`,
    });
    return { ok: true };
  },
});

export const removePlanItem = mutation({
  args: { id: v.id("auditPlanItems") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const item = await ctx.db.get(args.id);
    if (!item || item.organizationId !== access.organizationId) {
      throw new Error("Plan item not found");
    }
    const plan = await ctx.db.get(item.auditPlanId);

    await ctx.db.delete(args.id);
    if (plan) {
      await ctx.db.patch(plan._id, {
        totalEngagements: Math.max(0, plan.totalEngagements - 1),
        updatedAt: Date.now(),
      });
    }

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "audit_plan.item_removed",
      entityType: "auditPlanItems",
      entityId: args.id,
      summary: `Universe item removed from ${plan?.name ?? "plan"}`,
    });
    return { ok: true };
  },
});
