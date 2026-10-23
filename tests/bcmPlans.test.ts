import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  BCM_GAP_TRANSITIONS,
  BCM_IMPACT_CATEGORIES,
  BCM_PLAN_TRANSITIONS,
  BCM_STRATEGY_TRANSITIONS,
  canTransitionGap,
  canTransitionPlan,
  canTransitionStrategy,
  planIsEditable,
  recoveryCapabilityDelta,
  type BcmImpacts,
} from "../src/lib/bcm";

/**
 * Phase 4A Batch 4.2 — Business Continuity: continuity plans, recovery
 * strategies and recovery gaps.
 *
 * Security and governance properties under test:
 *  - plans, strategies and gaps are organization-scoped; every referenced
 *    service, analysis and strategy id is re-validated;
 *  - writes need bcm.manage + an active membership, reads only bcm.view;
 *  - the preparer cannot review their own plan;
 *  - approved versions are immutable, corrections are numbered revisions, and
 *    supersession only happens on approval;
 *  - the BIA a version relied on is snapshotted, and a draft baseline is
 *    flagged rather than presented as approved;
 *  - a strategy's capability is an estimate; exercise verification is refused;
 *  - a gap is never closed by documenting a strategy;
 *  - every transition is attributed in the append-only history.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function sampleImpacts(): BcmImpacts {
  return Object.fromEntries(
    BCM_IMPACT_CATEGORIES.map((category) => [
      category,
      { severity: "high", notes: `${category} impact rationale for the plan suite` },
    ]),
  ) as BcmImpacts;
}

// ---------------------------------------------------------------------------
// Structural / pure
// ---------------------------------------------------------------------------

describe("BCM continuity plans — structure and vocabulary", () => {
  test("the plan, strategy and gap lifecycles are closed transition tables", () => {
    expect(canTransitionPlan("draft", "in_review")).toBe(true);
    expect(canTransitionPlan("in_review", "approved")).toBe(true);
    expect(canTransitionPlan("in_review", "returned")).toBe(true);
    expect(canTransitionPlan("returned", "in_review")).toBe(true);
    // No shortcuts: a draft can never be approved, an approval never reopens.
    expect(canTransitionPlan("draft", "approved")).toBe(false);
    expect(canTransitionPlan("approved", "draft")).toBe(false);
    expect(BCM_PLAN_TRANSITIONS.archived).toEqual([]);
    expect(planIsEditable("draft")).toBe(true);
    expect(planIsEditable("returned")).toBe(true);
    expect(planIsEditable("approved")).toBe(false);
    expect(planIsEditable("superseded")).toBe(false);

    expect(canTransitionStrategy("proposed", "adopted")).toBe(true);
    expect(canTransitionStrategy("adopted", "proposed")).toBe(false);
    expect(BCM_STRATEGY_TRANSITIONS.retired).toEqual([]);

    expect(canTransitionGap("open", "in_progress")).toBe(true);
    expect(canTransitionGap("in_progress", "resolved")).toBe(true);
    expect(canTransitionGap("resolved", "open")).toBe(false);
    expect(BCM_GAP_TRANSITIONS.accepted).toEqual([]);
  });

  test("capability comparison is arithmetic, never a compliance verdict", () => {
    expect(recoveryCapabilityDelta({ objectiveMinutes: 240, expectedMinutes: 300 })).toBe(60);
    expect(recoveryCapabilityDelta({ objectiveMinutes: 240, expectedMinutes: 120 })).toBe(-120);
    expect(recoveryCapabilityDelta({ objectiveMinutes: 240, expectedMinutes: undefined })).toBe(
      undefined,
    );
    const lib = read("src/lib/bcm.ts");
    expect(lib).toContain("recoveryCapabilityDelta");
    // No automatic claim that a strategy meets an objective.
    expect(lib).not.toMatch(/meetsObjective\s*[:=]\s*true/);
    expect(lib).not.toMatch(/objectiveMet\s*[:=]\s*true/);
  });

  test("approved plans are frozen and corrections need re-approval", () => {
    const server = read("src/convex/continuityPlans.ts");
    expect(server).toContain("Only a draft or returned plan can be edited");
    expect(server).toContain(
      "Recovery strategies can only be documented while the plan is a draft or returned for revision",
    );
    expect(server).toContain("A strategy of an approved plan is frozen");
    expect(server).toContain("the preparer cannot review their own continuity plan");
    expect(server).toContain("supersededByPlanId");
    expect(server).toContain("assertPlanTransition");
  });

  test("a strategy can never claim exercise verification yet", () => {
    const server = read("src/convex/continuityPlans.ts");
    expect(server).toContain("Recovery exercises are not part of this module yet");
    expect(server).toContain('args.capabilityEvidence === "exercise_verified"');
    // Gaps are independent records: documenting a strategy never touches them.
    expect(server).not.toMatch(/createStrategy[\s\S]{0,2000}recoveryGaps/);
    expect(server).toContain("An archived plan accepts no new recovery gaps");
  });

  test("the module adds no resilience score and no second permission system", () => {
    const server = read("src/convex/continuityPlans.ts");
    const core = read("src/convex/bcmCore.ts");
    for (const source of [server, core]) {
      expect(source).not.toMatch(/readinessScore/);
      expect(source).not.toMatch(/resilienceScore/);
      expect(source).not.toMatch(/maturityScore/);
    }
    expect(server).toContain("resolveBcmAccess");
    expect(server).toContain("requireBcmManager");
    expect(server).not.toMatch(/bcm\.[a-z_]*manage[a-z_]*:/);
  });

  test("the schema scopes and indexes the new records", () => {
    const schema = read("src/convex/schema.ts");
    for (const table of [
      "continuityPlans: defineTable",
      "recoveryStrategies: defineTable",
      "recoveryGaps: defineTable",
    ]) {
      expect(schema).toContain(table);
    }
    expect(schema).toContain(".index(\"by_organization_plan\", [\"organizationId\", \"planId\"])");
    expect(schema).toContain("biaStatusAtApproval");
    expect(schema).toContain("capabilityEvidence: bcmCapabilityEvidenceValidator");
    // continuityEvents now carries plan/strategy/gap attribution.
    expect(schema).toContain("planId: v.optional(v.id(\"continuityPlans\"))");
  });

  test("the plan pages and routes are real, not placeholders", () => {
    const main = read("src/main.tsx");
    expect(main).toContain("BcmPlansPage");
    expect(main).toContain("BcmPlanDetailPage");
    expect(main).toContain('path="/bcm/plans"');
    expect(main).toContain('path="/bcm/plans/:planId"');
    const nav = read("src/lib/nav.ts");
    expect(nav).toContain('path: "/bcm/plans"');
    expect(nav).not.toContain('path: "/bcm/dr-plans"');
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const RUN_TAG = `BCP-${Date.now().toString(36).toUpperCase().slice(-6)}`;
const DAY = 24 * 60 * 60 * 1000;

const MANAGER_EMAIL = "compliance-manager-m@iitams.test";
const REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";
const READ_ONLY_EMAIL = "risk-tenant-m@iitams.test";
const OTHER_TENANT_EMAIL = "cyber-manager-a@iitams.test";

function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    return "";
  }
}
const token = testerToken();

function devAdminKey(): string | null {
  try {
    const parsed = JSON.parse(
      readFileSync(join(process.cwd(), ".convex/local/default/config.json"), "utf8"),
    ) as { adminKey?: unknown };
    return typeof parsed.adminKey === "string" && parsed.adminKey.length > 0
      ? parsed.adminKey
      : null;
  } catch {
    return null;
  }
}

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
  const client = new ConvexHttpClient(CONVEX_URL);
  try {
    await (client as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, { provider: "email-otp", params: { email } });
    let code: string | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const res = await fetch(`${HARNESS}/api/dev-otp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        const data = (await res.json()) as { code?: string };
        if (data.code && /^\d{6}$/.test(data.code)) {
          code = data.code;
          break;
        }
      }
    }
    if (!code) return null;
    const finished = (await (client as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) (client as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
    return client;
  } catch {
    return null;
  }
}

const fixturesReady = (await (async () => {
  if (!(await serverUp()) || !token) return false;
  const key = devAdminKey();
  if (!key) return false;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(key);
  try {
    await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {});
    return true;
  } catch {
    return false;
  }
})());

const runtime = fixturesReady ? describe : describe.skip;

function serviceInput(ownerUserId: string, name: string) {
  return {
    name,
    description: "Citizen payment intake and reconciliation for the revenue service.",
    department: "Revenue operations",
    ownerUserId: ownerUserId as Id<"users">,
    operationalStatus: "active" as const,
    criticality: "critical" as const,
    ictDependencies: "Payment switch (vendor-hosted), core banking API",
    keyDependencies:
      "Revenue operations staff, payment switch supplier and the banking interface.",
    singlePointsOfFailure: "Single vendor-hosted payment switch instance",
  };
}

function biaInput(serviceId: Id<"businessServices">, ownerUserId: Id<"users">, title: string) {
  return {
    serviceId,
    title,
    ownerUserId,
    assessmentDate: Date.now() - 2 * DAY,
    reviewDueAt: Date.now() + 180 * DAY,
    disruptionScenario:
      "Loss of the primary payment switch for an extended period, including reconciliation.",
    scope: "Citizen payment intake and the nightly reconciliation feed",
    impacts: sampleImpacts(),
    keyDependencies: "Payment switch supplier and the core banking interface",
    singlePointsOfFailure: "Vendor-hosted switch has no active-active pair",
    existingRecoveryArrangements: "Nightly backups and a manual receipting workaround.",
    assumptions: "Staff can reach the alternate site and the supplier honours its window.",
    limitations: "No recovery exercise has been performed, so the objectives are untested.",
    criticalityRationale: "Revenue collection stops and statutory deadlines are missed.",
    rtoMinutes: 240,
    rpoMinutes: 60,
    mtpdMinutes: 480,
    minimumServiceLevel:
      "Manual receipting continues for critical payments with daily reconciliation.",
    recoveryPriority: "p1" as const,
    objectiveRationale:
      "Statutory settlement cut-off requires restoration within the same business day.",
    mtpdExceptionJustification: undefined,
  };
}

function planInput(
  serviceId: Id<"businessServices">,
  ownerUserId: Id<"users">,
  title: string,
  biaId?: Id<"businessImpactAnalyses">,
) {
  return {
    title,
    purpose:
      "Restore revenue collection for citizens and statutory settlement within the agreed objectives.",
    primaryServiceId: serviceId,
    additionalServiceIds: [] as Id<"businessServices">[],
    ownerUserId,
    ...(biaId ? { biaId } : {}),
    disruptionScenarios:
      "Extended loss of the payment switch, including the nightly reconciliation batch.",
    recoveryPriority: "p1" as const,
    scope: "Citizen payment intake, receipting and the nightly reconciliation feed.",
    exclusions: "Counter service at district offices is out of scope for this plan.",
    assumptions: "The alternate site is available and the supplier honours its support window.",
    reviewDueAt: Date.now() + 180 * DAY,
  };
}

function strategyInput(ownerUserId: Id<"users">, title: string) {
  return {
    title,
    objective: "Restore citizen payment intake on the standby switch.",
    disruptionScenario: "Primary payment switch unavailable for more than four hours.",
    recoveryApproach:
      "Fail over to the warm standby switch and re-point the reconciliation batch.",
    alternativeArrangements: "Staff process critical payments at the alternate site.",
    manualFallback: "Manual receipting with daily reconciliation by the finance team.",
    personnelRequirements: "Two payment operations engineers and one finance reconciler.",
    ictDependencies: "Standby switch, core banking API, reconciliation scheduler.",
    vendorDependencies: "Payment switch supplier support window of four hours.",
    facilitiesRequirements: "Alternate operations room with network connectivity.",
    minimumServiceLevel:
      "Critical payments continue within the minimum service level agreed in the analysis.",
    expectedRecoveryMinutes: 300,
    targetRtoMinutes: 240,
    targetRpoMinutes: 60,
    targetMtpdMinutes: 480,
    capabilityEvidence: "estimate" as const,
    capabilityRationale:
      "Based on the supplier's documented failover procedure; never exercised by this organization.",
    ownerUserId,
    statusRationale:
      "Proposed by the plan owner; adoption needs an explicit decision by continuity management.",
  };
}

runtime("business continuity plans (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);
  const otherTenantPromise = signInEmailOtp(OTHER_TENANT_EMAIL);

  let manager: ConvexHttpClient | null = null;
  let reviewer: ConvexHttpClient | null = null;
  let readOnly: ConvexHttpClient | null = null;
  let other: ConvexHttpClient | null = null;

  let managerUserId = "" as Id<"users">;
  let reviewerUserId = "" as Id<"users">;
  let serviceId: Id<"businessServices">;
  let approvedBiaId: Id<"businessImpactAnalyses">;
  let draftBiaId: Id<"businessImpactAnalyses">;
  let planId: Id<"continuityPlans">;
  let strategyId: Id<"recoveryStrategies">;
  let gapId: Id<"recoveryGaps">;

  async function createDraftPlan(
    title: string,
    biaId?: Id<"businessImpactAnalyses">,
  ): Promise<{ planId: Id<"continuityPlans">; reference: string }> {
    if (!manager) throw new Error("[test:PREREQ-FAILED] manager session unavailable");
    return (await manager.mutation(
      api.continuityPlans.createPlan,
      planInput(serviceId, reviewerUserId, title, biaId),
    )) as { planId: Id<"continuityPlans">; reference: string };
  }

  async function getPlan(id: Id<"continuityPlans">): Promise<{
    plan: {
      reference: string;
      version: number;
      status: string;
      editable: boolean;
      approvalNotes?: string | null;
      biaStatusAtApproval?: string | null;
      baseline: {
        biaReference: string | null;
        biaVersion: number | null;
        biaStatusAtApproval: string | null;
      };
      preparedByUserId: string;
      reviewedByUserId: string | null;
    };
    baseline: { approved: boolean; reference: string; rtoMinutes: number } | null;
    baselineWarning: string | null;
    strategies: Array<{
      _id: Id<"recoveryStrategies">;
      status: string;
      capabilityEvidence: string;
      rtoDeltaMinutes: number | null;
      reference: string;
    }>;
    gaps: Array<{ _id: Id<"recoveryGaps">; status: string; resolvedByLabel: string | null }>;
    versions: Array<{ _id: Id<"continuityPlans">; version: number; status: string }>;
    history: Array<{ type: string; actorLabel: string }>;
    canManage: boolean;
  }> {
    if (!manager) throw new Error("[test:PREREQ-FAILED] manager session unavailable");
    return (await manager.query(api.continuityPlans.getPlan, {
      planId: id,
    })) as never;
  }

  test("fixture identities and a baseline analysis are prepared", async () => {
    manager = await managerPromise;
    reviewer = await reviewerPromise;
    readOnly = await readOnlyPromise;
    other = await otherTenantPromise;
    if (!manager || !reviewer || !readOnly || !other) {
      throw new Error("[test:PREREQ-FAILED] fixture identities could not sign in");
    }
    const session = (await manager.query(api.session.getSession, {})) as {
      userId?: string;
    };
    managerUserId = (session.userId ?? "") as Id<"users">;
    const reviewerSession = (await reviewer.query(api.session.getSession, {})) as {
      userId?: string;
    };
    reviewerUserId = (reviewerSession.userId ?? "") as Id<"users">;
    expect(managerUserId).not.toBe("");
    expect(reviewerUserId).not.toBe("");
    expect(reviewerUserId).not.toBe(managerUserId);

    const created = (await manager.mutation(
      api.businessServices.createService,
      serviceInput(String(reviewerUserId), `${RUN_TAG} continuity service`),
    )) as { serviceId: Id<"businessServices"> };
    serviceId = created.serviceId;

    // An approved baseline: create, submit, independently approve.
    const approved = (await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} approved baseline`),
    )) as { biaId: Id<"businessImpactAnalyses"> };
    approvedBiaId = approved.biaId;
    await manager.mutation(api.businessImpactAnalyses.submitBia, { biaId: approvedBiaId });
    await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
      biaId: approvedBiaId,
      decision: "approved",
      reviewNotes:
        "Impacts, dependencies and recovery objectives are consistent with the recorded scope.",
    });

    // A second, unapproved analysis for the same service (draft baseline case).
    const draft = (await manager.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(serviceId, reviewerUserId, `${RUN_TAG} draft baseline`),
    )) as { biaId: Id<"businessImpactAnalyses"> };
    draftBiaId = draft.biaId;
    expect(draftBiaId).not.toBe(approvedBiaId);
  }, 120000);

  test("a plan is created as a draft against an approved baseline", async () => {
    const created = await createDraftPlan(`${RUN_TAG} revenue continuity plan`, approvedBiaId);
    planId = created.planId;
    expect(created.reference).toMatch(/^BCP-\d{3,}$/);

    const detail = await getPlan(planId);
    expect(detail.plan.status).toBe("draft");
    expect(detail.plan.version).toBe(1);
    expect(detail.plan.editable).toBe(true);
    expect(detail.baseline?.approved).toBe(true);
    expect(detail.baselineWarning).toBeNull();
    expect(detail.plan.baseline.biaReference).toMatch(/^BIA-\d{3,}$/);
    expect(detail.plan.baseline.biaVersion).toBe(1);
    expect(detail.versions).toHaveLength(1);
    const created2 = detail.history.find((event) => event.type === "plan_created");
    expect(created2).toBeDefined();
    expect(created2!.actorLabel).toBeTruthy();
  }, 120000);

  test("plan content and references are validated server-side", async () => {
    if (!manager || !other) return;
    const tooShort = planInput(serviceId, reviewerUserId, "ab");
    await expect(
      manager.mutation(api.continuityPlans.createPlan, tooShort),
    ).rejects.toThrow(/at least 3 characters/i);

    await expect(
      manager.mutation(api.continuityPlans.createPlan, {
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} bad date`),
        reviewDueAt: Date.now() - DAY,
      }),
    ).rejects.toThrow(/future/i);

    await expect(
      manager.mutation(api.continuityPlans.createPlan, {
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} far date`),
        reviewDueAt: Date.now() + 5 * 365 * DAY,
      }),
    ).rejects.toThrow(/more than/i);

    // A foreign service id is indistinguishable from a missing one.
    const foreignOptions = (await other.query(api.businessServices.formOptions, {})) as {
      currentUserId: string;
    };
    const foreign = (await other.mutation(
      api.businessServices.createService,
      serviceInput(foreignOptions.currentUserId, `${RUN_TAG} foreign service`),
    )) as { serviceId: Id<"businessServices"> };
    await expect(
      manager.mutation(
        api.continuityPlans.createPlan,
        planInput(foreign.serviceId, reviewerUserId, `${RUN_TAG} foreign service plan`),
      ),
    ).rejects.toThrow(/not found in your organization/i);

    // A BIA that belongs to a different service cannot be the baseline.
    const foreignBia = (await other.mutation(
      api.businessImpactAnalyses.createBia,
      biaInput(foreign.serviceId, foreignOptions.currentUserId as Id<"users">, `${RUN_TAG} foreign bia`),
    )) as { biaId: Id<"businessImpactAnalyses"> };
    await expect(
      manager.mutation(api.continuityPlans.createPlan, {
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} mismatched baseline`),
        biaId: foreignBia.biaId,
      }),
    ).rejects.toThrow(/not found in your organization|must belong/i);
  }, 120000);

  test("the preparer cannot approve their own plan", async () => {
    if (!manager) return;
    await manager.mutation(api.continuityPlans.submitPlan, { planId });
    const detail = await getPlan(planId);
    expect(detail.plan.status).toBe("in_review");
    await expect(
      manager.mutation(api.continuityPlans.reviewPlan, {
        planId,
        decision: "approved",
        reviewNotes:
          "Self-approval must be refused by the server, not merely hidden by the UI.",
      }),
    ).rejects.toThrow(/preparer cannot review their own continuity plan/i);
  }, 120000);

  test("an independent reviewer approves and freezes the version", async () => {
    if (!manager || !reviewer) return;
    const approved = await reviewer.mutation(api.continuityPlans.reviewPlan, {
      planId,
      decision: "approved",
      reviewNotes:
        "Plan content, scenarios and strategies are consistent with the approved baseline.",
    });
    expect(approved.status).toBe("approved");

    const detail = await getPlan(planId);
    expect(detail.plan.status).toBe("approved");
    expect(detail.plan.editable).toBe(false);
    expect(detail.plan.baseline.biaStatusAtApproval).toBe("approved");
    expect(detail.plan.reviewedByUserId).toBe(reviewerUserId);

    await expect(
      manager.mutation(api.continuityPlans.updatePlan, {
        planId,
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} rewritten plan`),
      }),
    ).rejects.toThrow(/approved plan must be revised/i);

    await expect(
      manager.mutation(api.continuityPlans.createStrategy, {
        planId,
        ...strategyInput(reviewerUserId, `${RUN_TAG} late strategy`),
      }),
    ).rejects.toThrow(/approved plan is frozen/i);

    // A second review decision on the approved version is refused.
    await expect(
      reviewer.mutation(api.continuityPlans.reviewPlan, {
        planId,
        decision: "approved",
        reviewNotes: "A duplicate approval attempt must be refused outright.",
      }),
    ).rejects.toThrow(/submitted for review/i);
  }, 120000);

  test("two concurrent approvals cannot both be recorded", async () => {
    if (!manager || !reviewer) return;
    const created = await createDraftPlan(`${RUN_TAG} concurrent approval plan`, approvedBiaId);
    await manager.mutation(api.continuityPlans.submitPlan, { planId: created.planId });
    const notes =
      "Independent approval attempted twice in the same tick to prove the lifecycle holds.";
    const results = await Promise.allSettled([
      reviewer.mutation(api.continuityPlans.reviewPlan, {
        planId: created.planId,
        decision: "approved",
        reviewNotes: notes,
      }),
      reviewer.mutation(api.continuityPlans.reviewPlan, {
        planId: created.planId,
        decision: "approved",
        reviewNotes: notes,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    const detail = await getPlan(created.planId);
    expect(detail.plan.status).toBe("approved");
    expect(detail.history.filter((e) => e.type === "plan_approved")).toHaveLength(1);
  }, 120000);

  test("a revision preserves the approved version and supersedes it only on approval", async () => {
    if (!manager || !reviewer) return;
    const revision = (await manager.mutation(api.continuityPlans.revisePlan, {
      planId,
    })) as { planId: Id<"continuityPlans">; version: number };
    expect(revision.version).toBe(2);

    const original = await getPlan(planId);
    expect(original.plan.status).toBe("approved");
    const draft = await getPlan(revision.planId);
    expect(draft.plan.status).toBe("draft");
    expect(draft.versions.length).toBeGreaterThanOrEqual(2);

    await manager.mutation(api.continuityPlans.submitPlan, { planId: revision.planId });
    await reviewer.mutation(api.continuityPlans.reviewPlan, {
      planId: revision.planId,
      decision: "approved",
      reviewNotes:
        "The revision is reviewed on its own merits and approved independently.",
    });

    const superseded = await getPlan(planId);
    expect(superseded.plan.status).toBe("superseded");
    // The earlier approved version and its review remain readable.
    expect(superseded.plan.reviewedByUserId).toBe(reviewerUserId);
    expect(superseded.history.some((e) => e.type === "plan_approved")).toBe(true);
  }, 120000);

  test("a plan relying on an unapproved analysis is flagged, not presented as approved", async () => {
    if (!manager || !reviewer) return;
    const created = await createDraftPlan(
      `${RUN_TAG} draft baseline plan`,
      draftBiaId,
    );
    const detail = await getPlan(created.planId);
    expect(detail.baseline?.approved).toBe(false);
    expect(detail.baselineWarning).toBeTruthy();
    expect(detail.baselineWarning).toMatch(/not approved/i);

    // Approval is still possible, but the history records the baseline state.
    await manager.mutation(api.continuityPlans.submitPlan, { planId: created.planId });
    await reviewer.mutation(api.continuityPlans.reviewPlan, {
      planId: created.planId,
      decision: "approved",
      reviewNotes:
        "Approved with an explicitly recorded unapproved baseline; the gap is documented.",
    });
    const approved = await getPlan(created.planId);
    expect(approved.plan.status).toBe("approved");
    expect(approved.plan.baseline.biaStatusAtApproval).toBe("draft");
  }, 120000);

  test("a rejected submission returns the plan for revision with the decision recorded", async () => {
    if (!manager || !reviewer) return;
    const created = await createDraftPlan(`${RUN_TAG} returned plan`, approvedBiaId);
    await manager.mutation(api.continuityPlans.submitPlan, { planId: created.planId });
    await reviewer.mutation(api.continuityPlans.reviewPlan, {
      planId: created.planId,
      decision: "rejected",
      reviewNotes:
        "The recovery arrangements are not evidenced; revise the assumptions before resubmission.",
    });
    const detail = await getPlan(created.planId);
    expect(detail.plan.status).toBe("returned");
    expect(detail.plan.editable).toBe(true);
    expect(detail.history.some((e) => e.type === "plan_returned")).toBe(true);
  }, 120000);

  test("recovery strategies are documented as estimates", async () => {
    if (!manager || !reviewer) return;
    const created = await createDraftPlan(`${RUN_TAG} strategy plan`, approvedBiaId);
    const strategy = (await manager.mutation(api.continuityPlans.createStrategy, {
      planId: created.planId,
      ...strategyInput(reviewerUserId, `${RUN_TAG} standby switch strategy`),
    })) as { strategyId: Id<"recoveryStrategies">; reference: string };
    strategyId = strategy.strategyId;
    expect(strategy.reference).toMatch(/^BRS-\d{3,}$/);

    const detail = await getPlan(created.planId);
    const row = detail.strategies.find((s) => s._id === strategyId);
    expect(row).toBeDefined();
    expect(row!.status).toBe("proposed");
    expect(row!.capabilityEvidence).toBe("estimate");
    // Approved RTO 240, estimated 300 → the estimate is 60 minutes beyond it.
    expect(row!.rtoDeltaMinutes).toBe(60);

    await expect(
      manager.mutation(api.continuityPlans.createStrategy, {
        planId: created.planId,
        ...strategyInput(reviewerUserId, `${RUN_TAG} verified strategy`),
        capabilityEvidence: "exercise_verified",
      }),
    ).rejects.toThrow(/Recovery exercises are not part of this module yet/i);

    // Strategy status follows the controlled lifecycle.
    await manager.mutation(api.continuityPlans.updateStrategyStatus, {
      strategyId,
      status: "adopted",
      rationale: "Adopted by continuity management after reviewing the supplier procedure.",
    });
    await expect(
      manager.mutation(api.continuityPlans.updateStrategyStatus, {
        strategyId,
        status: "proposed",
        rationale: "An adopted strategy cannot silently return to proposed.",
      }),
    ).rejects.toThrow(/not a permitted transition/i);
  }, 120000);

  test("recording a strategy never resolves a gap", async () => {
    if (!manager) return;
    const created = await createDraftPlan(`${RUN_TAG} gap plan`, approvedBiaId);
    const gap = (await manager.mutation(api.continuityPlans.createGap, {
      planId: created.planId,
      description:
        "The documented strategy cannot meet the approved RTO because the standby switch needs manual promotion.",
      severity: "high",
      ownerUserId: reviewerUserId,
      targetResolutionDate: Date.now() + 60 * DAY,
      mitigationRecommendation:
        "Automate switch promotion and re-test the failover during the next exercise window.",
    })) as { gapId: Id<"recoveryGaps">; reference: string };
    gapId = gap.gapId;
    expect(gap.reference).toMatch(/^GAP-\d{3,}$/);

    // Documenting a strategy leaves the gap open.
    await manager.mutation(api.continuityPlans.createStrategy, {
      planId: created.planId,
      ...strategyInput(reviewerUserId, `${RUN_TAG} gap strategy`),
    });
    let detail = await getPlan(created.planId);
    expect(detail.gaps.find((g) => g._id === gapId)?.status).toBe("open");

    // Resolution needs a stated rationale, and is attributed.
    await expect(
      manager.mutation(api.continuityPlans.updateGapStatus, {
        gapId,
        status: "resolved",
      }),
    ).rejects.toThrow(/requires a stated resolution rationale/i);

    await manager.mutation(api.continuityPlans.updateGapStatus, {
      gapId,
      status: "resolved",
      rationale:
        "Promotion was automated and verified in a controlled test on the standby switch.",
    });
    detail = await getPlan(created.planId);
    const resolved = detail.gaps.find((g) => g._id === gapId);
    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedByLabel).toBeTruthy();

    await expect(
      manager.mutation(api.continuityPlans.updateGapStatus, {
        gapId,
        status: "open",
        rationale: "A resolved gap cannot be reopened silently.",
      }),
    ).rejects.toThrow(/not a permitted transition/i);
  }, 120000);

  test("a read-only member can read plans but cannot write", async () => {
    if (!readOnly || !manager) return;
    const register = (await readOnly.query(api.continuityPlans.listPlans, {})) as {
      rows: Array<{ _id: string }>;
      canManage: boolean;
    };
    expect(Array.isArray(register.rows)).toBe(true);
    expect(register.canManage).toBe(false);

    const detail = (await readOnly.query(api.continuityPlans.getPlan, {
      planId,
    })) as { canManage: boolean };
    expect(detail.canManage).toBe(false);

    await expect(
      readOnly.mutation(api.continuityPlans.createPlan, {
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} read-only plan`),
      }),
    ).rejects.toThrow(/Permission denied: bcm.manage/i);

    await expect(
      readOnly.mutation(api.continuityPlans.reviewPlan, {
        planId,
        decision: "approved",
        reviewNotes: "A read-only member must never be able to approve.",
      }),
    ).rejects.toThrow(/Permission denied: bcm.manage/i);

    // The manager still holds the pen.
    expect(manager).not.toBeNull();
  }, 120000);

  test("another organization cannot read or write these plans", async () => {
    if (!other) return;
    await expect(
      other.query(api.continuityPlans.getPlan, { planId }),
    ).rejects.toThrow(/not found in your organization/i);

    await expect(
      other.mutation(api.continuityPlans.submitPlan, { planId }),
    ).rejects.toThrow(/not found in your organization/i);

    await expect(
      other.mutation(api.continuityPlans.createPlan, {
        ...planInput(serviceId, reviewerUserId, `${RUN_TAG} cross tenant plan`),
      }),
    ).rejects.toThrow(/not found in your organization/i);

    const otherPlans = (await other.query(api.continuityPlans.listPlans, {})) as {
      rows: Array<{ _id: string }>;
    };
    expect(otherPlans.rows.some((row) => row._id === planId)).toBe(false);
  }, 120000);

  test("concurrent plan creation never allocates a duplicate reference", async () => {
    if (!manager) return;
    const results = (await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        manager!.mutation(
          api.continuityPlans.createPlan,
          planInput(serviceId, reviewerUserId, `${RUN_TAG} concurrent plan ${index}`),
        ),
      ),
    )) as Array<{ planId: string; reference: string }>;
    const references = results.map((row) => row.reference);
    expect(new Set(references).size).toBe(references.length);
    for (const reference of references) {
      expect(reference).toMatch(/^BCP-\d{3,}$/);
    }
  }, 120000);

  test("the plan register pages without duplicates and reports open gaps", async () => {
    if (!manager) return;
    const first = (await manager.query(api.continuityPlans.listPlans, {
      limit: 2,
    })) as {
      rows: Array<{ _id: string; openGaps: number }>;
      nextCursor: number | null;
      hasMore: boolean;
      counts: { total: number; openGaps: number };
    };
    expect(first.rows.length).toBeLessThanOrEqual(2);
    expect(first.counts.total).toBeGreaterThan(1);
    expect(first.counts.openGaps).toBeGreaterThanOrEqual(0);
    if (!first.nextCursor) return;

    const second = (await manager.query(api.continuityPlans.listPlans, {
      limit: 2,
      cursor: first.nextCursor,
    })) as { rows: Array<{ _id: string }> };
    const firstIds = new Set(first.rows.map((row) => row._id));
    expect(second.rows.every((row) => !firstIds.has(row._id))).toBe(true);

    const searched = (await manager.query(api.continuityPlans.listPlans, {
      search: "revenue continuity plan",
    })) as { rows: Array<{ title: string }> };
    expect(searched.rows.length).toBeGreaterThan(0);
    expect(searched.rows.every((row) => row.title.toLowerCase().includes("revenue"))).toBe(true);
  }, 120000);
});
