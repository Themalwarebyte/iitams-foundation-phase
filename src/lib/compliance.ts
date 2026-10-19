import { v } from "convex/values";

/**
 * Compliance vocabulary — framework catalogue and control register.
 * =================================================================
 * Shared by the schema, the backend (src/convex/compliance.ts) and the UI, so
 * status vocabularies, identifier rules and length limits can never drift
 * between server and client.
 *
 * Deliberate omissions (Phase 3C Batch 1 scope):
 *   - No assessment, control-testing, evidence-mapping or scoring model. The
 *     module stores what an organization ADOPTED and how far each control is
 *     implemented — it never invents a compliance percentage.
 *   - No shared/global framework template table: this architecture is
 *     organization-scoped throughout, so a framework row is always an
 *     organization's own adopted framework. Nothing here is globally visible.
 */

// ---------------------------------------------------------------------------
// Framework lifecycle
// ---------------------------------------------------------------------------

/** Lifecycle of an organization's adoption of a framework. */
export const COMPLIANCE_FRAMEWORK_STATUSES = [
  "planned",
  "active",
  "retired",
] as const;
export type ComplianceFrameworkStatus =
  (typeof COMPLIANCE_FRAMEWORK_STATUSES)[number];

export const COMPLIANCE_FRAMEWORK_STATUS_LABELS: Record<
  ComplianceFrameworkStatus,
  string
> = {
  planned: "Planned",
  active: "Active",
  retired: "Retired",
};

export const complianceFrameworkStatusValidator = v.union(
  ...COMPLIANCE_FRAMEWORK_STATUSES.map((s) => v.literal(s)),
);

// ---------------------------------------------------------------------------
// Control implementation status
// ---------------------------------------------------------------------------

/**
 * How far the organization has implemented a control. This is an operational
 * statement about the control, NOT a test result or an effectiveness rating:
 * `effectiveness` on the control row stays `not_tested` until control testing
 * exists (a later batch).
 */
export const CONTROL_IMPLEMENTATION_STATUSES = [
  "not_implemented",
  "planned",
  "in_progress",
  "implemented",
  "not_applicable",
] as const;
export type ControlImplementationStatus =
  (typeof CONTROL_IMPLEMENTATION_STATUSES)[number];

export const CONTROL_IMPLEMENTATION_STATUS_LABELS: Record<
  ControlImplementationStatus,
  string
> = {
  not_implemented: "Not implemented",
  planned: "Planned",
  in_progress: "In progress",
  implemented: "Implemented",
  not_applicable: "Not applicable",
};

export const controlImplementationStatusValidator = v.union(
  ...CONTROL_IMPLEMENTATION_STATUSES.map((s) => v.literal(s)),
);

/** Applicability of a control to this organization's scope. */
export const CONTROL_APPLICABILITY = [
  "applicable",
  "partially_applicable",
  "not_applicable",
] as const;
export type ControlApplicability = (typeof CONTROL_APPLICABILITY)[number];

export const CONTROL_APPLICABILITY_LABELS: Record<ControlApplicability, string> =
  {
    applicable: "Applicable",
    partially_applicable: "Partially applicable",
    not_applicable: "Not applicable",
  };

export const controlApplicabilityValidator = v.union(
  ...CONTROL_APPLICABILITY.map((s) => v.literal(s)),
);

/**
 * Control domains (categories). A bounded vocabulary keeps register filtering
 * meaningful; `other` covers local taxonomies.
 */
export const CONTROL_DOMAINS = [
  "governance",
  "risk_management",
  "asset_management",
  "access_control",
  "cryptography",
  "operations",
  "communications",
  "supply_chain",
  "development",
  "incident_management",
  "business_continuity",
  "compliance",
  "other",
] as const;
export type ControlDomain = (typeof CONTROL_DOMAINS)[number];

export const CONTROL_DOMAIN_LABELS: Record<ControlDomain, string> = {
  governance: "Governance",
  risk_management: "Risk management",
  asset_management: "Asset management",
  access_control: "Access control",
  cryptography: "Cryptography",
  operations: "Operations",
  communications: "Communications",
  supply_chain: "Supply chain",
  development: "Development",
  incident_management: "Incident management",
  business_continuity: "Business continuity",
  compliance: "Compliance",
  other: "Other",
};

export const controlDomainValidator = v.union(
  ...CONTROL_DOMAINS.map((d) => v.literal(d)),
);

