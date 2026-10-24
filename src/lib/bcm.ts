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

// ---------------------------------------------------------------------------
// Recovery exercises, testing and validation (Batch 4.3)
// ---------------------------------------------------------------------------
// An exercise is a RECORD of an activity that was planned and (once executed)
// observed. Recording, scheduling, completing or reviewing an exercise never
// executes recovery, shuts anything down, triggers failover or restores data:
// operational testing needs external authorization and responsible personnel.

export const BCM_EXERCISE_TYPES = [
  "tabletop",
  "walkthrough",
  "communications",
  "recovery_simulation",
  "technical_recovery_test",
] as const;
export type BcmExerciseType = (typeof BCM_EXERCISE_TYPES)[number];

export const BCM_EXERCISE_TYPE_LABELS: Record<BcmExerciseType, string> = {
  tabletop: "Tabletop exercise",
  walkthrough: "Walkthrough",
  communications: "Communications exercise",
  recovery_simulation: "Recovery-procedure simulation",
  technical_recovery_test: "Controlled technical recovery test",
};

export const BCM_EXERCISE_TYPE_DESCRIPTIONS: Record<BcmExerciseType, string> = {
  tabletop: "Discussion-based review of a scenario against the plan; no systems are touched.",
  walkthrough: "Step-by-step review of the documented procedures with the responsible people.",
  communications: "Exercise of notification, escalation and stakeholder communication only.",
  recovery_simulation: "Simulated recovery of procedures and decisions without operational failover.",
  technical_recovery_test:
    "Controlled test of recovery steps on authorized non-production or approved infrastructure, executed by responsible personnel outside this module.",
};

export const BCM_EXERCISE_STATUSES = [
  "planned",
  "scheduled",
  "in_progress",
  "completed",
  "in_review",
  "reviewed",
  "returned",
  "cancelled",
] as const;
export type BcmExerciseStatus = (typeof BCM_EXERCISE_STATUSES)[number];

export const BCM_EXERCISE_STATUS_LABELS: Record<BcmExerciseStatus, string> = {
  planned: "Planned",
  scheduled: "Scheduled",
  in_progress: "In progress",
  completed: "Completed — awaiting review",
  in_review: "Submitted for review",
  reviewed: "Reviewed / accepted",
  returned: "Returned — record a new version",
  cancelled: "Cancelled",
};

/**
 * Closed lifecycle. A returned exercise cannot be edited back into shape: the
 * reported results are history, so a material correction opens a new version.
 */
export const BCM_EXERCISE_TRANSITIONS: Record<
  BcmExerciseStatus,
  BcmExerciseStatus[]
> = {
  planned: ["scheduled", "in_progress", "cancelled"],
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: ["in_review"],
  in_review: ["reviewed", "returned"],
  reviewed: [],
  returned: [],
  cancelled: [],
};

