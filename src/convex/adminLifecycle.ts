import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, notify, requirePermission, requireUser } from "./auditAccess";
import { sha256Hex } from "../lib/sha256";
import {
  ADMIN_GRANT_TTL_MS,
  effectiveMembershipStatus,
  lastAdminGuardMessage,
  normalizeInvitationEmail,
} from "../lib/membership";

/**
 * Phase 3A — Batch A1: secure administrator lifecycle.
 * ===========================================================================
 * The privileged role key is the EXISTING registry entry `admin`
 * (src/convex/access.ts IITAMS_ROLES + schema ROLES.ADMIN). No second role
 * definition, no super-admin and no cross-organization authority exist here.
 *
 * The functions below are the ONLY server paths in the codebase that can
 * assign `admin` on a userProfiles row:
 *
 *   1. claimInitialAdministrator — one-time deployment-controlled bootstrap
 *      (STEP 2). Gated on explicit deployment configuration plus a
 *      high-entropy one-time activation secret; consumption is durably and
 *      atomically recorded in `initialBootstraps` (hash-only) so a second
 *      administrator can never be bootstrapped, even if the token is left
 *      in the environment.
 *
 *   2. grantAdministrator (STEP 3) — an existing admin starts a PENDING grant
 *      for an eligible same-organization member. Nothing elevates until the
 *      TARGET's own authenticated, verified identity accepts (acceptGrant);
 *      rejectGrant / cancelAdministratorGrant / expiry are explicit terminals.
 *
 *   3. revokeAdministrator (STEP 4) — an existing admin removes another
 *      admin's privilege, restoring the exact previous role recorded on the
 *      accepted grant (or bootstrap row) — never an automatic `member`
 *      fallback.
 *
 * Last-active-administrator invariants (STEP 5) share ONE counting helper
 * (`countActiveAdministrators`) with admin.setMembershipStatus's existing
 * guard — there are no duplicated inconsistent frontend versions.
 */

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

type GrantDoc = Doc<"administratorGrants">;
type BootstrapDoc = Doc<"initialBootstraps">;
type ProfileDoc = Doc<"userProfiles">;

const ADMIN_ROLE = "admin" as const;

/** Number of ACTIVE administrators in an organization (transactional read). */
export async function countActiveAdministrators(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  excludeProfileId?: Id<"userProfiles">,
): Promise<number> {
  const now = Date.now();
  const profiles = await ctx.db
    .query("userProfiles")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  return profiles.filter(
    (p) =>
      p.role === ADMIN_ROLE &&
      effectiveMembershipStatus(p.membershipStatus) === "active" &&
      p._id !== excludeProfileId &&
      // Expired trusted-harness demo grants do NOT count as administrators
      // (same semantics as resolveAccess in src/convex/access.ts).
      !(p.demoRoleExpiresAt !== undefined && p.demoRoleExpiresAt <= now),
  ).length;
}

// ---------------------------------------------------------------------------
// One-profile-per-user invariant (Batch A1 source-review fix)
// ---------------------------------------------------------------------------

/** The user's ONE existing profile row across ALL organizations (the userId
 * index is unique, so this is a single lookup). Callers MUST distinguish:
 *  - `null`                → no profile row exists anywhere (one-profile
 *                            invariant confirmed — safe to create one);
 *  - `.organizationId ===
 *     undefined`           → UNASSIGNED row: it may be completed in place;
 *  - any other organizationId → the user already holds membership elsewhere:
 *                            callers must refuse WITHOUT creating a row,
 *                            never silently drop the existing membership.
 */
async function profileByUser(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<{ profile: ProfileDoc | null }> {
  const profile = (await ctx.db
    .query("userProfiles")
    .withIndex("userId", (q) => q.eq("userId", userId))
    .unique()) as ProfileDoc | null;
  return { profile };
}

/** Profile scoped to ONE organization (membership checks elsewhere). The
 * same conflation trap does NOT apply here: callers combine the result of
 * `profileByUser` with the org comparison BEFORE any mutation. */
async function profileInOrg(
  ctx: MutationCtx,
  userId: Id<"users">,
  organizationId: Id<"organizations">,
): Promise<ProfileDoc | null> {
  const { profile } = await profileByUser(ctx, userId);
  if (!profile || profile.organizationId !== organizationId) return null;
  return profile;
}

async function userDoc(
  ctx: MutationCtx,
  userId: Id<"users">,
): Promise<Doc<"users"> | null> {
  return await ctx.db.get(userId);
}

/** The latest ACCEPTED lifecycle grant for a promotion of `targetUserId`. */
async function activeGrantFor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  targetUserId: Id<"users">,
): Promise<GrantDoc | null> {
  const rows = await ctx.db
    .query("administratorGrants")
    .withIndex("by_target_status", (q) =>
      q.eq("targetUserId", targetUserId).eq("status", "accepted"),
    )
    .collect();
  const inOrg = rows
    .filter((r) => r.organizationId === organizationId)
    .sort((a, b) => (b.decidedAt ?? 0) - (a.decidedAt ?? 0));
  return inOrg[0] ?? null;
}