// ---------------------------------------------------------------------------
// Control testing (Phase 3C — Batch 2)
// ---------------------------------------------------------------------------
// A control test is an EVIDENCE-GATHERING RECORD: it states what was tested,
// how, by whom, and what was observed. It never changes a control's
// `effectiveness` or produces a compliance percentage — the register reports
// the outcomes that tests actually recorded.

export const CONTROL_TEST_STATUSES = ["planned", "in_progress", "completed"] as const;
export type ControlTestStatus = (typeof CONTROL_TEST_STATUSES)[number];

export const CONTROL_TEST_STATUS_LABELS: Record<ControlTestStatus, string> = {
  planned: "Planned",
  in_progress: "In progress",
  completed: "Completed",
};

export const controlTestStatusValidator = v.union(
  ...CONTROL_TEST_STATUSES.map((s) => v.literal(s)),
);

/**
 * Test outcomes. `not_tested` is the only outcome a test may carry before it is
 * completed; completing a test requires one of the three verdicts.
 */
export const CONTROL_TEST_OUTCOMES = [
  "effective",
  "partially_effective",
  "ineffective",
  "not_tested",
] as const;
export type ControlTestOutcome = (typeof CONTROL_TEST_OUTCOMES)[number];

export const CONTROL_TEST_OUTCOME_LABELS: Record<ControlTestOutcome, string> = {
  effective: "Effective",
  partially_effective: "Partially effective",
  ineffective: "Ineffective",
  not_tested: "Not tested",
};

export const controlTestOutcomeValidator = v.union(
  ...CONTROL_TEST_OUTCOMES.map((o) => v.literal(o)),
);

/** Outcomes that constitute a completed verdict (and therefore a result). */
export const CONTROL_TEST_VERDICTS = [
  "effective",
  "partially_effective",
  "ineffective",
] as const;

export function isControlTestVerdict(
  outcome: ControlTestOutcome,
): outcome is (typeof CONTROL_TEST_VERDICTS)[number] {
  return (CONTROL_TEST_VERDICTS as readonly string[]).includes(outcome);
}

/**
 * Allowed status transitions. A completed test is FINAL: it is never reopened
 * or edited — a correction is a new superseding test record
 * (`supersedesTestId`), which keeps the original result readable forever.
 */
const TEST_TRANSITIONS: Record<ControlTestStatus, ControlTestStatus[]> = {
  planned: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: [],
};

