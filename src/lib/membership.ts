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
