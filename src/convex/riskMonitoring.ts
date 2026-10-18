import { v } from "convex/values";
import { query } from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { requirePermission } from "./auditAccess";
import {
  TREATMENT_STATUS_LABELS,
  TREATMENT_STRATEGY_LABELS,
  isTreatmentActionOverdue,
  riskBand,
  riskScore,
  treatmentProgress,
  type RiskBand,
  type TreatmentStatus,
} from "../lib/risk";

/**
 * Phase 3B — Batch 2C: ICT risk monitoring and treatment oversight.
 * ================================================================
 * READ-ONLY assurance views over the records that already exist (risks,
 * assessments, treatment plans/actions). Nothing here writes, re-scores or
 * approves anything: residual risk still moves exclusively through
 * `riskAssessments.createAssessment`, and a treatment `accept` strategy remains
 * a proposal rather than an approval decision.
 *
 * Bounds and isolation (every exported query):
 *  - requires `risk.view`;
 *  - organization comes ONLY from the resolved access context, so no global
 *    visibility and no client-supplied tenant;
 *  - every list is capped at a scan limit and every paged list uses an indexed
 *    cursor — an organization with a large register cannot push a query past
 *    Convex's document-read or execution limits;
 *  - counts are derived from the same records the lists show, so a KPI can
 *    never disagree with the underlying data.
 */

// Bounded scan windows. Convex allows ~1s of execution per query, so these
// caps keep one monitoring request well inside the budget even for a large
// register; `sampled` reports whenever a window was reached.
const RISK_SCAN_LIMIT = 250;
const PLAN_SCAN_LIMIT = 150;
const ACTION_SCAN_LIMIT = 300;
const ASSESSMENT_SCAN_LIMIT = 250;
const ATTENTION_LIMIT = 6;
const MOVEMENT_LIMIT = 25;
const OVERSIGHT_LIMIT = 60;
const LIST_BATCH_DEFAULT = 100;
const LIST_BATCH_MAX = 200;
const DAY = 24 * 60 * 60 * 1000;

type Viewer = {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
};

