import { internalMutation, mutation, query } from "./_generated/server";
import { v } from "convex/values";
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
        // Membership lifecycle is surfaced so the UI can distinguish an
        // administrator-held account (awaiting assignment) from one whose
        // membership was suspended/deactivated by an administrator.
        membershipStatus: access.membershipStatus,
        organization: null,
        permissions: {
          dashboard: false,
          workspace: false,
          audit: false,
          auditManage: false,
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
      auditManage: roleHasPermission(access.role, "audit.manage"),
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
      membershipStatus: access.membershipStatus,
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

/**
 * DEMO-ONLY role escalation for development/testing of permission-gated
 * workflows (e.g. the browser E2E suite exercising audit.manage actions).
 * Refuses unless the caller is an anonymous guest attached to an explicitly
 * demo-flagged organization. NEVER grants anything on production
 * deployments — real users are provisioned by an administrator.
 */
export const requestDemoRoleUpgrade = mutation({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const user = access.user;
    if (!user || !user.isAnonymous) {
      throw new Error("Demo role upgrades apply only to guest sessions");
    }
    if (!guestAuthEnabled()) {
      throw new Error("Guest access is disabled on this deployment");
    }
    if (!access.organizationId || !access.organizationIsDemo) {
      throw new Error("Demo role upgrades require the demo organization");
    }

    // Dev-only bridge runs before AppLayout's provisioning effect may have
    // resolved, so ensure the profile row exists here (same guest-only,
    // demo-org-only, audited path as joinDemoOrganization).
    let profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile || profile.organizationId !== access.organizationId) {
      if (profile) {
        // Incomplete/legacy guest profile pointing elsewhere: correct it
        // within this guest's single permitted tenant (the demo org).
        await ctx.db.patch(profile._id, {
          organizationId: access.organizationId,
          role: profile.role ?? user.role ?? "member",
          lastSeenAt: Date.now(),
        });
      } else {
        await ctx.db.insert("userProfiles", {
          userId: user._id,
          organizationId: access.organizationId,
          role: user.role ?? "member", // read-only guest tier
          jobTitle: "Assurance Officer",
          lastSeenAt: Date.now(),
        });
      }
      profile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", user._id))
        .unique();
      if (!profile) throw new Error("Guest profile provisioning failed");
      await ctx.db.insert("auditLogs", {
        organizationId: access.organizationId,
        userId: user._id,
        actorLabel: user.name ?? user.email ?? "Anonymous",
        action: "user.joined_organization",
        entityType: "userProfiles",
        entityId: profile._id,
        summary: "Guest profile provisioned via demo role escalation bridge",
        createdAt: Date.now(),
      });
    }

    await ctx.db.patch(profile._id, {
      role: "audit_manager",
      lastSeenAt: Date.now(),
    });

    await ctx.db.insert("auditLogs", {
      organizationId: access.organizationId,
      userId: user._id,
      actorLabel: user.name ?? user.email ?? "Anonymous",
      action: "user.demo_role_upgraded",
      entityType: "userProfiles",
      entityId: profile._id,
      summary: "Guest session escalated to audit_manager (demo organization)",
      createdAt: Date.now(),
    });

    return { ok: true, role: "audit_manager" as const };
  },
});

/**
 * DEMO-ONLY administrator escalation for development/testing of the Phase-3A
 * administration pages (e.g. the browser E2E suite exercising admin.view
 * gating). Same refusal contract as requestDemoRoleUpgrade: the caller must
 * be an anonymous guest attached to an explicitly demo-flagged organization.
 * NEVER grants anything on production deployments — the platform `admin` role
 * is assigned to real users by an administrator provisioning workflow, not
 * by this mutation.
 */
