import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { guestAuthEnabled } from "./access";

/**
 * DEVELOPMENT-ONLY tenant fixtures for behavioural isolation tests.
 * =================================================================
 * Creates three independent, explicitly demo-flagged organizations (A, B and
 * M), one verified non-anonymous member in each, and one risk record per
 * tenant. A and B exist so the risk-register suite can prove cross-tenant
 * denial with REAL separate tenants instead of only a structural assertion;
 * M is the mutable tenant the monitoring suite writes its records to.
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
 *  - Tenant M exists because the monitoring suite must CREATE records: it
 *    writes there so tenants A and B keep containing only their fixture rows.
 *  - The cleanup mutations below are also `internalMutation`s behind the same
 *    development gate, operate ONLY on the three fixture organizations and
 *    never touch auditLogs, so repeat runs cannot grow the fixture data
 *    indefinitely while the audit trail stays append-only.
 */
/** Dedicated compliance-manager fixture identity (tenant M only). */
export const COMPLIANCE_FIXTURE_EMAIL = "compliance-manager-m@iitams.test";

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
      {
        // Dedicated MUTABLE tenant for the monitoring suite: that suite
        // deliberately writes risks, assessments and treatment rows, so it
        // owns this organization. A and B stay write-free after their fixture
        // rows so the cross-tenant suite can assert on their exact contents.
        code: "IITAMS-TEST-M",
        name: "IITAMS Test Tenant M",
        email: "risk-tenant-m@iitams.test",
        riskTitle: "Tenant M fixture risk (monitoring baseline)",
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

    // Tenant M additionally carries a COMPLIANCE MANAGER identity. Compliance
    // writes require `compliance.manage`, which no read-only role holds, so the
    // compliance suite needs one writer in a disposable organization. It lives
    // in tenant M only: tenants A and B stay at the ordinary `user` role, which
    // keeps the read-only assertions of the risk suites intact.
    let complianceAdmin: {
      organizationId: string;
      organizationCode: string;
      userId: string;
      email: string;
    } | null = null;
    const tenantM = organizations.find(
      (o) => o.organizationCode === "IITAMS-TEST-M",
    );
    if (tenantM) {
      const email = COMPLIANCE_FIXTURE_EMAIL;
      let fixtureUser = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      if (fixtureUser && fixtureUser.isAnonymous === true) {
        throw new Error(
          `Refused: ${email} is an anonymous session, not a fixture identity`,
        );
      }
      if (!fixtureUser) {
        const userId = await ctx.db.insert("users", {
          name: "IITAMS Test Tenant M compliance manager",
          email,
          emailVerificationTime: now,
          isAnonymous: false,
        });
        fixtureUser = await ctx.db.get(userId);
      }
      if (!fixtureUser) throw new Error("Fixture identity could not be created");

      const profile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", fixtureUser._id))
        .unique();
      if (
        profile?.organizationId !== undefined &&
        profile.organizationId !== (tenantM.organizationId as never)
      ) {
        throw new Error(
          `Refused: ${email} already belongs to another organization (fixtures never migrate memberships)`,
        );
      }
      if (!profile) {
        await ctx.db.insert("userProfiles", {
          userId: fixtureUser._id,
          organizationId: tenantM.organizationId as never,
          // Admin ONLY inside the disposable, demo-flagged fixture tenant: it
          // is the minimum role in the registry that holds compliance.manage.
          role: "admin",
          jobTitle: "Compliance fixture manager",
          membershipStatus: "active",
          lastSeenAt: now,
        });
      }
      complianceAdmin = {
        organizationId: tenantM.organizationId,
        organizationCode: tenantM.organizationCode,
        userId: String(fixtureUser._id),
        email,
      };
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

    return { organizations, complianceAdmin };
  },
});

/**
 * Fixture organizations these cleanup helpers may ever write to, with the
 * exact baseline risks `ensureTenantFixtures` maintains in each. Anything
 * outside this allowlist is refused outright, so the helpers cannot be
 * repurposed to sweep real tenant data.
 */
const FIXTURE_BASELINE_CODES: Record<string, readonly string[]> = {
  "IITAMS-TEST-A": ["R-001"],
  "IITAMS-TEST-B": ["R-001", "R-002"],
  "IITAMS-TEST-M": ["R-001"],
};

async function fixtureOrganization(ctx: MutationCtx, code: string) {
  const org = await ctx.db
    .query("organizations")
    .withIndex("code", (q) => q.eq("code", code))
    .unique();
  if (!org) return null;
  if (org.isDemo !== true || !(org.code in FIXTURE_BASELINE_CODES)) {
    throw new Error(`Refused: ${code} is not an explicitly demo-flagged fixture organization`);
  }
  return org;
}

/**
 * Delete one treatment plan and its actions that a test created inside a
 * fixture organization. Scoped by id, refuses non-fixture organizations, and
 * leaves auditLogs untouched (the audit trail is append-only).
 */
export const deleteFixtureTreatmentPlan = internalMutation({
  args: { planId: v.id("riskTreatmentPlans") },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Fixture cleanup is only available on development deployments");
    }
    const plan = await ctx.db.get(args.planId);
    if (!plan) return { deletedActions: 0, deletedPlans: 0 };
    const org = await ctx.db.get(plan.organizationId);
    if (!org || org.isDemo !== true || !(org.code in FIXTURE_BASELINE_CODES)) {
      throw new Error("Refused: treatment plans can only be removed from fixture organizations");
    }
    const actions = await ctx.db
      .query("riskTreatmentActions")
      .withIndex("by_plan", (q) => q.eq("planId", plan._id))
      .take(200);
    for (const action of actions) {
      // Only delete actions that belong to this plan and this same org.
      if (action.organizationId !== plan.organizationId) continue;
      await ctx.db.delete(action._id);
    }
    await ctx.db.delete(plan._id);
    return { deletedActions: actions.length, deletedPlans: 1 };
  },
});

