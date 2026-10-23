import { v } from "convex/values";

/**
 * Business Continuity Management — shared vocabulary (Phase 4A — Batch 4.1)
 * ========================================================================
 * Pure labels, validators and objective arithmetic shared by the backend and
 * the UI. Nothing here scores resilience: a BIA is a documented analysis of a
 * service, not a tested continuity plan and not evidence of organizational
 * resilience.
 */

export const BCM_TITLE_MIN = 3;
export const BCM_TITLE_MAX = 200;
export const BCM_REFERENCE_MAX = 40;
export const BCM_TEXT_MAX = 4000;
export const BCM_NARRATIVE_MIN = 20;
/** A plan names one primary service plus up to this many additional services. */
export const BCM_MAX_ADDITIONAL_SERVICES = 10;
export const BCM_OWNER_LABEL_MAX = 160;
export const BCM_DEPARTMENT_MAX = 160;

/** Recovery objectives are stored in MINUTES so units are never ambiguous. */
export const BCM_MINUTES_MAX = 525_600; // one year
export const BCM_MIN_REVIEW_INTERVAL_DAYS = 1;
export const BCM_MAX_REVIEW_INTERVAL_DAYS = 1095; // three years

export const BCM_SERVICE_STATUSES = [
  "active",
  "degraded",
  "suspended",
  "retired",
] as const;
export type BcmServiceStatus = (typeof BCM_SERVICE_STATUSES)[number];

export const BCM_SERVICE_STATUS_LABELS: Record<BcmServiceStatus, string> = {
  active: "Active",
  degraded: "Degraded",
  suspended: "Suspended",
  retired: "Retired",
};

export const BCM_CRITICALITIES = ["low", "medium", "high", "critical"] as const;
export type BcmCriticality = (typeof BCM_CRITICALITIES)[number];

export const BCM_CRITICALITY_LABELS: Record<BcmCriticality, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const BCM_CRITICALITY_RANK: Record<BcmCriticality, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export const BCM_IMPACT_CATEGORIES = [
  "operational",
  "financial",
  "regulatory",
  "reputational",
  "customer",
] as const;
export type BcmImpactCategory = (typeof BCM_IMPACT_CATEGORIES)[number];

export const BCM_IMPACT_CATEGORY_LABELS: Record<BcmImpactCategory, string> = {
  operational: "Operational",
  financial: "Financial",
  regulatory: "Regulatory / legal",
  reputational: "Reputational",
  customer: "Customer / service delivery",
};

export const BCM_IMPACT_SEVERITIES = [
  "none",
  "low",
  "moderate",
  "high",
  "severe",
] as const;
export type BcmImpactSeverity = (typeof BCM_IMPACT_SEVERITIES)[number];

export const BCM_IMPACT_SEVERITY_LABELS: Record<BcmImpactSeverity, string> = {
  none: "None recorded",
  low: "Low",
  moderate: "Moderate",
  high: "High",
  severe: "Severe",
};

export const BCM_IMPACT_SEVERITY_RANK: Record<BcmImpactSeverity, number> = {
  none: 0,
  low: 1,
  moderate: 2,
  high: 3,
  severe: 4,
};

export const BCM_BIA_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "superseded",
] as const;
export type BcmBiaStatus = (typeof BCM_BIA_STATUSES)[number];

export const BCM_BIA_STATUS_LABELS: Record<BcmBiaStatus, string> = {
  draft: "Draft",
  in_review: "Submitted for review",
  approved: "Reviewed / approved",
  superseded: "Superseded",
};

export const BCM_REVIEW_DECISIONS = ["approved", "rejected"] as const;
export type BcmReviewDecision = (typeof BCM_REVIEW_DECISIONS)[number];

export const BCM_REVIEW_DECISION_LABELS: Record<BcmReviewDecision, string> = {
  approved: "Approved",
  rejected: "Returned for revision",
};

export const BCM_PRIORITIES = ["p1", "p2", "p3", "p4"] as const;
export type BcmPriority = (typeof BCM_PRIORITIES)[number];

export const BCM_PRIORITY_LABELS: Record<BcmPriority, string> = {
  p1: "P1 — restore first",
  p2: "P2 — high",
  p3: "P3 — medium",
  p4: "P4 — low",
};

