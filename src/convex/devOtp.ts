import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { guestAuthEnabled } from "./access";

/**
 * DEVELOPMENT-ONLY OTP capture — INTERNAL-ONLY backend functions.
 * ==============================================================
 * On a development deployment (guest auth explicitly enabled) with NO email
 * provider configured, verification codes are not delivered anywhere. These
 * INTERNAL functions expose them exclusively to the trusted server-side test
 * harness (the token-guarded HTTP routes in src/convex/http.ts), so only a
 * trusted test runner can read them. They are NOT callable by any browser
 * session or external client: internal function references are refused by the
 * Convex deployment when invoked from a client (unlike `api.devOtp.*` being
 * gated by a development flag, which is not authorization).
 *
 * Security architecture (Batch 2B hardening):
 *   - capture/pending are INTERNAL functions: they cannot be executed by
 *     unauthenticated external callers, ordinary authenticated users or
 *     anonymous guests — the Convex deployment itself refuses client-side
 *     invocation of internal references.
 *   - The ONLY runtime caller of capture() is the email-otp provider's
 *     "no external delivery" branch (src/convex/auth/emailOtp.ts), which
 *     runs on a dev deployment in a trusted action context.
 *   - The ONLY runtime caller of pending() is the token-guarded HTTP test
 *     harness route (src/convex/http.ts), which additionally requires:
 *       1. `IITAMS_ALLOW_GUEST_AUTH === "true"` (dev-only deployment), and
 *       2. the trusted test-runner secret (IITAMS_TESTER_TOKEN).
 *   Even with the flag mis-set, production configurations never set the
 *   test-runner secret on a deployment, and the guest-auth gate refuses
 *     regardless.
 *
 * Production properties this module never weakens:
 *   - no endpoint of this module is publicly callable;
 *   - it never creates, verifies or signs in accounts by itself;
 *   - it never touches userProfiles, organizations or memberships.
 */

const devOtpArgs = {
  email: v.string(),
  code: v.string(),
  expirationTime: v.number(),
};

/** Store (replace) the pending dev OTP for one address (INTERNAL ONLY). */
export const capture = internalMutation({
  args: devOtpArgs,
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("OTP capture is only available on development deployments");
    }
    const email = args.email.trim().toLowerCase();
    // Keep a single pending code per address (older rows are irrelevant).
    const existing = await ctx.db
      .query("devOtpCodes")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (existing) await ctx.db.delete(existing._id);
    await ctx.db.insert("devOtpCodes", {
      email,
      code: args.code,
      expirationTime: args.expirationTime,
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Read the pending dev OTP for one address for the TRUSTED TEST HARNESS only
 * (INTERNAL QUERY; only reachable through the token-guarded HTTP route).
 */
export const pending = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("OTP capture is only available on development deployments");
    }
    const email = args.email.trim().toLowerCase();
    const row = await ctx.db
      .query("devOtpCodes")
      .withIndex("by_email", (q) => q.eq("email", email))
      .unique();
    if (!row) return null;
    if (row.expirationTime < Date.now()) return null;
    return { code: row.code, expiresAt: row.expirationTime };
  },
});