async function bootstrapFor(
  ctx: MutationCtx,
  organizationId: Id<"organizations">,
  targetUserId?: Id<"users">,
): Promise<BootstrapDoc | null> {
  const rows = await ctx.db
    .query("initialBootstraps")
    .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
    .collect();
  const matching = targetUserId
    ? rows.filter((r) => r.targetUserId === targetUserId)
    : rows;
  return matching[0] ?? null;
}

// ---------------------------------------------------------------------------
// 1) One-time, deployment-controlled first-administrator bootstrap (STEP 2)
// ---------------------------------------------------------------------------

function bootstrapConfig(): {
  organizationCode: string;
  adminEmail: string;
  token: string;
} | null {
  const organizationCode = (process.env.IITAMS_BOOTSTRAP_ORG_CODE ?? "").trim();
  const adminEmail = (process.env.IITAMS_BOOTSTRAP_ADMIN_EMAIL ?? "")
    .trim()
    .toLowerCase();
  const token = (process.env.IITAMS_BOOTSTRAP_TOKEN ?? "").trim();
  if (!organizationCode || !adminEmail || !token) return null;
  return { organizationCode, adminEmail, token };
}

const BOOTSTRAP_UNCONFIGURED =
  "Administrator bootstrap is not configured on this deployment";

/**
 * Claim the first administrator role via the one-time bootstrap.
 *
 * Deployment configuration (operator procedure in
 * docs/ADMINISTRATOR_BOOTSTRAP.md):
 *   IITAMS_BOOTSTRAP_ORG_CODE    — target organization's stable `code`
 *                                  (a Convex document id is not an
 *                                  operator-manageable configuration value).
 *   IITAMS_BOOTSTRAP_ADMIN_EMAIL — the designated administrator's email.
 *   IITAMS_BOOTSTRAP_TOKEN       — one-time high-entropy secret generated
 *                                  OUTSIDE the app. Never in source. Never
 *                                  returned by any query; only its SHA-256
 *                                  hash is ever persisted (consumption row).
 *
 * Verification order (fail closed): signed-in real user → verified email →
 * secret digest match → configured email match → organization exists →
 * bootstrap unconsumed → no active administrator → target not in another
 * org → active membership. The consumption row and the role write land in
 * ONE mutation, so concurrent claimants serialize and the loser refuses.
 */