export const bcmServiceStatusValidator = v.union(
  ...BCM_SERVICE_STATUSES.map((status) => v.literal(status)),
);
export const bcmCriticalityValidator = v.union(
  ...BCM_CRITICALITIES.map((level) => v.literal(level)),
);
export const bcmImpactCategoryValidator = v.union(
  ...BCM_IMPACT_CATEGORIES.map((category) => v.literal(category)),
);
export const bcmImpactSeverityValidator = v.union(
  ...BCM_IMPACT_SEVERITIES.map((level) => v.literal(level)),
);
export const bcmBiaStatusValidator = v.union(
  ...BCM_BIA_STATUSES.map((status) => v.literal(status)),
);
export const bcmReviewDecisionValidator = v.union(
  ...BCM_REVIEW_DECISIONS.map((decision) => v.literal(decision)),
);
export const bcmPriorityValidator = v.union(
  ...BCM_PRIORITIES.map((priority) => v.literal(priority)),
);

export const bcmImpactEntryValidator = v.object({
  severity: bcmImpactSeverityValidator,
  notes: v.string(),
});

/** One severity + rationale per impact category; no invented magnitudes. */
export const bcmImpactsValidator = v.object({
  operational: bcmImpactEntryValidator,
  financial: bcmImpactEntryValidator,
  regulatory: bcmImpactEntryValidator,
  reputational: bcmImpactEntryValidator,
  customer: bcmImpactEntryValidator,
});

export type BcmImpactEntry = { severity: BcmImpactSeverity; notes: string };
export type BcmImpacts = Record<BcmImpactCategory, BcmImpactEntry>;

/** Draft → review → approved, with a revision creating a new version. */
export const BCM_BIA_TRANSITIONS: Record<BcmBiaStatus, BcmBiaStatus[]> = {
  draft: ["in_review"],
  in_review: ["approved", "draft"],
  approved: ["superseded"],
  superseded: [],
};

export function canTransitionBia(from: BcmBiaStatus, to: BcmBiaStatus): boolean {
  return BCM_BIA_TRANSITIONS[from]?.includes(to) ?? false;
}

export type RecoveryObjectiveInput = {
  rtoMinutes?: number;
  rpoMinutes?: number;
  mtpdMinutes?: number;
  minimumServiceLevel: string;
  recoveryPriority: BcmPriority;
  objectiveRationale: string;
  mtpdExceptionJustification?: string;
};

/**
 * Validates recovery objectives server-side. RTO and RPO are independent
 * concepts: no ordering is assumed between them. RTO may not exceed MTPD — the
 * point after which the disruption is intolerable — unless a documented
 * exception is recorded.
 */
