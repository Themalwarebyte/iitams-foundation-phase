import { v } from "convex/values";
import { query } from "./_generated/server";
import { requirePermission, requireEngagementAccess, userLabel } from "./auditAccess";
import { AUDIT_TEAM_ROLE_LABELS, ENGAGEMENT_LABELS, type EngagementStatus } from "../lib/auditWorkflow";

/**
 * Module 10 — Reporting foundation.
 * Server-assembled report payloads rendered by /audit/reports. Export is
 * performed client-side (print-to-PDF and Word-compatible HTML) to keep the
 * platform self-hostable with zero external services; these queries provide
 * the authoritative data.
 */

/** Engagement report: scope, objective, team, procedures, findings. */
export const engagementReport = query({
  args: { engagementId: v.id("auditEngagements") },
  handler: async (ctx, args) => {
    const ea = await requireEngagementAccess(ctx, args.engagementId);
    if (!ea.canWork) throw new Error("Only assigned users can generate reports");
    const e = ea.engagement;

    const [assignments, programs, procedures, findings, plan, universeItem] =
      await Promise.all([
        ctx.db
          .query("auditAssignments")
          .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
          .collect(),
        ctx.db
          .query("auditPrograms")
          .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
          .collect(),
        ctx.db
          .query("auditProcedures")
          .withIndex("by_engagement", (q) => q.eq("engagementId", args.engagementId))
          .collect(),
        ctx.db
          .query("findings")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", ea.access.organizationId!),
          )
          .collect(),
        e.planId ? ctx.db.get(e.planId) : Promise.resolve(null),
        e.universeItemId ? ctx.db.get(e.universeItemId) : Promise.resolve(null),
      ]);

    const engagementFindings = findings
      .filter((f) => f.engagementId === args.engagementId)
      .sort((a, b) => a.code.localeCompare(b.code));

    const team = await Promise.all(
      assignments.map(async (a) => ({
        role: a.teamRole,
        roleLabel: AUDIT_TEAM_ROLE_LABELS[a.teamRole],
        name: (await userLabel(ctx, a.userId)) ?? "Unknown user",
      })),
    );

    const org = await ctx.db.get(ea.access.organizationId!);

    return {
      generatedAt: Date.now(),
      organization: org ? { name: org.name, code: org.code } : null,
      engagement: {
        code: e.code,
        title: e.name,
        status: e.status,
        statusLabel: ENGAGEMENT_LABELS[e.status as EngagementStatus] ?? e.status,
        objective: e.objective ?? null,
        scope: e.scope ?? null,
        criteria: e.criteria ?? null,
        startDate: e.startDate ?? null,
        targetEndDate: e.targetEndDate ?? null,
        endDate: e.endDate ?? null,
        progressPct: e.progressPct,
        auditManager: e.auditManagerName ?? null,
        planName: plan?.name ?? null,
        universeItemName: universeItem?.name ?? null,
      },
      team,
      programs: programs.map((p) => ({
        code: p.code,
        title: p.title,
        objective: p.objective ?? null,
        status: p.status,
        procedures: procedures
          .filter((x) => x.auditProgramId === p._id)
          .map((x) => ({
            code: x.code,
            name: x.procedureName,
            controlObjective: x.controlObjective ?? null,
            expectedEvidence: x.expectedEvidence ?? null,
            completionStatus: x.completionStatus,
            result: x.result ?? null,
            resultNotes: x.resultNotes ?? null,
          })),
      })),
      findings: engagementFindings.map((f) => ({
        code: f.code,
        title: f.title,
        severity: f.severity,
        status: f.status,
        condition: f.condition ?? null,
        criteria: f.criteria ?? null,
        rootCause: f.rootCause ?? null,
        impact: f.impact ?? null,
        recommendation: f.recommendation ?? null,
        ownerName: f.ownerName ?? null,
        dueDate: f.dueDate ?? null,
        managementResponse: f.managementResponse ?? null,
      })),
    };
  },
});

