import { describe, expect, test } from "bun:test";
import {
  PROVISIONABLE_INITIAL_ROLES,
  isProvisionableInitialRole,
  provisioningSafeRefusal,
} from "../src/lib/membership";

/**
 * Phase 3A — Batch 2B unit tests: Organization Member Provisioning & Initial
 * Role Assignment.
 *
 * `provisionMember` executes inside Convex (auth, async DB), so its
 * authorization and safety structure is verified with source guards in the
 * established style, plus direct tests of the pure role-eligibility policy.
 * Operational end-to-end coverage lives in tests/browser.provision.test.ts.
 */

const adminSrc = await Bun.file("src/convex/admin.ts").text();
const schemaSrc = await Bun.file("src/convex/schema.ts").text();
const pageSrc = await Bun.file(
  "src/components/iitams/admin/AdminUsersPage.tsx",
).text();
const sessionSrc = await Bun.file("src/convex/session.ts").text();
const auditAccessSrc = await Bun.file("src/convex/auditAccess.ts").text();

const mutationSrc = adminSrc.match(
  /export const provisionMember = mutation\(\{[\s\S]*?\n\}\);/,
)?.[0] as string | undefined;

// ---------------------------------------------------------------------------
// Initial-role eligibility policy (pure domain logic)
// ---------------------------------------------------------------------------

describe("initial role eligibility policy", () => {
  test("the privileged admin role is excluded from ordinary provisioning", () => {
    expect(isProvisionableInitialRole("admin")).toBe(false);
  });

  test("all other registered roles are supported initial roles", () => {
    expect([...PROVISIONABLE_INITIAL_ROLES]).toEqual([
      "user",
      "member",
      "audit_director",
      "audit_manager",
      "auditor",
      "audit_reviewer",
      "management_user",
      "executive_viewer",
    ]);
    for (const role of PROVISIONABLE_INITIAL_ROLES) {
      expect(isProvisionableInitialRole(role)).toBe(true);
    }
    expect(isProvisionableInitialRole("unknown_role")).toBe(false);
    expect(isProvisionableInitialRole("")).toBe(false);
  });

  test("the uniform safe refusal does not disclose cross-organization data", () => {
    const msg = provisioningSafeRefusal();
    expect(msg).toMatch(/not eligible for provisioning into your organization/i);
    // It may reference the CALLER's organization, but must never reveal
    // whether the target belongs to another organization or their state.
    expect(msg).not.toMatch(/another organization|other organization|belongs to|membership state|suspended|deactivated/i);
  });
});

// ---------------------------------------------------------------------------
// provisionMember authorization & safety structure (source guards)
// ---------------------------------------------------------------------------