export function validateRecoveryObjectives(input: RecoveryObjectiveInput): {
  rtoMinutes: number;
  rpoMinutes?: number;
  mtpdMinutes?: number;
  minimumServiceLevel: string;
  recoveryPriority: BcmPriority;
  objectiveRationale: string;
  mtpdExceptionJustification?: string;
} {
  const minutes = (
    value: number | undefined,
    field: string,
  ): number | undefined => {
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`${field} must be a positive whole number of minutes`);
    }
    if (value > BCM_MINUTES_MAX) {
      throw new Error(`${field} cannot exceed one year (525 600 minutes)`);
    }
    return value;
  };

  const rtoMinutes = minutes(input.rtoMinutes, "Recovery time objective");
  const rpoMinutes = minutes(input.rpoMinutes, "Recovery point objective");
  const mtpdMinutes = minutes(
    input.mtpdMinutes,
    "Maximum tolerable period of disruption",
  );

  if (rtoMinutes === undefined) {
    throw new Error("A recovery time objective (RTO) is required");
  }
  if (rpoMinutes !== undefined && rpoMinutes > BCM_MINUTES_MAX) {
    throw new Error("Recovery point objective cannot exceed one year");
  }

  const exception = (input.mtpdExceptionJustification ?? "").trim();
  if (
    mtpdMinutes !== undefined &&
    rtoMinutes > mtpdMinutes &&
    exception.length < BCM_NARRATIVE_MIN
  ) {
    throw new Error(
      "Recovery time objective exceeds the maximum tolerable period of disruption; record a documented exception justification of at least " +
        `${BCM_NARRATIVE_MIN} characters or correct the values`,
    );
  }

  const minimumServiceLevel = input.minimumServiceLevel.trim();
  if (minimumServiceLevel.length < BCM_NARRATIVE_MIN) {
    throw new Error(
      `Minimum acceptable service level must be at least ${BCM_NARRATIVE_MIN} characters`,
    );
  }
  if (minimumServiceLevel.length > BCM_TEXT_MAX) {
    throw new Error("Minimum acceptable service level is too long");
  }

  const objectiveRationale = input.objectiveRationale.trim();
  if (objectiveRationale.length < BCM_NARRATIVE_MIN) {
    throw new Error(
      `Recovery objective rationale must be at least ${BCM_NARRATIVE_MIN} characters`,
    );
  }
  if (objectiveRationale.length > BCM_TEXT_MAX) {
    throw new Error("Recovery objective rationale is too long");
  }

  if (!BCM_PRIORITIES.includes(input.recoveryPriority)) {
    throw new Error("Recovery priority is not a recognised value");
  }

  return {
    rtoMinutes,
    rpoMinutes,
    mtpdMinutes,
    minimumServiceLevel,
    recoveryPriority: input.recoveryPriority,
    objectiveRationale,
    mtpdExceptionJustification:
      exception.length > 0 ? exception.slice(0, BCM_TEXT_MAX) : undefined,
  };
}

