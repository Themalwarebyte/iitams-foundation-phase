import { v } from "convex/values";

/**
 * Cybersecurity Assurance vocabulary (Phase 4A — Batch 1)
 * =======================================================
 * Shared by the schema, the backend (src/convex/cyberAssurance.ts,
 * src/convex/cyberEvidence.ts) and the UI so lifecycle vocabularies, CVSS
 * rules and length limits can never drift between server and client.
 *
 * Deliberate omissions — the module stores what an assessor actually recorded:
 *   - No second risk-scoring model. A vulnerable asset is never assigned a
 *     residual-risk score here; residual risk stays governed by the ICT Risk
 *     Assessment workflow (src/convex/riskAssessments.ts).
 *   - No "safe" severity implied by a CVSS score. Severity and CVSS are two
 *     INDEPENDENT inputs: the score is optional, is validated as a real CVSS
 *     base score when supplied, and is never derived from (or used to derive)
 *     the severity band.
 *   - No auto-completion. A vulnerability, an assessment or a remediation
 *     action only reaches a terminal state through an explicit authorized
 *     transition by a named actor.
 */

// ---------------------------------------------------------------------------
// Severity (shared with the Phase-1 cyber tables)
// ---------------------------------------------------------------------------

export const CYBER_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;
export type CyberSeverity = (typeof CYBER_SEVERITIES)[number];

export const cyberSeverityValidator = v.union(
  ...CYBER_SEVERITIES.map((s) => v.literal(s)),
);

export const CYBER_SEVERITY_LABELS: Record<CyberSeverity, string> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

/** Display order for register filters and roll-ups (worst first). */
export const CYBER_SEVERITY_RANK: Record<CyberSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

// ---------------------------------------------------------------------------
// Assessment lifecycle
// ---------------------------------------------------------------------------

/**
 * Assessment lifecycle. The stored literal `scheduled` is the Phase-1
 * vocabulary for a planned assessment and is presented as "Planned"; the
 * remaining states are explicit and never inferred from findings.
 */
export const CYBER_ASSESSMENT_STATUSES = [
  "scheduled",
  "in_progress",
  "completed",
  "cancelled",
] as const;
export type CyberAssessmentStatus =
  (typeof CYBER_ASSESSMENT_STATUSES)[number];

