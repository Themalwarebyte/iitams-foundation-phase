import { v } from "convex/values";
import { internalMutation, type MutationCtx } from "./_generated/server";
import { guestAuthEnabled } from "./access";
import { effectiveMembershipStatus } from "../lib/membership";

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
/**
 * Cybersecurity manager fixture identity in tenant A. Batch 2A needs a role
 * that actually holds `cyber.manage` INSIDE a second organization, so a
 * cross-tenant write attempt fails on ownership rather than merely on the
 * permission gate.
 */
export const CYBER_MANAGER_A_EMAIL = "cyber-manager-a@iitams.test";
/**
 * Second tenant-M compliance manager, used to prove that independent review is
 * recorded by a DIFFERENT person from the assessor.
 */
export const COMPLIANCE_REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";

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
      {
        // Dedicated SCALE tenant for the register-pagination suite. It is the
        // only fixture whose register is deliberately grown past every single
        // listing window, so multi-page traversal, summary sampling and
        // identifier allocation are exercised against an isolated organization
        // instead of the shared demo register.
        code: "IITAMS-TEST-P",
        name: "IITAMS Test Tenant P",
        email: "risk-tenant-p@iitams.test",
        riskTitle: "Tenant P fixture risk (pagination baseline)",
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
    let complianceReviewer: {
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

      // A second manager in the SAME disposable tenant, so separation of duties
      // (reviewer ≠ assessor) can be exercised positively rather than only by
      // asserting the refusal.
      const reviewerEmail = COMPLIANCE_REVIEWER_EMAIL;
      let reviewerUser = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", reviewerEmail))
        .unique();
      if (reviewerUser && reviewerUser.isAnonymous === true) {
        throw new Error(
          `Refused: ${reviewerEmail} is an anonymous session, not a fixture identity`,
        );
      }
      if (!reviewerUser) {
        const userId = await ctx.db.insert("users", {
          name: "IITAMS Test Tenant M compliance reviewer",
          email: reviewerEmail,
          emailVerificationTime: now,
          isAnonymous: false,
        });
        reviewerUser = await ctx.db.get(userId);
      }
      if (!reviewerUser) {
        throw new Error("Fixture reviewer identity could not be created");
      }
      const reviewerProfile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", reviewerUser!._id))
        .unique();
      if (
        reviewerProfile?.organizationId !== undefined &&
        reviewerProfile.organizationId !== (tenantM.organizationId as never)
      ) {
        throw new Error(
          `Refused: ${reviewerEmail} already belongs to another organization (fixtures never migrate memberships)`,
        );
      }
      if (!reviewerProfile) {
        await ctx.db.insert("userProfiles", {
          userId: reviewerUser._id,
          organizationId: tenantM.organizationId as never,
          role: "admin",
          jobTitle: "Compliance fixture reviewer",
          membershipStatus: "active",
          lastSeenAt: now,
        });
      }
      complianceReviewer = {
        organizationId: tenantM.organizationId,
        organizationCode: tenantM.organizationCode,
        userId: String(reviewerUser._id),
        email: reviewerEmail,
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

    // Tenant A additionally carries a CYBERSECURITY MANAGER identity. The risk
    // fixture identities in A and B stay at the ordinary `user` role; this
    // identity only exists so the cyber suites can attempt a write across
    // organizations with a role that genuinely holds cyber.manage.
    let cyberManagerA: {
      organizationId: string;
      organizationCode: string;
      userId: string;
      email: string;
    } | null = null;
    const tenantA = organizations.find(
      (o) => o.organizationCode === "IITAMS-TEST-A",
    );
    if (tenantA) {
      const email = CYBER_MANAGER_A_EMAIL;
      let cyberUser = await ctx.db
        .query("users")
        .withIndex("email", (q) => q.eq("email", email))
        .unique();
      if (cyberUser && cyberUser.isAnonymous === true) {
        throw new Error(
          `Refused: ${email} is an anonymous session, not a fixture identity`,
        );
      }
      if (!cyberUser) {
        const userId = await ctx.db.insert("users", {
          name: "IITAMS Test Tenant A cybersecurity manager",
          email,
          emailVerificationTime: now,
          isAnonymous: false,
        });
        cyberUser = await ctx.db.get(userId);
      }
      if (!cyberUser) throw new Error("Fixture identity could not be created");
      const cyberProfile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", cyberUser!._id))
        .unique();
      if (
        cyberProfile?.organizationId !== undefined &&
        cyberProfile.organizationId !== (tenantA.organizationId as never)
      ) {
        throw new Error(
          `Refused: ${email} already belongs to another organization (fixtures never migrate memberships)`,
        );
      }
      if (!cyberProfile) {
        await ctx.db.insert("userProfiles", {
          userId: cyberUser._id,
          organizationId: tenantA.organizationId as never,
          // Admin only inside the disposable, demo-flagged fixture tenant: it
          // is the minimum registry role that holds cyber.manage.
          role: "admin",
          jobTitle: "Cybersecurity fixture manager",
          membershipStatus: "active",
          lastSeenAt: now,
        });
      }
      cyberManagerA = {
        organizationId: tenantA.organizationId,
        organizationCode: tenantA.organizationCode,
        userId: String(cyberUser._id),
        email,
      };
    }

    return {
      organizations,
      complianceAdmin,
      complianceReviewer,
      cyberManagerA,
    };
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
  "IITAMS-TEST-P": ["R-001"],
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

/** The synthetic access-review identities the bulk capture suite provisions. */
const BULK_TEST_EMAIL = /^bulk-[a-z0-9-]+@check\.example$/i;

/**
 * DEVELOPMENT-ONLY test-fixture hygiene for the SHARED demo organization.
 * ======================================================================
 * The access-review suite provisions ~205 synthetic members (`bulk-*@
 * check.example`) per run to exercise >200-membership capture. Without
 * retirement those identities accumulate in the demo organization and inflate
 * every later snapshot scan.
 *
 * Safety properties:
 *  - internalMutation behind the development gate (never reachable from a
 *    browser, HTTP route or authenticated client);
 *  - only the demo-flagged `IITAMS-DEMO` organization is touched, and only
 *    profiles whose user email matches the synthetic bulk pattern;
 *  - SUSPENDS the membership (reversible, audited, nothing deleted): the
 *    profile, its user and the audit trail are all preserved;
 *  - never touches real members, roles, controls, evidence or audit rows.
 */
export const retireBulkTestMemberships = internalMutation({
  args: {
    maxRecords: v.optional(v.number()),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Fixture cleanup is only available on development deployments");
    }
    const org = await ctx.db
      .query("organizations")
      .withIndex("code", (q) => q.eq("code", "IITAMS-DEMO"))
      .unique();
    if (!org) return { suspended: 0, isDone: true, continueCursor: null };
    if (org.isDemo !== true) {
      throw new Error("Refused: the demo organization is not demo-flagged");
    }
    const requested = args.maxRecords ?? 200;
    const maxRecords = Math.min(Math.max(Math.floor(requested), 1), 400);

    // Cursor-paginated so one call stays inside the transaction read limit; the
    // caller resumes with `continueCursor` until `isDone`.
    const page = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .paginate({ numItems: 400, cursor: args.cursor ?? null });

    let suspended = 0;
    for (const profile of page.page) {
      if (suspended >= maxRecords) break;
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") continue;
      const user = await ctx.db.get(profile.userId);
      if (!BULK_TEST_EMAIL.test(user?.email ?? "")) continue;
      await ctx.db.patch(profile._id, { membershipStatus: "suspended" });
      suspended += 1;
    }

    if (suspended > 0) {
      await ctx.db.insert("auditLogs", {
        organizationId: org._id,
        action: "fixture.bulk_test_memberships_suspended",
        entityType: "userProfiles",
        actorLabel: "Development fixture cleanup",
        summary: `${suspended} synthetic access-review membership(s) suspended so repeated test runs do not inflate the demo organization`,
        createdAt: Date.now(),
      });
    }

    return {
      suspended,
      isDone: page.isDone,
      continueCursor: page.isDone ? null : page.continueCursor,
    };
  },
});

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
      return {
        deletedControls: 0,
        deletedFrameworks: 0,
        deletedTests: 0,
        deletedEvidence: 0,
        deletedMappings: 0,
        deletedAssessments: 0,
        deletedAssessmentItems: 0,
        deletedAssessmentEvidence: 0,
        deletedFindings: 0,
        deletedRemediationActions: 0,
        deletedFindingEvents: 0,
        remaining: 0,
      };
    }
    const requested = args.maxRecords ?? 25;
    const maxRecords = Math.min(Math.max(Math.floor(requested), 1), 50);

    // Phase 3C records are removed innermost first, so a control is never
    // deleted while assessments, tests, evidence or mappings still reference
    // it. Evidence blobs are removed from storage as well, so the cleanup
    // leaves no orphaned files behind. Findings go first: their remediation
    // actions reference the finding, which in turn references the framework,
    // control and assessment cycle it arose from.
    const findingEvents = await ctx.db
      .query("complianceFindingEvents")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const findingEventBatch = findingEvents.slice(0, maxRecords * 4);
    for (const event of findingEventBatch) {
      await ctx.db.delete(event._id);
    }

    const remediationActions = await ctx.db
      .query("complianceRemediationActions")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const remediationBatch = remediationActions.slice(0, maxRecords * 4);
    for (const action of remediationBatch) {
      await ctx.db.delete(action._id);
    }

    const findings = await ctx.db
      .query("complianceFindings")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const findingBatch = findings.slice(0, maxRecords);
    for (const finding of findingBatch) {
      await ctx.db.delete(finding._id);
    }

    const assessmentEvidence = await ctx.db
      .query("complianceAssessmentEvidence")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const assessmentEvidenceBatch = assessmentEvidence.slice(0, maxRecords * 4);
    for (const link of assessmentEvidenceBatch) {
      await ctx.db.delete(link._id);
    }

    const assessmentItems = await ctx.db
      .query("complianceAssessmentItems")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const assessmentItemBatch = assessmentItems.slice(0, maxRecords * 4);
    for (const item of assessmentItemBatch) {
      await ctx.db.delete(item._id);
    }

    const assessments = await ctx.db
      .query("complianceAssessments")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const assessmentBatch = assessments.slice(0, maxRecords);
    for (const assessment of assessmentBatch) {
      await ctx.db.delete(assessment._id);
    }

    const mappings = await ctx.db
      .query("complianceEvidenceMappings")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const mappingBatch = mappings.slice(0, maxRecords * 4);
    for (const mapping of mappingBatch) {
      await ctx.db.delete(mapping._id);
    }

    const evidence = await ctx.db
      .query("complianceEvidence")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const evidenceBatch = evidence.slice(0, maxRecords);
    for (const record of evidenceBatch) {
      if (record.storageId) await ctx.storage.delete(record.storageId);
      await ctx.db.delete(record._id);
    }

    const tests = await ctx.db
      .query("complianceControlTests")
      .withIndex("by_organization", (q) => q.eq("organizationId", org._id))
      .take(200);
    const testBatch = tests.slice(0, maxRecords);
    for (const test of testBatch) {
      await ctx.db.delete(test._id);
    }

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
      // Re-read this framework's children rather than trusting the pages above:
      // a framework is only removed once it has NO controls and NO tests left,
      // so the cleanup can never orphan register or test rows.
      const remainingControls = await ctx.db
        .query("controls")
        .withIndex("by_organization_framework", (q) =>
          q.eq("organizationId", org._id).eq("frameworkId", framework._id),
        )
        .first();
      if (remainingControls) continue;
      const remainingTests = await ctx.db
        .query("complianceControlTests")
        .withIndex("by_organization_framework", (q) =>
          q.eq("organizationId", org._id).eq("frameworkId", framework._id),
        )
        .first();
      if (remainingTests) continue;
      const remainingAssessments = await ctx.db
        .query("complianceAssessments")
        .withIndex("by_organization_framework", (q) =>
          q.eq("organizationId", org._id).eq("frameworkId", framework._id),
        )
        .first();
      if (remainingAssessments) continue;
      const remainingFindings = await ctx.db
        .query("complianceFindings")
        .withIndex("by_organization_framework", (q) =>
          q.eq("organizationId", org._id).eq("frameworkId", framework._id),
        )
        .first();
      if (remainingFindings) continue;
      await ctx.db.delete(framework._id);
      frameworkBatch.push(framework._id);
    }

    return {
      deletedControls: controlBatch.length,
      deletedFrameworks: frameworkBatch.length,
      deletedTests: testBatch.length,
      deletedEvidence: evidenceBatch.length,
      deletedMappings: mappingBatch.length,
      deletedAssessments: assessmentBatch.length,
      deletedAssessmentItems: assessmentItemBatch.length,
      deletedAssessmentEvidence: assessmentEvidenceBatch.length,
      deletedFindings: findingBatch.length,
      deletedRemediationActions: remediationBatch.length,
      deletedFindingEvents: findingEventBatch.length,
      remaining: Math.max(
        controls.length -
          controlBatch.length +
          frameworks.length -
          frameworkBatch.length +
          tests.length -
          testBatch.length +
          evidence.length -
          evidenceBatch.length +
          mappings.length -
          mappingBatch.length +
          assessments.length -
          assessmentBatch.length +
          assessmentItems.length -
          assessmentItemBatch.length +
          assessmentEvidence.length -
          assessmentEvidenceBatch.length +
          findings.length -
          findingBatch.length +
          remediationActions.length -
          remediationBatch.length +
          findingEvents.length -
          findingEventBatch.length,
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

/**
 * DEVELOPMENT-ONLY bulk risk seeding for the register-pagination suite.
 * ======================================================================
 * The pagination requirements (reach every record, traverse many pages, be
 * honest about summary sampling) can only be proven against a register larger
 * than one listing window. This mutation grows a FIXTURE organization's
 * register in bounded batches so the suite can exercise that scale without
 * touching the shared demo organization or any real tenant.
 *
 * Safety properties:
 *  - `internalMutation` behind the development gate: not reachable from a
 *    browser, HTTP route or authenticated client;
 *  - only an explicitly demo-flagged fixture organization is accepted, and the
 *    batch size is capped so one call stays inside a Convex transaction;
 *  - every seeded row carries the caller's `[iitams-…]` title tag, so
 *    `resetFixtureRecords` (which deletes by that tag) can remove exactly these
 *    rows again and nothing else. Codes continue the organization's real
 *    sequence and are re-checked against the unique index, so seeded rows can
 *    never collide with a record created through the API;
 *  - no audit entry is fabricated: seed rows are test data, and the identifiers
 *    they consume remain permanently unused (the register never reuses codes).
 */
export const seedFixtureRisks = internalMutation({
  args: {
    organizationCode: v.string(),
    titleTag: v.string(),
    count: v.number(),
  },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Fixture seeding is only available on development deployments");
    }
    const org = await fixtureOrganization(ctx, args.organizationCode);
    if (!org) throw new Error(`Unknown fixture organization: ${args.organizationCode}`);

    const tag = args.titleTag.trim();
    if (!/^\[iitams-[a-z0-9-]+\]$/.test(tag)) {
      throw new Error("Refused: a fixture seeding tag must look like [iitams-test-name]");
    }
    const count = Math.floor(args.count);
    if (!Number.isInteger(count) || count < 1 || count > 250) {
      throw new Error("Refused: seed between 1 and 250 risks per call");
    }

    const latest = await ctx.db
      .query("risks")
      .withIndex("by_organization_code", (q) =>
        q.eq("organizationId", org._id),
      )
      .order("desc")
      .take(1);
    let next = 1;
    for (const row of latest) {
      const match = /^R-(\d+)$/.exec(row.code);
      if (match) next = Math.max(next, Number(match[1]) + 1);
    }

    const now = Date.now();
    let firstCode = "";
    let lastCode = "";
    const categories = ["Cyber", "Process", "Data", "Third-party"] as const;
    for (let i = 0; i < count; i += 1) {
      // The unique index is the authority: increment until the code is free.
      let code = `R-${String(next).padStart(3, "0")}`;
      for (let guard = 0; guard < 1000; guard += 1) {
        const clash = await ctx.db
          .query("risks")
          .withIndex("by_organization_code", (q) =>
            q.eq("organizationId", org._id).eq("code", code),
          )
          .unique();
        if (!clash) break;
        next += 1;
        code = `R-${String(next).padStart(3, "0")}`;
      }
      await ctx.db.insert("risks", {
        organizationId: org._id,
        code,
        title: `${tag} seeded risk ${i + 1}`,
        category: categories[i % categories.length],
        description: "Synthetic pagination fixture row — not a real risk.",
        inherentLikelihood: ((i % 5) + 1) as number,
        inherentImpact: (((i + 2) % 5) + 1) as number,
        residualLikelihood: (((i + 1) % 5) + 1) as number,
        residualImpact: (((i + 3) % 5) + 1) as number,
        status: i % 7 === 0 ? "mitigating" : "open",
        ownerName: "Fixture owner",
        reviewDue: now + 30 * 24 * 60 * 60 * 1000,
        isDemo: true,
        createdAt: now,
        updatedAt: now,
      });
      if (i === 0) firstCode = code;
      lastCode = code;
      next += 1;
    }

    return { inserted: count, firstCode, lastCode };
  },
});
