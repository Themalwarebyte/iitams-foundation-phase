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