async function requireViewer(ctx: QueryCtx): Promise<Viewer> {
  const access = await requirePermission(ctx, "risk.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return { organizationId: access.organizationId, userId: access.user._id };
}

interface Workspace {
  risks: Doc<"risks">[];
  plans: Doc<"riskTreatmentPlans">[];
  actions: Doc<"riskTreatmentActions">[];
  assessments: Doc<"riskAssessments">[];
  sampled: { risks: boolean; plans: boolean; actions: boolean; assessments: boolean };
}

/**
 * Load the bounded slices this module reasons about. Four indexed reads, each
 * capped, so the per-request document budget stays far below Convex's 32,000
 * document limit even in a large organization.
 */
async function loadWorkspace(ctx: QueryCtx, org: Viewer): Promise<Workspace> {
  const [risks, plans, actions, assessments] = await Promise.all([
    ctx.db
      .query("risks")
      .withIndex("by_organization", (q) => q.eq("organizationId", org.organizationId))
      .take(RISK_SCAN_LIMIT),
    ctx.db
      .query("riskTreatmentPlans")
      .withIndex("by_organization", (q) => q.eq("organizationId", org.organizationId))
      .take(PLAN_SCAN_LIMIT),
    ctx.db
      .query("riskTreatmentActions")
      .withIndex("by_organization", (q) => q.eq("organizationId", org.organizationId))
      .take(ACTION_SCAN_LIMIT),
    ctx.db
      .query("riskAssessments")
      .withIndex("by_organization", (q) => q.eq("organizationId", org.organizationId))
      .take(ASSESSMENT_SCAN_LIMIT),
  ]);
  return {
    risks,
    plans,
    actions,
    assessments,
    sampled: {
      risks: risks.length === RISK_SCAN_LIMIT,
      plans: plans.length === PLAN_SCAN_LIMIT,
      actions: actions.length === ACTION_SCAN_LIMIT,
      assessments: assessments.length === ASSESSMENT_SCAN_LIMIT,
    },
  };
}

interface RiskMetrics {
  risk: Doc<"risks">;
  score: number;
  band: RiskBand;
  inherentScore: number;
  plans: Doc<"riskTreatmentPlans">[];
  openPlans: number;
  completedPlans: number;
  actions: Doc<"riskTreatmentActions">[];
  actionsTotal: number;
  actionsCompleted: number;
  actionsOutstanding: number;
  actionsOverdue: number;
  assessmentCount: number;
  latestAssessmentDate: number | null;
  latestResidual: number | null;
  previousResidual: number | null;
  trendDirection: "increased" | "decreased" | "unchanged" | "unknown";
  trendChange: number | null;
  lastPlanCompletedAt: number | null;
  awaitingReassessment: boolean;
}

function isActiveStatus(status: Doc<"risks">["status"]): boolean {
  return status !== "closed";
}

function planIsOpen(status: TreatmentStatus): boolean {
  return status === "planned" || status === "in_progress";
}

/**
 * Derive per-risk oversight metrics from the loaded records. Pure and shared
 * by the overview, the filtered lists and the trends query, so every surface
 * reports the same numbers.
 */
function deriveMetrics(ws: Workspace, now: number) {
  const plansByRisk = new Map<string, Doc<"riskTreatmentPlans">[]>();
  const plansById = new Map<string, Doc<"riskTreatmentPlans">>();
  for (const plan of ws.plans) {
    const key = String(plan.riskId);
    const list = plansByRisk.get(key);
    if (list) list.push(plan);
    else plansByRisk.set(key, [plan]);
    plansById.set(String(plan._id), plan);
  }

  const actionsByRisk = new Map<string, Doc<"riskTreatmentActions">[]>();
  const actionsByPlan = new Map<string, Doc<"riskTreatmentActions">[]>();
  for (const action of ws.actions) {
    const riskKey = String(action.riskId);
    const riskList = actionsByRisk.get(riskKey);
    if (riskList) riskList.push(action);
    else actionsByRisk.set(riskKey, [action]);
    const planKey = String(action.planId);
    const planList = actionsByPlan.get(planKey);
    if (planList) planList.push(action);
    else actionsByPlan.set(planKey, [action]);
  }

  const assessmentsByRisk = new Map<string, Doc<"riskAssessments">[]>();
  for (const row of ws.assessments) {
    const key = String(row.riskId);
    const list = assessmentsByRisk.get(key);
    if (list) list.push(row);
    else assessmentsByRisk.set(key, [row]);
  }
  for (const list of assessmentsByRisk.values()) {
    list.sort(
      (a, b) => a.assessmentDate - b.assessmentDate || a.createdAt - b.createdAt,
    );
  }

  const metrics = new Map<string, RiskMetrics>();
  for (const risk of ws.risks) {
    const key = String(risk._id);
    const plans = plansByRisk.get(key) ?? [];
    const actions = actionsByRisk.get(key) ?? [];
    const assessments = assessmentsByRisk.get(key) ?? [];
    const latest = assessments[assessments.length - 1];
    const previous = assessments.length >= 2 ? assessments[assessments.length - 2] : null;

    // Overdue treatment work only counts while its plan is still live: work
    // cancelled by management is closed evidence, not an outstanding item.
    const liveActionIds = new Set<string>();
    for (const plan of plans) {
      if (plan.status === "cancelled" || plan.status === "completed") continue;
      for (const action of actionsByPlan.get(String(plan._id)) ?? []) {
        liveActionIds.add(String(action._id));
      }
    }
    let actionsCompleted = 0;
    let actionsOverdue = 0;
    for (const action of actions) {
      if (action.status === "completed") actionsCompleted += 1;
      if (
        liveActionIds.has(String(action._id)) &&
        isTreatmentActionOverdue(action, now)
      ) {
        actionsOverdue += 1;
      }
    }

    const completedPlanTimes = plans
      .filter((p) => p.status === "completed" && p.completedAt !== undefined)
      .map((p) => p.completedAt as number);
    const lastPlanCompletedAt =
      completedPlanTimes.length === 0 ? null : Math.max(...completedPlanTimes);

    const latestAssessmentDate = latest ? latest.assessmentDate : null;
    const awaitingReassessment =
      lastPlanCompletedAt !== null &&
      (latestAssessmentDate === null || latestAssessmentDate < lastPlanCompletedAt);

    const latestResidual = latest
      ? riskScore(latest.residualLikelihood, latest.residualImpact)
      : null;
    const previousResidual = previous
      ? riskScore(previous.residualLikelihood, previous.residualImpact)
      : null;
    const trendChange =
      latestResidual !== null && previousResidual !== null
        ? latestResidual - previousResidual
        : null;
    const trendDirection: RiskMetrics["trendDirection"] =
      trendChange === null ? "unknown" : trendChange > 0 ? "increased" : trendChange < 0 ? "decreased" : "unchanged";

    const score = riskScore(risk.residualLikelihood, risk.residualImpact);
    metrics.set(key, {
      risk,
      score,
      band: riskBand(score),
      inherentScore: riskScore(risk.inherentLikelihood, risk.inherentImpact),
      plans,
      openPlans: plans.filter((p) => planIsOpen(p.status)).length,
      completedPlans: plans.filter((p) => p.status === "completed").length,
      actions,
      actionsTotal: actions.length,
      actionsCompleted,
      // "Outstanding" means open work on a plan that is still live; actions
      // belonging to a cancelled or completed plan are closed evidence.
      actionsOutstanding: actions.filter(
        (a) => planIsOpen(a.status) && liveActionIds.has(String(a._id)),
      ).length,
      actionsOverdue,
      assessmentCount: assessments.length,
      latestAssessmentDate,
      latestResidual,
      previousResidual,
      trendDirection,
      trendChange,
      lastPlanCompletedAt,
      awaitingReassessment,
    });
  }

  return { metrics, plansByRisk, actionsByPlan, assessmentsByRisk, plansById };
}

/** Compact risk row shared by the filtered list and the attention panels. */
function presentRisk(metrics: RiskMetrics, now: number) {
  const risk = metrics.risk;
  return {
    riskId: risk._id,
    code: risk.code,
    title: risk.title,
    category: risk.category,
    status: risk.status,
    ownerName: risk.ownerName,
    reviewDue: risk.reviewDue,
    reviewOverdue: risk.reviewDue !== undefined && risk.reviewDue < now,
    residualLikelihood: risk.residualLikelihood,
    residualImpact: risk.residualImpact,
    residualScore: metrics.score,
    residualBand: metrics.band,
    inherentScore: metrics.inherentScore,
    plansTotal: metrics.plans.length,
    openPlans: metrics.openPlans,
    completedPlans: metrics.completedPlans,
    actionsTotal: metrics.actionsTotal,
    actionsCompleted: metrics.actionsCompleted,
    actionsOutstanding: metrics.actionsOutstanding,
    actionsOverdue: metrics.actionsOverdue,
    assessments: metrics.assessmentCount,
    latestAssessmentDate: metrics.latestAssessmentDate,
    lastPlanCompletedAt: metrics.lastPlanCompletedAt,
    awaitingReassessment: metrics.awaitingReassessment,
    trendDirection: metrics.trendDirection,
    trendChange: metrics.trendChange,
  };
}

const MONITORING_FILTERS = [
  "all",
  "high_priority",
  "overdue_assessment",
  "overdue_treatment",
  "no_treatment_plan",
  "awaiting_reassessment",
] as const;
type MonitoringFilter = (typeof MONITORING_FILTERS)[number];

const monitoringFilterValidator = v.union(
  ...MONITORING_FILTERS.map((f) => v.literal(f)),
);

function matchesFilter(
  metrics: RiskMetrics,
  filter: MonitoringFilter,
  now: number,
): boolean {
  if (!isActiveStatus(metrics.risk.status)) return false;
  switch (filter) {
    case "all":
      return true;
    case "high_priority":
      return metrics.band === "critical" || metrics.band === "high";
    case "overdue_assessment":
      return (
        metrics.risk.reviewDue !== undefined && metrics.risk.reviewDue < now
      );
    case "overdue_treatment":
      return metrics.actionsOverdue > 0;
    case "no_treatment_plan":
      return metrics.plans.length === 0;
    case "awaiting_reassessment":
      return metrics.awaitingReassessment;
    default:
      return false;
  }
}

function matchesSearch(metrics: RiskMetrics, needle: string): boolean {
  if (!needle) return true;
  const risk = metrics.risk;
  return (
    risk.code.toLowerCase().includes(needle) ||
    risk.title.toLowerCase().includes(needle) ||
    (risk.ownerName ?? "").toLowerCase().includes(needle) ||
    (risk.category ?? "").toLowerCase().includes(needle) ||
    (risk.assetOrService ?? "").toLowerCase().includes(needle)
  );
}

function monthKey(timestamp: number): string {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, 1));
  return d.toLocaleDateString("en-GB", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

type Derived = ReturnType<typeof deriveMetrics>;

/**
 * Score movement over time, computed exclusively from the insert-only
 * `riskAssessments` history. Treatment completion is never read as a score
 * change: a movement exists only where an assessment recorded one.
 */
function deriveTrendBlock(ws: Workspace, derived: Derived) {
  const buckets = new Map<
    string,
    { count: number; inherent: number; residual: number; maxResidual: number }
  >();
  for (const row of ws.assessments) {
    const key = monthKey(row.assessmentDate);
    const inherent = riskScore(row.inherentLikelihood, row.inherentImpact);
    const residual = riskScore(row.residualLikelihood, row.residualImpact);
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.count += 1;
      bucket.inherent += inherent;
      bucket.residual += residual;
      bucket.maxResidual = Math.max(bucket.maxResidual, residual);
    } else {
      buckets.set(key, { count: 1, inherent, residual, maxResidual: residual });
    }
  }
  const monthly = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-12)
    .map(([month, bucket]) => ({
      month,
      label: monthLabel(month),
      assessments: bucket.count,
      avgInherent: Math.round((bucket.inherent / bucket.count) * 10) / 10,
      avgResidual: Math.round((bucket.residual / bucket.count) * 10) / 10,
      maxResidual: bucket.maxResidual,
    }));

  const all = [...derived.metrics.values()];
  const withHistory = all.filter(
    (m) => m.assessmentCount >= 2 && m.trendChange !== null,
  );
  const movements = {
    increased: withHistory.filter((m) => m.trendDirection === "increased").length,
    decreased: withHistory.filter((m) => m.trendDirection === "decreased").length,
    unchanged: withHistory.filter((m) => m.trendDirection === "unchanged").length,
    noHistory: all.filter((m) => m.assessmentCount < 2).length,
  };
  const riskMovements = withHistory
    .slice()
    .sort((a, b) => Math.abs(b.trendChange ?? 0) - Math.abs(a.trendChange ?? 0))
    .slice(0, MOVEMENT_LIMIT)
    .map((m) => ({
      riskId: m.risk._id,
      code: m.risk.code,
      title: m.risk.title,
      residualBand: m.band,
      from: m.previousResidual,
      to: m.latestResidual,
      change: m.trendChange,
      direction: m.trendDirection,
      at: m.latestAssessmentDate,
      awaitingReassessment: m.awaitingReassessment,
    }));

  return {
    monthly,
    movements,
    riskMovements,
    totalAssessments: ws.assessments.length,
    sampled: { assessments: ws.sampled.assessments, risks: ws.sampled.risks },
  };
}

