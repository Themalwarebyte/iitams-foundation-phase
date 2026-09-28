import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  guestAuthEnabled,
  resolveAccess,
  roleHasPermission,
} from "./access";

/**
 * Public auth policy flag. Lets the client render development-only affordances
 * (the guest sign-in button) strictly when the deployment enables guest auth.
 * In production this returns false and the button is never rendered.
 */
export const getAuthPolicy = query({
  args: {},
  handler: async () => ({ guestEnabled: guestAuthEnabled() }),
});

/**
 * Session context for the application shell: identity, organization context,
 * effective role and the resolved permission set driving the nav menu.
 */
export const getSession = query({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const user = access.user;
    if (!user) return null;

    // Production guest policy: anonymous users get no session context at all
    // when guest auth is disabled — protected data is unreachable.
    if (access.isGuest && !guestAuthEnabled()) {
      return null;
    }

    // Authenticated but not provisioned: a real user with no explicit
    // organization assignment. The UI shows a safe "awaiting provisioning"
    // state and no tenant data is resolved. Never fall back to another org.
    if (!access.isProvisioned) {
      return {
        userId: user._id,
        name: user.name ?? user.email ?? "Unnamed user",
        email: user.email ?? null,
        isAnonymous: user.isAnonymous ?? false,
        role: null,
        isProvisioned: false,
        awaitingProvisioning: true,
        organization: null,
        permissions: {
          dashboard: false,
          workspace: false,
          audit: false,
          risk: false,
          compliance: false,
          cyber: false,
          bcm: false,
          reports: false,
          admin: false,
          adminManage: false,
        },
        jobTitle: null,
      };
    }

    const org = access.organizationId
      ? await ctx.db.get(access.organizationId)
      : null;
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();

    const permissions = {
      dashboard: roleHasPermission(access.role, "dashboard.view"),
      workspace: roleHasPermission(access.role, "workspace.view"),
      audit: roleHasPermission(access.role, "audit.view"),
      risk: roleHasPermission(access.role, "risk.view"),
      compliance: roleHasPermission(access.role, "compliance.view"),
      cyber: roleHasPermission(access.role, "cyber.view"),
      bcm: roleHasPermission(access.role, "bcm.view"),
      reports: roleHasPermission(access.role, "reports.view"),
      admin: roleHasPermission(access.role, "admin.view"),
      adminManage: roleHasPermission(access.role, "admin.manage"),
    };

    return {
      userId: user._id,
      name: user.name ?? user.email ?? "Unnamed user",
      email: user.email ?? null,
      isAnonymous: user.isAnonymous ?? false,
      role: access.role ?? null,
      isProvisioned: true,
      awaitingProvisioning: false,
      permissions,
      organization: org
        ? {
            id: org._id,
            name: org.name,
            code: org.code,
            type: org.type,
            isDemo: org.isDemo ?? false,
          }
        : null,
      jobTitle: profile?.jobTitle ?? null,
    };
  },
});

/**
 * Attach the signed-in GUEST to the demo organization with an effective role,
 * so permission-aware navigation and org context work immediately after the
 * first sign-in. This is the single explicit provisioning path for guest
 * sessions (called by AppLayout); it never touches real users' profiles and
 * never attaches to any organization except the `IITAMS-DEMO` org, which must
 * be explicitly flagged `isDemo`. Real users are provisioned by an
 * administrator (Phase 2 workflow), not by this mutation.
 */
export const joinDemoOrganization = mutation({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const user = access.user;
    if (!user) throw new Error("Not authenticated");
    if (!user.isAnonymous) {
      // Real users are provisioned explicitly by an administrator, never by
      // this guest bootstrap — prevents auto-assignment on first sign-in.
      return { joined: false, organizationId: null };
    }
    if (!guestAuthEnabled()) {
      throw new Error("Guest access is disabled on this deployment");
    }

    const existingProfile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();
    if (existingProfile && existingProfile.organizationId) {
      return { joined: false, organizationId: existingProfile.organizationId };
    }

    const org = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (!org || org.isDemo !== true) {
      // Never attach a user (or guest) to a non-demo organization here.
      return { joined: false, organizationId: null };
    }

    if (existingProfile) {
      // Legacy/incomplete guest profile with no organization assignment:
      // complete provisioning instead of leaving the guest stuck unprovisioned.
      await ctx.db.patch(existingProfile._id, {
        organizationId: org._id,
        role: existingProfile.role ?? user.role ?? "member",
        lastSeenAt: Date.now(),
      });
    } else {
      await ctx.db.insert("userProfiles", {
        userId: user._id,
        organizationId: org._id,
        role: user.role ?? "member", // guests resolve to the read-only tier
        jobTitle: "Assurance Officer",
        lastSeenAt: Date.now(),
      });
    }

    await ctx.db.insert("auditLogs", {
      organizationId: org._id,
      userId: user._id,
      actorLabel: user.name ?? user.email ?? "Anonymous",
      action: "user.joined_organization",
      entityType: "userProfiles",
      summary: `${user.name ?? user.email ?? "A user"} joined ${org.name}`,
      createdAt: Date.now(),
    });

    return { joined: true, organizationId: org._id };
  },
});