export const claimInitialAdministrator = mutation({
  args: { activationToken: v.string() },
  handler: async (ctx, args) => {
    const access = await requireUser(ctx);
    const user = access.user!;
    if (user.isAnonymous === true) {
      throw new Error("Administrator bootstrap requires a signed-in account");
    }
    if (!user.emailVerificationTime) {
      throw new Error(
        "Verify your email address before claiming the administrator role",
      );
    }
    const verifiedEmail = normalizeInvitationEmail(user.email ?? "");
    if (!verifiedEmail) {
      throw new Error("Administrator bootstrap requires an email identity");
    }

    const cfg = bootstrapConfig();
    if (!cfg) throw new Error(BOOTSTRAP_UNCONFIGURED);

    // Secret comparison on SHA-256 digests; the plaintext token is persisted
    // NOWHERE (only e.g. its hash inside the durable consumption row).
    if (sha256Hex(args.activationToken.trim()) !== sha256Hex(cfg.token)) {
      throw new Error("Invalid activation credential");
    }
    if (verifiedEmail !== cfg.adminEmail) {
      throw new Error("This account is not the designated bootstrap identity");
    }

    const org = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", cfg.organizationCode))
      .unique();
    if (!org) {
      throw new Error("Configured bootstrap organization does not exist");
    }

    // ---- atomic consumption section (one mutation) ----
    if (await bootstrapFor(ctx, org._id)) {
      throw new Error(
        "Administrator bootstrap was already used for this organization",
      );
    }
    if ((await countActiveAdministrators(ctx, org._id)) > 0) {
      throw new Error(
        "This organization already has an active administrator — bootstrap disabled",
      );
    }

    // ---- one-profile-per-user invariant (Batch A1 source-review fix) ----
    // The user's profile is looked up ONCE across ALL organizations:
    //  - profile in ANOTHER organization → refuse here, changing nothing
    //    (before this fix the lookup conflated "no profile" with "different
    //    organization" and the insert branch would create a SECOND row);
    //  - UNASSIGNED row (organizationId unset) → complete that same row in
    //    place — preserving its metadata — rather than inserting a duplicate;
    //  - active profile in THIS organization → validate status, patch in
    //    place, preserving all existing metadata;
    //  - inactive profile in THIS organization → refuse for explicit review.
    //  - no profile at all → the only path that inserts one.
    const { profile } = await profileByUser(ctx, user._id);
    if (profile && profile.organizationId !== undefined && profile.organizationId !== org._id) {
      throw new Error(
        "Administrator bootstrap cannot proceed: this identity already holds an active membership in another organization",
      );
    }
    if (profile && effectiveMembershipStatus(profile.membershipStatus) !== "active") {
      throw new Error(
        "An inactive membership cannot be bootstrapped into administration",
      );
    }

    // Exact previous role for auditable restoration on revocation.
    const previousRole: Exclude<ProfileDoc["role"], undefined> =
      profile?.role && profile.role !== ADMIN_ROLE ? profile.role : "member";

    if (profile) {
      if (profile.organizationId !== undefined) {
        // In-place elevation of the EXISTING row — never a second row. All
        // other fields (jobTitle, department, membership status, session
        // metadata) are preserved verbatim.
        await ctx.db.patch(profile._id, { role: ADMIN_ROLE });
      } else {
        // UNASSIGNED row (organizationId not set): complete the SAME row in
        // place — its other fields stay untouched.
        await ctx.db.patch(profile._id, {
          organizationId: org._id,
          role: ADMIN_ROLE,
          membershipStatus: profile.membershipStatus ?? "active",
        });
      }
    } else {
      // The configured identity has no profile anywhere: the bootstrap
      // CREATES one in the designated organization (explicit configuration).
      await ctx.db.insert("userProfiles", {
        userId: user._id,
        organizationId: org._id,
        role: ADMIN_ROLE,
        jobTitle: "Platform Administrator",
        membershipStatus: "active",
        lastSeenAt: Date.now(),
      });
    }

    // Durable consumption marker (hash-only), same mutation as the role
    // write. Once this row exists the bootstrap stays dead even if the
    // environment token is accidentally left configured.
    await ctx.db.insert("initialBootstraps", {
      organizationId: org._id,
      targetUserId: user._id,
      targetEmail: verifiedEmail,
      previousRole,
      tokenHash: sha256Hex(args.activationToken.trim()),
      consumedAt: Date.now(),
    });

    await logAudit(ctx, {
      organizationId: org._id,
      userId: user._id,
      // No human actor exists: the deployment-controlled bootstrap is the
      // source of authority; target identity recorded separately.
      actorId: undefined,
      actorLabel: "Deployment bootstrap (one-time initial administrator)",
      action: "admin.initial_administrator_bootstrapped",
      entityType: "initialBootstraps",
      summary: `First administrator established via deployment bootstrap for ${verifiedEmail} (role: platform admin)`,
    });
    await notify(ctx, {
      organizationId: org._id,
      userId: user._id,
      title: "You are now an organization administrator",
      body: "The one-time deployment bootstrap granted you the platform administrator role for this organization.",
      severity: "success",
    });

    return { ok: true as const, organizationId: org._id };
  },
});

// ---------------------------------------------------------------------------
// 2) Controlled administrator grants with recipient confirmation (STEP 3)
// ---------------------------------------------------------------------------

/**
 * Initiate a PENDING administrator grant. No privilege change happens here —
 * the target's confirmed authenticated acceptance (acceptGrant) elevates.
 */