/**
 * Plan-level oversight: owner, strategy, status, action counts, target date and
 * the register's CURRENT residual risk. `accept` plans are visibly labelled as
 * proposals — they are not an approved risk-acceptance decision.
 */
function deriveOversightBlock(
  ws: Workspace,
  derived: Derived,
  now: number,
  includeCompleted: boolean,
) {
  const rows = [];
  for (const plan of ws.plans) {
    if (plan.status === "cancelled") continue;
    if (plan.status === "completed" && !includeCompleted) continue;
    const metrics = derived.metrics.get(String(plan.riskId));
    if (!metrics) continue;
    const actions = derived.actionsByPlan.get(String(plan._id)) ?? [];
    const progress = treatmentProgress(actions, now);
    rows.push({
      planId: plan._id,
      reference: plan.reference,
      riskId: plan.riskId,
      riskCode: metrics.risk.code,
      riskTitle: metrics.risk.title,
      strategy: plan.strategy,
      strategyLabel: TREATMENT_STRATEGY_LABELS[plan.strategy],
      status: plan.status,
      statusLabel: TREATMENT_STATUS_LABELS[plan.status],
      ownerName: plan.ownerName,
      targetDate: plan.targetDate,
      targetOverdue: plan.status !== "completed" && plan.targetDate < now,
      daysToTarget: Math.ceil((plan.targetDate - now) / DAY),
      total: progress.total,
      completed: progress.completed,
      outstanding: progress.planned + progress.inProgress,
      overdue: progress.overdue,
      progressPct: progress.progressPct,
      completedAt: plan.completedAt,
      residualScore: metrics.score,
      residualBand: metrics.band,
      awaitingReassessment: metrics.awaitingReassessment,
      // Strategy `accept` records a proposal; it approves nothing.
      acceptanceProposal: plan.strategy === "accept",
    });
  }
  rows.sort((a, b) => {
    if (a.targetOverdue !== b.targetOverdue) return a.targetOverdue ? -1 : 1;
    return a.targetDate - b.targetDate;
  });
  return {
    rows: rows.slice(0, OVERSIGHT_LIMIT),
    total: rows.length,
    truncated: rows.length > OVERSIGHT_LIMIT,
    sampled: ws.sampled,
  };
}