export const requestDemoAdminUpgrade = mutation({
  args: {},
  handler: async (ctx) => {
    const access = await resolveAccess(ctx);
    const user = access.user;
    if (!user || !user.isAnonymous) {
      throw new Error("Demo admin upgrades apply only to guest sessions");
    }
    if (!guestAuthEnabled()) {
      throw new Error("Guest access is disabled on this deployment");
    }
    if (!access.organizationId || !access.organizationIsDemo) {
      throw new Error("Demo admin upgrades require the demo organization");
    }

    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", user._id))
      .unique();
    if (!profile || profile.organizationId !== access.organizationId) {
      throw new Error("Guest must be provisioned into the demo organization first");
    }

    await ctx.db.patch(profile._id, {
      role: "admin",
      lastSeenAt: Date.now(),
    });

    await ctx.db.insert("auditLogs", {
      organizationId: access.organizationId,
      userId: user._id,
      actorLabel: user.name ?? user.email ?? "Anonymous",
      action: "user.demo_role_upgraded",
      entityType: "userProfiles",
      entityId: profile._id,
      summary: "Guest session escalated to platform admin (demo organization)",
      createdAt: Date.now(),
    });        return { ok: true, role: "admin" as const };
  },
});

/**
 * Trusted test-runner test-identity seeder — INTERNAL-ONLY (Batch 2B hardening).
 * Creates a NON-anonymous users row with a VERIFIED email (simulating a real
 * email-OTP sign-up) but NO organization profile, so the administrative
 * provisioning flow can be exercised end-to-end against the demo deployment.
 *
 * Authorization boundary (Batch 2B hardening — replaced the previous
 * anonymous-guest gate, which was NOT authorization because any visitor on a
 * publicly reachable development deployment can obtain a guest session):
 *   - the function is an INTERNAL mutation callable ONLY through the token-
 *     guarded, development-only HTTP test-harness route
 *     (`POST /api/dev-seed-test-user`, see src/convex/http.ts) — no browser
 *     session, no external client and no ordinary configured flag can invoke
 *     a client-side call;
 *   - guest auth must ALSO be explicitly enabled (production never sets it);
 *   - the seeding never touches userProfiles, memberships or roles — test
 *     identities cannot grant unauthorized organization membership (real
 *     provisioning still requires admin.manage server-side); and
 *   - production authentication state is never altered (this is refused on
 *     any production configuration, and no OTP/company identity is bypassed).
 */
export const seedVerifiedTestUser = internalMutation({
  args: {
    email: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Test identity seeding is only available on development deployments");
    }

    const email = args.email.trim().toLowerCase();
    if (!email.includes("@")) {
      throw new Error("Enter a valid email address");
    }

    // Idempotent under concurrency: refuse duplicates via the email index —
    // repeated harness calls can never create duplicate verified identities.
    const existing = await ctx.db
      .query("users")
      .withIndex("email", (q) => q.eq("email", email))
      .unique();
    if (existing) {
      return { ok: true, email, alreadyExisted: true };
    }

    // The audit trail entry is attached to the explicitly demo-flagged
    // organization (the only permitted context for test identities).
    const demoOrg = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (!demoOrg || demoOrg.isDemo !== true) {
      throw new Error("Test identity seeding requires the demo organization");
    }

    const userId = await ctx.db.insert("users", {
      name: args.name ?? email.split("@")[0],
      email,
      emailVerificationTime: Date.now(),
      isAnonymous: false,
    });

    // Traceability: the trusted harness seeding is itself audited. There is
    // no human caller — the ACTOR is the trusted server-side test runner,
    // distinct from the TARGET identity it creates.
    await ctx.db.insert("auditLogs", {
      organizationId: demoOrg._id,
      userId,
      actorLabel: "trusted test harness (server-side)",
      action: "system.seeded_test_identity",
      entityType: "users",
      entityId: userId,
      summary: `${email} seeded as a verified test identity by the trusted test runner (development deployment)`,
      createdAt: Date.now(),
    });

    // Deliberately NO userProfiles row: the seeded user is unassigned and
    // becomes provisionable through the administrative flow under test.
    return { ok: true, email };
  },
});