export function canTransitionControlTest(
  from: ControlTestStatus,
  to: ControlTestStatus,
): boolean {
  return TEST_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A test that still needs work (not final). */
export function isOpenControlTest(status: ControlTestStatus): boolean {
  return status === "planned" || status === "in_progress";
}

// ---------------------------------------------------------------------------
// Compliance assessments (Phase 3C Batch 3)
// ---------------------------------------------------------------------------

/**
 * A cycle moves draft → in progress → completed, and (when independent review
 * is required) completed → reviewed. A finalised cycle is never reopened: a
 * correction is a NEW assessment that supersedes it.
 */
export const COMPLIANCE_ASSESSMENT_STATUSES = [
  "draft",
  "in_progress",
  "completed",
  "reviewed",
] as const;
export type ComplianceAssessmentStatus =
  (typeof COMPLIANCE_ASSESSMENT_STATUSES)[number];

export const COMPLIANCE_ASSESSMENT_STATUS_LABELS: Record<
  ComplianceAssessmentStatus,
  string
> = {
  draft: "Draft",
  in_progress: "In progress",
  completed: "Completed",
  reviewed: "Reviewed",
};

export const complianceAssessmentStatusValidator = v.union(
  ...COMPLIANCE_ASSESSMENT_STATUSES.map((s) => v.literal(s)),
);

/** Control-level assessment outcomes. */
export const COMPLIANCE_ASSESSMENT_OUTCOMES = [
  "compliant",
  "partially_compliant",
  "non_compliant",
  "not_assessed",
  "not_applicable",
] as const;
export type ComplianceAssessmentOutcome =
  (typeof COMPLIANCE_ASSESSMENT_OUTCOMES)[number];

export const COMPLIANCE_ASSESSMENT_OUTCOME_LABELS: Record<
  ComplianceAssessmentOutcome,
  string
> = {
  compliant: "Compliant",
  partially_compliant: "Partially compliant",
  non_compliant: "Non-compliant",
  not_assessed: "Not assessed",
  not_applicable: "Not applicable",
};

export const complianceAssessmentOutcomeValidator = v.union(
  ...COMPLIANCE_ASSESSMENT_OUTCOMES.map((o) => v.literal(o)),
);

/** Outcomes that constitute an assessor's conclusion (not a non-answer). */
export const COMPLIANCE_ASSESSMENT_VERDICTS = [
  "compliant",
  "partially_compliant",
  "non_compliant",
] as const;

export function isAssessmentVerdict(
  outcome: ComplianceAssessmentOutcome,
): outcome is (typeof COMPLIANCE_ASSESSMENT_VERDICTS)[number] {
  return (COMPLIANCE_ASSESSMENT_VERDICTS as readonly string[]).includes(outcome);
}

const ASSESSMENT_TRANSITIONS: Record<
  ComplianceAssessmentStatus,
  ComplianceAssessmentStatus[]
> = {
  draft: ["in_progress", "completed"],
  in_progress: ["completed"],
  completed: ["reviewed"],
  reviewed: [],
};

export function canTransitionAssessment(
  from: ComplianceAssessmentStatus,
  to: ComplianceAssessmentStatus,
): boolean {
  return ASSESSMENT_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A cycle that still accepts work. */
export function isOpenAssessment(status: ComplianceAssessmentStatus): boolean {
  return status === "draft" || status === "in_progress";
}

/** A cycle whose results are final and must not be rewritten. */
export function isFinalAssessment(status: ComplianceAssessmentStatus): boolean {
  return status === "completed" || status === "reviewed";
}

// Assessment limits.
export const ASSESSMENT_TITLE_MAX = 200;
export const ASSESSMENT_REFERENCE_MAX = 40;
export const ASSESSMENT_SCOPE_MAX = 4000;
export const ASSESSMENT_PERIOD_MAX = 120;
/** Minimum rationale behind an assessor's conclusion. */
export const ASSESSMENT_RATIONALE_MIN = 20;
export const ASSESSMENT_RATIONALE_MAX = 4000;
export const ASSESSMENT_FINDINGS_MAX = 4000;
export const ASSESSMENT_REMEDIATION_MAX = 2000;
export const ASSESSMENT_NOTES_MIN = 20;
export const ASSESSMENT_REVIEW_NOTES_MAX = 2000;
export const ASSESSMENT_EVIDENCE_UNLINK_REASON_MAX = 300;

// ---------------------------------------------------------------------------
// Compliance findings and remediation (Phase 3C Batch 4)
// ---------------------------------------------------------------------------
// A finding records a compliance GAP an assessor or manager has identified —
// it is never created automatically because a control was assessed partially
// compliant or non-compliant. Remediation is tracked as separate actions, with
// an explicit line between RECOMMENDED work, ASSIGNED work, work an
// implementer has COMPLETED and work an independent verifier has VERIFIED.
// Completion never becomes verification on its own.

/** Lifecycle of a finding, from identification to closed (or reopened). */
export const COMPLIANCE_FINDING_STATUSES = [
  "open",
  "in_remediation",
  "awaiting_verification",
  "closed",
] as const;
export type ComplianceFindingStatus =
  (typeof COMPLIANCE_FINDING_STATUSES)[number];

export const COMPLIANCE_FINDING_STATUS_LABELS: Record<
  ComplianceFindingStatus,
  string
> = {
  open: "Open",
  in_remediation: "In remediation",
  awaiting_verification: "Awaiting verification",
  closed: "Closed",
};

export const complianceFindingStatusValidator = v.union(
  ...COMPLIANCE_FINDING_STATUSES.map((s) => v.literal(s)),
);

/** Severity scale (highest first) — matches the audit severity vocabulary. */
export const COMPLIANCE_FINDING_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "informational",
] as const;
export type ComplianceFindingSeverity =
  (typeof COMPLIANCE_FINDING_SEVERITIES)[number];

export const COMPLIANCE_FINDING_SEVERITY_LABELS: Record<
  ComplianceFindingSeverity,
  string
> = {
  critical: "Critical",
  high: "High",
  medium: "Medium",
  low: "Low",
  informational: "Informational",
};

export const complianceFindingSeverityValidator = v.union(
  ...COMPLIANCE_FINDING_SEVERITIES.map((s) => v.literal(s)),
);

/** Ordering rank for severity-first lists (lower is more severe). */
export const COMPLIANCE_FINDING_SEVERITY_RANK: Record<
  ComplianceFindingSeverity,
  number
> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  informational: 4,
};

/**
 * Remediation action lifecycle.
 * assigned → in_progress → completed → verified, with cancellation available
 * while the action is still being worked. `completed` states what the
 * implementer finished; only an independent `verified` transition records that
 * the correction was checked.
 */
