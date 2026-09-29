/**
 * IITAMS risk-based audit priority scoring (Phase 2, Module 2)
 * ============================================================
 * Pure, dependency-free domain logic shared by the Convex backend and the
 * React frontend. Every audit universe item can be ranked by an audit
 * priority score derived from six weighted inputs (each rated 0–5):
 *
 *   - business criticality
 *   - data sensitivity (derived from data classification)
 *   - regulatory importance
 *   - security exposure
 *   - previous findings
 *   - change frequency
 *
 * The weighted mean is scaled to 0–100 and banded Low / Medium / High /
 * Critical. Weights are configurable per deployment via `ScoringWeights`;
 * `normalizeWeights` guarantees the total never exceeds 1.
 */

export const SCORING_INPUTS = [
  "criticality",
  "dataSensitivity",
  "regulatoryImpact",
  "securityExposure",
  "previousFindings",
  "changeFrequency",
] as const;

export type ScoringInput = (typeof SCORING_INPUTS)[number];
export type ScoringInputs = Record<ScoringInput, number>;
export type ScoringWeights = Record<ScoringInput, number>;

/** Default weights (sum = 1.0). Documented in docs/AUDIT_MODULE_ARCHITECTURE.md. */
export const DEFAULT_WEIGHTS: ScoringWeights = {
  criticality: 0.25,
  dataSensitivity: 0.2,
  regulatoryImpact: 0.2,
  securityExposure: 0.15,
  previousFindings: 0.1,
  changeFrequency: 0.1,
};

/** Clamp an input rating into the 0–5 domain. */
export function clampRating(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(5, Math.max(0, Math.round(value)));
}

/** Scale weights so they sum to exactly 1 (guards misconfigured weights). */
export function normalizeWeights(weights: ScoringWeights): ScoringWeights {
  const total = SCORING_INPUTS.reduce(
    (sum, key) => sum + Math.max(0, weights[key] ?? 0),
    0,
  );
  if (total <= 0) return { ...DEFAULT_WEIGHTS };
  const normalized = {} as ScoringWeights;
  for (const key of SCORING_INPUTS) {
    normalized[key] = Math.max(0, weights[key] ?? 0) / total;
  }
  return normalized;
}

/**
 * Compute the 0–100 audit priority score.
 * `inputs` values are clamped to 0–5; missing entries count as 0.
 */
export function computePriorityScore(
  inputs: Partial<ScoringInputs>,
  weights: ScoringWeights = DEFAULT_WEIGHTS,
): number {
  const w = normalizeWeights(weights);
  let weighted = 0;
  for (const key of SCORING_INPUTS) {
    weighted += clampRating(inputs[key] ?? 0) * w[key];
  }
  // weighted ∈ [0,5] → scale ×20 to a 0–100 score.
  return Math.round(Math.min(100, Math.max(0, weighted * 20)));
}

export type PriorityBand = "low" | "medium" | "high" | "critical";

/**
 * Band boundaries (documented in docs/AUDIT_MODULE_ARCHITECTURE.md §scoring):
 *   Low < 40 ≤ Medium < 60 ≤ High < 80 ≤ Critical ≤ 100
 */
export const BAND_THRESHOLDS = { medium: 40, high: 60, critical: 80 } as const;

export function priorityBand(score: number): PriorityBand {
  if (score >= BAND_THRESHOLDS.critical) return "critical";
  if (score >= BAND_THRESHOLDS.high) return "high";
  if (score >= BAND_THRESHOLDS.medium) return "medium";
  return "low";
}

// ---------------------------------------------------------------------------
// Mapping helpers: universe-item attributes → scoring inputs
// ---------------------------------------------------------------------------

export type CriticalityLevel =
  | "very_low"
  | "low"
  | "medium"
  | "high"
  | "very_high";

export const CRITICALITY_LEVELS: readonly CriticalityLevel[] = [
  "very_low",
  "low",
  "medium",
  "high",
  "very_high",
];

export function criticalityToRating(level: CriticalityLevel): number {
  const index = CRITICALITY_LEVELS.indexOf(level);
  return index < 0 ? 0 : index + 1; // very_low=1 … very_high=5
}

export type DataClassificationLevel =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/** Data-classification sensitivity: public=1, internal=3, confidential=4, restricted=5. */
export function classificationToRating(
  classification: DataClassificationLevel,
): number {
  switch (classification) {
    case "public":
      return 1;
    case "internal":
      return 3;
    case "confidential":
      return 4;
    case "restricted":
      return 5;
    default:
      return 0;
  }
}

/** Universe item shape accepted by the default input derivation. */
export interface ScoringSourceItem {
  criticality?: CriticalityLevel;
  dataClassification?: DataClassificationLevel;
  regulatoryImportance?: CriticalityLevel;
  securityExposure?: CriticalityLevel;
}

/**
 * Derive default scoring inputs from an audit universe item. Planning users
 * may override any input when scheduling the item into a plan.
 */
export function scoringInputsFromUniverse(
  item: ScoringSourceItem,
  overrides: Partial<ScoringInputs> = {},
): ScoringInputs {
  return {
    criticality: overrides.criticality ?? criticalityToRating(item.criticality ?? "medium"),
    dataSensitivity:
      overrides.dataSensitivity ??
      classificationToRating(item.dataClassification ?? "internal"),
    regulatoryImpact:
      overrides.regulatoryImpact ??
      criticalityToRating(item.regulatoryImportance ?? "medium"),
    securityExposure:
      overrides.securityExposure ??
      criticalityToRating(item.securityExposure ?? "medium"),
    previousFindings: overrides.previousFindings ?? 0,
    changeFrequency: overrides.changeFrequency ?? 0,
  };
}