export const cyberAssessmentStatusValidator = v.union(
  ...CYBER_ASSESSMENT_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_ASSESSMENT_STATUS_LABELS: Record<
  CyberAssessmentStatus,
  string
> = {
  scheduled: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const CYBER_ASSESSMENT_TRANSITIONS: Record<
  CyberAssessmentStatus,
  CyberAssessmentStatus[]
> = {
  // A planned assessment must be started before it can be completed: the
  // lifecycle is explicit, never inferred from the presence of findings.
  scheduled: ["in_progress", "cancelled"],
  in_progress: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionAssessment(
  from: CyberAssessmentStatus,
  to: CyberAssessmentStatus,
): boolean {
  return CYBER_ASSESSMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Assessment types (Phase-1 vocabulary, surfaced with readable labels). */
export const CYBER_ASSESSMENT_TYPES = [
  "penetration_test",
  "network_assessment",
  "application_security",
  "configuration_review",
  "red_team",
] as const;
export type CyberAssessmentType = (typeof CYBER_ASSESSMENT_TYPES)[number];

export const cyberAssessmentTypeValidator = v.union(
  ...CYBER_ASSESSMENT_TYPES.map((t) => v.literal(t)),
);

export const CYBER_ASSESSMENT_TYPE_LABELS: Record<CyberAssessmentType, string> =
  {
    penetration_test: "Penetration test",
    network_assessment: "Network assessment",
    application_security: "Application security review",
    configuration_review: "Configuration review",
    red_team: "Red team exercise",
  };

// ---------------------------------------------------------------------------
// Vulnerability lifecycle
// ---------------------------------------------------------------------------

/**
 * Vulnerability lifecycle. `remediated` means the fix was claimed/applied;
 * `verified` requires a DIFFERENT authorized user to confirm the fix, and only
 * a verified (or risk-accepted / false-positive) record may be closed.
 */
export const CYBER_VULNERABILITY_STATUSES = [
  "open",
  "confirmed",
  "in_remediation",
  "remediated",
  "verified",
  "risk_accepted",
  "false_positive",
  "closed",
] as const;
export type CyberVulnerabilityStatus =
  (typeof CYBER_VULNERABILITY_STATUSES)[number];

export const cyberVulnerabilityStatusValidator = v.union(
  ...CYBER_VULNERABILITY_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_VULNERABILITY_STATUS_LABELS: Record<
  CyberVulnerabilityStatus,
  string
> = {
  open: "Open",
  confirmed: "Confirmed",
  in_remediation: "In remediation",
  remediated: "Remediated (unverified)",
  verified: "Verified",
  risk_accepted: "Risk accepted",
  false_positive: "False positive",
  closed: "Closed",
};

export const CYBER_VULNERABILITY_TRANSITIONS: Record<
  CyberVulnerabilityStatus,
  CyberVulnerabilityStatus[]
> = {
  open: ["confirmed", "false_positive", "risk_accepted"],
  confirmed: ["in_remediation", "remediated", "false_positive", "risk_accepted"],
  in_remediation: ["remediated", "risk_accepted"],
  // A failed independent verification returns the record to active remediation.
  remediated: ["verified", "in_remediation"],
  // A verified record can be closed, or reopened if a regression is found.
  verified: ["closed", "open"],
  risk_accepted: ["closed", "open"],
  false_positive: ["closed", "open"],
  closed: ["open"],
};

export function canTransitionVulnerability(
  from: CyberVulnerabilityStatus,
  to: CyberVulnerabilityStatus,
): boolean {
  return CYBER_VULNERABILITY_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Statuses that count as unresolved work in roll-ups. */
export const CYBER_OPEN_VULNERABILITY_STATUSES: CyberVulnerabilityStatus[] = [
  "open",
  "confirmed",
  "in_remediation",
  "remediated",
];

export function isOpenVulnerabilityStatus(
  status: CyberVulnerabilityStatus,
): boolean {
  return CYBER_OPEN_VULNERABILITY_STATUSES.includes(status);
}

/** Discovery sources — where the record came from, not who owns the fix. */
export const CYBER_VULNERABILITY_SOURCES = [
  "vulnerability_scan",
  "penetration_test",
  "configuration_review",
  "vendor_advisory",
  "incident_postmortem",
  "manual_review",
  "external_report",
  "other",
] as const;
export type CyberVulnerabilitySource =
  (typeof CYBER_VULNERABILITY_SOURCES)[number];

export const cyberVulnerabilitySourceValidator = v.union(
  ...CYBER_VULNERABILITY_SOURCES.map((s) => v.literal(s)),
);

export const CYBER_VULNERABILITY_SOURCE_LABELS: Record<
  CyberVulnerabilitySource,
  string
> = {
  vulnerability_scan: "Vulnerability scan",
  penetration_test: "Penetration test",
  configuration_review: "Configuration review",
  vendor_advisory: "Vendor advisory",
  incident_postmortem: "Incident post-mortem",
  manual_review: "Manual review",
  external_report: "External report",
  other: "Other",
};

// ---------------------------------------------------------------------------
// Remediation action lifecycle
// ---------------------------------------------------------------------------

/**
 * Action lifecycle. `completed` records that the work was done; it is NOT
 * verification. Only an independent verifier may move an action to `verified`,
 * and only a verified action may be closed.
 */
export const CYBER_ACTION_STATUSES = [
  "open",
  "in_progress",
  "completed",
  "verified",
  "closed",
  "cancelled",
] as const;
export type CyberActionStatus = (typeof CYBER_ACTION_STATUSES)[number];

export const cyberActionStatusValidator = v.union(
  ...CYBER_ACTION_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_ACTION_STATUS_LABELS: Record<CyberActionStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  completed: "Completed (unverified)",
  verified: "Verified",
  closed: "Closed",
  cancelled: "Cancelled",
};

export const CYBER_ACTION_TRANSITIONS: Record<
  CyberActionStatus,
  CyberActionStatus[]
> = {
  open: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  // Failed verification reopens the work rather than silently reopening it as
  // "open" — history keeps both the claim and the rejection.
  completed: ["verified", "in_progress", "cancelled"],
  verified: ["closed"],
  closed: [],
  cancelled: [],
};

export function canTransitionAction(
  from: CyberActionStatus,
  to: CyberActionStatus,
): boolean {
  return CYBER_ACTION_TRANSITIONS[from]?.includes(to) ?? false;
}

export const CYBER_ACTION_OPEN_STATUSES: CyberActionStatus[] = [
  "open",
  "in_progress",
  "completed",
];

/** An action that still blocks closing its vulnerability. */
export function isOutstandingAction(status: CyberActionStatus): boolean {
  return status === "open" || status === "in_progress";
}

// ---------------------------------------------------------------------------
// CVSS validation (independent of severity)
// ---------------------------------------------------------------------------

export const CVSS_MIN = 0;
export const CVSS_MAX = 10;
/** CVSS base scores carry at most one decimal place (e.g. 7.5, 10.0, 0.0). */
export const CVSS_DECIMALS = 1;
export const CVSS_VECTOR_MAX = 128;
/**
 * A syntactically valid CVSS v3.0/v3.1 vector header. This validates the
 * SHAPE only — the app never computes a score from a vector, so a supplied
 * score must already be the assessor's real value.
 */
export const CVSS_VECTOR_PATTERN =
  /^CVSS:3\.[01]\/[A-Z]{1,3}:[A-Z](?:\/[A-Z]{1,3}:[A-Z])*$/;

export function validateCvssScore(score: number | undefined): number | undefined {
  if (score === undefined) return undefined;
  if (!Number.isFinite(score)) throw new Error("CVSS score must be a number");
  if (score < CVSS_MIN || score > CVSS_MAX) {
    throw new Error(`CVSS score must be between ${CVSS_MIN} and ${CVSS_MAX}`);
  }
  const scaled = score * 10;
  if (Math.abs(scaled - Math.round(scaled)) > 1e-9) {
    throw new Error("CVSS score must have at most one decimal place");
  }
  return Math.round(scaled) / 10;
}

export function validateCvssVector(
  vector: string | undefined,
): string | undefined {
  if (vector === undefined) return undefined;
  const cleaned = vector.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > CVSS_VECTOR_MAX) {
    throw new Error(`CVSS vector must be at most ${CVSS_VECTOR_MAX} characters`);
  }
  if (!CVSS_VECTOR_PATTERN.test(cleaned)) {
    throw new Error(
      "CVSS vector must be a CVSS v3.0/v3.1 vector, e.g. CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
    );
  }
  return cleaned;
}

/** CVE identifiers are optional and only stored when structurally valid. */
export const CVE_ID_PATTERN = /^CVE-\d{4}-\d{4,7}$/i;

export function validateCveId(cveId: string | undefined): string | undefined {
  if (cveId === undefined) return undefined;
  const cleaned = cveId.trim().toUpperCase();
  if (!cleaned) return undefined;
  if (!CVE_ID_PATTERN.test(cleaned)) {
    throw new Error("CVE identifier must look like CVE-2026-12345");
  }
  return cleaned;
}

// ---------------------------------------------------------------------------
// Length limits and required-detail minimums
// ---------------------------------------------------------------------------

export const CYBER_TITLE_MAX = 160;
export const CYBER_TITLE_MIN = 4;
export const CYBER_REFERENCE_MAX = 40;
export const CYBER_TEXT_MAX = 2000;
export const CYBER_NARRATIVE_MIN = 20;
export const CYBER_DESCRIPTION_MAX = 4000;
export const CYBER_OBJECTIVES_MAX = 2000;
export const CYBER_SCOPE_MAX = 300;
export const CYBER_ASSET_NAME_MAX = 160;
export const CYBER_COMPLETION_NOTES_MIN = 15;
export const CYBER_VERIFICATION_NOTES_MIN = 15;
export const CYBER_REASON_MIN = 10;
export const CYBER_OWNER_LABEL_MAX = 120;

/** Evidence constraints — mirrors the compliance evidence limits. */
export const CYBER_EVIDENCE_FILENAME_MAX = 200;
export const CYBER_EVIDENCE_DESCRIPTION_MAX = 500;
export const CYBER_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024;
export const CYBER_EVIDENCE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/plain",
  "text/csv",
  "application/json",
  "application/zip",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

export const CYBER_EVIDENCE_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export type CyberEvidenceClassification =
  (typeof CYBER_EVIDENCE_CLASSIFICATIONS)[number];

export const cyberEvidenceClassificationValidator = v.union(
  ...CYBER_EVIDENCE_CLASSIFICATIONS.map((c) => v.literal(c)),
);

export const CYBER_EVIDENCE_CLASSIFICATION_LABELS: Record<
  CyberEvidenceClassification,
  string
> = {
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
};

/** Restricted evidence is downloadable only by a cyber manager. */
export function mayReadRestrictedCyberEvidence(canManage: boolean): boolean {
  return canManage;
}

/**
 * Append-only history entry types. The events table is insert-only: status
 * changes, verifications and refusals are all recorded with actor attribution.
 */
export const CYBER_EVENT_TYPES = [
  "assessment_created",
  "assessment_updated",
  "assessment_started",
  "assessment_completed",
  "assessment_cancelled",
  "vulnerability_created",
  "vulnerability_updated",
  "vulnerability_confirmed",
  "vulnerability_remediation_started",
  "vulnerability_remediated",
  "vulnerability_verified",
  "vulnerability_risk_accepted",
  "vulnerability_false_positive",
  "vulnerability_closed",
  "vulnerability_reopened",
  "vulnerability_risk_linked",
  "action_created",
  "action_started",
  "action_completed",
  "action_verified",
  "action_verification_failed",
  "action_closed",
  "action_cancelled",
  "evidence_recorded",
  "evidence_linked",
  "evidence_unlinked",
] as const;
