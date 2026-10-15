import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { guestAuthEnabled } from "./access";

/**
 * DEVELOPMENT-ONLY OTP capture (Phase 3A — Batch 2B acceptance tooling).
 * =========================================================
 * On a development deployment (guest auth explicitly enabled) with NO email
 * provider configured, verification codes are not delivered anywhere. This
 * module surfaces them to the DEV QA bridge so browser tests can complete a
 * REAL email-OTP authentication for a test identity.
 *
 * Backend boundary (defense in depth — the writing side is also gated):
 *   capture() and pending() both refuse unless
 *   `IITAMS_ALLOW_GUEST_AUTH === "true"`, which production never sets. The
 *   capture is also only invoked from the email-otp provider's
 *   "no external delivery" branch (src/convex/auth/emailOtp.ts), so on any
 *   production configuration with a real provider configured, nothing is
 *   written here. Codes are stored plain ONLY on development deployments.
 *
 * Production properties this module must NOT weaken:
 *   - it never creates, verifies or signs in accounts by itself;
 *   - it never touches userProfiles, organizations or memberships.
 */

const devOtpcap = v.object({
  email: v.string(),
  code: v.string(),
  expirationTime: v.number(),
});

/** Store (replace) the pending dev OTP for one address. */
export const capture = mutation({
  args: devOtpcap.fields,
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

/** Read the pending dev OTP for one address (browser-test bridge only). */
export const pending = query({
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
