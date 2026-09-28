import { describe, expect, test } from "bun:test";
import {
  IITAMS_ROLES,
  roleHasPermission,
  guestAuthEnabled,
  type IitamsPermission,
  type IitamsRole,
} from "../src/convex/access";

/**
 * Role-model & tenant-isolation contract tests (Phase-1 closure, items 2–3).
 *
 * `resolveAccess` itself performs async Convex queries, so its DB-dependent
 * invariants are verified here as source-level regression guards: the test
 * reads `src/convex/access.ts` and `src/convex/session.ts` and asserts the
 * fail-closed structure is present. Any edit that reintroduces a first-org
 * fallback, guest fallback to a real org, or role inference silently fails
 * these tests.
 */

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const ALL_PERMISSIONS: IitamsPermission[] = [
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
];

const accessSrc = await Bun.file("src/convex/access.ts").text();
const sessionSrc = await Bun.file("src/convex/session.ts").text();

// ---------------------------------------------------------------------------
// Role registry (item 3: explicit role model)
// ---------------------------------------------------------------------------

describe("role registry", () => {
  test("defines exactly the three Phase-1 roles", () => {
    expect([...IITAMS_ROLES].sort()).toEqual(["admin", "member", "user"]);
  });

  test("unknown roles fail closed", () => {
    expect(
      roleHasPermission("superadmin" as unknown as IitamsRole, "dashboard.view"),
    ).toBe(false);
    expect(
      roleHasPermission(undefined, "dashboard.view"),
    ).toBe(false);
  });

  test("every registered role grants dashboard.view (operational baseline)", () => {
    for (const role of IITAMS_ROLES) {
      expect(roleHasPermission(role, "dashboard.view")).toBe(true);
    }
  });

  test("manage permissions follow the documented tier model", () => {
    // admin: full management
    for (const perm of ["audit.manage", "risk.manage", "compliance.manage", "cyber.manage", "bcm.manage", "admin.manage", "admin.view"] as const) {
      expect(roleHasPermission("admin", perm)).toBe(true);
    }
    // user: scoped operational management (audit + risk only)
    expect(roleHasPermission("user", "audit.manage")).toBe(true);
    expect(roleHasPermission("user", "risk.manage")).toBe(true);
    for (const perm of ["compliance.manage", "cyber.manage", "bcm.manage", "admin.manage", "admin.view"] as const) {
      expect(roleHasPermission("user", perm)).toBe(false);
    }
    // member: strictly read-only
    for (const perm of ["audit.manage", "risk.manage", "compliance.manage", "cyber.manage", "bcm.manage", "admin.manage", "admin.view"] as const) {
      expect(roleHasPermission("member", perm)).toBe(false);
    }
  });

  test("every permission is granted to at least one role (no dead permissions)", () => {
    for (const perm of ALL_PERMISSIONS) {
      const granted = IITAMS_ROLES.some((role) =>
        roleHasPermission(role, perm),
      );
      expect(granted).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation (item 2: no first-organization fallback; guests demo-only)
// ---------------------------------------------------------------------------

describe("tenant isolation invariants (source guards)", () => {
  test("access.ts contains no first-organization fallback", () => {
    // Any ordered/first() organization query would be a fallback. The ONLY
    // permitted org lookup is the explicit IITAMS-DEMO guest bootstrap.
    expect(accessSrc).not.toMatch(/\.order\(\s*"asc"\s*\)[\s\S]*?\.first\(\)/);
    expect(accessSrc).not.toMatch(/\.query\("organizations"\)[\s\S]*?\.first\(\)/);
    const orgLookups = accessSrc.match(
      /\.query\("organizations"\)[\s\S]*?\.unique\(\)/g,
    ) ?? [];
    expect(orgLookups.length).toBeGreaterThan(0);
    for (const lookup of orgLookups) {
      expect(lookup).toContain('"IITAMS-DEMO"');
    }
  });

  test("role is never inferred from permission strings", () => {
    // The legacy `permissions[]` field must not be read back as a role source.
    expect(accessSrc).not.toMatch(/profile\?\.permissions/);
    expect(accessSrc).not.toMatch(/role\s*=[^\n]*permissions/i);
    // The only role assignment beyond profile/user lookup is the documented
    // guest member-tier default.
    const roleAssignments = accessSrc.match(/^\s*role = .*$/gm) ?? [];
    expect(roleAssignments.length).toBe(1);
    expect(roleAssignments[0]).toContain('"member"');
  });

  test("dangling organization references are denied", () => {
    expect(accessSrc).toContain("organizationId = null; // dangling");
  });

  test("guest sessions may only attach to explicitly demo-flagged organizations", () => {
    expect(accessSrc).toContain("if (isGuest && !organizationIsDemo)");
    expect(accessSrc).toContain('q.eq("code", "IITAMS-DEMO")');
  });

  test("guest role default is scoped to anonymous demo sessions only", () => {
    expect(accessSrc).toContain('if (isGuest && organizationId !== null && role === undefined)');
  });

  test("guest policy is fail-closed on an explicit environment flag", () => {
    expect(accessSrc).toContain(
      'process.env.IITAMS_ALLOW_GUEST_AUTH === "true"',
    );
    expect(guestAuthEnabled()).toBe(false); // unset in test env → denied
  });

  test("session join mutation is guest-only and demo-org-only", () => {
    expect(sessionSrc).toContain("if (!user.isAnonymous)");
    expect(sessionSrc).toContain('q.eq("code", "IITAMS-DEMO")');
    expect(sessionSrc).toContain("org.isDemo !== true");
  });

  test("audit log writes are insert-only (immutability invariant, item 13)", async () => {
    const sources = [
      "src/convex/notifications.ts",
      "src/convex/seed.ts",
      "src/convex/session.ts",
    ];
    for (const file of sources) {
      const src = await Bun.file(file).text();
      const ops = src.match(/ctx\.db\.(insert|patch|replace|delete)\("auditLogs"/g) ?? [];
      expect(ops.length).toBeGreaterThan(0); // writes exist…
      for (const op of ops) {
        expect(op.startsWith("ctx.db.insert")).toBe(true); // …and are insert-only
      }
    }
    // the notification read-status patches target notifications, never auditLogs
    const notifSrc = await Bun.file("src/convex/notifications.ts").text();
    expect(notifSrc).toMatch(/ctx\.db\.patch\(args\.id/);
  });
});

// ---------------------------------------------------------------------------
// Dashboard critical-risk threshold (item 12: 5×5 critical band = 15–25)
// ---------------------------------------------------------------------------

describe("5×5 critical band", () => {
  test("criticalRisks uses the single >=15 threshold", async () => {
    const dashboardSrc = await Bun.file("src/convex/dashboard.ts").text();
    expect(dashboardSrc).toMatch(
      /residualLikelihood \* r\.residualImpact >= 15/,
    );
    expect(dashboardSrc).not.toMatch(/>=\s*15\s*\|\|/); // no redundant OR
    expect(dashboardSrc).not.toMatch(/>=\s*12/); // 12 is high, not critical
  });

  test("band boundaries behave as documented (pure arithmetic)", () => {
    const isCritical = (l: number, i: number) => l * i >= 15;
    // critical cells
    for (const [l, i] of [[3, 5], [4, 4], [4, 5], [5, 3], [5, 4], [5, 5]] as const) {
      expect(isCritical(l, i)).toBe(true);
    }
    // high cells (esp. the 12-score pair) must NOT be critical
    for (const [l, i] of [[3, 4], [4, 3], [3, 3], [2, 5], [4, 2]] as const) {
      expect(isCritical(l, i)).toBe(false);
    }
  });
});
