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
