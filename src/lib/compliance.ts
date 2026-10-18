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
