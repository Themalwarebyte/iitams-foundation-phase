import { describe, expect, test } from "bun:test";
import {
  MEMBERSHIP_STATUSES,
  MEMBERSHIP_STATUS_LABELS,
  canChangeMembershipStatus,
  effectiveMembershipStatus,
  lastAdminGuardMessage,
} from "../src/lib/membership";

/**
 * Phase 3A — Batch 2A unit tests: User Membership Status & Lifecycle Controls.
 *
 * The transition state machine is pure domain logic and tested directly.
 * The Convex mutation and access-resolution denial run server-side, so they
 * are verified with source guards in the established style: any edit that
 * removes an authorization gate, tenant check, anti-lockout guard or
 * audit write fails loudly here.
 */

const adminSrc = await Bun.file("src/convex/admin.ts").text();
const accessSrc = await Bun.file("src/convex/access.ts").text();
const schemaSrc = await Bun.file("src/convex/schema.ts").text();
const sessionSrc = await Bun.file("src/convex/session.ts").text();

// ---------------------------------------------------------------------------
// Membership status domain model
// ---------------------------------------------------------------------------

describe("membership status model", () => {
  test("defines exactly the three lifecycle states", () => {
    expect([...MEMBERSHIP_STATUSES].sort()).toEqual([
      "active",
      "deactivated",
      "suspended",
    ]);
  });

  test("labels exist for every status", () => {
    for (const status of MEMBERSHIP_STATUSES) {
      expect(MEMBERSHIP_STATUS_LABELS[status].length).toBeGreaterThan(0);
    }
  });

  test("absent/legacy field resolves to active (no data migration)", () => {
    expect(effectiveMembershipStatus(undefined)).toBe("active");
    expect(effectiveMembershipStatus("suspended")).toBe("suspended");
  });
});

describe("membership transition machine", () => {
  test("permitted administrative transitions", () => {
    expect(canChangeMembershipStatus("active", "suspended")).toBe(true);
    expect(canChangeMembershipStatus("active", "deactivated")).toBe(true);
    expect(canChangeMembershipStatus("suspended", "active")).toBe(true);
    expect(canChangeMembershipStatus("suspended", "deactivated")).toBe(true);
    expect(canChangeMembershipStatus("deactivated", "active")).toBe(true);
  });

  test("rejects no-op writes and undeclared transitions", () => {
    for (const status of MEMBERSHIP_STATUSES) {
      expect(canChangeMembershipStatus(status, status)).toBe(false);
    }
    expect(canChangeMembershipStatus("deactivated", "suspended")).toBe(false);
  });

  test("last-admin guard message is defined", () => {
    expect(lastAdminGuardMessage()).toMatch(/last active administrator/i);
  });
});

// ---------------------------------------------------------------------------
// Batch 2A server-side authorization (source guards)
// ---------------------------------------------------------------------------

const mutationSrc = adminSrc.match(
  /export const setMembershipStatus = mutation\(\{[\s\S]*?\n\}\);/,
)?.[0] as string | undefined;

describe("setMembershipStatus authorization structure (source guards)", () => {
  test("the mutation exists with the membership status validator", () => {
    expect(mutationSrc).toBeDefined();
  });

  test("gated on admin.manage, not admin.view", () => {
    // Order matters structurally: the gate must run before any db access.
    expect(mutationSrc!.indexOf('requirePermission(ctx, "admin.manage")')).toBeLessThan(
      mutationSrc!.indexOf("ctx.db.get(args.profileId)"),
    );
  });

  test("target must resolve to a real membership of the caller's organization", () => {
    expect(mutationSrc).toContain("target.organizationId !== access.organizationId");
    expect(mutationSrc).toContain("Member not found in your organization");
  });

  test("administrators cannot change their own membership status", () => {
    expect(mutationSrc).toContain("target.userId === access.user._id");
    expect(mutationSrc).toContain("own membership status");
  });

  test("no-op writes are rejected via the transition machine", () => {
    expect(mutationSrc).toContain("canChangeMembershipStatus(current, args.status)");
  });

  test("the organization's last active administrator cannot be locked out", () => {
    expect(mutationSrc).toContain("otherActiveAdmins");
    expect(mutationSrc).toContain("p.role === \"admin\"");
    expect(mutationSrc).toContain(
      "effectiveMembershipStatus(p.membershipStatus) === \"active\"",
    );
    expect(mutationSrc).toContain("lastAdminGuardMessage()");
  });

  test("accepted changes are audited (append-only, with target identity)", () => {
    expect(mutationSrc).toContain("logAudit(ctx,");
    expect(mutationSrc).toContain("entityType: \"userProfiles\"");
    // The action registry covers suspended, deactivated and reactivated states.
    expect(adminSrc).toContain("user.membership_suspended");
    expect(adminSrc).toContain("user.membership_deactivated");
    expect(adminSrc).toContain("user.membership_activated");
  });

  test("membership status changes are patches, never deletes", () => {
    expect(mutationSrc).toMatch(/ctx\.db\.patch\(target\._id, \{ membershipStatus/);
    expect(mutationSrc).not.toContain("ctx.db.delete");
  });
});

// ---------------------------------------------------------------------------
// Server-side access denial for suspended/deactivated memberships
// ---------------------------------------------------------------------------

describe("access resolution denies inactive memberships (source guards)", () => {
  test("resolveAccess computes the effective membership state from the profile", () => {
    expect(accessSrc).toContain("effectiveMembershipStatus(profile?.membershipStatus)");
  });

  test("suspended/deactivated memberships lose organization context before any fallback", () => {
    // Structural check: the denial branch must clear the org context and must
    // sit ahead of the guest demo-org bootstrap so an inactive member cannot
    // regain context through the bootstrap path.
    const denyIndex = accessSrc.indexOf("organizationId && !membershipActive");
    const bootstrapIndex = accessSrc.indexOf("isGuest && guestAuthEnabled()");
    expect(denyIndex).toBeGreaterThan(-1);
    expect(bootstrapIndex).toBeGreaterThan(-1);
    expect(denyIndex).toBeLessThan(bootstrapIndex);
    // The denial branch nulls the context.
    const denyBody = accessSrc.slice(denyIndex, denyIndex + 400);
    expect(denyBody).toContain("organizationId = null;");
    expect(denyBody).toContain("organizationIsDemo = false;");
  });

  test("AccessContext exposes membershipStatus and isProvisioned inherits the denial", () => {
    expect(accessSrc).toContain("membershipStatus: MembershipStatus;");
    expect(accessSrc).toContain("membershipStatus: effectiveMembershipStatus(undefined)");
  });

  test("schema declares the membershipStatus field as an optional membership enum", () => {
    expect(schemaSrc).toContain("membershipStatus: v.optional(");
    expect(schemaSrc).toContain('v.literal("suspended"),');
    expect(schemaSrc).toContain("v.literal(\"deactivated\"),");
  });

  test("getSession surfaces membershipStatus so suspension is detectable in the UI", () => {
    expect(sessionSrc).toContain("membershipStatus: access.membershipStatus");
  });
});