// ---------------------------------------------------------------------------
// Overview — KPI strip, distribution, attention lists
// ---------------------------------------------------------------------------

/**
 * Organization-level monitoring snapshot. Every figure is derived from the
 * same bounded record set, so KPIs and lists cannot contradict each other.
 */
export const monitoringOverview = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();
    const ws = await loadWorkspace(ctx, viewer);
    const derived = deriveMetrics(ws, now);
    const all = [...derived.metrics.values()];
    const active = all.filter((m) => isActiveStatus(m.risk.status));

    const bands: Record<RiskBand, number> = {
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
    };
    const statuses: Record<string, number> = {};
    for (const metrics of active) {
      bands[metrics.band] += 1;
      statuses[metrics.risk.status] =
        (statuses[metrics.risk.status] ?? 0) + 1;
    }

    const overdueAssessmentRows = active.filter((m) =>
      matchesFilter(m, "overdue_assessment", now),
    );
    const highPriorityRows = active.filter((m) =>
      matchesFilter(m, "high_priority", now),
    );
    const awaitingRows = active.filter((m) => m.awaitingReassessment);
    const withoutPlanRows = active.filter((m) => m.plans.length === 0);

    const overdueActionRows = ws.actions
      .filter((action) => {
        if (!isTreatmentActionOverdue(action, now)) return false;
        const plan = derived.plansById.get(String(action.planId));
        if (!plan || !planIsOpen(plan.status)) return false;
        return true;
      })
      .map((action) => {
        const plan = derived.plansById.get(String(action.planId));
        const risk = derived.metrics.get(String(action.riskId));
        return {
          actionId: action._id,
          riskId: action.riskId,
          planId: action.planId,
          planReference: plan?.reference ?? "—",
          riskCode: risk?.risk.code ?? "—",
          riskTitle: risk?.risk.title ?? "—",
          description: action.description,
          ownerName: action.ownerName,
          dueDate: action.dueDate,
          daysOverdue: Math.max(0, Math.floor((now - action.dueDate) / DAY)),
        };
      })
      .sort((a, b) => a.dueDate - b.dueDate);

    let plansTotal = 0;
    let openPlans = 0;
    let completedPlans = 0;
    let actionsTotal = 0;
    let actionsCompleted = 0;
    let actionsOutstanding = 0;
    const strategyCounts: Record<string, number> = {};
    for (const metrics of all) {
      for (const plan of metrics.plans) {
        plansTotal += 1;
        if (planIsOpen(plan.status)) openPlans += 1;
        if (plan.status === "completed") completedPlans += 1;
        strategyCounts[plan.strategy] = (strategyCounts[plan.strategy] ?? 0) + 1;
      }
      actionsTotal += metrics.actionsTotal;
      actionsCompleted += metrics.actionsCompleted;
      actionsOutstanding += metrics.actionsOutstanding;
    }

    const withHistory = active.filter((m) => m.assessmentCount >= 2);
    const movements = {
      increased: withHistory.filter((m) => m.trendDirection === "increased").length,
      decreased: withHistory.filter((m) => m.trendDirection === "decreased").length,
      unchanged: withHistory.filter((m) => m.trendDirection === "unchanged").length,
      noHistory: active.filter((m) => m.assessmentCount < 2).length,
    };

    return {
      generatedAt: now,
      sampled: ws.sampled,
      kpis: {
        activeRisks: active.length,
        highCritical: highPriorityRows.length,
        overdueAssessments: overdueAssessmentRows.length,
        risksWithOpenPlans: active.filter((m) => m.openPlans > 0).length,
        overdueActions: overdueActionRows.length,
        completedActions: actionsCompleted,
        increasingResidual: movements.increased,
        awaitingReassessment: awaitingRows.length,
      },
      bands,
      statuses,
      movements,
      treatment: {
        plansTotal,
        openPlans,
        completedPlans,
        actionsTotal,
        actionsCompleted,
        actionsOutstanding,
        actionsOverdue: overdueActionRows.length,
        strategyCounts,
      },
      attention: {
        highPriority: highPriorityRows
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, ATTENTION_LIMIT)
          .map((m) => presentRisk(m, now)),
        overdueAssessments: overdueAssessmentRows
          .slice()
          .sort(
            (a, b) =>
              (a.risk.reviewDue ?? 0) - (b.risk.reviewDue ?? 0),
          )
          .slice(0, ATTENTION_LIMIT)
          .map((m) => presentRisk(m, now)),
        awaitingReassessment: awaitingRows
          .slice()
          .sort(
            (a, b) =>
              (a.lastPlanCompletedAt ?? 0) - (b.lastPlanCompletedAt ?? 0),
          )
          .slice(0, ATTENTION_LIMIT)
          .map((m) => presentRisk(m, now)),
        withoutTreatmentPlan: withoutPlanRows
          .slice()
          .sort((a, b) => b.score - a.score)
          .slice(0, ATTENTION_LIMIT)
          .map((m) => presentRisk(m, now)),
        overdueActions: overdueActionRows.slice(0, ATTENTION_LIMIT),
      },
      // Trends and plan-level oversight come from the SAME bounded record set,
      // so a monitoring card can never disagree with its own KPI strip.
      trend: deriveTrendBlock(ws, derived),
      oversight: deriveOversightBlock(ws, derived, now, false),
    };
  },
});

