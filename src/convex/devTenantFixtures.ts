import { internalMutation } from "./_generated/server";
import { guestAuthEnabled } from "./access";

/**
 * DEVELOPMENT-ONLY tenant fixtures for behavioural isolation tests.
 * =================================================================
 * Creates two independent, explicitly demo-flagged organizations (A and B),
 * one verified non-anonymous member in each, and one risk record per tenant.
 * These fixtures exist so the risk-register test suite can prove cross-tenant
 * denial with a REAL second tenant instead of only a structural assertion.
 *
 * Safety properties:
 *  - `internalMutation`: not callable from any browser session, HTTP route or
 *    authenticated client; only a deployment-credential caller can run it
 *    (the trusted local test runner).
 *  - Refuses on any deployment that is not a development deployment
 *    (`guestAuthEnabled()` — the same gate as every other dev harness).
 *  - Idempotent: fixed organization codes / fixture emails are reused; nothing
 *    is ever deleted, replaced or migrated.
 *  - Never touches the shared demo organization, real organizations, real
 *    users or production data. An identity that already belongs to another
 *    organization is refused rather than reassigned.
 *  - The fixture users hold the ordinary `user` role (risk.view + risk.manage)
 *    — no administrator role, no elevated permission, no recovery bypass.
 */
export const ensureTenantFixtures = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!guestAuthEnabled()) {
      throw new Error("Tenant fixtures are only available on development deployments");
    }

    const now = Date.now();
    const specs = [
      {
        code: "IITAMS-TEST-A",
        name: "IITAMS Test Tenant A",
        email: "risk-tenant-a@iitams.test",
        riskTitle: "Tenant A fixture risk (payment gateway)",
      },
      {
        code: "IITAMS-TEST-B",
        name: "IITAMS Test Tenant B",
        email: "risk-tenant-b@iitams.test",
        riskTitle: "Tenant B fixture risk (records archive)",
      },
    ] as const;

    const organizations: Array<{
      organizationId: string;
      organizationCode: string;
      userId: string;
      email: string;
      riskId: string;
      riskCode: string;
    }> = [];

    for (const spec of specs) {
      const existingOrg = await ctx.db
        .query("organizations")
        .withIndex("code", (q) => q.eq("code", spec.code))
        .unique();
      if (existingOrg && existingOrg.isDemo !== true) {
        throw new Error(
          `Refused: ${spec.code} exists but is not an explicitly demo-flagged fixture organization`,
        );
      }
      const organizationId =
        existingOrg?._id ??
        (await ctx.db.insert("organizations", {
          name: spec.name,
          code: spec.code,
          type: "agency",
          description:
            "Isolated cross-tenant test fixture. Synthetic data only — not a real MDAC.",
          isDemo: true,
          createdAt: now,
          updatedAt: now,
        }));

      let user = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", spec.email))
        .unique();
      if (user && user.isAnonymous === true) {
        throw new Error(
          `Refused: ${spec.email} is an anonymous session, not a fixture identity`,
        );
      }
      if (!user) {
        const userId = await ctx.db.insert("users", {
          name: `${spec.name} member`,
          email: spec.email,
          emailVerificationTime: now,
          isAnonymous: false,
        });
        user = await ctx.db.get(userId);
      }
      if (!user) throw new Error("Fixture identity could not be created");

      const existingProfile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", user._id))
        .unique();
      if (
        existingProfile?.organizationId !== undefined &&
        existingProfile.organizationId !== organizationId
      ) {
        throw new Error(
          `Refused: ${spec.email} already belongs to another organization (fixtures never migrate memberships)`,
        );
      }
      if (!existingProfile) {
        await ctx.db.insert("userProfiles", {
          userId: user._id,
          organizationId,
          role: "user",
          jobTitle: "Risk fixture member",
          membershipStatus: "active",
          lastSeenAt: now,
        });
      }

      const existingRisk = await ctx.db
        .query("risks")
        .withIndex("by_organization", (q) => q.eq("organizationId", organizationId))
        .first();
      const riskId =
        existingRisk?._id ??
        (await ctx.db.insert("risks", {
          organizationId,
          code: "R-001",
          title: spec.riskTitle,
          category: "Cyber",
          description:
            "Isolated cross-tenant test fixture row. Synthetic data only.",
          inherentLikelihood: 4,
          inherentImpact: 4,
          residualLikelihood: 2,
          residualImpact: 2,
          status: "open",
          ownerName: "Fixture owner",
          reviewDue: now + 30 * 24 * 60 * 60 * 1000,
          isDemo: true,
          createdAt: now,
          updatedAt: now,
        }));

      organizations.push({
        organizationId: String(organizationId),
        organizationCode: spec.code,
        userId: String(user._id),
        email: spec.email,
        riskId: String(riskId),
        riskCode: existingRisk?.code ?? "R-001",
      });
    }

    // Tenant B also carries an overdue-review fixture so the review-overdue
    // indicator can be verified against real data. Tenant A deliberately has
    // none, which lets the test prove the count does not leak across tenants.
    const tenantB = organizations.find((o) => o.organizationCode === "IITAMS-TEST-B");
    if (tenantB) {
      const existingOverdue = await ctx.db
        .query("risks")
        .withIndex("by_organization_code", (q) =>
          q
            .eq("organizationId", tenantB.organizationId as never)
            .eq("code", "R-002"),
        )
        .unique();
      if (!existingOverdue) {
        await ctx.db.insert("risks", {
          organizationId: tenantB.organizationId as never,
          code: "R-002",
          title: "Tenant B overdue review fixture risk",
          category: "Process",
          inherentLikelihood: 3,
          inherentImpact: 4,
          residualLikelihood: 3,
          residualImpact: 3,
          status: "assessing",
          ownerName: "Fixture owner",
          reviewDue: now - 10 * 24 * 60 * 60 * 1000,
          isDemo: true,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return { organizations };
  },
});
