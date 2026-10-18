import { v } from "convex/values";

/**
 * ICT risk vocabulary + the authoritative 5×5 scoring model.
 * ==========================================================
 * Risk score = likelihood (1–5) × impact (1–5) → 1–25, with the bands defined
 * in docs/DESIGN_SYSTEM.md §1.5. This module is the single source of truth
 * shared by the schema, the backend (list/detail/summary) and the register UI,
 * so scoring can never drift between server and client.
 */

export const RISK_STATUSES = [
  "open",
  "assessing",
  "mitigating",
  "treated",
  "accepted",
  "closed",
] as const;
export type RiskStatus = (typeof RISK_STATUSES)[number];

export const RISK_STATUS_LABELS: Record<RiskStatus, string> = {
  open: "Open",
  assessing: "Assessing",
  mitigating: "Mitigating",
  treated: "Treated",
  accepted: "Accepted",
  closed: "Closed",
};

export const RISK_CATEGORIES = [
  "Cyber",
  "Infrastructure",
  "Data",
  "Third-party",
  "People",
  "Process",
  "Compliance",
  "Other",
] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

export const RISK_BANDS = ["critical", "high", "medium", "low"] as const;
export type RiskBand = (typeof RISK_BANDS)[number];

export const RISK_BAND_LABELS: Record<RiskBand, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Canonical bands (docs/DESIGN_SYSTEM.md §1.5). Score range 1–25. */
export function riskBand(score: number): RiskBand {
  if (score >= 15) return "critical";
  if (score >= 10) return "high";
  if (score >= 4) return "medium";
  return "low";
}

/** Score from likelihood × impact (both 1–5). */
export function riskScore(likelihood: number, impact: number): number {
  return likelihood * impact;
}

/** True when the 1–5 inputs are valid whole numbers. */
export function isValidRiskFactor(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 5;
}

// ---------------------------------------------------------------------------
// Convex validators
// ---------------------------------------------------------------------------

export const riskStatusValidator = v.union(
  ...RISK_STATUSES.map((s) => v.literal(s)),
);

export const riskCategoryValidator = v.union(
  ...RISK_CATEGORIES.map((c) => v.literal(c)),
);

export const riskFactorValidator = v.number();

/** Max lengths — evidence text fields, not blobs. */
export const RISK_TEXT_MAX = 4000;
export const RISK_TITLE_MAX = 200;
export const RISK_OWNER_MAX = 120;
export const RISK_ASSET_MAX = 200;
export const RISK_ACTION_REFERENCE_MAX = 500;

// ---------------------------------------------------------------------------
// Treatment plans and actions (Phase 3B — Batch 2B)
// ---------------------------------------------------------------------------
// A treatment plan records HOW an assessed risk will be handled. Selecting the
// `accept` strategy records a documented PROPOSAL only: it never approves the
// risk, changes its register status or reduces its residual score. Residual
// risk moves solely through the assessment workflow (riskAssessments.ts).

export const TREATMENT_STRATEGIES = [
  "mitigate",
  "avoid",
  "transfer",
  "accept",
] as const;
export type TreatmentStrategy = (typeof TREATMENT_STRATEGIES)[number];

export const TREATMENT_STRATEGY_LABELS: Record<TreatmentStrategy, string> = {
  mitigate: "Mitigate",
  avoid: "Avoid",
  transfer: "Transfer",
  accept: "Accept (proposal)",
};

export const TREATMENT_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type TreatmentStatus = (typeof TREATMENT_STATUSES)[number];

export const TREATMENT_STATUS_LABELS: Record<TreatmentStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

/**
 * Controlled state machine for plans and actions. Completed and cancelled are
 * terminal: history is preserved by adding a new record, never by reopening.
 */
export const TREATMENT_TRANSITIONS: Record<TreatmentStatus, TreatmentStatus[]> =
  {
    planned: ["in_progress", "cancelled"],
    in_progress: ["completed", "cancelled"],
    completed: [],
    cancelled: [],
  };

/** True when `next` is an allowed transition from `current`. */
export function canTransitionTreatment(
  current: TreatmentStatus,
  next: TreatmentStatus,
): boolean {
  return TREATMENT_TRANSITIONS[current].includes(next);
}

/** Statuses an authorized user may move a plan or action to right now. */
export function nextTreatmentStatuses(
  current: TreatmentStatus,
): TreatmentStatus[] {
  return TREATMENT_TRANSITIONS[current];
}

/** A treatment action counts as overdue while it is open and past its due date. */
export function isTreatmentActionOverdue(
  action: { status: TreatmentStatus; dueDate: number },
  now: number,
): boolean {
  return (
    action.status !== "completed" &&
    action.status !== "cancelled" &&
    action.dueDate < now
  );
}

export interface TreatmentProgress {
  total: number;
  planned: number;
  inProgress: number;
  completed: number;
  cancelled: number;
  overdue: number;
  /** Completed share of the non-cancelled actions (0–100). */
  progressPct: number;
}

/** Progress is derived from stored actions — never a separate counter. */
export function treatmentProgress(
  actions: Array<{ status: TreatmentStatus; dueDate: number }>,
  now: number,
): TreatmentProgress {
  const progress: TreatmentProgress = {
    total: actions.length,
    planned: 0,
    inProgress: 0,
    completed: 0,
    cancelled: 0,
    overdue: 0,
    progressPct: 0,
  };
  for (const action of actions) {
    if (action.status === "planned") progress.planned += 1;
    else if (action.status === "in_progress") progress.inProgress += 1;
    else if (action.status === "completed") progress.completed += 1;
    else progress.cancelled += 1;
    if (isTreatmentActionOverdue(action, now)) progress.overdue += 1;
  }
  const applicable = progress.total - progress.cancelled;
  progress.progressPct =
    applicable === 0 ? 0 : Math.round((progress.completed / applicable) * 100);
  return progress;
}

// ---------------------------------------------------------------------------
// Treatment validators
// ---------------------------------------------------------------------------

export const treatmentStrategyValidator = v.union(
  ...TREATMENT_STRATEGIES.map((s) => v.literal(s)),
);

export const treatmentStatusValidator = v.union(
  ...TREATMENT_STATUSES.map((s) => v.literal(s)),
);
