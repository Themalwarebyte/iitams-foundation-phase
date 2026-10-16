import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import type { ProvisionableInitialRole } from "../lib/membership";

/**
 * Phase 3A — Batch 2C: shared membership-write core.
 * ===========================================================================
 * ONE structured helper for assigning an initial organization role to a
 * verified user account — used by BOTH
 *   - admin.provisionMember (administrator-driven, Batch 2B), and
 *   - invitations.acceptInvitation (verified-invitation-driven, Batch 2C).
 * Keeping the profile-write rules in one place guarantees that invitation
 * acceptance can never drift from the authorized administrator provisioning
 * semantics (same one-profile-per-user invariant, same unassigned-profile
 * completion, same uniform conflict refusals — no parallel membership
 * system, no silent transfers).
 *
 * Invariants enforced here:
 *  - a user with ANY organization membership (this or another organization,
 *    active/suspended/deactivated) is refused — the membership with its
 *    lifecycle status is the boundary, so suspension cannot be bypassed;
 *  - an unassigned profile that already carries a role is refused for
 *    review instead of being silently overwritten;
 *  - an existing UNASSIGNED profile with no role is completed in place
 *    (never a second profile row — userId holds a unique index);
 *  - global auth-owned user fields are never modified.
 *
 * The refusal message is caller-supplied so each flow keeps its own safe,
 * flow-appropriate wording (provisioning's never discloses cross-org state;
 * acceptance's blocks duplicates and conflicts uniformly).
 */
export async function applyInitialMembership(
  ctx: MutationCtx,
  input: {
    user: Doc<"users">;
    organizationId: Id<"organizations">;
    initialRole: ProvisionableInitialRole;
    jobTitle?: string;
    /** Acceptance flow preserves a manually-entered existing job title. */
    preserveExistingJobTitle: boolean;
    /** Flow-appropriate uniform refusal thrown on membership conflicts. */
    conflictRefusal: () => string;
  },
): Promise<Id<"userProfiles">> {
  const profile = await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", input.user._id))
    .unique();

  if (profile && profile.organizationId) {
    // Belongs to this or another organization — uniformly refused. Also
    // covers suspended/deactivated members (provisioning is never a route
    // around membership lifecycle restrictions).
    throw new Error(input.conflictRefusal());
  }
  if (profile && profile.role !== undefined) {
    // Unassigned profile that already carries a role: non-obvious state —
    // refuse for review instead of silently overwriting.
    throw new Error(input.conflictRefusal());
  }

  const jobTitle = input.jobTitle !== undefined
    ? (input.preserveExistingJobTitle && profile?.jobTitle
      ? profile.jobTitle
      : input.jobTitle)
    : undefined;

  if (profile) {
    // Existing unassigned profile: complete it in place (no duplicate).
    await ctx.db.patch(profile._id, {
      organizationId: input.organizationId,
      role: input.initialRole,
      ...(jobTitle !== undefined ? { jobTitle } : {}),
    });
    return profile._id;
  }

  return await ctx.db.insert("userProfiles", {
    userId: input.user._id,
    organizationId: input.organizationId,
    role: input.initialRole,
    ...(jobTitle !== undefined ? { jobTitle } : {}),
  });
}