export function canTransitionExercise(
  from: BcmExerciseStatus,
  to: BcmExerciseStatus,
): boolean {
  return BCM_EXERCISE_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Planning detail may change before the exercise starts. */
export function exercisePlanningEditable(status: BcmExerciseStatus): boolean {
  return status === "planned" || status === "scheduled";
}

/** Observations, measurements and coverage may only be recorded while running. */
export function exerciseResultsEditable(status: BcmExerciseStatus): boolean {
  return status === "in_progress";
}

/** Findings may be raised from the moment an exercise is running. */
export function exerciseAcceptsFindings(status: BcmExerciseStatus): boolean {
  return (
    status === "in_progress" ||
    status === "completed" ||
    status === "in_review" ||
    status === "reviewed" ||
    status === "returned"
  );
}

export const BCM_EXERCISE_STATUS_TERMINAL: readonly BcmExerciseStatus[] = [
  "reviewed",
  "returned",
  "cancelled",
];

export const BCM_MEASUREMENT_OBJECTIVES = [
  "rto",
  "rpo",
  "service_level",
] as const;
export type BcmMeasurementObjective =
  (typeof BCM_MEASUREMENT_OBJECTIVES)[number];

export const BCM_MEASUREMENT_OBJECTIVE_LABELS: Record<
  BcmMeasurementObjective,
  string
> = {
  rto: "Recovery time (RTO)",
  rpo: "Recovery point / data loss (RPO)",
  service_level: "Minimum service level achieved",
};

export const BCM_MEASUREMENT_OUTCOMES = [
  "met",
  "missed",
  "not_assessed",
] as const;
export type BcmMeasurementOutcome = (typeof BCM_MEASUREMENT_OUTCOMES)[number];

export const BCM_MEASUREMENT_OUTCOME_LABELS: Record<
  BcmMeasurementOutcome,
  string
> = {
  met: "Objective met",
  missed: "Objective missed — record a finding",
  not_assessed: "Not assessed against an objective",
};

/**
 * Arithmetic comparison between an approved objective and what an exercise
 * actually observed. Positive means the observation exceeded the objective.
 * A missing objective has no comparison at all — never zero, never "met".
 */
export function measuredObjectiveDelta(input: {
  objectiveMinutes?: number;
  measuredMinutes?: number;
}): number | undefined {
  if (
    input.objectiveMinutes === undefined ||
    input.measuredMinutes === undefined
  ) {
    return undefined;
  }
  return input.measuredMinutes - input.objectiveMinutes;
}

/**
 * An outcome must agree with the recorded measurement. A "met" verdict cannot
 * sit on a measurement that exceeds the objective, and without an approved
 * objective the only honest outcome is "not assessed".
 */
export function measurementOutcomeIsConsistent(input: {
  objectiveMinutes?: number;
  measuredMinutes?: number;
  outcome: BcmMeasurementOutcome;
}): boolean {
  const { objectiveMinutes, measuredMinutes, outcome } = input;
  if (objectiveMinutes === undefined || measuredMinutes === undefined) {
    return outcome === "not_assessed";
  }
  if (outcome === "not_assessed") return false;
  const delta = measuredMinutes - objectiveMinutes;
  return outcome === "met" ? delta <= 0 : delta > 0;
}

export const BCM_FINDING_SEVERITIES = [
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type BcmFindingSeverity = (typeof BCM_FINDING_SEVERITIES)[number];

export const BCM_FINDING_SEVERITY_LABELS: Record<BcmFindingSeverity, string> =
  BCM_GAP_SEVERITY_LABELS;

export const BCM_FINDING_STATUSES = [
  "open",
  "in_progress",
  "resolved",
  "verified",
  "accepted",
] as const;
export type BcmFindingStatus = (typeof BCM_FINDING_STATUSES)[number];

export const BCM_FINDING_STATUS_LABELS: Record<BcmFindingStatus, string> = {
  open: "Open",
  in_progress: "Corrective action in progress",
  resolved: "Resolved — awaiting verification",
  verified: "Resolved and independently verified",
  accepted: "Accepted (deficiency disclosed)",
};

export const BCM_FINDING_TRANSITIONS: Record<
  BcmFindingStatus,
  BcmFindingStatus[]
> = {
  open: ["in_progress", "resolved", "accepted"],
  in_progress: ["resolved", "accepted"],
  resolved: ["verified", "accepted"],
  verified: [],
  accepted: [],
};

export function canTransitionFinding(
  from: BcmFindingStatus,
  to: BcmFindingStatus,
): boolean {
  return BCM_FINDING_TRANSITIONS[from]?.includes(to) ?? false;
}

// Validators live after their source arrays: this module's constants are
// evaluated top-down, so referencing them earlier would read `undefined`.
export const bcmExerciseTypeValidator = v.union(
  ...BCM_EXERCISE_TYPES.map((type) => v.literal(type)),
);
export const bcmExerciseStatusValidator = v.union(
  ...BCM_EXERCISE_STATUSES.map((status) => v.literal(status)),
);
export const bcmMeasurementObjectiveValidator = v.union(
  ...BCM_MEASUREMENT_OBJECTIVES.map((objective) => v.literal(objective)),
);
export const bcmMeasurementOutcomeValidator = v.union(
  ...BCM_MEASUREMENT_OUTCOMES.map((outcome) => v.literal(outcome)),
);
export const bcmFindingSeverityValidator = v.union(
  ...BCM_FINDING_SEVERITIES.map((severity) => v.literal(severity)),
);
export const bcmFindingStatusValidator = v.union(
  ...BCM_FINDING_STATUSES.map((status) => v.literal(status)),
);

/**
 * Exercise-verified capability (Batch 4.3 §G).
 *
 * A strategy is exercise-verified ONLY when a reviewed exercise tested the
 * exact plan version that contains it, recorded the recovery steps as
 * performed, produced at least one measurement, and left no unverified
 * high/critical deficiency attached to that strategy. Anything less stays a
 * documented estimate with the unmet conditions spelled out.
 */
export type StrategyCapabilityEvidence = {
  exerciseId: string;
  exerciseReference: string;
  exerciseStatus: string;
  planId: string;
  planVersion: number;
  biaVersion?: number;
  stepsPerformed: boolean;
  /** Measurements attributed to THIS strategy (not merely to the exercise). */
  strategyMeasurements: number;
  /** Of those, measurements actually assessed as met or missed. */
  assessedMeasurements: number;
  /**
   * Objectives this exercise measured as missed without a finding or recovery
   * gap recording the deviation. A concealed miss cannot be verified.
   */
  undisclosedMisses?: number;
};

export type StrategyFindingSummary = {
  severity: BcmFindingSeverity;
  status: BcmFindingStatus;
};

export function evaluateStrategyCapability(input: {
  strategyId: string;
  planVersion: number;
  biaVersion?: number;
  exercises: StrategyCapabilityEvidence[];
  findings: StrategyFindingSummary[];
}): { verified: boolean; reasons: string[]; exerciseReference?: string } {
  const reasons: string[] = [];
  const reviewed = input.exercises.filter(
    (row) => row.exerciseStatus === "reviewed" && row.planVersion === input.planVersion,
  );
  if (reviewed.length === 0) {
    reasons.push(
      "No independently reviewed exercise has covered this strategy on this plan version",
    );
  }
  const performed = reviewed.filter((row) => row.stepsPerformed);
  if (reviewed.length > 0 && performed.length === 0) {
    reasons.push("No reviewed exercise recorded the recovery steps as performed");
  }
  // Only an assessed observation (met/missed against an approved objective) can
  // establish capability. "not_assessed" is a measurement of nothing.
  const measured = performed.filter((row) => row.assessedMeasurements > 0);
  if (
    reviewed.length > 0 &&
    measured.length === 0 &&
    performed.some((row) => row.strategyMeasurements > 0)
  ) {
    reasons.push(
      "This strategy was only measured as 'not assessed'; no observation was compared against an approved objective",
    );
  } else if (reviewed.length > 0 && measured.length === 0) {
    reasons.push(
      "No reviewed exercise recorded a measurement for this strategy supporting the claimed capability",
    );
  }
  if (measured.some((row) => (row.undisclosedMisses ?? 0) > 0)) {
    reasons.push(
      "An exercise measured this strategy beyond its approved objective without raising the deviation as a finding or recovery gap",
    );
  }
  const blocking = input.findings.filter(
    (row) =>
      row.severity !== "low" &&
      (row.status === "open" ||
        row.status === "in_progress" ||
        row.status === "resolved"),
  );
  if (blocking.length > 0) {
    reasons.push(
      "A high or critical exercise finding is unresolved or awaiting independent verification",
    );
  }
  const candidate = measured.find(
    (row) =>
      reviewed.some((r) => r.exerciseId === row.exerciseId) &&
      (input.biaVersion === undefined || row.biaVersion === input.biaVersion),
  );
  if (candidate === undefined && reviewed.length > 0 && reasons.length === 0) {
    reasons.push(
      "The reviewed exercise tested a different analysis baseline than the plan version being presented",
    );
  }
  const verified = reasons.length === 0 && candidate !== undefined;
  return {
    verified,
    reasons,
    exerciseReference: verified ? candidate?.exerciseReference : undefined,
  };
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