export const grantAdministrator = mutation({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    const target = await ctx.db.get(args.profileId);
    if (!target || target.organizationId !== access.organizationId) {
      throw new Error("Member not found in your organization");
    }
    if (target.userId === access.user._id) {
      throw new Error("Administrators cannot promote themselves");
    }
    if (target.role === ADMIN_ROLE) {
      throw new Error("This member is already an administrator");
    }
    if (effectiveMembershipStatus(target.membershipStatus) !== "active") {
      throw new Error(
        "Suspended or deactivated members cannot receive an administrator grant",
      );
    }
    const targetUser = await userDoc(ctx, target.userId);
    if (!targetUser || targetUser.isAnonymous === true) {
      throw new Error("Administrator grants require a real IITAMS account");
    }
    if (!targetUser.emailVerificationTime) {
      throw new Error(
        "Administrator grants require a verified email identity — the recipient must verify their address first",
      );
    }
    // Duplicate prevention: any LIVE (still-valid) grant for this target in
    // this org. An EXPIRED pending grant is transactionally transitioned to
    // its expired terminal state here (lazy expiry, immutable audit event)
    // so it can never block a new request indefinitely and can never be
    // accepted afterwards. Convex serializes mutations, so concurrent
    // requests that hit the same expired row: the loser observes status
    // "expired" (not "pending") and silently leaves the already-recorded
    // terminal transition untouched; both requests that find NO live row
    // then re-validate their duplicate read against the serialized write
    // state, so a simultaneous double-insert cannot sneak through.
    const liveDup = await ctx.db
      .query("administratorGrants")
      .withIndex("by_target_status", (q) =>
        q.eq("targetUserId", target.userId).eq("status", "pending"),
      )
      .collect();
    const now = Date.now();
    for (const dup of liveDup) {
      if (dup.organizationId !== access.organizationId) continue;
      if (dup.expiresAt <= now) {
        // Same lazy-expiry transition + audit event as refuseIfExpired.
        await ctx.db.patch(dup._id, { status: "expired", decidedAt: now });
        await logAudit(ctx, {
          organizationId: dup.organizationId,
          userId: dup.targetUserId,
          actorId: undefined,
          actorLabel: "Administrator-lifecycle policy",
          action: "admin.administrator_grant_expired",
          entityType: "administratorGrants",
          entityId: dup._id,
          summary: `Administrator grant expired without a recipient decision`,
        });
        continue;
      }
      throw new Error(
        "An administrator grant is already pending for this member",
      );
    }

    // Exact previous role recorded at INITIATION (restored verbatim on
    // revocation — never converted to `member` automatically).
    const previousRole = target.role ?? "member";
    const grantId = await ctx.db.insert("administratorGrants", {
      organizationId: access.organizationId,
      targetUserId: target.userId,
      targetLabel: targetUser.name ?? targetUser.email ?? "Unknown member",
      initiatorUserId: access.user._id,
      initiatorLabel: access.user.name ?? access.user.email ?? "Administrator",
      previousRole,
      status: "pending",
      requestedAt: now,
      expiresAt: now + ADMIN_GRANT_TTL_MS,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "admin.administrator_grant_requested",
      entityType: "administratorGrants",
      entityId: grantId,
      summary: `Administrator grant requested for ${targetUser.name ?? targetUser.email ?? "a member"} (previous role: ${previousRole}) — awaiting recipient confirmation`,
    });
    await notify(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      title: "Administrator privileges requested for you",
      body: `An administrator of your organization requested to grant you the platform administrator role. Review it at /privilege-requests — privileges activate only after YOUR confirmation.`,
      severity: "info",
      href: "/privilege-requests",
    });

    return { ok: true as const, grantId };
  },
});

/** Mark an expired grant (lazy, at interaction time) and refuse. */
async function refuseIfExpired(
  ctx: MutationCtx,
  grant: GrantDoc,
): Promise<void> {
  if (grant.status === "pending" && grant.expiresAt <= Date.now()) {
    await ctx.db.patch(grant._id, { status: "expired", decidedAt: Date.now() });
    await logAudit(ctx, {
      organizationId: grant.organizationId,
      userId: grant.targetUserId,
      actorId: undefined,
      action: "admin.administrator_grant_expired",
      actorLabel: "Administrator-lifecycle policy",
      entityType: "administratorGrants",
      entityId: grant._id,
      summary: `Administrator grant expired without a recipient decision`,
    });
    throw new Error(
      "This administrator grant has expired — ask an administrator to issue a new one",
    );
  }
}