describe("provisionMember authorization (source guards)", () => {
  test("the mutation exists and takes no organization argument", () => {
    expect(mutationSrc).toBeDefined();
    // The organization must come from the server-side access context: the
    // args surface contains only email / initialRole / jobTitle.
    expect(mutationSrc!.indexOf("args: {")).toBeLessThan(
      mutationSrc!.indexOf("organizationId"),
    );
    expect(mutationSrc).toContain("email: v.string()");
    expect(mutationSrc).toContain("initialRole: initialRoleArg");
    expect(mutationSrc).toContain("jobTitle: v.optional(v.string())");
  });

  test("gated on admin.manage and an active, provisioned caller context", () => {
    const dbAccess = mutationSrc!.search(/ctx\.db\s*\.?\s*query/);
    expect(mutationSrc!.indexOf('requirePermission(ctx, "admin.manage")')).toBeLessThan(
      dbAccess,
    );
    expect(mutationSrc).toContain("if (!access.isProvisioned)");
  });

  test("target resolution uses verified email identity via an indexed lookup", () => {
    // Canonicalization before lookup (Convex Auth stores lower-case identifiers).
    expect(mutationSrc).toContain('args.email.trim().toLowerCase()');
    expect(mutationSrc).toContain('withIndex("email"');
    // Verified ownership is required; nothing is created or re-marked.
    expect(mutationSrc).toContain("user.emailVerificationTime");
    expect(mutationSrc).not.toContain('insert("users"');
    expect(mutationSrc).not.toMatch(/patch\(user\._id/);
  });

  test("anonymous and unverified identities are refused (uniform safe error)", () => {
    expect(mutationSrc).toContain("user.isAnonymous === true");
    expect(mutationSrc).toContain("provisioningSafeRefusal()");
    // Uniform refusals: no-account/unverified/anonymous (combined),
    // self-address, existing membership (any org/status), pre-roled profile.
    const refusals = (mutationSrc!.match(/provisioningSafeRefusal\(\)/g) ?? []).length;
    expect(refusals).toBe(4);
  });

  test("no self-provisioning and no cross-organization transfers", () => {
    expect(mutationSrc).toContain("user._id === access.user._id");
    expect(mutationSrc).toContain("profile.organizationId");
  });

  test("existing memberships (any status, any organization) are refused, not rewritten", () => {
    expect(mutationSrc).toContain("if (profile.organizationId)");
    // Only unassigned profiles are completed; the write is a patch of
    // organizationId/role — the membership lifecycle fields are untouched, so
    // the newly provisioned membership resolves active implicitly.
    expect(mutationSrc).toContain("profile.role !== undefined");
    expect(mutationSrc).toMatch(/ctx\.db\.patch\(profile\._id, \{/);
    expect(mutationSrc).not.toContain("membershipStatus");
  });

  test("unassigned profiles complete in place — one profile per user, no duplicates", () => {
    // The insert branch only runs when no userProfiles row exists.
    const insertBranch = mutationSrc!.match(/await ctx\.db\.insert\("userProfiles"/);
    const profileLookup = mutationSrc!.indexOf('withIndex("userId"');
    expect(profileLookup).toBeLessThan(insertBranch!.index);
    expect(mutationSrc).toContain('withIndex("userId", (q) => q.eq("userId", user._id))');
  });

  test("the initial role is written server-side to the organization-scoped profile only", () => {
    expect(mutationSrc).toContain("role: args.initialRole");
    // Global auth role is never written (no users-table patches at all).
    expect(mutationSrc).not.toMatch(/\.patch\(.*"users"/);
  });

  test("every successful provisioning is audited with actor AND target identities", () => {
    expect(mutationSrc).toContain("logAudit(ctx,");
    expect(mutationSrc).toContain('action: "user.membership_provisioned"');
    expect(mutationSrc).toContain("actorId: access.user._id");
    expect(mutationSrc).toContain("userId: user._id");
    expect(mutationSrc).toContain('entityType: "userProfiles"');
  });

  test("the log remains insert-only (no patch/replace/delete of auditLogs)", () => {
    expect(adminSrc).not.toMatch(/ctx\.db\.(patch|replace|delete)\("auditLogs"/);
  });
});

// ---------------------------------------------------------------------------
// Schema + infrastructure guards
// ---------------------------------------------------------------------------

describe("audit-log actor identity (backward-compatible)", () => {
  test("auditLogs gains an optional actorId — existing rows stay valid", () => {
    expect(schemaSrc).toMatch(/actorId: v\.optional\(v\.id\("users"\)\)/);
  });

  test("logAudit forwards the acting principal", () => {
    expect(auditAccessSrc).toContain("actorId");
    expect(auditAccessSrc).toContain("actorId: input.actorId");
  });

  test("existing provisioning for other flows also records the actor", () => {
    // setMembershipStatus (Batch 2A) was upgraded to record actorId too.
    const statusSrc = adminSrc.match(
      /export const setMembershipStatus = mutation\(\{[\s\S]*?\n\}\);/,
    )!;
    expect(statusSrc[0]).toContain("actorId: access.user._id");
  });
});

// ---------------------------------------------------------------------------
// UI structure guards (the server remains authoritative)
// ---------------------------------------------------------------------------

describe("Add Existing User UI (source guards)", () => {
  test("the control renders only inside the adminManage UX gate", () => {
    expect(pageSrc).toContain("AddExistingUserDialog disabled={!canManage}");
    expect(pageSrc).toContain("canManage = session?.permissions?.adminManage === true");
  });

  test("there is no global user search/autocomplete surface", () => {
    // No backend call feeds recipient options: the email is typed manually
    // and validated by a client format check before server validation.
    expect(pageSrc).toContain('type="email"');
    expect(pageSrc).not.toMatch(/listUsers.{0,40}options|OptionItem|CommandInput/);
  });

  test("the form only offers server-approved initial roles (admin excluded)", () => {
    expect(pageSrc).toContain("INITIAL_ROLE_LABELS");
    // The role picker iterates ONLY the server-approved registry — it never
    // lists arbitrary roles (the administrative/admin role is therefore not
    // selectable; absence is asserted at unit level on the shared registry).
    expect(pageSrc).toContain("Object.keys(INITIAL_ROLE_LABELS)");
    expect(pageSrc).toContain("not offered here");
  });

  test("submission is confirmed, single-flight, and reports server errors as-is", () => {
    expect(pageSrc).toContain("setConfirming(true)");
    expect(pageSrc).toContain("submitting");
    expect(pageSrc).toContain("toast.error");
    expect(pageSrc).toContain("toast.success");
  });

  test("the directory refreshes reactively (useQuery stays the source of rows)", () => {
    expect(pageSrc).toContain('useQuery(api.admin.listUsers, {})');
  });
});

// ---------------------------------------------------------------------------
// Guest policy & dev test-identity seeding
// ---------------------------------------------------------------------------

describe("verified test-identity seeder (development only)", () => {
  test("seeded identities are non-anonymous, verified, and never auto-provisioned", () => {
    expect(sessionSrc).toContain("seedVerifiedTestUser");
    expect(sessionSrc).toContain("isAnonymous: false");
    expect(sessionSrc).toContain("emailVerificationTime: Date.now()");
    expect(sessionSrc).toContain("!guestAuthEnabled()");
    // No organization profile is created by the seeder.
    expect(sessionSrc).not.toMatch(/seedVerifiedTestUser[\s\S]*insert\("userProfiles"/);
  });

  test("backend authorization boundary: guest caller + demo organization only", () => {
    // Hardened (Batch 2B acceptance): the seeder is gated at the mutation —
    // guest auth must be explicitly enabled AND the caller must be an
    // anonymous guest attached to the explicitly demo-flagged organization.
    // External/unauthenticated or real callers are refused server-side, so
    // no external caller can create an email-verified account in production
    // without completing the real authentication process.
    const src = sessionSrc.slice(sessionSrc.indexOf("export const seedVerifiedTestUser"));
    expect(src).toContain("if (!guestAuthEnabled())");
    expect(src).toContain("resolveAccess(ctx)");
    expect(src).toContain("caller.isAnonymous !== true");
    expect(src).toContain("!access.organizationIsDemo");
    // Seeding is itself audited in the demo organization's trail.
    expect(src).toContain("system.seeded_test_identity");
    // Duplicate seeding of an existing address is refused (idempotent).
    expect(src).toContain('withIndex("email"');
  });
});