/** Findings report across the organization (filterable). */
export const findingsReport = query({
  args: {
    severity: v.optional(v.string()),
    status: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "reports.view");
    if (!access.organizationId) return null;
    const [findings, org] = await Promise.all([
      ctx.db
        .query("findings")
        .withIndex("by_organization", (q) =>
          q.eq("organizationId", access.organizationId!),
        )
        .collect(),
      ctx.db.get(access.organizationId),
    ]);

    let rows = findings;
    if (args.severity) rows = rows.filter((f) => f.severity === args.severity);
    if (args.status) rows = rows.filter((f) => f.status === args.status);
    rows = rows.sort((a, b) => a.code.localeCompare(b.code));

    const bySeverity: Record<string, number> = {
      critical: 0, high: 0, medium: 0, low: 0, informational: 0,
    };
    for (const f of rows) bySeverity[f.severity] += 1;

    return {
      generatedAt: Date.now(),
      organization: org ? { name: org.name, code: org.code } : null,
      bySeverity,
      total: rows.length,
      findings: rows.map((f) => ({
        code: f.code,
        title: f.title,
        severity: f.severity,
        status: f.status,
        ownerName: f.ownerName ?? null,
        dueDate: f.dueDate ?? null,
        isOverdue: f.isOverdue ?? false,
        recommendation: f.recommendation ?? null,
      })),
    };
  },
});

/**
 * Executive audit summary: coverage, key risks, critical findings,
 * outstanding actions and an overall audit opinion heuristic derived
 * from coverage + critical finding load.
 */
export const executiveSummary = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "reports.view");
    if (!access.organizationId) return null;

    const [universe, engagements, findings, actions, org] = await Promise.all([
      ctx.db
        .query("auditUniverseItems")
        .withIndex("by_organization", (q) => q.eq("organizationId", access.organizationId!))
        .collect(),
      ctx.db
        .query("auditEngagements")
        .withIndex("by_organization", (q) => q.eq("organizationId", access.organizationId!))
        .collect(),
      ctx.db
        .query("findings")
        .withIndex("by_organization", (q) => q.eq("organizationId", access.organizationId!))
        .collect(),
      ctx.db
        .query("correctiveActions")
        .withIndex("by_organization", (q) => q.eq("organizationId", access.organizationId!))
        .collect(),
      ctx.db.get(access.organizationId),
    ]);

    const activeUniverse = universe.filter((u) => (u.status ?? "active") !== "archived");
    const auditedItemIds = new Set(
      engagements
        .filter((e) => e.universeItemId)
        .map((e) => e.universeItemId as string),
    );
    const coveragePct =
      activeUniverse.length > 0
        ? Math.round(
            (activeUniverse.filter((u) => auditedItemIds.has(u._id)).length /
              activeUniverse.length) *
              100,
          )
        : 0;

    const openFindings = findings.filter(
      (f) => f.status !== "closed" && f.status !== "resolved",
    );
    const criticalFindings = openFindings.filter((f) => f.severity === "critical");
    const highFindings = openFindings.filter((f) => f.severity === "high");
    const outstandingActions = actions.filter(
      (a) =>
        (a.status as string) !== "verified" && (a.status as string) !== "closed",
    );

    // Opinion heuristic (documented in docs/AUDIT_WORKFLOW.md):
    //   satisfactory        — coverage ≥ 70% and no open critical findings
    //   needs_improvement   — no open critical findings but coverage < 70%,
    //                         or ≤ 2 critical findings
    //   unsatisfactory      — more than 2 open critical findings
    const opinion =
      criticalFindings.length > 2
        ? "unsatisfactory"
        : coveragePct >= 70 && criticalFindings.length === 0
          ? "satisfactory"
          : "needs_improvement";

    return {
      generatedAt: Date.now(),
      organization: org ? { name: org.name, code: org.code } : null,
      auditUniverse: {
        total: activeUniverse.length,
        audited: activeUniverse.filter((u) => auditedItemIds.has(u._id)).length,
        coveragePct,
      },
      engagements: {
        total: engagements.length,
        completed: engagements.filter((e) => e.status === "closed" || e.status === "completed").length,
        active: engagements.filter(
          (e) => !["closed", "completed", "cancelled"].includes(e.status),
        ).length,
        delayed: engagements.filter(
          (e) =>
            !["closed", "completed", "cancelled"].includes(e.status) &&
            e.targetEndDate !== undefined &&
            e.targetEndDate < Date.now(),
        ).length,
      },
      findings: {
        open: openFindings.length,
        critical: criticalFindings.length,
        high: highFindings.length,
      },
      actions: {
        outstanding: outstandingActions.length,
        overdue: outstandingActions.filter(
          (a) => a.status === "overdue" || (a.dueDate !== undefined && a.dueDate < Date.now()),
        ).length,
      },
      opinion,
      criticalFindingsList: criticalFindings.slice(0, 10).map((f) => ({
        code: f.code,
        title: f.title,
        ownerName: f.ownerName ?? null,
        dueDate: f.dueDate ?? null,
      })),
    };
  },
});