/**
 * The recipient's own authenticated, verified acceptance: the ONLY public
 * path that turns a pending grant into an administrator promotion
 * (single-mutation role write + terminal grant transition).
 */
export const acceptAdministratorGrant = mutation({
  args: { grantId: v.id("administratorGrants") },
  handler: async (ctx, args) => {
    const access = await requireUser(ctx);
    const user = access.user!;
    if (user.isAnonymous === true) {
      throw new Error("Sign in with your own account to review this grant");
    }
    const grant = (await ctx.db.get(args.grantId)) as GrantDoc | null;
    // Tenant isolation: a grant id from another organization is invisible.
    if (!grant || grant.organizationId !== access.organizationId) {
      throw new Error("Grant not found");
    }
    // Confirmation binds to the INTENDED authenticated user.
    if (grant.targetUserId !== user._id) {
      throw new Error("This grant was issued to a different account");
    }
    if (grant.status === "pending") await refuseIfExpired(ctx, grant);
    if (grant.status !== "pending") {
      throw new Error(
        grant.status === "expired"
          ? "This administrator grant has expired — ask an administrator to issue a new one"
          : `This grant is already ${grant.status} and cannot be confirmed again`,
      );
    }

    // Recipient state re-validated at acceptance time.
    const targetUser = await userDoc(ctx, user._id);
    if (!targetUser || !targetUser.emailVerificationTime) {
      throw new Error("Verify your email address before accepting this grant");
    }
    const profile = await profileInOrg(
      ctx,
      user._id,
      grant.organizationId,
    );
    if (!profile) {
      throw new Error(
        "Your membership in this organization no longer exists — accepting is not possible",
      );
    }
    if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
      throw new Error(
        "An inactive membership cannot be elevated to administrator",
      );
    }
    if (profile.role === ADMIN_ROLE) {
      // Already elevated (e.g. concurrent acceptance): terminate the grant
      // idempotently instead of corrupting state; refusing outright would
      // strand a pending row after the privilege is already active.
      await ctx.db.patch(grant._id, {
        status: "accepted",
        decidedAt: grant.decidedAt ?? Date.now(),
      });
      return { ok: true as const, role: ADMIN_ROLE };
    }

    // ---- atomic elevation: role write + grant acceptance in ONE mutation ----
    await ctx.db.patch(profile._id, { role: ADMIN_ROLE });
    await ctx.db.patch(grant._id, { status: "accepted", decidedAt: Date.now() });

    await logAudit(ctx, {
      organizationId: grant.organizationId,
      userId: grant.targetUserId,
      actorId: user._id,
      actorLabel: grant.targetLabel,
      action: "admin.administrator_grant_accepted",
      entityType: "administratorGrants",
      entityId: grant._id,
      summary: `${grant.targetLabel} confirmed their administrator grant (previous role: ${grant.previousRole}) requested by ${grant.initiatorLabel}`,
    });

    return { ok: true as const, role: ADMIN_ROLE };
  },
});

/** The recipient's explicit refusal — never changes any privilege. */
export const rejectAdministratorGrant = mutation({
  args: { grantId: v.id("administratorGrants") },
  handler: async (ctx, args) => {
    const access = await requireUser(ctx);
    const grant = (await ctx.db.get(args.grantId)) as GrantDoc | null;
    if (!grant || grant.organizationId !== access.organizationId) {
      throw new Error("Grant not found");
    }
    if (grant.targetUserId !== access.user!._id) {
      throw new Error("This grant was issued to a different account");
    }
    if (grant.status === "pending") await refuseIfExpired(ctx, grant);
    if (grant.status !== "pending") {
      throw new Error(`This grant is already ${grant.status}`);
    }
    await ctx.db.patch(grant._id, {
      status: "rejected",
      decidedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: grant.organizationId,
      userId: grant.targetUserId,
      actorId: access.user!._id,
      actorLabel: grant.targetLabel,
      action: "admin.administrator_grant_rejected",
      entityType: "administratorGrants",
      entityId: grant._id,
      summary: `${grant.targetLabel} declined the requested administrator grant (no privilege change)`,
    });
    await notify(ctx, {
      organizationId: grant.organizationId,
      userId: grant.initiatorUserId,
      title: "Administrator grant declined",
      body: `${grant.targetLabel} declined the requested administrator grant. Their role is unchanged.`,
      severity: "info",
    });
    return { ok: true as const } as const;
  },
});

