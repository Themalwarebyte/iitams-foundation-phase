import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { roleHasPermission } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  CYBER_ASSET_NAME_MAX,
  CYBER_DESCRIPTION_MAX,
  CYBER_NARRATIVE_MIN,
  CYBER_OWNER_LABEL_MAX,
  CYBER_REFERENCE_MAX,
  CYBER_SEVERITY_LABELS,
  CYBER_SEVERITY_RANK,
  CYBER_TEXT_MAX,
  CYBER_VULNERABILITY_SOURCE_LABELS,
  CYBER_VULNERABILITY_STATUS_LABELS,
  CYBER_ASSESSMENT_STATUS_LABELS,
  CYBER_ASSESSMENT_TYPE_LABELS,
  CYBER_ACTION_STATUS_LABELS,
  isOpenVulnerabilityStatus,
  type CyberSeverity,
} from "../lib/cyber";

/**
 * Cybersecurity Assurance — shared server core (Phase 4A — Batch 1)
 * =================================================================
 * Authorization invariants, shared by every cybersecurity function:
 *
 *  1. Reads require `cyber.view`; writes require `cyber.manage` AND an ACTIVE
 *     membership (`isProvisioned`). Anonymous demo guests therefore only ever
 *     read.
 *  2. The organization ALWAYS comes from the authenticated access context.
 *     No function accepts an organizationId argument.
 *  3. Every referenced id (assessment, vulnerability, remediation action,
 *     evidence, risk, owner) is re-validated against that organization, so a
 *     foreign or guessed id is indistinguishable from a missing one.
 *  4. Audit entries record the ACTOR explicitly and identify the affected
 *     entity separately (entityType/entityId + relatedEntity*), so an action
 *     performed by user A on user B's record never reads as B's own action.
 *  5. Status changes go through the transition tables in src/lib/cyber.ts and
 *     append an immutable `vulnerabilityEvents` row; nothing is hard-deleted.
 */

export interface CyberAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
  canManage: boolean;
}

export async function resolveCyberAccess(
  ctx: QueryCtx | MutationCtx,
): Promise<CyberAccess> {
  const access = await requirePermission(ctx, "cyber.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage:
      access.isProvisioned && roleHasPermission(access.role, "cyber.manage"),
  };
}

