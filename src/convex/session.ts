import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import {
  getActiveOrganizationId,
  getCurrentUserOrNull,
  getEffectiveRole,
  roleHasPermission,
} from "./access";

/**
 * Session context for the application shell: identity, organization context,
 * effective role and the resolved permission set driving the nav menu.
 */
export const getSession = query({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) return null;

    const organizationId = await getActiveOrganizationId(ctx);
    const role = await getEffectiveRole(ctx);

    const org = organizationId ? await ctx.db.get(organizationId) : null;
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();

    const permissions = {
      dashboard: roleHasPermission(role, "dashboard.view"),
      workspace: roleHasPermission(role, "workspace.view"),
      audit: roleHasPermission(role, "audit.view"),
      risk: roleHasPermission(role, "risk.view"),
      compliance: roleHasPermission(role, "compliance.view"),
      cyber: roleHasPermission(role, "cyber.view"),
      bcm: roleHasPermission(role, "bcm.view"),
      reports: roleHasPermission(role, "reports.view"),
      admin: roleHasPermission(role, "admin.view"),
      adminManage: roleHasPermission(role, "admin.manage"),
    };

    return {
      userId: user._id,
      name: user.name ?? user.email ?? "Unnamed user",
      email: user.email ?? null,
      isAnonymous: user.isAnonymous ?? false,
      role: role ?? "member",
      permissions,
      organization: org
        ? { id: org._id, name: org.name, code: org.code, type: org.type, isDemo: org.isDemo ?? false }
        : null,
      jobTitle: profile?.jobTitle ?? null,
    };
  },
});

/**
 * Attach the signed-in user to the demo organization with an effective role,
 * so permission-aware navigation and org context work immediately after the
 * first sign-in. No-ops if the user already has a profile.
 */
export const joinDemoOrganization = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await getCurrentUserOrNull(ctx);
    if (!user) throw new Error("Not authenticated");

    const existingProfile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();
    if (existingProfile) {
      return { joined: false, organizationId: existingProfile.organizationId ?? null };
    }

    const org = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (!org) return { joined: false, organizationId: null };

    await ctx.db.insert("userProfiles", {
      userId: user._id,
      organizationId: org._id,
      jobTitle: "Assurance Officer",
      permissions: [user.role ?? "member"],
      lastSeenAt: Date.now(),
    });

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
