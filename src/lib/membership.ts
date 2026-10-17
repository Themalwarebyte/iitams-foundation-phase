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
/**
 * Maximum rows the organization directory returns in one call. Bounded on
 * purpose: a full-directory read plus one identity lookup per row exceeds
 * Convex's per-function read budget in large (demo) organizations.
 */
export const DIRECTORY_ROW_LIMIT = 300;

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

// ---------------------------------------------------------------------------
// Phase 3A — Batch A1: administrator lifecycle
// ---------------------------------------------------------------------------

/** Administrator-grant confirmation window. After expiry the grant can never
 * elevate (server-side refusal) — only a fresh request can. */
export const ADMIN_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Display label for the canonical privileged role (`admin` in the registry). */
export const ADMIN_ROLE_LABEL = "Platform Administrator";

// ---------------------------------------------------------------------------
// Phase 3A — Batch 2C: secure organization invitations and onboarding
// ---------------------------------------------------------------------------

/** Canonical normalization for invitation/acceptance email addresses.
 * Convex Auth stores identifiers lower-cased (see admin.provisionMember) —
 * invitations use exactly the same canonical form so the verified email
 * must match the invited address exactly (no display-case games). */
export function normalizeInvitationEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Syntactic email validation used before any write (server re-validates). */
export function isValidInvitationEmail(email: string): boolean {
  const e = normalizeInvitationEmail(email);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);
}

/** Invitation lifecycle states (order matters only for UX display). */
export const INVITATION_STATUSES = [
  "pending_delivery",
  "pending",
  "delivery_failed",
  "accepted",
  "revoked",
  "expired",
] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Human labels for the administration tables / status chips. */
export const INVITATION_STATUS_LABELS: Record<InvitationStatus, string> = {
  pending_delivery: "Pending delivery",
  pending: "Pending",
  delivery_failed: "Delivery failed",
  accepted: "Accepted",
  revoked: "Revoked",
  expired: "Expired",
};

/** Statuses from which a fresh secret may be issued (resend/reissue). */
export function isReissueable(status: InvitationStatus): boolean {
  return status === "pending" || status === "delivery_failed" || status === "pending_delivery";
}

/** A still-actionable invitation (the acceptance flow refuses everything else). */
export function isAcceptableInviteStatus(
  status: InvitationStatus,
): boolean {
  return status === "pending";
}

/** Default/TTL bounds for invitation validity. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (default)
export const INVITATION_TTL_MAX_MS = 14 * 24 * 60 * 60 * 1000; // hard cap: 14 days
/** Cooldown between resend/reissue operations (anti-flooding). */
export const INVITATION_RESEND_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
/** Max actionable invitations (pending/failed) one administrator may hold open
 * against distinct emails per rolling window — reasonable anti-flooding cap. */
export const MAX_ACTIVE_INVITATIONS_PER_ORG = 100;
/** Max invitations for the same email per rolling window, including failures. */
export const MAX_INVITATIONS_PER_EMAIL_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MAX_INVITATIONS_PER_EMAIL_WINDOW_COUNT = 3;

/** Uniform decline message for the recipient-facing acceptance flow. It
 * deliberately does not distinguish invalid/expired/revoked/accepted tokens
 * so a guessing adversary learns nothing from probing links. */
export function invitationSafeRefusal(): string {
  return "This invitation is invalid, expired or already used";
}
