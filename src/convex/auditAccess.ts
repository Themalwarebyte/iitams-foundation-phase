import { v } from "convex/values";
import type { QueryCtx, MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  resolveAccess,
  roleHasPermission,
  type AccessContext,
  type IitamsPermission,
} from "./access";
import type { AuditTeamRole } from "../lib/auditWorkflow";

/**
 * Server-side authorization core for the Phase-2 audit engine.
 * ============================================================
 * Every audit mutation MUST obtain its authority through one of the
 * `require*` helpers here, which all fail closed:
 *
 *   - requireAccess(ctx, permission)   → module-level RBAC
 *   - requireEngagementAccess(ctx, …)  → module RBAC + tenant match +
 *                                        engagement-team assignment
 *
 * Rules encoded (Module 4): only assigned users can perform engagement
 * activities; audit_manager/audit_director (and platform `admin`) hold
 * engagement-wide authority; tenant isolation is re-checked on every call
 * even when an id was guessed from another organization.
 */

/** Roles that carry engagement-wide (manager-level) authority. */
const ENGAGEMENT_WIDE_ROLES: readonly AuditTeamRole[] = [
  "audit_manager",
  "audit_director",
];

/** Platform roles that bypass assignment checks (still tenant-scoped). */
const PLATFORM_PRIVILEGED = new Set(["admin"]);

export interface EngagementAccess {
  access: AccessContext;
  engagement: Doc<"auditEngagements">;
  /** Caller's team assignment on this engagement (null = unassigned). */
  assignment: Doc<"auditAssignments"> | null;
  teamRole: AuditTeamRole | undefined;
  /** Any assignment → may participate in engagement work. */
  canWork: boolean;
  /** Manager-level authority (audit_manager/director/admin). */
  isManagerLike: boolean;
  /** May create/edit structural artefacts (programs, findings, team). */
  canManageStructure: boolean;
}

/** Resolve the caller; throw (fail closed) when unauthenticated. */
export async function requireUser(
  ctx: QueryCtx | MutationCtx,
): Promise<AccessContext> {
  const access = await resolveAccess(ctx);
  if (!access.user) throw new Error("Not authenticated");
  return access;
}

/** Require a module-level permission; throws when the role denies it. */
export async function requirePermission(
  ctx: QueryCtx | MutationCtx,
  permission: IitamsPermission,
): Promise<AccessContext> {
  const access = await requireUser(ctx);
  if (!roleHasPermission(access.role, permission)) {
    throw new Error(`Permission denied: ${permission}`);
  }
  return access;
}

/**
 * Full engagement-level authorization: module permission + same-organization
 * tenancy + team assignment (managers/directors and platform admins excepted).
 */
export async function requireEngagementAccess(
  ctx: QueryCtx | MutationCtx,
  engagementId: Id<"auditEngagements">,
  permission: IitamsPermission = "audit.view",
): Promise<EngagementAccess> {
  const access = await requirePermission(ctx, permission);
  if (!access.organizationId) throw new Error("No organization context");

  const engagement = await ctx.db.get(engagementId);
  // Tenant isolation: a valid id from another organization is invisible.
  if (!engagement || engagement.organizationId !== access.organizationId) {
    throw new Error("Engagement not found");
  }

  const assignment = await ctx.db
    .query("auditAssignments")
    .withIndex("by_engagement", (q) => q.eq("engagementId", engagementId))
    .filter((q) => q.eq(q.field("userId"), access.user!._id))
    .first();

  const platformPrivileged =
    access.role !== undefined && PLATFORM_PRIVILEGED.has(access.role);
  const teamRole = assignment?.teamRole;
  const isManagerLike =
    platformPrivileged ||
    (teamRole !== undefined && ENGAGEMENT_WIDE_ROLES.includes(teamRole));
  const canWork = platformPrivileged || teamRole !== undefined;

  return {
    access,
    engagement,
    assignment,
    teamRole,
    canWork,
    isManagerLike,
    canManageStructure: isManagerLike,
  };
}

/** Assert the caller holds one of the given team roles on the engagement. */
export function requireTeamRole(
  ea: EngagementAccess,
  roles: readonly AuditTeamRole[],
  action: string,
): void {
  if (ea.isManagerLike) return; // managers/directors/admin may act as any role
  if (!ea.teamRole || !roles.includes(ea.teamRole)) {
    throw new Error(`Not authorized to ${action} on this engagement`);
  }
}

// ---------------------------------------------------------------------------
// Audit log + notification helpers (append-only logging; Module 12 events)
// ---------------------------------------------------------------------------

/** Append an entry to the immutable audit log (insert-only by design). */
export async function logAudit(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations"> | undefined;
    userId: Id<"users"> | undefined;
    actorLabel?: string;
    action: string;
    entityType: string;
    entityId?: string;
    summary?: string;
  },
): Promise<void> {
  await ctx.db.insert("auditLogs", {
    organizationId: input.organizationId,
    userId: input.userId,
    actorLabel: input.actorLabel,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    summary: input.summary,
    createdAt: Date.now(),
  });
}

/** Raise an in-app notification (Module 12). Never throws on missing user. */
export async function notify(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    userId?: Id<"users">;
    title: string;
    body?: string;
    severity?: "info" | "success" | "warning" | "critical";
    href?: string;
  },
): Promise<void> {
  await ctx.db.insert("notifications", {
    organizationId: input.organizationId,
    userId: input.userId,
    title: input.title,
    body: input.body,
    severity: input.severity ?? "info",
    href: input.href,
    createdAt: Date.now(),
  });
}

/** Lookup a user's display label (name → email → "User"). */
export async function userLabel(
  ctx: QueryCtx | MutationCtx,
  userId: Id<"users"> | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  const u = await ctx.db.get(userId);
  return u?.name ?? u?.email ?? undefined;
}

/** Standard validation fragment for organisation-scoped lists. */
export const orgArgs = v.object({});

/** Human-readable engagement number generator: ENG-YYYY-NNN. */
export function formatEngagementCode(
  fiscalYear: number,
  sequence: number,
): string {
  return `ENG-${fiscalYear}-${String(sequence).padStart(3, "0")}`;
}
