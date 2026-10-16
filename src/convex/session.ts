import { internalMutation, mutation, query, type MutationCtx } from "./_generated/server";
import { v } from "convex/values";
import {
  guestAuthEnabled,
  resolveAccess,
  roleHasPermission,
} from "./access";
import { effectiveMembershipStatus } from "../lib/membership";

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
 * Trusted-harness demo role grants — INTERNAL-ONLY (demo-escalation hardening).
 * ===========================================================================
 * The previous PUBLIC mutations (requestDemoRoleUpgrade /
 * requestDemoAdminUpgrade) allowed ANY authenticated demo guest to elevate
 * its own role by calling a client mutation — guest/demo context is tenant
 * confinement, NOT authorization, and ordinary visitors can obtain guest
 * sessions on publicly reachable development deployments.
 *
 * Replacements below are internal mutations: the Convex deployment refuses
 * every client-initiated call. The ONLY entry point is the trusted, token-
 * guarded server-side human harness routes
 *   POST /api/dev-grant-demo-role, POST /api/dev-revoke-demo-role
 * (src/convex/http.ts). The tester secret never enters the browser.
 *
 * Grant authorization model (ALL required, fail closed):
 *   1. dev-only deployment flag (guestAuthEnabled) — production refuses
 *      regardless of any other condition;
 *   2. target resolved from a VALIDATED userId (never the caller's session);
 *   3. target must be an ANONYMOUS guest (real authenticated users are
 *      hierarchically refused — a guest flag alone is never authorization);
 *   4. target must hold an EXPLICIT userProfiles membership in the
 *      IITAMS-DEMO organization — missing profiles are NEVER recreated here;
 *      use the existing explicit guest-provisioning path first
 *      (AppLayout → joinDemoOrganization);
 *   5. the organization must be explicitly flagged isDemo === true;
 *   6. suspended/deactivated memberships are refused;
 *   7. targets of any other organization are refused (no cross-tenant, no
 *      silent reassignment — see (4));
 *   8. only the two approved TEST roles (audit_manager / admin) are
 *      accepted — no arbitrary role assignment;
 *   9. global auth identities/roles are never modified (profile-scoped
 *      organization RBAC only);
 *  10. the grant carries a server-enforced hard expiration
 *      (demoRoleExpiresAt; enforced in resolveAccess) so abandoned test
 *      privileges never authorize protected operations indefinitely;
 *  11. every grant and revocation writes an immutable audit-log entry with
 *      the trusted test harness as ACTOR and the affected guest as TARGET.
 */


/** THE demo organization the harness may operate on (never arbitrary IDs). */
async function requireDemoOrg(ctx: MutationCtx) {
  const demoOrg = await ctx.db
    .query("organizations")
    .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
    .unique();
  if (!demoOrg || demoOrg.isDemo !== true) {
    throw new Error("Demo test-role grants require the explicitly demo-flagged IITAMS-DEMO organization");
  }
  return demoOrg;
}

/**
 * INTERNAL mutation — grant an approved TEST role to a specific demo guest.
 * Callable ONLY through the trusted harness HTTP routes (see http.ts).
 */
export const grantDemoTestRole = internalMutation({
  args: {
    userId: v.id("users"),
    role: v.optional(v.union(v.literal("audit_manager"), v.literal("admin"))),
    /**
     * Optional hard expiration override, in MINUTES (fractional allowed).
     * Default 30; capped at 24h. The elevated role is ignored by resolveAccess
     * once the deadline passes, server-side.
     */
    ttlMinutes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Demo test-role grants are only available on development deployments");
    }

    const approvedRole = args.role ?? "audit_manager";
    if (approvedRole !== "audit_manager" && approvedRole !== "admin") {
      throw new Error("Only audit_manager and admin are approved demo test roles");
    }

    // Resolve the TARGET strictly by the validated userId argument — never
    // from an ambient session/identity (the harness is the only caller).
    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("Demo test-role grant target not found");
    if (!target.isAnonymous) {
      throw new Error("Demo test-role grants apply only to anonymous guest identities");
    }

    const demoOrg = await requireDemoOrg(ctx);

    // EXPLICIT pre-established demo membership required: never recreate or
    // "fix" a missing/misassigned profile during elevation — the guest must
    // be provisioned through the explicit audited guest path first.
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!profile || profile.organizationId !== demoOrg._id) {
      throw new Error("Demo test-role grant target must hold an explicit membership in the demo organization");
    }
    if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
      throw new Error("Demo test-role grants are refused for suspended or deactivated memberships");
    }

    // Server-enforced lifecycle: each grant (re)arms the hard deadline.
    const ttlMinutes = args.ttlMinutes ?? 30;
    if (!(ttlMinutes > 0 && ttlMinutes <= 24 * 60)) {
      throw new Error("Demo test-role grant TTL must be between 0 and 1440 minutes");
    }
    const expiresAt = Date.now() + Math.round(ttlMinutes * 60 * 1000);
    const previousRole = profile.role ?? "member";

    await ctx.db.patch(profile._id, {
      role: approvedRole,
      demoRoleExpiresAt: expiresAt,
      demoRoleGrantedAt: Date.now(),
      lastSeenAt: Date.now(),
    });

    // Immutable audit trail: ACTOR is the trusted test harness (server-side;
    // there is no human caller), TARGET is the affected guest — never conflated.
    await ctx.db.insert("auditLogs", {
      organizationId: demoOrg._id,
      userId: args.userId,
      actorLabel: "trusted test harness (server-side)",
      action: "user.demo_role_granted",
      entityType: "userProfiles",
      entityId: profile._id,
      summary: `Demo test role ${approvedRole} granted to guest session by the trusted test runner (previous role: ${previousRole}; expires ${new Date(expiresAt).toISOString()})`,
      createdAt: Date.now(),
    });

    return { ok: true, userId: args.userId, role: approvedRole, expiresAt };
  },
});

