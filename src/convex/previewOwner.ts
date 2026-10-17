import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { logAudit } from "./auditAccess";
import { effectiveMembershipStatus } from "../lib/membership";

/**
 * Documented operator procedure — establish the PREVIEW OWNER account.
 * ===================================================================
 * Why this exists: a fresh preview deployment has no genuine owner account.
 * The one-time bootstrap is a single global, already-consumed invariant and
 * must not be reset; the emergency recovery path refuses (correctly) while
 * legitimate administrators exist. This procedure is the narrow, auditable
 * operator path for a NON-PRODUCTION demo/preview organization only.
 *
 * It is deliberately NOT an in-app privilege path:
 *
 *  - `internalMutation`: CLI/deployment-credential access only. It is not
 *    callable from the browser, the HTTP router, or any authenticated client
 *    and adds no public API surface.
 *  - DOUBLE gate: requires `IITAMS_OWNER_PROVISIONING_ENABLED=true` AND a
 *    matching high-entropy `IITAMS_OWNER_PROVISIONING_TOKEN` argument. One
 *    forgotten environment variable cannot enable it.
 *  - NON-PRODUCTION ONLY: the target organization must be explicitly flagged
 *    `isDemo`. A production organization can never be reached, so this cannot
 *    grant administrator access to production data.
 *  - The target must already exist as a real, non-anonymous account with a
 *    VERIFIED email — ownership is proven through the normal authentication
 *    flow, never asserted by the operator.
 *  - One profile invariant is preserved: an existing profile in another
 *    organization is refused instead of being silently migrated.
 *  - The one-time bootstrap (`initialBootstraps`) is never read, written or
 *    reset, and invitation rows are never touched.
 *  - The promotion and its immutable audit entry are written in one
 *    transaction, attributed to the deployment operator so it is never
 *    confused with an in-app administrator decision.
 *
 * Revoking this access is ordinary administration: revoke the administrator
 * role through the normal lifecycle, or suspend the membership.
 */

const OPERATOR_LABEL = "Deployment operator (CLI preview provisioning)";

export const establishPreviewOwner = internalMutation({
  args: {
    organizationCode: v.string(),
    email: v.string(),
    operatorToken: v.string(),
  },
  handler: async (ctx, args) => {
    if (process.env.IITAMS_OWNER_PROVISIONING_ENABLED !== "true") {
      throw new Error("Preview owner provisioning is not enabled on this deployment");
    }
    const expected = (process.env.IITAMS_OWNER_PROVISIONING_TOKEN ?? "").trim();
    if (expected.length < 24 || args.operatorToken !== expected) {
      throw new Error("Preview owner provisioning refused: invalid operator token");
    }

    const organizationCode = args.organizationCode.trim();
    const email = args.email.trim().toLowerCase();
    if (!organizationCode || !email) {
      throw new Error("organizationCode and email are required");
    }

    const org = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", organizationCode))
      .unique();
    if (!org) throw new Error("Unknown organization code");
    // Non-production guard: only an explicitly demo/preview organization.
    if (org.isDemo !== true) {
      throw new Error(
        "Refused: preview owner provisioning is limited to an explicitly demo/preview organization",
      );
    }

    const user = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (!user || user.isAnonymous === true || !user.emailVerificationTime) {
      throw new Error(
        "The owner must sign in once with the email OTP flow so a verified account exists",
      );
    }

    const existing = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();

    if (existing && existing.organizationId && existing.organizationId !== org._id) {
      throw new Error(
        "Refused: this account already belongs to another organization",
      );
    }
    if (
      existing &&
      existing.organizationId === org._id &&
      existing.role === "admin" &&
      effectiveMembershipStatus(existing.membershipStatus) === "active"
    ) {
      return { ok: true as const, alreadyAdministrator: true, profileId: existing._id };
    }

    const now = Date.now();
    let profileId = existing?._id;
    if (existing) {
      await ctx.db.patch(existing._id, {
        organizationId: org._id,
        role: "admin",
        membershipStatus: "active",
      });
    } else {
      profileId = await ctx.db.insert("userProfiles", {
        userId: user._id,
        organizationId: org._id,
        role: "admin",
        membershipStatus: "active",
        lastSeenAt: now,
      });
    }

    const targetLabel = user.name ?? user.email ?? "Preview owner";
    await logAudit(ctx, {
      organizationId: org._id,
      userId: user._id,
      actorId: undefined,
      actorLabel: OPERATOR_LABEL,
      action: "admin.preview_owner_established",
      entityType: "userProfiles",
      entityId: String(profileId),
      summary: `${targetLabel} established as preview owner administrator in demo organization ${org.code} by documented operator procedure (non-production)`,
    });

    return {
      ok: true as const,
      alreadyAdministrator: false,
      profileId,
      organizationId: org._id,
    };
  },
});