export const COMPLIANCE_REMEDIATION_STATUSES = [
  "assigned",
  "in_progress",
  "completed",
  "verified",
  "cancelled",
] as const;
export type ComplianceRemediationStatus =
  (typeof COMPLIANCE_REMEDIATION_STATUSES)[number];

export const COMPLIANCE_REMEDIATION_STATUS_LABELS: Record<
  ComplianceRemediationStatus,
  string
> = {
  assigned: "Assigned",
  in_progress: "In progress",
  completed: "Implementation complete",
  verified: "Independently verified",
  cancelled: "Cancelled",
};

export const complianceRemediationStatusValidator = v.union(
  ...COMPLIANCE_REMEDIATION_STATUSES.map((s) => v.literal(s)),
);

const FINDING_TRANSITIONS: Record<
  ComplianceFindingStatus,
  ComplianceFindingStatus[]
> = {
  open: ["in_remediation", "awaiting_verification", "closed"],
  in_remediation: ["awaiting_verification"],
  awaiting_verification: ["closed", "in_remediation"],
  // Closing is terminal; a closed finding is reopened through an explicit
  // reopen action that preserves the closure in the history.
  closed: ["in_remediation"],
};

export function canTransitionFinding(
  from: ComplianceFindingStatus,
  to: ComplianceFindingStatus,
): boolean {
  return FINDING_TRANSITIONS[from]?.includes(to) ?? false;
}

/** A finding that still needs work. */
export function isOpenFinding(status: ComplianceFindingStatus): boolean {
  return status !== "closed";
}

const REMEDIATION_TRANSITIONS: Record<
  ComplianceRemediationStatus,
  ComplianceRemediationStatus[]
> = {
  assigned: ["in_progress", "completed", "cancelled"],
  in_progress: ["completed", "cancelled"],
  // A failed verification sends the action back to work — the attempt stays in
  // the history and nothing is deleted.
  completed: ["verified", "in_progress"],
  verified: [],
  cancelled: [],
};

export function canTransitionRemediation(
  from: ComplianceRemediationStatus,
  to: ComplianceRemediationStatus,
): boolean {
  return REMEDIATION_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Work an implementer has finished (whether or not it has been verified). */
export function isRemediationComplete(
  status: ComplianceRemediationStatus,
): boolean {
  return status === "completed" || status === "verified";
}

/** Work that no longer needs anything further (verified, or cancelled). */
export function isRemediationResolved(
  status: ComplianceRemediationStatus,
): boolean {
  return status === "verified" || status === "cancelled";
}

/**
 * Overdue: a due date has passed and the action is still unresolved. Verified,
 * cancelled and timestamped-complete work is never reported as overdue.
 */
export function isRemediationOverdue(
  dueDate: number | undefined,
  status: ComplianceRemediationStatus,
  now: number = Date.now(),
): boolean {
  if (dueDate === undefined) return false;
  if (isRemediationComplete(status) || status === "cancelled") return false;
  return dueDate < now;
}

/**
 * Separation of duties for verification: nobody signs off their own work. The
 * verifier must differ from both the action owner and the implementer who
 * recorded completion.
 */
export function canIndependentlyVerify(
  verifierUserId: string,
  parties: { ownerUserId?: string; completedByUserId?: string },
): boolean {
  return (
    verifierUserId !== parties.ownerUserId &&
    verifierUserId !== parties.completedByUserId
  );
}

// Finding limits.
export const FINDING_TITLE_MAX = 200;
export const FINDING_REFERENCE_MAX = 40;
export const FINDING_DESCRIPTION_MIN = 20;
export const FINDING_DESCRIPTION_MAX = 4000;
export const FINDING_TEXT_MAX = 4000;
export const FINDING_GAP_MAX = 2000;
export const FINDING_REQUIREMENT_MAX = 500;
export const FINDING_OWNER_MAX = 160;
/** Minimum documented reason for a closure without verification evidence. */
export const FINDING_EXCEPTION_MIN = 20;
export const FINDING_CLOSURE_NOTES_MAX = 2000;
export const FINDING_REOPEN_REASON_MAX = 1000;
export const REMEDIATION_DESCRIPTION_MIN = 10;
export const REMEDIATION_DESCRIPTION_MAX = 2000;
export const REMEDIATION_REFERENCE_MAX = 40;
export const REMEDIATION_NOTES_MAX = 2000;
export const REMEDIATION_REASON_MAX = 1000;

// ---------------------------------------------------------------------------
// Evidence integrity + classification
// ---------------------------------------------------------------------------

/** Integrity states recorded for a compliance evidence record. */
export const EVIDENCE_INTEGRITY_STATES = [
  "pending",
  "intact",
  "hash_mismatch",
  "blob_missing",
] as const;
export type EvidenceIntegrityState = (typeof EVIDENCE_INTEGRITY_STATES)[number];

export const EVIDENCE_INTEGRITY_LABELS: Record<EvidenceIntegrityState, string> = {
  pending: "Hashing queued",
  intact: "Integrity verified",
  hash_mismatch: "Hash mismatch",
  blob_missing: "File missing",
};

export const evidenceIntegrityValidator = v.union(
  ...EVIDENCE_INTEGRITY_STATES.map((s) => v.literal(s)),
);

/**
 * Classifications for compliance evidence. `restricted` additionally requires
 * the caller to hold compliance.manage, so an ordinary viewer can see that a
 * document exists without being able to download it.
 */
export const COMPLIANCE_EVIDENCE_CLASSIFICATIONS = [
  "public",
  "internal",
  "confidential",
  "restricted",
] as const;
export type ComplianceEvidenceClassification =
  (typeof COMPLIANCE_EVIDENCE_CLASSIFICATIONS)[number];

export const COMPLIANCE_EVIDENCE_CLASSIFICATION_LABELS: Record<
  ComplianceEvidenceClassification,
  string
> = {
  public: "Public",
  internal: "Internal",
  confidential: "Confidential",
  restricted: "Restricted",
};

export const complianceEvidenceClassificationValidator = v.union(
  ...COMPLIANCE_EVIDENCE_CLASSIFICATIONS.map((c) => v.literal(c)),
);

/** Evidence files: same type/size envelope as audit evidence. */
export const COMPLIANCE_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024; // 10 MB
export const COMPLIANCE_EVIDENCE_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/json",
  "application/zip",
] as const;

