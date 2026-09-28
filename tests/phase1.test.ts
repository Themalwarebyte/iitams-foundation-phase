import { describe, expect, test } from "bun:test";
import { NAV_GROUPS, NAV_INDEX } from "../src/lib/nav";
import {
  DEFAULT_PERMISSIONS,
  type PermissionSet,
} from "../src/lib/permissions";
import {
  CLASSIFICATION_META,
  SEVERITY_META,
} from "../src/lib/severity";
import {
  formatNumber,
  formatPercent,
  formatRelative,
} from "../src/lib/format";

// ---------------------------------------------------------------------------
// Navigation contract
// ---------------------------------------------------------------------------

describe("navigation model", () => {
  test("contains the eight Phase-1 groups in order", () => {
    expect(NAV_GROUPS.map((g) => g.label)).toEqual([
      "Overview",
      "Audit Management",
      "ICT Risk",
      "Compliance",
      "Cybersecurity Assurance",
      "Business Continuity",
      "Reports & Analytics",
      "Administration",
    ]);
  });

  test("every nav item has a unique path", () => {
    const paths = NAV_GROUPS.flatMap((g) => g.items.map((i) => i.path));
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("nav index mirrors the group items", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(NAV_INDEX.get(item.path)?.label).toBe(item.label);
        expect(NAV_INDEX.get(item.path)?.group).toBe(group.label);
      }
    }
  });

  test("every nav path is registered as a protected route in the router", async () => {
    const mainSrc = await Bun.file("src/main.tsx").text();
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.path === "/dashboard") continue; // dedicated route element
        expect(mainSrc).toContain(`"${item.path}"`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Permission model (client mirror of convex/access.ts)
// ---------------------------------------------------------------------------

describe("permission model", () => {
  const fullAdmin: PermissionSet = {
    dashboard: true,
    workspace: true,
    audit: true,
    risk: true,
    compliance: true,
    cyber: true,
    bcm: true,
    reports: true,
    admin: true,
    adminManage: true,
  };

  test("default permissions deny everything (fail closed)", () => {
    for (const value of Object.values(DEFAULT_PERMISSIONS)) {
      expect(value).toBe(false);
    }
  });

  test("nav item permissions are valid PermissionSet keys", () => {
    const keys = Object.keys(DEFAULT_PERMISSIONS);
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.permission) {
          expect(keys).toContain(item.permission);
        }
      }
    }
  });

  test("admin-gated nav items only exist in the Administration group", () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        if (item.permission === "admin") {
          expect(group.label).toBe("Administration");
        }
      }
    }
  });

  test("full-admin nav grants access to every module", () => {
    const gated = NAV_GROUPS.flatMap((g) => g.items).filter((i) => i.permission);
    for (const item of gated) {
      expect(fullAdmin[item.permission as keyof PermissionSet]).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Severity & classification tokens
// ---------------------------------------------------------------------------

describe("severity system", () => {
  test("defines exactly the five standard severities", () => {
    expect(Object.keys(SEVERITY_META).sort()).toEqual(
      ["critical", "high", "informational", "low", "medium"].sort(),
    );
  });

  test("every severity pairs an icon + label with its colour", () => {
    for (const meta of Object.values(SEVERITY_META)) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(typeof meta.icon).toBe("object"); // Lucide icons are forward-ref components
      expect(meta.badge).toContain("border-");
      expect(meta.color).toMatch(/^var\(--/);
    }
  });

  test("defines the four data classifications", () => {
    expect(Object.keys(CLASSIFICATION_META).sort()).toEqual(
      ["confidential", "internal", "public", "restricted"].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

describe("format helpers", () => {
  test("formatNumber uses en-KE grouping", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
    expect(formatNumber(null)).toBe("—");
  });

  test("formatPercent rounds and appends %", () => {
    expect(formatPercent(75.4)).toBe("75%");
    expect(formatPercent(undefined)).toBe("—");
  });

  test("formatRelative renders a suffixed distance", () => {
    const result = formatRelative(Date.now() - 60_000);
    expect(result).toMatch(/minute|second/);
  });
});