/**
 * Remove the framework adoption and control records the compliance suite creates
 * in its disposable fixture organization (IITAMS-TEST-M).
 *
 * Scope mirrors `resetFixtureRecords`: development deployments only, tenant M
 * only while it is demo-flagged, bounded batches, and `auditLogs` are never
 * touched (the compliance audit trail stays append-only).
 */
export const resetComplianceFixtures = internalMutation({
  args: { maxRecords: v.optional(v.number()) },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Fixture cleanup is only available on development deployments");
    }
    const org = await fixtureOrganization(ctx, "IITAMS-TEST-M");
    if (!org) {
      return { deletedControls: 0, deletedFrameworks: 0, remaining: 0 };
    }
    const requested = args.maxRecords ?? 25;
    const maxRecords = Math.min(Math.max(Math.floor(requested), 1), 50);

    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const controlBatch = controls.slice(0, maxRecords);
    for (const control of controlBatch) {
      await ctx.db.delete(control._id);
    }

    const frameworks = await ctx.db
      .query("complianceFrameworks")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const frameworkBatch = [];
    for (const framework of frameworks) {
      if (frameworkBatch.length >= maxRecords) break;
      // Re-read this framework's controls rather than trusting the page above:
      // a framework is only removed once it has NO controls left, so the
      // cleanup can never orphan register rows.
      const remainingControls = await ctx.db
        .query("controls")
        .withIndex("by_organization_framework", (q) =>
          q.eq("organizationId", org._id).eq("frameworkId", framework._id),
        )
        .first();
      if (remainingControls) continue;
      await ctx.db.delete(framework._id);
      frameworkBatch.push(framework._id);
    }

    return {
      deletedControls: controlBatch.length,
      deletedFrameworks: frameworkBatch.length,
      remaining: Math.max(
        controls.length - controlBatch.length + frameworks.length - frameworkBatch.length,
        0,
      ),
    };
  },
});

/**
 * Remove records a test run created inside a fixture organization, so repeated
 * local runs cannot grow the fixtures indefinitely.
 *
 * Scope is deliberately narrow:
 *  - development deployments only (same gate as every other dev harness);
 *  - the three `IITAMS-TEST-*` fixture organizations only, and only while
 *    they are still demo-flagged; a real organization is refused outright;
 *  - with `titleTag`, only risks carrying that explicit test-run tag; without
 *    it, only risks outside the organization's `ensureTenantFixtures`
 *    baseline (`R-001`, plus `R-002` in tenant B);
 *  - cascades to that risk's assessments, treatment plans and actions, because
 *    those rows exist only inside this sandbox and are meaningless without
 *    their risk;
 *  - never deletes `auditLogs` — audit history stays append-only.
 *
 * Batched so one call stays well inside a Convex transaction: the caller loops
 * until `remaining` is 0.
 */
export const resetFixtureRecords = internalMutation({
  args: {
    organizationCode: v.string(),
    /** Optional explicit test-run tag; omit to reset the disposable tenant. */
    titleTag: v.optional(v.string()),
    maxRisks: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Fixture cleanup is only available on development deployments");
    }
    const org = await fixtureOrganization(ctx, args.organizationCode);
    if (!org) {
      return { deletedRisks: 0, deletedPlans: 0, deletedActions: 0, deletedAssessments: 0, remaining: 0 };
    }
    const baselines = FIXTURE_BASELINE_CODES[org.code] ?? [];
    const tag = args.titleTag?.trim();
    if (tag !== undefined && !/^\[iitams-[a-z0-9-]+\]$/.test(tag)) {
      throw new Error("Refused: a fixture cleanup tag must look like [iitams-test-name]");
    }

    const requested = args.maxRisks ?? 10;
    const maxRisks = Math.min(Math.max(Math.floor(requested), 1), 25);
    const risks = await ctx.db
      .query("risks")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const removable = risks.filter((risk) =>
      tag ? risk.title.startsWith(tag) : !baselines.includes(risk.code),
    );
    const batch = removable.slice(0, maxRisks);

    let deletedPlans = 0;
    let deletedActions = 0;
    let deletedAssessments = 0;
    for (const risk of batch) {
      const plans = await ctx.db
        .query("riskTreatmentPlans")
        .withIndex("by_organization_risk", (q) =>
          q.eq("organizationId", org._id).eq("riskId", risk._id),
        )
        .take(100);
      for (const plan of plans) {
        const actions = await ctx.db
          .query("riskTreatmentActions")
          .withIndex("by_plan", (q) => q.eq("planId", plan._id))
          .take(100);
        for (const action of actions) {
          if (action.organizationId !== org._id) continue;
          await ctx.db.delete(action._id);
          deletedActions += 1;
        }
        await ctx.db.delete(plan._id);
        deletedPlans += 1;
      }
      const assessments = await ctx.db
        .query("riskAssessments")
        .withIndex("by_organization_risk", (q) =>
          q.eq("organizationId", org._id).eq("riskId", risk._id),
        )
        .take(200);
      for (const assessment of assessments) {
        await ctx.db.delete(assessment._id);
        deletedAssessments += 1;
      }
      await ctx.db.delete(risk._id);
    }

    return {
      deletedRisks: batch.length,
      deletedPlans,
      deletedActions,
      deletedAssessments,
      remaining: Math.max(removable.length - batch.length, 0),
    };
  },
});
