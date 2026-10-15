/**
 * Organization membership lifecycle domain model (Phase 3A — Batch 2A).
 * =============================================================
 * The security boundary is the ORGANIZATION MEMBERSHIP (the userProfiles
 * row with its organizationId), never a global user status. A suspended or
 * deactivated membership denies all organization access server-side
 * (src/convex/access.ts resolveAccess), regardless of the member's role.
 *
 *   active       — member can access the organization normally
 *   suspended    — temporary administrative hold (recoverable)
 *   deactivated  — membership administratively ended (recoverable only
 *                  by explicit administrator reactivation; no data is deleted)
 *
 * Absent/legacy rows (no field) resolve to "active" so existing profiles
 * keep their access without a data migration.
 */

export const MEMBERSHIP_STATUSES = ["active", "suspended", "deactivated"] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Legacy/missing field → active (backward compatible, no data migration). */
export function effectiveMembershipStatus(
  raw: MembershipStatus | undefined,
): MembershipStatus {
  return raw ?? "active";
}

/** Human labels used in tables and audit summaries. */
export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  active: "Active",
  suspended: "Suspended",
  deactivated: "Deactivated",
};

/**
 * Allowed administrative transitions. The machine forbids no-op writes and
 * moves between suspensions only through reactivation semantics that remain
 * auditable and reversible by an administrator:
 *
 *   active       → suspended | deactivated
 *   suspended    → active     | deactivated
 *   deactivated  → active
 */
const ALLOWED_TRANSITIONS: Record<MembershipStatus, MembershipStatus[]> = {
  active: ["suspended", "deactivated"],
  suspended: ["active", "deactivated"],
  deactivated: ["active"],
};

export function canChangeMembershipStatus(
  from: MembershipStatus,
  to: MembershipStatus,
): boolean {
  if (from === to) return false; // no-op writes are rejected, not audited
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

/** Requirement text for the last-active-administrator invariant. */
export function lastAdminGuardMessage(): string {
  return "Cannot suspend or deactivate the organization's last active administrator";
}

// ---------------------------------------------------------------------------
// Phase 3A — Batch 2B: initial role assignment for member provisioning
// ---------------------------------------------------------------------------

/**
 * Roles an administrator may pick when PROVISIONING a member (Batch 2B).
 *
 * Eligibility policy (server-enforced, this list is the single source):
 *  - the privileged platform `admin` role is EXCLUDED — creating another
 *    administrator is a separately controlled, audited workflow in a later
 *    batch, never the ordinary provisioning form;
 *  - every other registered platform / audit-workflow role is a supported
 *    initial role
 *    (platform: user, member · audit: director, manager, auditor,
 *    reviewer, management user, executive viewer).
 */
export const PROVISIONABLE_INITIAL_ROLES = [
  "user",
  "member",
  "audit_director",
  "audit_manager",
  "auditor",
  "audit_reviewer",
  "management_user",
  "executive_viewer",
] as const;
export type ProvisionableInitialRole = (typeof PROVISIONABLE_INITIAL_ROLES)[number];

/** Human labels for the initial-role picker (loads the same wording as the directory). */
export const INITIAL_ROLE_LABELS: Record<ProvisionableInitialRole, string> = {
  user: "Assurance User",
  member: "Member",
  audit_director: "Audit Director",
  audit_manager: "Audit Manager",
  auditor: "Auditor",
  audit_reviewer: "Audit Reviewer",
  management_user: "Management User",
  executive_viewer: "Executive Viewer",
};

/**
 * Server-side validation of an administrator-selected initial role. The role
 * registry itself stays in src/convex/access.ts; this only gates which of the
 * registered roles the ordinary provisioning form may assign.
 */
export function isProvisionableInitialRole(
  role: string,
): role is ProvisionableInitialRole {
  return (PROVISIONABLE_INITIAL_ROLES as readonly string[]).includes(role);
}

/** Uniform, safe refusal for provisioning eligibility failures. Deliberately
 * does NOT reveal whether the address belongs to another organization. */
export function provisioningSafeRefusal(): string {
  return "This email is not eligible for provisioning into your organization";
}
