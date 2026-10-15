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

  test("every exported admin mutation is gated on admin.manage (Batch 2A)", () => {
    // The membership-lifecycle mutation is the only permitted write surface,
    // and it must always go through the=admin.manage gate.
    const mutations = (adminSrc.match(/export const \w+ = mutation\(\{/g) ?? []);
    expect(mutations.length).toBe(1);
    expect(mutations[0]).toContain("setMembershipStatus");
    const mutSrc = adminSrc.match(
      /export const setMembershipStatus = mutation\(\{[\s\S]*?\n\}\);/,
    );
    expect(mutSrc).not.toBeNull();
    expect(mutSrc![0]).toContain('requirePermission(ctx, "admin.manage")');
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
// Demo admin escalation (dev/test convenience — production fail-closed)
// ---------------------------------------------------------------------------

describe("demo admin escalation guardrails", () => {
  test("requestDemoAdminUpgrade is guest-only, demo-org-only and audited", () => {
    expect(sessionSrc).toContain("requestDemoAdminUpgrade");
    // Same refusal chain as the existing demo role upgrade.
    const fn = sessionSrc.match(
      /export const requestDemoAdminUpgrade = mutation\(\{[\s\S]*?\n\}\);/,
    );
    expect(fn).not.toBeNull();
    const src = fn![0];
    expect(src).toContain("!user.isAnonymous");
    expect(src).toContain("!guestAuthEnabled()");
    expect(src).toContain("!access.organizationIsDemo");
    expect(src).toContain('ctx.db.insert("auditLogs"');
  });

  test("dev QA bridge exposes becomeDemoAdmin (DEV bundle only)", () => {
    expect(devToolsSrc).toContain("becomeDemoAdmin");
  });
});
