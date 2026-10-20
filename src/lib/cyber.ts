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
    penetration_test: "Penetration testing",
    network_assessment: "Network security review",
    application_security: "Web/application security testing",
    configuration_review: "Security configuration review",
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

/** Batch 2A — testing scope and test-case detail limits. */
export const CYBER_SUBTYPE_MAX = 80;
export const CYBER_METHODOLOGY_MAX = 500;
export const CYBER_AUTHORIZATION_REF_MAX = 160;
export const CYBER_TEST_OBSERVATIONS_MIN = 15;
export const CYBER_TEST_REVIEW_MIN = 10;
export const CYBER_TEST_EXPECTED_MIN = 10;

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

// ---------------------------------------------------------------------------
// Security testing scope & authorization (Phase 4A — Batch 2A)
// ---------------------------------------------------------------------------

/**
 * Scope status of an authorized testing engagement. A scope starts as `draft`:
 * recording an engagement never authorizes intrusive work. Only an explicit
 * authorization (which requires in-scope systems, exclusions, a window, a lead
 * tester, methodology, rules of engagement and an authorization reference) may
 * move it to `authorized`, and no test may be executed before it is.
 */
export const CYBER_SCOPE_STATUSES = ["draft", "authorized"] as const;
export type CyberScopeStatus = (typeof CYBER_SCOPE_STATUSES)[number];