export async function requireCyberManager(
  ctx: MutationCtx,
): Promise<CyberAccess> {
  const access = await requirePermission(ctx, "cyber.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage: true,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function requireText(
  value: string,
  field: string,
  max: number,
  min = 1,
): string {
  const cleaned = value.trim().replace(/\s+/g, " ");
  if (cleaned.length < min) {
    throw new Error(`${field} must be at least ${min} characters`);
  }
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

export function requireNarrative(
  value: string,
  field: string,
  max: number,
  min = CYBER_NARRATIVE_MIN,
): string {
  const cleaned = value.trim();
  if (cleaned.length < min) {
    throw new Error(`${field} must be at least ${min} characters`);
  }
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

export function optionalText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

export function optionalDate(value: number | undefined, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${field} must be a valid date`);
  return Math.floor(value);
}

/** The assessment addressed by an id, re-validated against the organization. */
export async function requireOwnedAssessment(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  assessmentId: Id<"securityAssessments">,
): Promise<Doc<"securityAssessments">> {
  const assessment = await ctx.db.get(assessmentId);
  if (!assessment || assessment.organizationId !== organizationId) {
    throw new Error("Cybersecurity assessment not found in your organization");
  }
  return assessment;
}

export async function requireOwnedVulnerability(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  vulnerabilityId: Id<"vulnerabilities">,
): Promise<Doc<"vulnerabilities">> {
  const vulnerability = await ctx.db.get(vulnerabilityId);
  if (!vulnerability || vulnerability.organizationId !== organizationId) {
    throw new Error("Vulnerability not found in your organization");
  }
  return vulnerability;
}

export async function requireOwnedAction(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  actionId: Id<"vulnerabilityRemediationActions">,
): Promise<Doc<"vulnerabilityRemediationActions">> {
  const action = await ctx.db.get(actionId);
  if (!action || action.organizationId !== organizationId) {
    throw new Error("Remediation action not found in your organization");
  }
  return action;
}

/** A named owner must be an ACTIVE member of the same organization. */
export async function resolveMemberLabel(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users"> | undefined,
  fallbackLabel: string,
  field: string,
): Promise<string> {
  if (userId === undefined) return fallbackLabel;
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .unique();
  if (
    !profile ||
    profile.organizationId !== organizationId ||
    effectiveMembershipStatus(profile.membershipStatus) !== "active"
  ) {
    throw new Error(`${field} is not an active member of your organization`);
  }
  const user = await ctx.db.get(userId);
  return user?.name ?? user?.email ?? fallbackLabel;
}

/** Evidence ids must exist in this organization (and match the subject). */
export async function validateEvidenceIds(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  vulnerabilityId: Id<"vulnerabilities"> | undefined,
  evidenceIds: Id<"cyberEvidence">[] | undefined,
): Promise<Id<"cyberEvidence">[]> {
  if (!evidenceIds || evidenceIds.length === 0) return [];
  const unique = [...new Set(evidenceIds.map(String))] as Id<"cyberEvidence">[];
  for (const evidenceId of unique) {
    const record = await ctx.db.get(evidenceId);
    if (!record || record.organizationId !== organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (
      vulnerabilityId !== undefined &&
      record.vulnerabilityId !== undefined &&
      record.vulnerabilityId !== vulnerabilityId
    ) {
      throw new Error(
        "Evidence can only be referenced when it belongs to this vulnerability and organization",
      );
    }
  }
  return unique;
}

/** Per-organization reference sequence (CSA-001, VUL-001, VRA-001). */
export async function nextReference(
  ctx: MutationCtx,
  table:
    | "securityAssessments"
    | "vulnerabilities"
    | "vulnerabilityRemediationActions",
  organizationId: Id<"organizations">,
  prefix: string,
): Promise<string> {
  const limit = 1000;
  let rows: Array<{ reference?: string }> = [];
  if (table === "securityAssessments") {
    rows = await ctx.db
      .query("securityAssessments")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(limit);
  } else if (table === "vulnerabilities") {
    rows = await ctx.db
      .query("vulnerabilities")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(limit);
  } else {
    rows = await ctx.db
      .query("vulnerabilityRemediationActions")
      .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
      .take(limit);
  }
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  let highest = 0;
  for (const row of rows) {
    const match = row.reference ? pattern.exec(row.reference) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return `${prefix}-${String(highest + 1).padStart(3, "0")}`;
}

// ---------------------------------------------------------------------------
// Append-only history + audit
// ---------------------------------------------------------------------------

export async function appendCyberEvent(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    vulnerabilityId?: Id<"vulnerabilities">;
    assessmentId?: Id<"securityAssessments">;
    actionId?: Id<"vulnerabilityRemediationActions">;
    type: string;
    fromStatus?: string;
    toStatus?: string;
    actorUserId: Id<"users">;
    actorLabel: string;
    summary: string;
    reason?: string;
  },
): Promise<void> {
  await ctx.db.insert("vulnerabilityEvents", {
    organizationId: input.organizationId,
    vulnerabilityId: input.vulnerabilityId,
    assessmentId: input.assessmentId,
    actionId: input.actionId,
    type: input.type,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    actorUserId: input.actorUserId,
    actorLabel: input.actorLabel,
    summary: input.summary,
    reason: input.reason,
    createdAt: Date.now(),
  });
}

/**
 * Audit entry for a cybersecurity mutation: the ACTOR is explicit and the
 * affected entity is identified separately from any related record.
 */
export async function logCyberAudit(
  ctx: MutationCtx,
  access: CyberAccess,
  input: {
    action: string;
    entityType: string;
    entityId: string;
    relatedEntityType?: string;
    relatedEntityId?: string;
    summary: string;
  },
): Promise<void> {
  await logAudit(ctx, {
    organizationId: access.organizationId,
    userId: access.userId,
    actorId: access.userId,
    actorLabel: access.label,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    relatedEntityType: input.relatedEntityType,
    relatedEntityId: input.relatedEntityId,
    summary: input.summary,
  });
}

// ---------------------------------------------------------------------------
// Presenters
// ---------------------------------------------------------------------------

export type SeverityCounts = Record<CyberSeverity, number>;

export function emptySeverityCounts(): SeverityCounts {
  return {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    informational: 0,
  };
}

export function countBySeverity(
  rows: Array<{ severity: CyberSeverity }>,
): SeverityCounts {
  const counts = emptySeverityCounts();
  for (const row of rows) counts[row.severity] += 1;
  return counts;
}

export type ActionRollup = {
  total: number;
  outstanding: number;
  mandatoryOutstanding: number;
  completedUnverified: number;
  verified: number;
  cancelled: number;
  overdue: number;
};

export function rollupActions(
  actions: Doc<"vulnerabilityRemediationActions">[],
  now: number,
): ActionRollup {
  const rollup: ActionRollup = {
    total: actions.length,
    outstanding: 0,
    mandatoryOutstanding: 0,
    completedUnverified: 0,
    verified: 0,
    cancelled: 0,
    overdue: 0,
  };
  for (const action of actions) {
    if (action.status === "open" || action.status === "in_progress") {
      rollup.outstanding += 1;
      if (action.mandatory) rollup.mandatoryOutstanding += 1;
      if (action.dueDate !== undefined && action.dueDate < now) {
        rollup.overdue += 1;
      }
    }
    if (action.status === "completed") {
      rollup.completedUnverified += 1;
      if (action.dueDate !== undefined && action.dueDate < now) {
        rollup.overdue += 1;
      }
    }
    if (action.status === "verified" || action.status === "closed") {
      rollup.verified += 1;
    }
    if (action.status === "cancelled") rollup.cancelled += 1;
  }
  return rollup;
}

export function presentAction(
  action: Doc<"vulnerabilityRemediationActions">,
  now: number,
) {
  const overdue =
    action.dueDate !== undefined &&
    action.dueDate < now &&
    action.status !== "verified" &&
    action.status !== "closed" &&
    action.status !== "cancelled";
  return {
    _id: action._id,
    vulnerabilityId: action.vulnerabilityId,
    reference: action.reference,
    description: action.description,
    ownerUserId: action.ownerUserId ?? null,
    ownerLabel: action.ownerLabel,
    dueDate: action.dueDate ?? null,
    mandatory: action.mandatory,
    status: action.status,
    statusLabel: CYBER_ACTION_STATUS_LABELS[action.status],
    progressNotes: action.progressNotes ?? null,
    evidenceIds: action.evidenceIds.map(String),
    startedAt: action.startedAt ?? null,
    completedAt: action.completedAt ?? null,
    completedByUserId: action.completedByUserId ?? null,
    completedByLabel: action.completedByLabel ?? null,
    completionNotes: action.completionNotes ?? null,
    verifiedAt: action.verifiedAt ?? null,
    verifiedByUserId: action.verifiedByUserId ?? null,
    verifiedByLabel: action.verifiedByLabel ?? null,
    verificationNotes: action.verificationNotes ?? null,
    cancelledAt: action.cancelledAt ?? null,
    cancelledByLabel: action.cancelledByLabel ?? null,
    cancelReason: action.cancelReason ?? null,
    overdue,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
  };
}

export function presentAssessment(
  assessment: Doc<"securityAssessments">,
  derived: {
    vulnerabilities: Doc<"vulnerabilities">[];
    now: number;
  },
) {
  const counts = countBySeverity(derived.vulnerabilities);
  const openVulnerabilities = derived.vulnerabilities.filter((row) =>
    isOpenVulnerabilityStatus(row.status),
  ).length;
  const overdueVulnerabilities = derived.vulnerabilities.filter(
    (row) =>
      isOpenVulnerabilityStatus(row.status) &&
      row.remediationDue !== undefined &&
      row.remediationDue < derived.now,
  ).length;
  return {
    _id: assessment._id,
    reference: assessment.reference ?? null,
    name: assessment.name,
    type: assessment.type,
    typeLabel: CYBER_ASSESSMENT_TYPE_LABELS[assessment.type],
    status: assessment.status,
    statusLabel: CYBER_ASSESSMENT_STATUS_LABELS[assessment.status],
    description: assessment.description ?? null,
    scope: assessment.scope ?? null,
    objectives: assessment.objectives ?? null,
    relatedAssetOrService: assessment.relatedAssetOrService ?? null,
    ownerUserId: assessment.ownerUserId ?? null,
    ownerLabel: assessment.ownerLabel ?? null,
    plannedStartAt: assessment.plannedStartAt ?? null,
    plannedEndAt: assessment.plannedEndAt ?? null,
    startedAt: assessment.startedAt ?? null,
    startedByLabel: assessment.startedByLabel ?? null,
    completedAt: assessment.completedAt ?? null,
    completedByLabel: assessment.completedByLabel ?? null,
    outcomeSummary: assessment.outcomeSummary ?? null,
    cancelledAt: assessment.cancelledAt ?? null,
    cancelledByLabel: assessment.cancelledByLabel ?? null,
    cancelReason: assessment.cancelReason ?? null,
    // DERIVED, never stored: the assessment row carries no finding counters.
    vulnerabilityCount: derived.vulnerabilities.length,
    openVulnerabilityCount: openVulnerabilities,
    overdueVulnerabilityCount: overdueVulnerabilities,
    severityCounts: counts,
    criticalCount: counts.critical,
    highCount: counts.high,
    mediumCount: counts.medium,
    lowCount: counts.low,
    informationalCount: counts.informational,
    createdAt: assessment.createdAt,
    updatedAt: assessment.updatedAt,
  };
}

export function presentVulnerability(
  vulnerability: Doc<"vulnerabilities">,
  input: {
    actions: Doc<"vulnerabilityRemediationActions">[];
    now: number;
  },
) {
  const overdue =
    vulnerability.remediationDue !== undefined &&
    vulnerability.remediationDue < input.now &&
    isOpenVulnerabilityStatus(vulnerability.status);
  return {
    _id: vulnerability._id,
    reference: vulnerability.reference ?? null,
    title: vulnerability.title,
    description: vulnerability.description ?? null,
    assetName: vulnerability.assetName,
    cveId: vulnerability.cveId ?? null,
    severity: vulnerability.severity,
    severityLabel: CYBER_SEVERITY_LABELS[vulnerability.severity],
    severityRank: CYBER_SEVERITY_RANK[vulnerability.severity],
    cvssScore: vulnerability.cvssScore ?? null,
    cvssVector: vulnerability.cvssVector ?? null,
    source: vulnerability.source ?? null,
    sourceLabel: vulnerability.source
      ? CYBER_VULNERABILITY_SOURCE_LABELS[vulnerability.source]
      : null,
    status: vulnerability.status,
    statusLabel: CYBER_VULNERABILITY_STATUS_LABELS[vulnerability.status],
    open: isOpenVulnerabilityStatus(vulnerability.status),
    discoveredAt: vulnerability.discoveredAt,
    remediationDue: vulnerability.remediationDue ?? null,
    assessmentId: vulnerability.assessmentId ?? null,
    ownerUserId: vulnerability.ownerUserId ?? null,
    ownerLabel: vulnerability.ownerLabel ?? null,
    remediationNotes: vulnerability.remediationNotes ?? null,
    riskId: vulnerability.riskId ?? null,
    remediatedAt: vulnerability.remediatedAt ?? null,
    remediatedByUserId: vulnerability.remediatedByUserId ?? null,
    remediatedByLabel: vulnerability.remediatedByLabel ?? null,
    verifiedAt: vulnerability.verifiedAt ?? null,
    verifiedByUserId: vulnerability.verifiedByUserId ?? null,
    verifiedByLabel: vulnerability.verifiedByLabel ?? null,
    verificationNotes: vulnerability.verificationNotes ?? null,
    closedAt: vulnerability.closedAt ?? null,
    closureReason: vulnerability.closureReason ?? null,
    overdue,
    actions: rollupActions(input.actions, input.now),
    createdAt: vulnerability.createdAt,
    updatedAt: vulnerability.updatedAt,
  };
}

export function presentEvent(event: Doc<"vulnerabilityEvents">) {
  return {
    _id: event._id,
    type: event.type,
    fromStatus: event.fromStatus ?? null,
    toStatus: event.toStatus ?? null,
    actorUserId: event.actorUserId,
    actorLabel: event.actorLabel,
    summary: event.summary,
    reason: event.reason ?? null,
    createdAt: event.createdAt,
  };
}

export function presentCyberEvidence(row: Doc<"cyberEvidence">) {
  return {
    _id: row._id,
    filename: row.filename,
    fileType: row.fileType,
    sizeBytes: row.sizeBytes,
    classification: row.classification,
    description: row.description ?? null,
    source: row.source ?? null,
    sha256: row.sha256,
    integrity: row.integrity,
    integrityCheckedAt: row.integrityCheckedAt ?? null,
    vulnerabilityId: row.vulnerabilityId ?? null,
    assessmentId: row.assessmentId ?? null,
    uploadedById: row.uploadedById,
    uploadedByLabel: row.uploadedByLabel,
    createdAt: row.createdAt,
  };
}

/** Longest text a free-text field may carry in the UI. */
export const CYBER_TEXT_LIMIT = CYBER_TEXT_MAX;
export const CYBER_ASSET_LIMIT = CYBER_ASSET_NAME_MAX;
export const CYBER_DESCRIPTION_LIMIT = CYBER_DESCRIPTION_MAX;
export const CYBER_REFERENCE_LIMIT = CYBER_REFERENCE_MAX;
export const CYBER_OWNER_LIMIT = CYBER_OWNER_LABEL_MAX;
