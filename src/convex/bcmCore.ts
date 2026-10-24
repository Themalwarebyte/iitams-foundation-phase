import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { roleHasPermission } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  BCM_NARRATIVE_MIN,
  BCM_TEXT_MAX,
  BCM_TITLE_MAX,
  BCM_TITLE_MIN,
} from "../lib/bcm";

/**
 * Business Continuity — shared server core (Phase 4A — Batch 4.1)
 * ==============================================================
 * The same invariants as the other IITAMS modules:
 *
 *  1. Reads require `bcm.view`; writes require `bcm.manage` AND an active
 *     membership, so a demo guest never changes a continuity record.
 *  2. The organization ALWAYS comes from the access context; no function takes
 *     an organizationId argument.
 *  3. Owners, services and BIA ids are re-validated against that organization,
 *     making a foreign id indistinguishable from a missing one.
 *  4. Every transition appends an immutable `continuityEvents` row and writes an
 *     audit entry that separates the ACTOR from the affected entity.
 *  5. Nothing here scores resilience: a reviewed BIA is an analysis, not a
 *     tested continuity or disaster-recovery plan.
 */

export interface BcmAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
  canManage: boolean;
}

export async function resolveBcmAccess(
  ctx: QueryCtx | MutationCtx,
): Promise<BcmAccess> {
  const access = await requirePermission(ctx, "bcm.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
    canManage:
      access.isProvisioned && roleHasPermission(access.role, "bcm.manage"),
  };
}

export async function requireBcmManager(ctx: MutationCtx): Promise<BcmAccess> {
  const access = await requirePermission(ctx, "bcm.manage");
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
  max = BCM_TEXT_MAX,
  min = BCM_NARRATIVE_MIN,
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
  max = BCM_TEXT_MAX,
): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

export function requireDate(value: number | undefined, field: string): number {
  if (value === undefined || !Number.isFinite(value)) {
    throw new Error(`${field} must be a valid date`);
  }
  return Math.floor(value);
}

export function optionalDateNumber(
  value: number | undefined,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${field} must be a valid date`);
  return Math.floor(value);
}

export function requireTitle(value: string, field: string): string {
  return requireText(value, field, BCM_TITLE_MAX, BCM_TITLE_MIN);
}

/**
 * A user referenced as an owner must be an active member of the caller's
 * organization. Returns the label stored alongside the id, so history keeps the
 * name the owner had when the record was written.
 */
export async function requireActiveMember(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  userId: Id<"users">,
  field: string,
): Promise<string> {
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
  return user?.name ?? user?.email ?? "Member";
}

export async function requireOwnedService(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  serviceId: Id<"businessServices">,
): Promise<Doc<"businessServices">> {
  const row = await ctx.db.get(serviceId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Business service not found in your organization");
  }
  return row;
}

export async function requireOwnedBia(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  biaId: Id<"businessImpactAnalyses">,
): Promise<Doc<"businessImpactAnalyses">> {
  const row = await ctx.db.get(biaId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Business impact analysis not found in your organization");
  }
  return row;
}

export async function requireOwnedPlan(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  planId: Id<"continuityPlans">,
): Promise<Doc<"continuityPlans">> {
  const row = await ctx.db.get(planId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Continuity plan not found in your organization");
  }
  return row;
}

export async function requireOwnedStrategy(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  strategyId: Id<"recoveryStrategies">,
): Promise<Doc<"recoveryStrategies">> {
  const row = await ctx.db.get(strategyId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Recovery strategy not found in your organization");
  }
  return row;
}

export async function requireOwnedGap(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  gapId: Id<"recoveryGaps">,
): Promise<Doc<"recoveryGaps">> {
  const row = await ctx.db.get(gapId);
  if (!row || row.organizationId !== organizationId) {
    throw new Error("Recovery gap not found in your organization");
  }
  return row;
}

/**
 * Per-organization reference sequence (BS-001, BIA-001).
 *
 * The existing rows give the high-water mark (so an import or seeded record is
 * never overwritten), while the counter document is READ AND PATCHED in the
 * same mutation. Two concurrent registrations therefore conflict on that shared
 * document and Convex retries one of them, so the same reference can never be
 * handed out twice.
 */
export async function nextBcmReference(
  ctx: MutationCtx,
  table:
    | "businessServices"
    | "businessImpactAnalyses"
    | "continuityPlans"
    | "recoveryStrategies"
    | "recoveryGaps"
    | "recoveryExercises"
    | "recoveryExerciseFindings",
  organizationId: Id<"organizations">,
  prefix: string,
): Promise<string> {
  const rows = await ctx.db
    .query(table)
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .take(2000);
  const pattern = new RegExp(`^${prefix}-(\\d+)$`);
  const references = new Set<string>();
  let highest = 0;
  for (const row of rows) {
    references.add(row.reference);
    const match = row.reference ? pattern.exec(row.reference) : null;
    if (match) highest = Math.max(highest, Number(match[1]));
  }

  const counter = await ctx.db
    .query("bcmReferenceCounters")
    .withIndex("by_organization_prefix", (q) =>
      q.eq("organizationId", organizationId).eq("prefix", prefix),
    )
    .unique();

  let value = Math.max(highest, counter?.value ?? 0) + 1;
  let reference = `${prefix}-${String(value).padStart(3, "0")}`;
  while (references.has(reference)) {
    value += 1;
    reference = `${prefix}-${String(value).padStart(3, "0")}`;
  }

  if (counter) {
    await ctx.db.patch(counter._id, { value });
  } else {
    await ctx.db.insert("bcmReferenceCounters", {
      organizationId,
      prefix,
      value,
    });
  }
  return reference;
}

export async function appendContinuityEvent(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    serviceId?: Id<"businessServices">;
    biaId?: Id<"businessImpactAnalyses">;
    planId?: Id<"continuityPlans">;
    strategyId?: Id<"recoveryStrategies">;
    gapId?: Id<"recoveryGaps">;
    exerciseId?: Id<"recoveryExercises">;
    findingId?: Id<"recoveryExerciseFindings">;
    type: string;
    fromStatus?: string;
    toStatus?: string;
    actorUserId: Id<"users">;
    actorLabel: string;
    summary: string;
    reason?: string;
  },
): Promise<void> {
  await ctx.db.insert("continuityEvents", {
    organizationId: input.organizationId,
    serviceId: input.serviceId,
    biaId: input.biaId,
    planId: input.planId,
    strategyId: input.strategyId,
    gapId: input.gapId,
    exerciseId: input.exerciseId,
    findingId: input.findingId,
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

export async function logBcmAudit(
  ctx: MutationCtx,
  access: BcmAccess,
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