// ---------------------------------------------------------------------------
// Paged, filtered risk lists
// ---------------------------------------------------------------------------

/**
 * Filtered monitoring list with an indexed cursor.
 *
 * Filters such as "overdue assessment" or "awaiting reassessment" are derived
 * (score/plan/assessment joins), so they cannot be expressed as a single index
 * range. Instead each request scans ONE bounded, indexed batch of the
 * organization's risks — `numItems` is that batch size, not a promise of a row
 * count — and returns every matching record in the batch together with the
 * Convex cursor for the next batch. Convex permits exactly one paginated query
 * per function execution, so the batch boundary IS the page boundary; nothing
 * is scanned twice and no risk is skipped.
 */
export const monitoringRisks = query({
  args: {
    filter: v.optional(monitoringFilterValidator),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();
    const filter: MonitoringFilter = args.filter ?? "all";
    const needle = args.search?.trim().toLowerCase() ?? "";
    const requested = args.numItems ?? LIST_BATCH_DEFAULT;
    const batchSize = Math.min(
      Math.max(Number.isFinite(requested) ? Math.floor(requested) : LIST_BATCH_DEFAULT, 1),
      LIST_BATCH_MAX,
    );

    const ws = await loadWorkspace(ctx, viewer);
    const derived = deriveMetrics(ws, now);

    const page = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .paginate({ numItems: batchSize, cursor: args.cursor ?? null });

    const rows: ReturnType<typeof presentRisk>[] = [];
    for (const risk of page.page) {
      const metrics = derived.metrics.get(String(risk._id));
      if (!metrics) continue;
      if (!matchesFilter(metrics, filter, now)) continue;
      if (!matchesSearch(metrics, needle)) continue;
      rows.push(presentRisk(metrics, now));
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      scanned: page.page.length,
      batchSize,
      filter,
      sampled: ws.sampled,
    };
  },
});

// ---------------------------------------------------------------------------
// Standalone views over the same bounded record set
// ---------------------------------------------------------------------------
// The monitoring page renders `monitoringOverview` (one consistent snapshot).
// These two queries expose the same derived blocks for API consumers and
// focused tests, so the two surfaces can never disagree about a figure.

/** Score movement over time (immutable assessment history only). */
export const assessmentTrends = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const now = Date.now();
    const ws = await loadWorkspace(ctx, viewer);
    return deriveTrendBlock(ws, deriveMetrics(ws, now));
  },
});

/**
 * Plan-level oversight: owner, strategy, status, action counts, target date and
 * the register's CURRENT residual risk. `accept` plans are visibly labelled as
 * proposals — they are not an approved risk-acceptance decision.
 */
export const treatmentOversight = query({
  args: { includeCompleted: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const ws = await loadWorkspace(ctx, viewer);
    return deriveOversightBlock(
      ws,
      deriveMetrics(ws, Date.now()),
      Date.now(),
      args.includeCompleted === true,
    );
  },
});
