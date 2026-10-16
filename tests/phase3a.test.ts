import { describe, expect, test } from "bun:test";
import {
  IITAMS_ROLES,
  roleHasPermission,
  permissionsForRole,
} from "../src/convex/access";
import { NAV_GROUPS } from "../src/lib/nav";

/**
 * Phase 3A unit tests — Administration & Identity Management foundation.
 *
 * The admin queries run inside Convex (async DB access), so their security
 * structure is verified with source guards in the established style: any
 * edit that removes a permission gate, widens tenancy or makes the audit
 * log writable fails loudly here.
 */

const adminSrc = await Bun.file("src/convex/admin.ts").text();
const mainSrc = await Bun.file("src/main.tsx").text();
const sessionSrc = await Bun.file("src/convex/session.ts").text();
const accessSrc = await Bun.file("src/convex/access.ts").text();
const devToolsSrc = await Bun.file("src/dev/DevTools.tsx").text();

// ---------------------------------------------------------------------------
// Administration section (nav)
// ---------------------------------------------------------------------------

describe("administration navigation", () => {
  const adminGroup = NAV_GROUPS.find((g) => g.label === "Administration");

  test("exists as its own group and is hidden without the admin permission", () => {
    expect(adminGroup).toBeDefined();
    for (const item of adminGroup!.items) {
      expect(item.permission).toBe("admin");
    }
  });

  test("exposes the five Phase-3A routes plus the later-batch scaffolds", () => {
    const paths = adminGroup!.items.map((i) => i.path);
    expect(paths).toContain("/admin/dashboard");
    expect(paths).toContain("/admin/organizations");
    expect(paths).toContain("/admin/users");
    expect(paths).toContain("/admin/roles");
    expect(paths).toContain("/admin/audit-logs");
  });

  test("every Phase-3A admin page has a dedicated protected route in the router", () => {
    for (const path of [
      "/admin/dashboard",
      "/admin/organizations",
      "/admin/users",
      "/admin/roles",
      "/admin/audit-logs",
    ]) {
      expect(mainSrc).toContain(`path="${path}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// Admin backend permission gating (source guards)
// ---------------------------------------------------------------------------

describe("admin backend authorization (source guards)", () => {
  test("every exported admin query is gated on admin.view", () => {
    // Count query handlers and admin.view gates: each query must call
    // requirePermission(ctx, "admin.view") before touching the database.
    const queryCount = (adminSrc.match(/export const \w+ = query\(/g) ?? []).length;
    const gateCount = (adminSrc.match(/requirePermission\(ctx, "admin\.view"\)/g) ?? [])
      .length;
    expect(queryCount).toBeGreaterThanOrEqual(5);
    expect(gateCount).toBe(queryCount);
  });

  test("every exported admin mutation is gated on admin.manage (Batch 2A/2B)", () => {
    // Membership-lifecycle and provisioning are the only permitted write
    // surfaces, and both must always go through the admin.manage gate.
    const mutations = (adminSrc.match(/export const \w+ = mutation\(\{/g) ?? []);
    expect(mutations.length).toBe(2);
    expect(mutations[0]).toContain("setMembershipStatus");
    expect(mutations[1]).toContain("provisionMember");
    for (const name of ["setMembershipStatus", "provisionMember"] as const) {
      const mutSrc = adminSrc.match(
        new RegExp(`export const ${name} = mutation\\([^;]*requirePermission\\(ctx,`),
      );
      expect(mutSrc).not.toBeNull();
    }
    const gateCount = (adminSrc.match(/requirePermission\(ctx, "admin\.manage"\)/g) ?? []).length;
    expect(gateCount).toBe(2);
  });

  test("the admin module contains no delete/replace operations (no destructive paths)", () => {
    expect(adminSrc).not.toMatch(/ctx\.db\.delete\(/);
    expect(adminSrc).not.toMatch(/ctx\.db\.replace\(/);
  });

  test("every admin DB read is organization-scoped", () => {
    // All auditLogs / userProfiles / auditEngagements reads must go through
    // the by_organization index bound to the caller's resolved org.
    for (const table of ["auditLogs", "userProfiles", "auditEngagements"]) {
      const pattern = new RegExp(
        `\\.query\\("${table}"\\)[\\s\\S]{0,200}?withIndex\\("by_organization"`,
      );
      expect(adminSrc).toMatch(pattern);
    }
  });

  test("audit log reads never write, patch or delete the log", () => {
    expect(adminSrc).not.toMatch(/ctx\.db\.(patch|replace|delete)\("auditLogs"/);
    // The membership mutation appends log entries via logAudit (insert-only).
    expect(adminSrc).toContain("logAudit(ctx,");
  });

  test("the log viewer has no organization argument (tenant isolation is structural)", () => {
    const listAuditLogs = adminSrc.match(
      /export const listAuditLogs = query\(\{[\s\S]*?\n\}\);/,
    );
    expect(listAuditLogs).not.toBeNull();
    expect(listAuditLogs![0]).not.toContain("organizationId: v.");
  });
});

// ---------------------------------------------------------------------------
// Role registry visibility page data
// ---------------------------------------------------------------------------

describe("role registry visibility", () => {
  test("permissionsForRole mirrors roleHasPermission for every role and permission", () => {
    const allPermissions = [
      "dashboard.view",
      "workspace.view",
      "audit.view",
      "audit.manage",
      "risk.view",
      "risk.manage",
      "compliance.view",
      "compliance.manage",
      "cyber.view",
      "cyber.manage",
      "bcm.view",
      "bcm.manage",
      "reports.view",
      "admin.view",
      "admin.manage",
    ] as const;
    for (const role of IITAMS_ROLES) {
      const granted = permissionsForRole(role);
      for (const permission of allPermissions) {
        expect(roleHasPermission(role, permission)).toBe(
          granted.includes(permission),
        );
      }
    }
  });

  test("exactly one role holds admin.view (no hidden platform bypasses)", () => {
    const holders = IITAMS_ROLES.filter((r) =>
      roleHasPermission(r, "admin.view"),
    );
    expect(holders).toEqual(["admin"]);
  });

  test("no audit workflow role holds admin.view or admin.manage", () => {
    for (const role of [
      "audit_director",
      "audit_manager",
      "auditor",
      "audit_reviewer",
      "management_user",
      "executive_viewer",
    ] as const) {
      expect(roleHasPermission(role, "admin.view")).toBe(false);
      expect(roleHasPermission(role, "admin.manage")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Demo escalation model (internal-only, trusted harness — see
// tests/security.demoescalation.test.ts for the runtime boundary)
// ---------------------------------------------------------------------------

describe("demo escalation guardrails (internal-only model)", () => {
  test("no public escalation mutations remain — internal–only grants via the harness", () => {
    // The old public, session-based escalators must be gone entirely (only a
    // historical docblock mention documents WHY they were removed).
    expect(sessionSrc).not.toMatch(
      /export const requestDemo(RoleUpgrade|AdminUpgrade) = mutation\(/,
    );
    // The only public mutating surface in the session module is the explicit
    // guest provisioning path (joinDemoOrganization); every role-granting
    // operation is INTERNAL (deployment refuses client calls).
    const publicMutations = (
      sessionSrc.match(/export const (\w+) = mutation\(/g) ?? []
    ).map((m) => m.replace("export const ", "").replace(" = mutation(", ""));
    expect(publicMutations).toEqual(["joinDemoOrganization"]);
    expect(sessionSrc).toContain(
      "export const grantDemoTestRole = internalMutation(",
    );
    expect(sessionSrc).toContain(
      "export const revokeDemoTestRole = internalMutation(",
    );
  });

  test("grantDemoTestRole enforces the full fail-closed authorization chain", () => {
    const fn = sessionSrc.match(
      /export const grantDemoTestRole = internalMutation\(\{[\s\S]*?\n\}\);/,
    );
    expect(fn).not.toBeNull();
    const src = fn![0];
    // 1. dev-only deployment flag (production refuses everything).
    expect(src).toContain("if (!guestAuthEnabled())");
    // 2. target resolved from a validated userId argument (never a session).
    expect(src).toContain("userId: v.id(\"users\")");
    expect(src).toContain("ctx.db.get(args.userId)");
    // 3/7. target must be an anonymous guest.
    expect(src).toContain("!target.isAnonymous");
    // 4/5/8. explicit IITAMS-DEMO membership, demo-flagged org, no other org.
    expect(src).toContain("profile.organizationId !== demoOrg._id");
    // The demo org is looked up through the shared requireDemoOrg guard,
    // which is the ONLY permitted organization target (never arbitrary IDs).
    expect(src).toContain("await requireDemoOrg(ctx)");
    expect(sessionSrc).toContain('q.eq("code", "IITAMS-DEMO")');
    expect(sessionSrc).toContain("demoOrg.isDemo !== true");
    // 6. suspended/deactivated memberships refused.
    expect(src).toContain("effectiveMembershipStatus(profile.membershipStatus)");
    // 9. only the approved test roles — no arbitrary assignment.
    for (const role of ["audit_manager", "admin"] as const) {
      expect(src).toContain(`v.literal("${role}")`);
    }
    expect(src).not.toMatch(/v\.string\(\)\)\s*,\s*\n\s*\/\/\s*role/);
    // 10. server-enforced expiration is part of the grant.
    expect(src).toContain("demoRoleExpiresAt");
    // 12. immutable audit entry: harness actor, guest target.
    expect(src).toContain('ctx.db.insert("auditLogs"');
    expect(src).toContain("trusted test harness");
    expect(src).toContain("user.demo_role_granted");
  });

  test("revokeDemoTestRole restores the read-only tier and is audited", () => {
    const fn = sessionSrc.match(
      /export const revokeDemoTestRole = internalMutation\(\{[\s\S]*?\n\}\);/,
    );
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toContain("if (!guestAuthEnabled())");
    expect(src).toContain("!target.isAnonymous");
    expect(src).toContain('role: "member"');
    expect(src).toContain("user.demo_role_revoked");
  });

  test("the expiry deadline is enforced in resolveAccess (server-side)", () => {
    // src/convex/access.ts ignores the elevated profile role once the hard
    // deadline passes, so expired grants can never authorize protected ops.
    expect(accessSrc).toContain("demoRoleExpiresAt");
    expect(accessSrc).toContain("const grantExpired =");
  });

  test("dev QA bridge exposes NO escalation helpers (harness-only grants)", () => {
    expect(devToolsSrc).not.toContain("upgradeDemoRole");
    expect(devToolsSrc).not.toContain("becomeDemoAdmin");
  });
});