/** The initiating administrator cancels a request that was not yet decided. */
export const cancelAdministratorGrant = mutation({
  args: { grantId: v.id("administratorGrants") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    const grant = (await ctx.db.get(args.grantId)) as GrantDoc | null;
    if (!grant || grant.organizationId !== access.organizationId) {
      throw new Error("Grant not found in your organization");
    }
    if (grant.status !== "pending") {
      throw new Error(`Only pending grants can be cancelled (this one is ${grant.status})`);
    }
    await ctx.db.patch(grant._id, {
      status: "cancelled",
      decidedAt: Date.now(),
    });
    await logAudit(ctx, {
      organizationId: grant.organizationId,
      userId: grant.targetUserId,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "admin.administrator_grant_cancelled",
      entityType: "administratorGrants",
      entityId: grant._id,
      summary: `Administrator grant for ${grant.targetLabel} cancelled by ${grant.initiatorLabel === (access.user.name ?? access.user.email) ? "the requesting administrator" : "an administrator"} (no privilege change)`,
    });
    await notify(ctx, {
      organizationId: grant.organizationId,
      userId: grant.targetUserId,
      title: "Administrator grant cancelled",
      body: "An administrator cancelled the pending administrator grant request. Your role is unchanged.",
      severity: "info",
    });
    return { ok: true as const } as const;
  },
});

// ---------------------------------------------------------------------------
// 3) Administrator revocation with previous-role restoration (STEP 4)
// ---------------------------------------------------------------------------

/**
 * Revoke another administrator's platform role. The restoration role is the
 * exact previous role recorded on the latest accepted grant (or the
 * bootstrap consumption row) — revoked administrators keep their legitimate
 * audit/business role; `member` is only used when it genuinely was their
 * previous role.
 */
export const revokeAdministrator = mutation({
  args: { profileId: v.id("userProfiles") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    const target = await ctx.db.get(args.profileId);
    if (!target || target.organizationId !== access.organizationId) {
      throw new Error("Member not found in your organization");
    }
    if (target.role !== ADMIN_ROLE) {
      throw new Error("This member does not hold the administrator role");
    }
    if (target.userId === access.user._id) {
      throw new Error(
        "Administrators cannot revoke their own role here — ask another administrator",
      );
    }
    // STEP 5: structural last-active-administrator protection.
    if ((await countActiveAdministrators(ctx, access.organizationId, target._id)) === 0) {
      throw new Error(lastAdminGuardMessage());
    }

    // Restoration authority: the auditable lifecycle record.
    const sourceGrant = await activeGrantFor(
      ctx,
      access.organizationId,
      target.userId,
    );
    const sourceBootstrap = sourceGrant
      ? null
      : await bootstrapFor(ctx, access.organizationId, target.userId);
    const restoreRole =
      sourceGrant?.previousRole ?? sourceBootstrap?.previousRole ?? null;
    if (restoreRole === null || restoreRole === ADMIN_ROLE) {
      throw new Error(
        "No auditable previous role is on record for this administrator — roles granted outside the administrator lifecycle cannot be revoked here",
      );
    }

    await ctx.db.patch(target._id, { role: restoreRole });
    if (sourceGrant) {
      await ctx.db.patch(sourceGrant._id, {
        status: "revoked",
        revokedAt: Date.now(),
        revokedByUserId: access.user._id,
      });
    }

    const targetUser = await userDoc(ctx, target.userId);
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "admin.administrator_revoked",
      entityType: sourceGrant ? "administratorGrants" : "initialBootstraps",
      entityId: sourceGrant?._id ?? sourceBootstrap?._id,
      summary: `${targetUser?.name ?? targetUser?.email ?? "An administrator"}'s administrator role revoked; previous role ${restoreRole} restored (demotion takes effect immediately)`,
    });
    await notify(ctx, {
      organizationId: access.organizationId,
      userId: target.userId,
      title: "Administrator privileges revoked",
      body: `An administrator changed your role from platform administrator back to ${restoreRole}. The change is effective immediately.`,
      severity: "warning",
    });

    return { ok: true as const, role: restoreRole };
  },
});

// ---------------------------------------------------------------------------
// 4) Organization-scoped reads (admin.view / recipient self-view)
// ---------------------------------------------------------------------------

