import { v } from "convex/values";
import { query } from "./_generated/server";
import { resolveAccess, roleHasPermission } from "./access";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Executive dashboard aggregate — one reactive query powering all tiles. */
export const executive = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const organizationId = access.organizationId;
    const canView = roleHasPermission(access.role, "dashboard.view");

    // Unauthenticated, unprovisioned, or unauthorized → no tenant data.
    if (!access.user || !organizationId || !canView) {
      return null;
    }

    const now = Date.now();
    const soonThreshold = now + 30 * DAY_MS;

    const [
      org,
      engagements,
      allFindings,
      actions,
      risks,
      frameworks,
      controls,
      vulns,
      criticalServices,
      drTests,
      trends,
      logs,
    ] = await Promise.all([
      ctx.db.get(organizationId),
      ctx.db
        .query("auditEngagements")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("findings")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("correctiveActions")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("risks")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("complianceFrameworks")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("controls")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("vulnerabilities")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("criticalServices")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("drTests")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("riskTrendSnapshots")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .collect(),
      ctx.db
        .query("auditLogs")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .order("desc")
        .take(8),
    ]);

    // --- Findings -----------------------------------------------------
    const openFindings = allFindings.filter(
      (f) => f.status === "open" || f.status === "in_remediation",
    );
    const criticalHighFindings = openFindings.filter(
      (f) => f.severity === "critical" || f.severity === "high",
    );
    const findingsBySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      informational: 0,
    };
    for (const f of openFindings) findingsBySeverity[f.severity] += 1;

    const overdueActions = actions.filter(
      (a) => a.status === "overdue" || (a.dueDate !== undefined && a.dueDate < now),
    ).length;

    // --- Audit plan progress ------------------------------------------
    const activeEngagements = engagements.filter(
      (e) => e.status !== "completed" && e.status !== "cancelled",
    );
    const completedEngagements = engagements.filter(
      (e) => e.status === "completed",
    );
    const avgProgress =
      engagements.length > 0
        ? Math.round(
            engagements.reduce((sum, e) => sum + e.progressPct, 0) /
              engagements.length,
          )
        : 0;

    // --- Risk ----------------------------------------------------------
    const openRisks = risks.filter((r) => r.status !== "closed");
    // Critical band of the 5×5 model: residual score 15–25 (see
    // docs/DESIGN_SYSTEM.md severity matrix). Scores of exactly 15 arise from
    // (3,5) and (5,3); 12 (3,4)/(4,3) is HIGH, not critical.
    const criticalRisks = openRisks.filter(
      (r) => r.residualLikelihood * r.residualImpact >= 15,
    );
    const riskHeatCells: Record<string, number> = {};
    for (const r of openRisks) {
      const key = `${r.residualLikelihood}-${r.residualImpact}`;
      riskHeatCells[key] = (riskHeatCells[key] ?? 0) + 1;
    }
    const orderedTrends = [...trends].sort((a, b) => a.periodStart - b.periodStart);

    // --- Compliance -----------------------------------------------------
    const complianceScore =
      frameworks.length > 0
        ? Math.round(
            frameworks.reduce((sum, f) => sum + f.complianceScorePct, 0) /
              frameworks.length,
          )
        : 0;
    const testedControls = controls.filter((c) => c.effectiveness !== "not_tested");
    const effectiveControls = controls.filter(
      (c) => c.effectiveness === "effective",
    );
    const controlEffectiveness =
      testedControls.length > 0
        ? Math.round(
            (effectiveControls.length / testedControls.length) * 100,
          )
        : 0;

    // --- Cyber -----------------------------------------------------------
    const openVulns = vulns.filter(
      (v) => v.status === "open" || v.status === "confirmed",
    );
    const criticalVulns = openVulns.filter(
      (v) => v.severity === "critical" || v.severity === "high",
    );
    const vulnBySeverity: Record<string, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      informational: 0,
    };
    for (const v of openVulns) vulnBySeverity[v.severity] += 1;
    const vulnAgeingBuckets = { "0-30": 0, "31-90": 0, "90+": 0 };
    for (const v of openVulns) {
      const ageDays = Math.floor((now - v.discoveredAt) / DAY_MS);
      if (ageDays <= 30) vulnAgeingBuckets["0-30"] += 1;
      else if (ageDays <= 90) vulnAgeingBuckets["31-90"] += 1;
      else vulnAgeingBuckets["90+"] += 1;
    }

    // --- BCM / DR --------------------------------------------------------
    const bcmReadiness =
      criticalServices.length > 0
        ? Math.round(
            criticalServices.reduce((s, c) => s + c.readinessScorePct, 0) /
              criticalServices.length,
          )
        : 0;
    const drPassRate =
      drTests.length > 0
        ? Math.round(
            (drTests.filter((t) => t.status === "completed").length /
              drTests.length) *
              100,
          )
        : 0;
    const upcomingDrTests = drTests.filter(
      (t) => t.status === "planned" && t.scheduledFor >= now,
    ).length;

    const anyDemo = Boolean(
      (engagements[0]?.isDemo ??
        allFindings[0]?.isDemo ??
        risks[0]?.isDemo ??
        vulns[0]?.isDemo ??
        frameworks[0]?.isDemo ??
        criticalServices[0]?.isDemo) ?? false,
    );

    return {
      organization: org ? { name: org.name, code: org.code, type: org.type } : null,
      isDemoData: anyDemo,
      role: access.role ?? null,
      generatedAt: now,
      kpis: {
        activeAudits: activeEngagements.length,
        auditPlanCompletionPct: avgProgress,
        openFindings: openFindings.length,
        criticalHighFindings: criticalHighFindings.length,
        overdueCorrectiveActions: overdueActions,
        openRisks: openRisks.length,
        criticalRisks: criticalRisks.length,
        criticalVulnerabilities: criticalVulns.length,
        complianceScorePct: complianceScore,
        controlEffectivenessPct: controlEffectiveness,
        bcmReadinessPct: bcmReadiness,
        drReadinessPct: drPassRate,
      },
      upcomingDeadlines: {
        engagementsDueSoon: activeEngagements.filter(
          (e) =>
            e.targetEndDate !== undefined &&
            e.targetEndDate >= now &&
            e.targetEndDate <= soonThreshold,
        ).length,
        upcomingDrTests,
      },
      distributions: {
        findingsBySeverity,
        vulnerabilitiesBySeverity: vulnBySeverity,
        vulnerabilityAgeing: vulnAgeingBuckets,
        riskHeatCells,
        controlEffectivenessBreakdown: {
          effective: effectiveControls.length,
          partially_effective: controls.filter(
            (c) => c.effectiveness === "partially_effective",
          ).length,
          ineffective: controls.filter((c) => c.effectiveness === "ineffective")
            .length,
          not_tested: controls.filter((c) => c.effectiveness === "not_tested")
            .length,
        },
        frameworkScores: frameworks
          .map((f) => ({ name: f.name, score: f.complianceScorePct }))
          .sort((a, b) => a.score - b.score),
      },
      trends: orderedTrends.map((t) => ({
        label: t.periodLabel,
        openRisks: t.openRisks,
        criticalHigh: t.criticalHighRisks,
        avgResidual: t.avgResidualScore,
      })),
      recentActivity: logs.map((l) => ({
        id: l._id,
        action: l.action,
        summary: l.summary ?? l.action,
        actor: l.actorLabel ?? "System",
        createdAt: l.createdAt,
      })),
    };
  },
});
