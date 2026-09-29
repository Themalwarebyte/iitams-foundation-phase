import { query } from "./_generated/server";
import { requirePermission } from "./auditAccess";
import { ENGAGEMENT_ORDER, type EngagementStatus } from "../lib/auditWorkflow";

/**
 * Module 11 — Audit dashboard metrics.
 * One reactive query powering the audit-programme strip on the executive
 * dashboard: universe size, coverage, planned/completed/delayed audits,
 * findings load and overdue actions, plus workload by lifecycle stage.
 */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return null;

    const now = Date.now();
    const [universe, plans, planItems, engagements, findings, actions] =
      await Promise.all([
        ctx.db
          .query("auditUniverseItems")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
        ctx.db
          .query("auditPlans")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
        ctx.db
          .query("auditPlanItems")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
        ctx.db
          .query("auditEngagements")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
        ctx.db
          .query("findings")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
        ctx.db
          .query("correctiveActions")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", access.organizationId!),
          )
          .collect(),
      ]);

    const activeUniverse = universe.filter(
      (u) => (u.status ?? "active") !== "archived",
    );
    const engagedUniverseIds = new Set(
      engagements
        .filter((e) => e.universeItemId)
        .map((e) => e.universeItemId as string),
    );
    const coveragePct =
      activeUniverse.length > 0
        ? Math.round(
            (activeUniverse.filter((u) => engagedUniverseIds.has(u._id)).length /
              activeUniverse.length) *
              100,
          )
        : 0;

    // High-risk universe items not covered by any engagement (Module 2 KPI).
    const highRiskUncovered = activeUniverse.filter(
      (u) =>
        !engagedUniverseIds.has(u._id) &&
        (u.criticality === "very_high" ||
          u.criticality === "high" ||
          u.inherentRisk === "critical"),
    );

    const openFindings = findings.filter(
      (f) => f.status !== "closed" && f.status !== "resolved",
    );
    const criticalFindings = openFindings.filter(
      (f) => f.severity === "critical",
    );
    const overdueActions = actions.filter(
      (a) =>
        (a.status as string) !== "verified" &&
        (a.status as string) !== "closed" &&
        ((a.status as string) === "overdue" ||
          (a.dueDate !== undefined && a.dueDate < now)),
    );

    // Workload: engagements per lifecycle stage (spec order).
    const workload: Record<string, number> = {};
    for (const stage of ENGAGEMENT_ORDER) workload[stage] = 0;
    for (const e of engagements) {
      const s = e.status as EngagementStatus;
      workload[s] = (workload[s] ?? 0) + 1;
    }

    // Audit backlog: plan items not yet started as engagements.
    const backlog = planItems.filter(
      (pi) => pi.status === "planned" || pi.status === "deferred",
    ).length;

    const anyDemo = Boolean(
      universe[0]?.isDemo ?? engagements[0]?.isDemo ?? false,
    );

    return {
      isDemoData: anyDemo,
      generatedAt: now,
      universe: {
        total: activeUniverse.length,
        highRiskUncovered: highRiskUncovered.length,
        coveragePct,
      },
      plans: {
        total: plans.length,
        inExecution: plans.filter((p) => p.status === "in_execution").length,
        backlog,
      },
      engagements: {
        planned: engagements.filter((e) =>
          ["draft", "planning", "approved", "planned"].includes(e.status),
        ).length,
        active: engagements.filter((e) =>
          ["fieldwork", "in_progress"].includes(e.status),
        ).length,
        completed: engagements.filter((e) =>
          ["closed", "report_issued", "completed"].includes(e.status),
        ).length,
        delayed: engagements.filter(
          (e) =>
            !["closed", "completed", "cancelled", "report_issued"].includes(
              e.status,
            ) &&
            e.targetEndDate !== undefined &&
            e.targetEndDate < now,
        ).length,
      },
      findings: {
        open: openFindings.length,
        critical: criticalFindings.length,
        ageingOver90Days: openFindings.filter(
          (f) => now - f.createdAt > 90 * 24 * 60 * 60 * 1000,
        ).length,
      },
      actions: {
        overdue: overdueActions.length,
        completionRatePct:
          actions.length > 0
            ? Math.round(
                (actions.filter((a) =>
                  ["verified", "closed", "implemented", "completed"].includes(
                    a.status as string,
                  ),
                ).length /
                  actions.length) *
                  100,
              )
            : 0,
      },
      workload,
    };
  },
});