export const cyberScopeStatusValidator = v.union(
  ...CYBER_SCOPE_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_SCOPE_STATUS_LABELS: Record<CyberScopeStatus, string> = {
  draft: "Draft (not authorized)",
  authorized: "Authorized",
};

/** Execution is permitted only inside an authorized scope that has started. */
export function mayExecuteTests(
  assessmentStatus: CyberAssessmentStatus,
  scopeStatus: CyberScopeStatus | undefined,
): boolean {
  return assessmentStatus === "in_progress" && scopeStatus === "authorized";
}

/**
 * Normalize a scope entry or a test target for a deterministic comparison.
 * Scope membership and exclusions are matched on this normalized text, so the
 * server and the UI always agree on whether a target is authorized.
 */
export function normalizeCyberTarget(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/** True when `now` is inside the recorded written-authorization window. */
export function isWithinTestingWindow(
  startAt: number | undefined,
  endAt: number | undefined,
  now: number,
): boolean {
  if (startAt === undefined || endAt === undefined) return false;
  return now >= startAt && now <= endAt;
}

/**
 * A target named in the exclusions can never be executed, whatever else the
 * scope says. An empty exclusion list (or the literal "none") excludes nothing.
 */
export function isTargetExcluded(
  exclusions: string | undefined,
  target: string,
): boolean {
  const normalized = normalizeCyberTarget(target);
  if (normalized.length < 4) return false;
  const text = normalizeCyberTarget(exclusions ?? "");
  if (!text || text === "none") return false;
  return text.includes(normalized);
}

/** The target must be declared in the authorized in-scope systems list. */
export function isTargetInAuthorizedScope(
  systemsInScope: string | undefined,
  target: string,
): boolean {
  const normalized = normalizeCyberTarget(target);
  if (!normalized) return false;
  const text = normalizeCyberTarget(systemsInScope ?? "");
  return text.length > 0 && text.includes(normalized);
}

export type TestingExecution = { allowed: boolean; reason: string | null };

/**
 * The full server-side execution gate for a security test: assessment state,
 * authorized scope, the written window and the specific target. The same rule
 * is used to present the reason to the UI, so no client can bypass it and no
 * screen can silently imply execution was permitted.
 */
export function testingExecutionStatus(input: {
  assessmentStatus: CyberAssessmentStatus;
  scopeStatus: CyberScopeStatus | undefined;
  systemsInScope: string | undefined;
  exclusions: string | undefined;
  authorizedStartAt: number | undefined;
  authorizedEndAt: number | undefined;
  target: string;
  now: number;
}): TestingExecution {
  if (!mayExecuteTests(input.assessmentStatus, input.scopeStatus)) {
    return {
      allowed: false,
      reason:
        "Testing can only start inside an authorized scope on an assessment that is in progress",
    };
  }
  if (
    !isWithinTestingWindow(
      input.authorizedStartAt,
      input.authorizedEndAt,
      input.now,
    )
  ) {
    return {
      allowed: false,
      reason:
        "Execution is refused: today is outside the authorized testing window recorded for this engagement",
    };
  }
  if (isTargetExcluded(input.exclusions, input.target)) {
    return {
      allowed: false,
      reason: `Execution is refused: “${input.target}” is named in the explicit exclusions of this authorization`,
    };
  }
  if (!isTargetInAuthorizedScope(input.systemsInScope, input.target)) {
    return {
      allowed: false,
      reason: `Execution is refused: “${input.target}” is not listed in the authorized testing scope`,
    };
  }
  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Security test cases
// ---------------------------------------------------------------------------

export const CYBER_TEST_CATEGORIES = [
  "identity_authentication",
  "authorization_access",
  "input_validation",
  "cryptography_data_protection",
  "network_security",
  "configuration_hardening",
  "logging_monitoring",
  "resilience_recovery",
  "other",
] as const;
export type CyberTestCategory = (typeof CYBER_TEST_CATEGORIES)[number];

export const cyberTestCategoryValidator = v.union(
  ...CYBER_TEST_CATEGORIES.map((c) => v.literal(c)),
);

export const CYBER_TEST_CATEGORY_LABELS: Record<CyberTestCategory, string> = {
  identity_authentication: "Identity & authentication",
  authorization_access: "Authorization & access control",
  input_validation: "Input validation",
  cryptography_data_protection: "Cryptography & data protection",
  network_security: "Network security",
  configuration_hardening: "Configuration hardening",
  logging_monitoring: "Logging & monitoring",
  resilience_recovery: "Resilience & recovery",
  other: "Other",
};

/**
 * Test execution status. `completed` is terminal and immutable: a correction is
 * a new test case, never a silent rewrite of a recorded historical result.
 */
export const CYBER_TEST_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "not_applicable",
  "cancelled",
] as const;
export type CyberTestStatus = (typeof CYBER_TEST_STATUSES)[number];

export const cyberTestStatusValidator = v.union(
  ...CYBER_TEST_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_TEST_STATUS_LABELS: Record<CyberTestStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
  not_applicable: "Not applicable",
  cancelled: "Cancelled",
};

export const CYBER_TEST_TRANSITIONS: Record<
  CyberTestStatus,
  CyberTestStatus[]
> = {
  planned: ["in_progress", "not_applicable", "cancelled"],
  in_progress: ["completed", "not_applicable", "cancelled"],
  completed: [],
  not_applicable: [],
  cancelled: [],
};

export function canTransitionTest(
  from: CyberTestStatus,
  to: CyberTestStatus,
): boolean {
  return CYBER_TEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A recorded result. Status and outcome are DISTINCT fields on purpose. */
export const CYBER_TEST_OUTCOMES = [
  "not_tested",
  "pass",
  "fail",
  "inconclusive",
] as const;
export type CyberTestOutcome = (typeof CYBER_TEST_OUTCOMES)[number];

export const cyberTestOutcomeValidator = v.union(
  ...CYBER_TEST_OUTCOMES.map((o) => v.literal(o)),
);

export const CYBER_TEST_OUTCOME_LABELS: Record<CyberTestOutcome, string> = {
  not_tested: "Not tested",
  pass: "Pass",
  fail: "Fail",
  inconclusive: "Inconclusive",
};

/** Outcomes that represent a recorded test result (never asserted without one). */
export const CYBER_RECORDED_OUTCOMES: CyberTestOutcome[] = [
  "pass",
  "fail",
  "inconclusive",
];

export function isRecordedOutcome(outcome: CyberTestOutcome): boolean {
  return CYBER_RECORDED_OUTCOMES.includes(outcome);
}

/** Tests that still block completing their assessment. */
export function isOutstandingTest(status: CyberTestStatus): boolean {
  return status === "planned" || status === "in_progress";
}

/**
 * A vulnerability only counts as confirmed once a human has confirmed it; an
 * `open` record (or a false positive) is not a confirmed finding.
 */
export function isConfirmedVulnerabilityStatus(
  status: CyberVulnerabilityStatus,
): boolean {
  return (
    status === "confirmed" ||
    status === "in_remediation" ||
    status === "remediated" ||
    status === "verified" ||
    status === "risk_accepted" ||
    status === "closed"
  );
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
  // Batch 2A — security testing engagements and test cases
  "assessment_scope_authorized",
  "test_case_created",
  "test_case_updated",
  "test_started",
  "test_observations_recorded",
  "test_evidence_linked",
  "test_vulnerability_linked",
  "test_completed",
  "test_not_applicable",
  "test_cancelled",
  "test_reviewed",
  // Batch 2B — security retesting, independent verification, assurance reporting
  "retest_created",
  "retest_started",
  "retest_completed",
  "retest_reviewed",
  "retest_rejected",
  "report_created",
  "report_updated",
  "report_submitted",
  "report_finalized",
  "report_revised",
] as const;

// ---------------------------------------------------------------------------
// Security retests (Phase 4A — Batch 2B)
// ---------------------------------------------------------------------------

/**
 * A retest is a NEW record against a previously recorded failed or
 * inconclusive test. It never rewrites the original result: the original stays
 * `completed` with its historical outcome, and the retest carries its own
 * evidence, tester, reviewer and history.
 */
export const CYBER_RETEST_STATUSES = [
  "planned",
  "in_progress",
  "completed",
  "reviewed",
  "rejected",
] as const;
export type CyberRetestStatus = (typeof CYBER_RETEST_STATUSES)[number];

export const cyberRetestStatusValidator = v.union(
  ...CYBER_RETEST_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_RETEST_STATUS_LABELS: Record<CyberRetestStatus, string> = {
  planned: "Retest planned",
  in_progress: "Retest in progress",
  completed: "Awaiting independent review",
  reviewed: "Independently reviewed",
  rejected: "Rejected — further remediation required",
};

export const CYBER_RETEST_TRANSITIONS: Record<
  CyberRetestStatus,
  CyberRetestStatus[]
> = {
  planned: ["in_progress"],
  in_progress: ["completed"],
  completed: ["reviewed", "rejected"],
  reviewed: [],
  rejected: [],
};

export function canTransitionRetest(
  from: CyberRetestStatus,
  to: CyberRetestStatus,
): boolean {
  return CYBER_RETEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** The reviewer's decision on a completed retest. */
export const CYBER_RETEST_REVIEW_DECISIONS = ["approved", "rejected"] as const;
export type CyberRetestReviewDecision =
  (typeof CYBER_RETEST_REVIEW_DECISIONS)[number];

export const cyberRetestReviewDecisionValidator = v.union(
  ...CYBER_RETEST_REVIEW_DECISIONS.map((d) => v.literal(d)),
);

export const CYBER_RETEST_REVIEW_DECISION_LABELS: Record<
  CyberRetestReviewDecision,
  string
> = {
  approved: "Approved",
  rejected: "Rejected — remediation incomplete",
};

/** Only a recorded failure or inconclusive result may be retested. */
export function isRetestEligible(
  status: CyberTestStatus,
  outcome: CyberTestOutcome,
): boolean {
  return (
    status === "completed" && (outcome === "fail" || outcome === "inconclusive")
  );
}

export type RetestExecution = { allowed: boolean; reason: string | null };

/**
 * Retest execution gate. A retest may run after its assessment has completed
 * (remediation happens later), so "in progress" is not required — but the
 * written authorization, its window and the specific target still are. A
 * cancelled assessment or a draft/expired authorization refuses execution.
 */
export function retestExecutionStatus(input: {
  assessmentStatus: CyberAssessmentStatus;
  scopeStatus: CyberScopeStatus | undefined;
  systemsInScope: string | undefined;
  exclusions: string | undefined;
  authorizedStartAt: number | undefined;
  authorizedEndAt: number | undefined;
  target: string;
  now: number;
}): RetestExecution {
  if (input.assessmentStatus === "cancelled") {
    return {
      allowed: false,
      reason: "A retest cannot run against a cancelled assessment",
    };
  }
  if (input.scopeStatus !== "authorized") {
    return {
      allowed: false,
      reason:
        "A retest requires an authorized testing scope; record a new authorization decision first",
    };
  }
  if (
    !isWithinTestingWindow(
      input.authorizedStartAt,
      input.authorizedEndAt,
      input.now,
    )
  ) {
    return {
      allowed: false,
      reason:
        "Retest execution is refused: today is outside the authorized testing window. A new documented authorization is required",
    };
  }
  if (isTargetExcluded(input.exclusions, input.target)) {
    return {
      allowed: false,
      reason: `Retest execution is refused: “${input.target}” is named in the explicit exclusions of this authorization`,
    };
  }
  if (!isTargetInAuthorizedScope(input.systemsInScope, input.target)) {
    return {
      allowed: false,
      reason: `Retest execution is refused: “${input.target}” is not listed in the authorized testing scope`,
    };
  }
  return { allowed: true, reason: null };
}

// ---------------------------------------------------------------------------
// Security assurance reports (Phase 4A — Batch 2B)
// ---------------------------------------------------------------------------

/**
 * A report is a snapshot of recorded evidence, not a security score. A
 * finalized report keeps the exact content it was finalized with; later
 * remediation never rewrites it, and a revision is a new draft version.
 */
export const CYBER_REPORT_STATUSES = [
  "draft",
  "in_review",
  "reviewed",
  "finalized",
  "superseded",
] as const;
export type CyberReportStatus = (typeof CYBER_REPORT_STATUSES)[number];

export const cyberReportStatusValidator = v.union(
  ...CYBER_REPORT_STATUSES.map((s) => v.literal(s)),
);

export const CYBER_REPORT_STATUS_LABELS: Record<CyberReportStatus, string> = {
  draft: "Draft",
  in_review: "Awaiting independent review",
  reviewed: "Independently approved",
  finalized: "Finalized",
  superseded: "Superseded by a later revision",
};

/** The independent reviewer's decision on a submitted report. */
export const CYBER_REPORT_REVIEW_DECISIONS = ["approved", "rejected"] as const;
export type CyberReportReviewDecision =
  (typeof CYBER_REPORT_REVIEW_DECISIONS)[number];

export const cyberReportReviewDecisionValidator = v.union(
  ...CYBER_REPORT_REVIEW_DECISIONS.map((d) => v.literal(d)),
);

export const CYBER_REPORT_REVIEW_DECISION_LABELS: Record<
  CyberReportReviewDecision,
  string
> = {
  approved: "Approved",
  rejected: "Rejected",
};

export const CYBER_REPORT_TRANSITIONS: Record<
  CyberReportStatus,
  CyberReportStatus[]
> = {
  draft: ["in_review"],
  in_review: ["reviewed", "draft"],
  // Approval never finalizes: an approved report is finalized separately, and
  // can only be invalidated (back to draft) or finalised with its frozen copy.
  reviewed: ["finalized", "draft"],
  finalized: ["superseded"],
  superseded: [],
};

export function canTransitionReport(
  from: CyberReportStatus,
  to: CyberReportStatus,
): boolean {
  return CYBER_REPORT_TRANSITIONS[from]?.includes(to) ?? false;
}