export interface AdminGrantRow {
  _id: Id<"administratorGrants">;
  targetUserId: Id<"users">;
  targetLabel: string;
  initiatorLabel: string;
  previousRole: string;
  status: string;
  requestedAt: number;
  expiresAt: number;
  effectiveStatus: string;
}

/** Pending + decided administrator grants, plus the active administrators. */
export const listAdministratorLifecycle = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return null;
    const now = Date.now();

    const grants = await ctx.db
      .query("administratorGrants")
      .withIndex("by_organization_status", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();

    const admins = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    // The directory presents only EFFECTIVE administrators: rows whose
    // trusted demo-role grant has expired are excluded — the same predicate
    // countActiveAdministrators uses for the last-admin guard, so the UI can
    // never point an operator at a credential that is no longer valid.
    const adminRows = admins.filter(
      (p) =>
        p.role === ADMIN_ROLE &&
        !(p.demoRoleExpiresAt !== undefined && p.demoRoleExpiresAt <= now),
    );

    const adminLabels = await Promise.all(
      adminRows.map(async (p) => {
        const u = await ctx.db.get(p.userId);
        return { label: u?.name ?? u?.email ?? "Administrator" };
      }),
    );

    return {
      grants: grants
        .map((g): AdminGrantRow => ({
          _id: g._id,
          targetUserId: g.targetUserId,
          targetLabel: g.targetLabel,
          initiatorLabel: g.initiatorLabel,
          previousRole: g.previousRole,
          status: g.status,
          requestedAt: g.requestedAt,
          expiresAt: g.expiresAt,
          effectiveStatus:
            g.status === "pending" && g.expiresAt <= now ? "expired" : g.status,
        }))
        .sort((a, b) => b.requestedAt - a.requestedAt),
      administrators: adminRows.map((p, i) => ({
        profileId: p._id,
        userId: p.userId,
        label: adminLabels[i]?.label ?? "Administrator",
        membershipStatus: effectiveMembershipStatus(p.membershipStatus),
      })),
    };
  },
});

/**
 * The caller's own pending grants (recipient review). Org-scoped to the
 * caller's resolved organization; guests receive nothing.
 */
export const myPendingAdministratorGrants = query({
  args: {},
  handler: async (ctx) => {
    const access = await requireUser(ctx);
    if (!access.user || access.user.isAnonymous === true) return [];
    if (!access.organizationId) return [];
    const rows = await ctx.db
      .query("administratorGrants")
      .withIndex("by_target_status", (q) =>
        q.eq("targetUserId", access.user!._id).eq("status", "pending"),
      )
      .collect();
    const now = Date.now();
    return rows
      .filter((r) => r.organizationId === access.organizationId)
      .map((r) => ({
        _id: r._id,
        initiatorLabel: r.initiatorLabel,
        previousRole: r.previousRole,
        requestedAt: r.requestedAt,
        expiresAt: r.expiresAt,
        expired: r.expiresAt <= now,
      }));
  },
});

// ---------------------------------------------------------------------------
// 5) Internal helpers (tests / sweeps)
// ---------------------------------------------------------------------------

/** Explicit expiry for EXACTLY the pending grants the trusted runner names
 * (test-harness fixture list; each row is the runner's own record). Test
 * isolation (source-review fix): no blanket organization-wide or global
 * sweep exists anymore — a stale queued action can never force-expire
 * pending grants it did not create, and legitimate pending grants of other
 * organizations are untouched. Requires grantIds; expires only rows that
 * are still pending, recording the same immutable audit event as the lazy
 * acceptance-time expiry. */
export const expireDueGrants = internalMutation({
  args: { grantIds: v.array(v.id("administratorGrants")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    let expired = 0;
    for (const grantId of args.grantIds) {
      const g = (await ctx.db.get(grantId)) as GrantDoc | null;
      if (!g || g.status !== "pending") continue;
      await ctx.db.patch(g._id, { status: "expired", decidedAt: now });
      await logAudit(ctx, {
        organizationId: g.organizationId,
        userId: g.targetUserId,
        actorId: undefined,
        actorLabel: "Administrator-lifecycle policy",
        action: "admin.administrator_grant_expired",
        entityType: "administratorGrants",
        entityId: g._id,
        summary: `Administrator grant expired without a recipient decision`,
      });
      expired += 1;
    }
    return { expired };
  },
});