/**
 * INTERNAL mutation — revoke a demo guest's test role, restoring the guest
 * read-only tier (member) and clearing the lingering grant state. Same
 * trusted-harness-only authorization as grantDemoTestRole (no need for a
 * role whitelist here: revocation only ever LOWERS privileges).
 */
export const revokeDemoTestRole = internalMutation({
  args: {
    userId: v.id("users"),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Demo test-role revocation is only available on development deployments");
    }

    const target = await ctx.db.get(args.userId);
    if (!target) throw new Error("Demo test-role revocation target not found");
    if (!target.isAnonymous) {
      throw new Error("Demo test-role revocation applies only to anonymous guest identities");
    }
    const demoOrg = await requireDemoOrg(ctx);
    const profile = await ctx.db
      .query("userProfiles")
      .withIndex("userId", (q) => q.eq("userId", args.userId))
      .unique();
    if (!profile || profile.organizationId !== demoOrg._id) {
      throw new Error("Demo test-role revocation target must hold an explicit membership in the demo organization");
    }

    const previousRole = profile.role ?? "member";
    // Patch with `undefined` removes the optional fields (schema-clear).
    await ctx.db.patch(profile._id, {
      role: "member",
      demoRoleExpiresAt: undefined,
      demoRoleGrantedAt: undefined,
      lastSeenAt: Date.now(),
    });

    await ctx.db.insert("auditLogs", {
      organizationId: demoOrg._id,
      userId: args.userId,
      actorLabel: "trusted test harness (server-side)",
      action: "user.demo_role_revoked",
      entityType: "userProfiles",
      entityId: profile._id,
      summary: `Demo test role revoked and guest restored to the read-only tier by the trusted test runner (previous role: ${previousRole})`,
      createdAt: Date.now(),
    });

    return { ok: true, userId: args.userId, role: "member" as const, previousRole };
  },
});

/**
 * INTERNAL mutation — hard-expire any outstanding demo test grants whose
 * deadline has passed: the elevated role is cleared and the expiry state
 * removed (resolveAccess already enforces expiry at read time; this hygiene
 * sweep runs whenever the trusted harness grants or revokes).
 */
export const expireDemoTestGrants = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!guestAuthEnabled()) return { expired: 0 };
    const demoOrg = await requireDemoOrg(ctx);
    const now = Date.now();
    // Full scan of the demo-organization profiles: the grant/revoke and
    // dedicated harness route invoke this, so the scan must see every demo
    // member (pagination alone could miss stale rows beyond the first page).
    const stale = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) => q.eq("organizationId", demoOrg._id))
      .collect();
    let expired = 0;
    for (const profile of stale) {
      if (
        profile.demoRoleExpiresAt !== undefined &&
        profile.demoRoleExpiresAt <= now
      ) {
        await ctx.db.patch(profile._id, {
          role: "member",
          demoRoleExpiresAt: undefined,
          demoRoleGrantedAt: undefined,
        });
        expired += 1;
        await ctx.db.insert("auditLogs", {
          organizationId: demoOrg._id,
          userId: profile.userId,
          actorLabel: "trusted test harness (server-side)",
          action: "user.demo_role_expired",
          entityType: "userProfiles",
          entityId: profile._id,
          summary: "Demo test role expired (server-enforced deadline); guest restored to the read-only tier",
          createdAt: now,
        });
      }
    }
    return { expired };
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
      return { ok: true, email, alreadyExisted: true, userId: existing._id };
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
    // The userId is returned for trusted-runner-driven boundary tests only
    // (never exposed through any browser-facing path).
    return { ok: true, email, userId };
  },
});