/** Restricted evidence is only downloadable by a compliance manager. */
export function mayReadRestrictedEvidence(holdsManage: boolean): boolean {
  return holdsManage;
}

// ---------------------------------------------------------------------------
// Length limits — reference data, never blobs
// ---------------------------------------------------------------------------

export const COMPLIANCE_NAME_MAX = 200;
export const COMPLIANCE_IDENTIFIER_MAX = 40;
export const COMPLIANCE_VERSION_MAX = 60;
export const COMPLIANCE_AUTHORITY_MAX = 160;
export const COMPLIANCE_CONTROL_IDENTIFIER_MAX = 60;
export const COMPLIANCE_CONTROL_TITLE_MAX = 200;
export const COMPLIANCE_TEXT_MAX = 4000;
export const COMPLIANCE_SOURCE_REFERENCE_MAX = 300;
export const COMPLIANCE_OWNER_MAX = 120;

// Control testing limits.
export const CONTROL_TEST_TITLE_MAX = 200;
export const CONTROL_TEST_TEXT_MAX = 4000;
export const CONTROL_TEST_PERIOD_MAX = 120;
export const CONTROL_TEST_SAMPLE_MAX = 300;
export const CONTROL_TEST_REFERENCE_MAX = 40;
/** Minimum completion narrative — "adequate completion details". */
export const CONTROL_TEST_COMPLETION_MIN = 20;
/** Minimum length of a documented missing-evidence exception. */
export const CONTROL_TEST_EXCEPTION_MIN = 20;
export const COMPLIANCE_EVIDENCE_FILENAME_MAX = 200;
export const COMPLIANCE_EVIDENCE_DESCRIPTION_MAX = 1000;
export const COMPLIANCE_EVIDENCE_UNLINK_REASON_MAX = 300;

// ---------------------------------------------------------------------------
// Identifier rules
// ---------------------------------------------------------------------------

/**
 * Framework identifier: uppercase letters, digits, dots, dashes, slashes and
 * underscores (e.g. `ISO-27001`, `NIST-CSF`, `DPA-2019`).
 */
export function isValidFrameworkIdentifier(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9._/-]{1,39}$/.test(value);
}

/**
 * Control identifier: the framework's own clause numbering, so dots, dashes
 * and slashes are expected (e.g. `A.5.1`, `ID.AM-1`, `2.1.3`).
 */
export function isValidControlIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,59}$/.test(value);
}

/** Canonicalize a framework identifier for comparison and storage. */
export function normalizeFrameworkIdentifier(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "-");
}

/** Canonicalize a control identifier (case-sensitive clause codes are kept). */
export function normalizeControlIdentifier(value: string): string {
  return value.trim().replace(/\s+/g, "");
}

/** Normalize a human name/label field. */
export function normalizeComplianceName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