/** Human-readable duration from normalized minutes (for summaries/UI). */
export function formatMinutes(minutes: number | undefined | null): string {
  if (minutes === undefined || minutes === null) return "Not recorded";
  if (minutes < 60) return `${minutes} min`;
  if (minutes % 1440 === 0) return `${minutes / 1440} day(s)`;
  if (minutes % 60 === 0) return `${minutes / 60} hour(s)`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours}h ${rest}m`;
}

// ---------------------------------------------------------------------------
// Continuity plans, recovery strategies and recovery gaps (Batch 4.2)
// ---------------------------------------------------------------------------
// A plan documents HOW a service would be recovered. It never asserts that the
// service WILL be recovered, and a strategy's capability is an ESTIMATE until a
// recovery exercise (a later milestone) evidences otherwise.

export const BCM_PLAN_STATUSES = [
  "draft",
  "in_review",
  "approved",
  "returned",
  "superseded",
  "archived",
] as const;
export type BcmPlanStatus = (typeof BCM_PLAN_STATUSES)[number];

export const BCM_PLAN_STATUS_LABELS: Record<BcmPlanStatus, string> = {
  draft: "Draft",
  in_review: "Submitted for review",
  approved: "Approved",
  returned: "Returned for revision",
  superseded: "Superseded",
  archived: "Archived",
};

/** Closed lifecycle: archived and superseded rows are history, never editable. */
export const BCM_PLAN_TRANSITIONS: Record<BcmPlanStatus, BcmPlanStatus[]> = {
  draft: ["in_review"],
  in_review: ["approved", "returned"],
  returned: ["in_review"],
  approved: ["superseded", "archived"],
  superseded: ["archived"],
  archived: [],
};

export function canTransitionPlan(
  from: BcmPlanStatus,
  to: BcmPlanStatus,
): boolean {
  return BCM_PLAN_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses whose content may still be edited (approved is frozen). */
export const BCM_PLAN_EDITABLE_STATUSES: readonly BcmPlanStatus[] = [
  "draft",
  "returned",
];

export function planIsEditable(status: BcmPlanStatus): boolean {
  return BCM_PLAN_EDITABLE_STATUSES.includes(status);
}

export const BCM_STRATEGY_STATUSES = ["proposed", "adopted", "retired"] as const;
export type BcmStrategyStatus = (typeof BCM_STRATEGY_STATUSES)[number];

export const BCM_STRATEGY_STATUS_LABELS: Record<BcmStrategyStatus, string> = {
  proposed: "Proposed",
  adopted: "Adopted",
  retired: "Retired",
};

export const BCM_STRATEGY_TRANSITIONS: Record<
  BcmStrategyStatus,
  BcmStrategyStatus[]
> = {
  proposed: ["adopted", "retired"],
  adopted: ["retired"],
  retired: [],
};

export function canTransitionStrategy(
  from: BcmStrategyStatus,
  to: BcmStrategyStatus,
): boolean {
  return BCM_STRATEGY_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * How a strategy's expected recovery capability is known.
 *
 * `exercise_verified` exists in the vocabulary because a recovery exercise is a
 * later milestone; until then the server refuses it, so a documented estimate
 * can never be displayed as a verified capability.
 */
export const BCM_CAPABILITY_EVIDENCE = ["estimate", "exercise_verified"] as const;
export type BcmCapabilityEvidence = (typeof BCM_CAPABILITY_EVIDENCE)[number];

export const BCM_CAPABILITY_EVIDENCE_LABELS: Record<
  BcmCapabilityEvidence,
  string
> = {
  estimate: "Documented estimate — not validated by an exercise",
  exercise_verified: "Verified by a recovery exercise",
};

export const BCM_GAP_SEVERITIES = ["low", "medium", "high", "critical"] as const;
export type BcmGapSeverity = (typeof BCM_GAP_SEVERITIES)[number];

export const BCM_GAP_SEVERITY_LABELS: Record<BcmGapSeverity, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  critical: "Critical",
};

export const BCM_GAP_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "accepted",
] as const;
export type BcmGapStatus = (typeof BCM_GAP_STATUSES)[number];

export const BCM_GAP_STATUS_LABELS: Record<BcmGapStatus, string> = {
  open: "Open",
  in_progress: "Mitigation in progress",
  resolved: "Resolved",
  accepted: "Accepted (risk acknowledged)",
};

export const BCM_GAP_TRANSITIONS: Record<BcmGapStatus, BcmGapStatus[]> = {
  open: ["in_progress", "resolved", "accepted"],
  in_progress: ["resolved", "accepted"],
  resolved: [],
  accepted: [],
};

export function canTransitionGap(
  from: BcmGapStatus,
  to: BcmGapStatus,
): boolean {
  return BCM_GAP_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A recovery gap can never be created already resolved/accepted. */
export const BCM_GAP_OPEN_STATUSES: readonly BcmGapStatus[] = [
  "open",
  "in_progress",
];

export const bcmPlanStatusValidator = v.union(
  ...BCM_PLAN_STATUSES.map((status) => v.literal(status)),
);
export const bcmStrategyStatusValidator = v.union(
  ...BCM_STRATEGY_STATUSES.map((status) => v.literal(status)),
);
export const bcmCapabilityEvidenceValidator = v.union(
  ...BCM_CAPABILITY_EVIDENCE.map((evidence) => v.literal(evidence)),
);
export const bcmGapSeverityValidator = v.union(
  ...BCM_GAP_SEVERITIES.map((severity) => v.literal(severity)),
);
export const bcmGapStatusValidator = v.union(
  ...BCM_GAP_STATUSES.map((status) => v.literal(status)),
);

/**
 * Arithmetic comparison between a documented objective and an ESTIMATED
 * recovery capability.
 *
 * This is deliberately a difference, not a verdict: a positive delta means the
 * estimate is longer than the objective, which is worth recording as a gap. It
 * is never evidence that a strategy WOULD meet (or would miss) the objective,
 * because nothing here has been exercised.
 */
export function recoveryCapabilityDelta(input: {
  objectiveMinutes?: number;
  expectedMinutes?: number;
}): number | undefined {
  if (input.objectiveMinutes === undefined || input.expectedMinutes === undefined) {
    return undefined;
  }
  return input.expectedMinutes - input.objectiveMinutes;
}

/** The highest recorded impact severity for a BIA (display only). */
export function highestImpactSeverity(
  impacts: BcmImpacts,
): BcmImpactSeverity {
  let highest: BcmImpactSeverity = "none";
  for (const category of BCM_IMPACT_CATEGORIES) {
    const severity = impacts[category]?.severity ?? "none";
    if (BCM_IMPACT_SEVERITY_RANK[severity] > BCM_IMPACT_SEVERITY_RANK[highest]) {
      highest = severity;
    }
  }
  return highest;
}
