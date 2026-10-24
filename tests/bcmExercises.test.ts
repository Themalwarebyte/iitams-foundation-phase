import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  BCM_EXERCISE_TRANSITIONS,
  BCM_FINDING_TRANSITIONS,
  BCM_IMPACT_CATEGORIES,
  canTransitionExercise,
  canTransitionFinding,
  evaluateStrategyCapability,
  exerciseAcceptsFindings,
  exercisePlanningEditable,
  exerciseResultsEditable,
  measurementOutcomeIsConsistent,
  measuredObjectiveDelta,
  type BcmImpacts,
} from "../src/lib/bcm";

/**
 * Phase 4A Batch 4.3 — Business Continuity: recovery exercises, testing and
 * validation.
 *
 * Properties under test:
 *  - only an approved plan version can be tested; every plan, strategy and
 *    participant id is re-validated against the caller's organization;
 *  - planning data is only editable before the start, results only while the
 *    exercise is in progress, and a completed record is frozen;
 *  - reported (`performed`) and independently verified are separate facts;
 *  - a measurement must agree with its outcome, and without an approved
 *    objective only `not_assessed` is accepted;
 *  - the reviewer cannot own, facilitate, record or complete the exercise;
 *  - exercise-verified capability requires a reviewed exercise, performed
 *    steps, a measurement and no unverified high/critical finding;
 *  - a finding is never closed by assignment, and closing one never closes a
 *    recovery gap;
 *  - read-only roles can read but cannot write; cross-tenant ids are refused;
 *  - every transition is attributed in the append-only history.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const RUN_TAG = `EXR-${Date.now().toString(36).toUpperCase().slice(-6)}`;
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

function sampleImpacts(): BcmImpacts {
  return Object.fromEntries(
    BCM_IMPACT_CATEGORIES.map((category) => [
      category,
      { severity: "high", notes: `${category} impact rationale for the exercise suite` },
    ]),
  ) as BcmImpacts;
}

// ---------------------------------------------------------------------------
// Structural / pure
// ---------------------------------------------------------------------------

describe("BCM recovery exercises — structure and vocabulary", () => {
  test("the exercise and finding lifecycles are closed transition tables", () => {
    expect(canTransitionExercise("planned", "scheduled")).toBe(true);
    expect(canTransitionExercise("scheduled", "in_progress")).toBe(true);
    expect(canTransitionExercise("in_progress", "completed")).toBe(true);
    expect(canTransitionExercise("completed", "in_review")).toBe(true);
    expect(canTransitionExercise("in_review", "reviewed")).toBe(true);
    expect(canTransitionExercise("in_review", "returned")).toBe(true);
    // No shortcuts: a planned exercise cannot be completed or reviewed.
    expect(canTransitionExercise("planned", "completed")).toBe(false);
    expect(canTransitionExercise("planned", "reviewed")).toBe(false);
    expect(BCM_EXERCISE_TRANSITIONS.reviewed).toEqual([]);
    expect(BCM_EXERCISE_TRANSITIONS.returned).toEqual([]);
    expect(BCM_EXERCISE_TRANSITIONS.cancelled).toEqual([]);

    expect(canTransitionFinding("open", "resolved")).toBe(true);
    expect(canTransitionFinding("resolved", "verified")).toBe(true);
    expect(canTransitionFinding("open", "verified")).toBe(false);
    expect(BCM_FINDING_TRANSITIONS.verified).toEqual([]);
    expect(BCM_FINDING_TRANSITIONS.accepted).toEqual([]);
  });

  test("planning and result write windows do not overlap", () => {
    expect(exercisePlanningEditable("planned")).toBe(true);
    expect(exercisePlanningEditable("scheduled")).toBe(true);
    expect(exercisePlanningEditable("in_progress")).toBe(false);
    expect(exerciseResultsEditable("in_progress")).toBe(true);
    expect(exerciseResultsEditable("completed")).toBe(false);
    expect(exerciseResultsEditable("reviewed")).toBe(false);
    expect(exerciseAcceptsFindings("planned")).toBe(false);
    expect(exerciseAcceptsFindings("in_progress")).toBe(true);
    expect(exerciseAcceptsFindings("reviewed")).toBe(true);
  });

  test("a measurement outcome must agree with the recorded performance", () => {
    expect(
      measurementOutcomeIsConsistent({
        objectiveMinutes: 240,
        measuredMinutes: 180,
        outcome: "met",
      }),
    ).toBe(true);
    expect(
      measurementOutcomeIsConsistent({
        objectiveMinutes: 240,
        measuredMinutes: 300,
        outcome: "met",
      }),
    ).toBe(false);
    expect(
      measurementOutcomeIsConsistent({
        objectiveMinutes: 240,
        measuredMinutes: 300,
        outcome: "missed",
      }),
    ).toBe(true);
    // Without an approved objective, nothing can be "met" or "missed".
    expect(
      measurementOutcomeIsConsistent({
        objectiveMinutes: undefined,
        measuredMinutes: 300,
        outcome: "met",
      }),
    ).toBe(false);
    expect(
      measurementOutcomeIsConsistent({
        objectiveMinutes: undefined,
        measuredMinutes: undefined,
        outcome: "not_assessed",
      }),
    ).toBe(true);
    expect(measuredObjectiveDelta({ objectiveMinutes: 240, measuredMinutes: 300 })).toBe(60);
    expect(measuredObjectiveDelta({ objectiveMinutes: 240 })).toBeUndefined();
  });

  test("exercise-verified capability needs a reviewed exercise, performed steps and an assessed measurement", () => {
    const base = {
      strategyId: "s1",
      planVersion: 2,
      biaVersion: 1,
      findings: [],
    };
    const unverified = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "in_review",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 1,
          assessedMeasurements: 1,
        },
      ],
    });
    expect(unverified.verified).toBe(false);
    expect(unverified.reasons.join(" ")).toMatch(/reviewed/i);

    const noMeasurement = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "reviewed",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 0,
          assessedMeasurements: 0,
        },
      ],
    });
    expect(noMeasurement.verified).toBe(false);
    expect(noMeasurement.reasons.join(" ")).toMatch(/measurement/i);

    // A "not assessed" observation measured nothing: it cannot establish
    // capability just because an exercise produced a row.
    const notAssessed = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "reviewed",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 2,
          assessedMeasurements: 0,
        },
      ],
    });
    expect(notAssessed.verified).toBe(false);
    expect(notAssessed.reasons.join(" ")).toMatch(/not assessed/i);

    // A missed objective that was never raised as a finding is concealed, not
    // verified.
    const concealedMiss = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "reviewed",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 1,
          assessedMeasurements: 1,
          undisclosedMisses: 1,
        },
      ],
    });
    expect(concealedMiss.verified).toBe(false);
    expect(concealedMiss.reasons.join(" ")).toMatch(/without raising the deviation/i);

    const blocking = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "reviewed",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 2,
          assessedMeasurements: 2,
        },
      ],
      findings: [{ severity: "critical", status: "resolved" }],
    });
    expect(blocking.verified).toBe(false);
    expect(blocking.reasons.join(" ")).toMatch(/finding/i);

    const verified = evaluateStrategyCapability({
      ...base,
      exercises: [
        {
          exerciseId: "e1",
          exerciseReference: "EXR-001",
          exerciseStatus: "reviewed",
          planId: "p1",
          planVersion: 2,
          biaVersion: 1,
          stepsPerformed: true,
          strategyMeasurements: 2,
          assessedMeasurements: 2,
        },
      ],
      findings: [{ severity: "critical", status: "verified" }],
    });
    expect(verified.verified).toBe(true);
    expect(verified.exerciseReference).toBe("EXR-001");
  });

  test("the server refuses operational execution, foreign ids and self-review", () => {
    const server = read("src/convex/recoveryExercises.ts");
    expect(server).toContain("requireBcmManager");
    expect(server).toContain("requireOwnedExercise");
    expect(server).toContain("A recovery exercise can only test an approved continuity plan");
    expect(server).toContain("the person who reported the activity cannot verify it");
    expect(server).toContain("cannot review an exercise");
    expect(server).toContain("Resolution evidence");
    // No infrastructure operation is reachable from this module.
    expect(server).not.toMatch(/restoreBackup|triggerFailover|shutdownSystem|runRecovery/);
    expect(server).not.toMatch(/fetch\(\s*["'`]https?:\/\/(?!api\.resend)/);
  });

  test("the module stores no resilience score and no second permission system", () => {
    const server = read("src/convex/recoveryExercises.ts");
    const lib = read("src/lib/bcm.ts");
    for (const source of [server, lib]) {
      expect(source).not.toMatch(/readinessScore/);
      expect(source).not.toMatch(/resilienceScore/);
      expect(source).not.toMatch(/maturityScore/);
    }
    expect(server).toContain("planStrategyCapabilities");
    expect(server).toContain("bcm.exercise_created");
    expect(server).toContain("bcm.exercise_reviewed");
  });

  test("the schema scopes, snapshots and indexes exercise records", () => {
    const schema = read("src/convex/schema.ts");
    for (const table of [
      "recoveryExercises: defineTable",
      "recoveryExerciseActivities: defineTable",
      "recoveryExerciseMeasurements: defineTable",
      "recoveryExerciseStrategies: defineTable",
      "recoveryExerciseFindings: defineTable",
    ]) {
      expect(schema).toContain(table);
    }
    expect(schema).toContain("planVersion: v.number()");
    expect(schema).toContain("biaRtoMinutes");
    expect(schema).toContain('exerciseId: v.optional(v.id("recoveryExercises"))');
    expect(schema).toContain(
      '.index("by_organization_exercise", ["organizationId", "exerciseId"])',
    );
  });

  test("the exercise pages and routes are real, not placeholders", () => {
    const main = read("src/main.tsx");
    expect(main).toContain("BcmExercisesPage");
    expect(main).toContain("BcmExerciseDetailPage");
    expect(main).toContain('path="/bcm/dr-tests"');
    expect(main).toContain('path="/bcm/dr-tests/:exerciseId"');
    const nav = read("src/lib/nav.ts");
    expect(nav).toContain('path: "/bcm/dr-tests"');
  });

  test("the plan detail exposes derived capability without mutating the plan", () => {
    const plans = read("src/convex/continuityPlans.ts");
    expect(plans).toContain("planStrategyCapabilities");
    expect(plans).toContain("exerciseVerified");
    expect(plans).not.toMatch(/capabilityEvidence:\s*"exercise_verified"/);
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

runtime("recovery exercises (runtime)", () => {
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
  let planId: Id<"continuityPlans">;
  let draftPlanId: Id<"continuityPlans">;
  let strategyId: Id<"recoveryStrategies">;
  let secondStrategyId: Id<"recoveryStrategies">;
  let exerciseId: Id<"recoveryExercises">;
  let approvedExerciseId: Id<"recoveryExercises">;
  let findingId: Id<"recoveryExerciseFindings">;
  let activityId: Id<"recoveryExerciseActivities">;

  function exerciseInput(plan: Id<"continuityPlans">) {
    return {
      title: `${RUN_TAG} tabletop for revenue restoration`,
      objectives:
        "Establish whether the documented recovery steps restore citizen payment intake.",
      planId: plan,
      type: "tabletop" as const,
      scope: "Payment intake, receipting and the reconciliation batch during a switch outage.",
      exclusions: "District counter service and supplier internal operations are excluded.",
      scenario:
        "The primary payment switch is unavailable for six hours during the settlement window.",
      ownerUserId: managerUserId,
      facilitatorUserId: managerUserId,
      participants: [
        { userId: reviewerUserId, role: "Independent observer" },
      ],
      plannedStartAt: Date.now() + 7 * DAY,
      plannedEndAt: Date.now() + 8 * DAY,
      methodology:
        "Discussion-based walkthrough of each recovery step against the documented plan.",
      requiredResources:
        "Continuity plan, supplier failover procedure and two payment operations engineers.",
      constraints:
        "No infrastructure is touched: this is a tabletop exercise with no system access.",
      evidenceReferences: "Exercise pack held in the continuity evidence folder.",
    };
  }

  async function getExercise(id: Id<"recoveryExercises">) {
    if (!manager) throw new Error("[test:PREREQ-FAILED] manager session unavailable");
    return (await manager.query(api.recoveryExercises.getExercise, {
      exerciseId: id,
    })) as {
      exercise: {
        reference: string;
        status: string;
        version: number;
        counts: { activities: number; measurements: number; openFindings: number };
        completedByUserId: string | null;
        ownerUserId: string;
        supersededByExerciseId: string | null;
        outcomeSummary: string | null;
      };
      baselineWarning: string | null;
      activities: Array<{
        _id: Id<"recoveryExerciseActivities">;
        performed: boolean;
        verified: boolean;
        evidenceState: string;
      }>;
      measurements: Array<{
        objective: string;
        measuredMinutes: number | null;
        objectiveMinutes: number | null;
        outcome: string;
        deltaMinutes: number | null;
      }>;
      coverage: Array<{
        strategyReference: string | null;
        capabilityVerified: boolean;
        capabilityReasons: string[];
      }>;
      findings: Array<{ status: string; verifiedByLabel: string | null }>;
      history: Array<{ type: string; actorLabel: string }>;
      reviewBlockedReasons: string[];
      canManage: boolean;
    };
  }

  test("fixture identities, an approved plan and two strategies are prepared", async () => {
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

    const created = (await manager.mutation(api.businessServices.createService, {
      name: `${RUN_TAG} payments service`,
      description: "Citizen payment intake and reconciliation for the revenue service.",
      department: "Revenue operations",
      ownerUserId: reviewerUserId,
      operationalStatus: "active",
      criticality: "critical",
      ictDependencies: "Payment switch (vendor-hosted), core banking API",
      keyDependencies: "Revenue operations staff and the payment switch supplier.",
      singlePointsOfFailure: "Single vendor-hosted payment switch instance",
    })) as { serviceId: Id<"businessServices"> };
    serviceId = created.serviceId;

    const bia = (await manager.mutation(api.businessImpactAnalyses.createBia, {
      serviceId,
      title: `${RUN_TAG} approved baseline`,
      ownerUserId: reviewerUserId,
      assessmentDate: Date.now() - 2 * DAY,
      reviewDueAt: Date.now() + 180 * DAY,
      disruptionScenario:
        "Loss of the primary payment switch during the settlement window.",
      scope: "Citizen payment intake and the nightly reconciliation feed",
      impacts: sampleImpacts(),
      keyDependencies: "Payment switch supplier and the core banking interface",
      singlePointsOfFailure: "Vendor-hosted switch has no active-active pair",
      existingRecoveryArrangements: "Nightly backups and a manual receipting workaround.",
      assumptions: "Staff can reach the alternate site.",
      limitations: "No recovery exercise has been performed.",
      criticalityRationale: "Revenue collection stops and statutory deadlines are missed.",
      rtoMinutes: 240,
      rpoMinutes: 60,
      mtpdMinutes: 480,
      minimumServiceLevel:
        "Manual receipting continues for critical payments with daily reconciliation.",
      recoveryPriority: "p1",
      objectiveRationale:
        "Statutory settlement cut-off requires restoration within the same business day.",
    })) as { biaId: Id<"businessImpactAnalyses"> };
    await manager.mutation(api.businessImpactAnalyses.submitBia, { biaId: bia.biaId });
    await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
      biaId: bia.biaId,
      decision: "approved",
      reviewNotes:
        "Impacts, dependencies and recovery objectives are consistent with the recorded scope.",
    });

    const plan = (await manager.mutation(api.continuityPlans.createPlan, {
      title: `${RUN_TAG} revenue continuity plan`,
      purpose:
        "Restore revenue collection for citizens and statutory settlement within the agreed objectives.",
      primaryServiceId: serviceId,
      additionalServiceIds: [],
      ownerUserId: reviewerUserId,
      biaId: bia.biaId,
      disruptionScenarios:
        "Extended loss of the payment switch, including the nightly reconciliation batch.",
      recoveryPriority: "p1",
      scope: "Citizen payment intake, receipting and the nightly reconciliation feed.",
      exclusions: "Counter service at district offices is out of scope for this plan.",
      assumptions: "The alternate site is available and the supplier honours its window.",
      reviewDueAt: Date.now() + 180 * DAY,
    })) as { planId: Id<"continuityPlans"> };
    planId = plan.planId;

    const strategyBase = {
      objective: "Restore citizen payment intake on the standby switch.",
      disruptionScenario: "Primary payment switch unavailable for more than four hours.",
      recoveryApproach:
        "Fail over to the warm standby switch and re-point the reconciliation batch.",
      personnelRequirements: "Two payment operations engineers and one finance reconciler.",
      minimumServiceLevel:
        "Critical payments continue within the minimum service level agreed in the analysis.",
      expectedRecoveryMinutes: 300,
      targetRtoMinutes: 240,
      targetRpoMinutes: 60,
      targetMtpdMinutes: 480,
      capabilityEvidence: "estimate" as const,
      capabilityRationale:
        "Based on the supplier's documented failover procedure; never exercised here.",
      ownerUserId: reviewerUserId,
      statusRationale: "Proposed by the plan owner; adoption is a separate decision.",
    };
    const first = (await manager.mutation(api.continuityPlans.createStrategy, {
      planId,
      title: `${RUN_TAG} warm standby switch`,
      ...strategyBase,
    })) as { strategyId: Id<"recoveryStrategies"> };
    strategyId = first.strategyId;
    const second = (await manager.mutation(api.continuityPlans.createStrategy, {
      planId,
      title: `${RUN_TAG} manual receipting fallback`,
      ...strategyBase,
      objective: "Keep receipting afloat with manual procedures during the outage.",
    })) as { strategyId: Id<"recoveryStrategies"> };
    secondStrategyId = second.strategyId;
    expect(secondStrategyId).not.toBe(strategyId);

    await manager.mutation(api.continuityPlans.submitPlan, { planId });
    await reviewer.mutation(api.continuityPlans.reviewPlan, {
      planId,
      decision: "approved",
      reviewNotes:
        "Plan, strategies and baseline are complete and consistent with the approved analysis.",
    });

    // A separate draft plan for the negative "only approved plans" case.
    const draft = (await manager.mutation(api.continuityPlans.createPlan, {
      title: `${RUN_TAG} draft plan not yet approved`,
      purpose:
        "A draft plan that must not accept a recovery exercise until it is approved.",
      primaryServiceId: serviceId,
      additionalServiceIds: [],
      ownerUserId: reviewerUserId,
      biaId: bia.biaId,
      disruptionScenarios:
        "Extended loss of the payment switch, including the nightly reconciliation batch.",
      recoveryPriority: "p1",
      scope: "Citizen payment intake, receipting and the nightly reconciliation feed.",
      exclusions: "Counter service at district offices is out of scope for this plan.",
      assumptions: "The alternate site is available.",
      reviewDueAt: Date.now() + 180 * DAY,
    })) as { planId: Id<"continuityPlans"> };
    draftPlanId = draft.planId;
  }, 180000);

  test("an exercise can only be recorded against an approved plan version", async () => {
    if (!manager || !other) return;
    await expect(
      manager.mutation(api.recoveryExercises.createExercise, exerciseInput(draftPlanId)),
    ).rejects.toThrow(/only test an approved continuity plan/i);

    // A foreign plan id is indistinguishable from a missing one.
    const foreign = (await other.mutation(api.continuityPlans.createPlan, {
      title: `${RUN_TAG} foreign plan`,
      purpose: "A plan in another organization that must never be testable here.",
      primaryServiceId: (
        (await other.mutation(api.businessServices.createService, {
          name: `${RUN_TAG} foreign service`,
          description: "A service in another organization for isolation checks.",
          department: "Other tenant",
          ownerUserId: (
            (await other.query(api.session.getSession, {})) as { userId?: string }
          ).userId as Id<"users">,
          operationalStatus: "active",
          criticality: "high",
          keyDependencies: "Other tenant operations staff and their supplier contacts.",
        })) as { serviceId: Id<"businessServices"> }
      ).serviceId,
      additionalServiceIds: [],
      ownerUserId: (
        (await other.query(api.session.getSession, {})) as { userId?: string }
      ).userId as Id<"users">,
      disruptionScenarios: "Foreign disruption scenario for the isolation test only.",
      recoveryPriority: "p2",
      scope: "Foreign scope that must never be visible to the first organization.",
      exclusions: "Everything outside the foreign organization is excluded.",
      assumptions: "This is a foreign tenant fixture used only for isolation checks.",
      reviewDueAt: Date.now() + 180 * DAY,
    })) as { planId: Id<"continuityPlans"> };
    await expect(
      manager.mutation(api.recoveryExercises.createExercise, exerciseInput(foreign.planId)),
    ).rejects.toThrow(/not found in your organization/i);
  }, 120000);

  test("participants must be active members of the same organization", async () => {
    if (!manager || !other) return;
    const otherUserId = ((await other.query(api.session.getSession, {})) as {
      userId?: string;
    }).userId as Id<"users">;
    // A member of another organization is not a valid participant here.
    await expect(
      manager.mutation(api.recoveryExercises.createExercise, {
        ...exerciseInput(planId),
        participants: [{ userId: otherUserId, role: "Observer" }],
      }),
    ).rejects.toThrow(/not an active member of your organization/i);

    const foreignUserId = ((await manager.query(api.session.getSession, {})) as {
      userId?: string;
    }).userId as Id<"users">;
    await expect(
      manager.mutation(api.recoveryExercises.createExercise, {
        ...exerciseInput(planId),
        participants: [
          { userId: foreignUserId, role: "Observer" },
          { userId: foreignUserId, role: "Second role" },
        ],
      }),
    ).rejects.toThrow(/only be listed once/i);

    await expect(
      manager.mutation(api.recoveryExercises.createExercise, {
        ...exerciseInput(planId),
        plannedEndAt: Date.now() + 6 * DAY,
      }),
    ).rejects.toThrow(/after the planned start/i);
  }, 120000);

  test("an exercise is created, scheduled and started with attributed history", async () => {
    if (!manager) return;
    const created = (await manager.mutation(
      api.recoveryExercises.createExercise,
      exerciseInput(planId),
    )) as { exerciseId: Id<"recoveryExercises">; reference: string };
    exerciseId = created.exerciseId;
    expect(created.reference).toMatch(/^EXR-\d{3,}$/);

    let detail = await getExercise(exerciseId);
    expect(detail.exercise.status).toBe("planned");
    expect(detail.exercise.version).toBe(1);
    expect(detail.baselineWarning).toBeNull();
    expect(detail.history.some((event) => event.type === "exercise_created")).toBe(true);

    await manager.mutation(api.recoveryExercises.scheduleExercise, { exerciseId });
    await manager.mutation(api.recoveryExercises.startExercise, { exerciseId });
    detail = await getExercise(exerciseId);
    expect(detail.exercise.status).toBe("in_progress");
    expect(detail.history.some((event) => event.type === "exercise_started")).toBe(true);
    expect(detail.history.every((event) => event.actorLabel.length > 0)).toBe(true);
  }, 120000);

  test("planning data is frozen once the exercise starts", async () => {
    if (!manager) return;
    const detail = await getExercise(exerciseId);
    await expect(
      manager.mutation(api.recoveryExercises.updateExercise, {
        exerciseId,
        ...exerciseInput(planId),
        title: `${RUN_TAG} amended after start`,
      }),
    ).rejects.toThrow(/before the exercise starts/i);
    expect(detail.exercise.status).toBe("in_progress");
  }, 120000);

  test("an activity is reported performed and only a different user can verify it", async () => {
    if (!manager || !reviewer) return;
    const added = (await manager.mutation(
      api.recoveryExercises.addExerciseActivity,
      {
        exerciseId,
        plannedActivity: "Notify the payment operations duty engineer.",
        expectedResponse:
          "The duty engineer acknowledges within fifteen minutes and opens the bridge.",
        performed: true,
        actualObservation:
          "The duty engineer acknowledged after eight minutes and opened the bridge.",
        evidenceReference: "Bridge transcript held in the continuity evidence folder.",
      },
    )) as { activityId: Id<"recoveryExerciseActivities"> };
    activityId = added.activityId;

    let detail = await getExercise(exerciseId);
    expect(detail.activities).toHaveLength(1);
    expect(detail.activities[0].performed).toBe(true);
    expect(detail.activities[0].verified).toBe(false);
    expect(detail.activities[0].evidenceState).toBe("reported");

    // The reporter can never verify their own activity.
    await expect(
      manager.mutation(api.recoveryExercises.verifyExerciseActivity, {
        activityId,
        verificationNotes:
          "Attempting to verify the activity I reported myself should be refused.",
      }),
    ).rejects.toThrow(/cannot verify it/i);

    await reviewer.mutation(api.recoveryExercises.verifyExerciseActivity, {
      activityId,
      verificationNotes:
        "Bridge transcript and duty-engineer acknowledgement confirm the reported activity.",
    });
    detail = await getExercise(exerciseId);
    expect(detail.activities[0].verified).toBe(true);
    expect(detail.activities[0].evidenceState).toBe("verified");
  }, 120000);

  test("measurements must agree with the approved objective", async () => {
    if (!manager) return;
    // The approved RTO is 240 minutes. A 300-minute observation cannot be "met".
    await expect(
      manager.mutation(api.recoveryExercises.recordExerciseMeasurement, {
        exerciseId,
        objective: "rto",
        measuredMinutes: 300,
        observedValue: "Payment intake restored on the standby switch.",
        outcome: "met",
        justification:
          "The standby switch restored payment intake within the exercise window.",
        evidenceReference: "Exercise log page 4",
        limitations: "The supplier failover step was simulated by the facilitator.",
      }),
    ).rejects.toThrow(/does not agree/i);

    await manager.mutation(api.recoveryExercises.recordExerciseMeasurement, {
      exerciseId,
      objective: "rto",
      measuredMinutes: 300,
      observedValue: "Payment intake restored on the standby switch.",
      outcome: "missed",
      justification:
        "Restoration took 300 minutes against an approved objective of 240 minutes.",
      evidenceReference: "Exercise log page 4",
      limitations: "The supplier failover step was simulated by the facilitator.",
    });

    const detail = await getExercise(exerciseId);
    expect(detail.measurements).toHaveLength(1);
    expect(detail.measurements[0].objectiveMinutes).toBe(240);
    expect(detail.measurements[0].measuredMinutes).toBe(300);
    expect(detail.measurements[0].outcome).toBe("missed");
    expect(detail.measurements[0].deltaMinutes).toBe(60);
  }, 120000);

  test("a measurement cannot be recorded outside the in-progress window", async () => {
    if (!manager) return;
    // A fresh planned exercise has no results window at all.
    const planned = (await manager.mutation(
      api.recoveryExercises.createExercise,
      exerciseInput(planId),
    )) as { exerciseId: Id<"recoveryExercises"> };
    await expect(
      manager.mutation(api.recoveryExercises.recordExerciseMeasurement, {
        exerciseId: planned.exerciseId,
        objective: "rto",
        measuredMinutes: 120,
        observedValue: "Not applicable — nothing was exercised.",
        outcome: "not_assessed",
        justification:
          "This attempt must be refused because the exercise has not started.",
        evidenceReference: "No evidence",
        limitations: "No exercise was performed.",
      }),
    ).rejects.toThrow(/while the exercise is in progress/i);
  }, 120000);

  test("strategy coverage is recorded for the tested plan only, once per strategy", async () => {
    if (!manager) return;
    await manager.mutation(api.recoveryExercises.recordStrategyCoverage, {
      exerciseId,
      strategyId,
      stepsRecorded:
        "Failover to the standby switch, re-point the reconciliation batch and confirm receipting.",
      stepsPerformed: true,
      observation:
        "The steps were walked in order; the supplier failover step was read from the procedure.",
      limitations: "No production system was touched during this tabletop exercise.",
    });

    await expect(
      manager.mutation(api.recoveryExercises.recordStrategyCoverage, {
        exerciseId,
        strategyId,
        stepsRecorded: "Duplicate coverage for the same strategy should be refused.",
        stepsPerformed: true,
        observation: "This is a duplicate attempt and must be rejected by the server.",
      }),
    ).rejects.toThrow(/already records coverage/i);

    const detail = await getExercise(exerciseId);
    expect(detail.coverage).toHaveLength(1);
    expect(detail.coverage[0].strategyReference).toBeTruthy();
    // Reviewed? No: capability must not be verified yet.
    expect(detail.coverage[0].capabilityVerified).toBe(false);
  }, 120000);

  test("a finding never closes itself and high findings block verified capability", async () => {
    if (!manager || !reviewer) return;
    const created = (await manager.mutation(
      api.recoveryExercises.createExerciseFinding,
      {
        exerciseId,
        description:
          "The supplier failover step has no documented owner in the recovery procedure.",
        severity: "high",
        strategyId,
        relatedObjective: "rto",
        ownerUserId: reviewerUserId,
        targetResolutionDate: Date.now() + 30 * DAY,
        correctiveAction:
          "Assign an owner for the supplier failover step and update the procedure.",
      },
    )) as { findingId: Id<"recoveryExerciseFindings">; reference: string };
    findingId = created.findingId;
    expect(created.reference).toMatch(/^EXF-\d{3,}$/);

    // Resolving needs notes and evidence; verification cannot be done by the resolver.
    await expect(
      manager.mutation(api.recoveryExercises.updateExerciseFindingStatus, {
        findingId,
        status: "resolved",
      }),
    ).rejects.toThrow(/Resolution notes/i);

    await manager.mutation(api.recoveryExercises.updateExerciseFindingStatus, {
      findingId,
      status: "resolved",
      note:
        "The procedure now names the payment operations lead as owner of the failover step.",
      evidenceReference: "Procedure revision 4.2, section 3",
    });
    await expect(
      manager.mutation(api.recoveryExercises.updateExerciseFindingStatus, {
        findingId,
        status: "verified",
        note: "Attempting to verify my own resolution must be refused by the server.",
      }),
    ).rejects.toThrow(/cannot verify it/i);

    await reviewer.mutation(api.recoveryExercises.updateExerciseFindingStatus, {
      findingId,
      status: "verified",
      note: "Procedure revision 4.2 names the owner; the finding is verified as resolved.",
    });

    const detail = await getExercise(exerciseId);
    expect(detail.findings[0].status).toBe("verified");
    expect(detail.findings[0].verifiedByLabel).toBeTruthy();
    // The finding status changed; no recovery gap was created or closed.
    expect(detail.exercise.counts.openFindings).toBe(0);
  }, 120000);

  test("completion requires a performed activity and a stated outcome", async () => {
    if (!manager) return;
    await expect(
      manager.mutation(api.recoveryExercises.completeExercise, {
        exerciseId,
        outcomeSummary: "Too short",
        outcomeJustification: "Also too short to be a real justification of an outcome.",
      }),
    ).rejects.toThrow(/at least 20 characters/i);

    await manager.mutation(api.recoveryExercises.completeExercise, {
      exerciseId,
      outcomeSummary:
        "The walkthrough restored payment intake in the exercise, 60 minutes beyond the objective.",
      outcomeJustification:
        "The steps were performed in order; the observed RTO of 300 minutes exceeds the approved 240 minutes.",
    });

    const detail = await getExercise(exerciseId);
    expect(detail.exercise.status).toBe("completed");
    expect(detail.exercise.outcomeSummary).toContain("60 minutes beyond");
    // Completion alone never marks the measurement as met.
    expect(detail.measurements[0].outcome).toBe("missed");
  }, 120000);

  test("the reviewer cannot be the owner, facilitator or completer", async () => {
    if (!manager || !reviewer) return;
    await manager.mutation(api.recoveryExercises.submitExercise, { exerciseId });

    // The manager owns, facilitates and completed the exercise.
    await expect(
      manager.mutation(api.recoveryExercises.reviewExercise, {
        exerciseId,
        decision: "approved",
        reviewNotes:
          "Reviewing my own exercise must be refused regardless of the note length.",
      }),
    ).rejects.toThrow(/Independent review required/i);

    const blocked = await getExercise(exerciseId);
    expect(blocked.reviewBlockedReasons.length).toBeGreaterThan(0);

    await reviewer.mutation(api.recoveryExercises.reviewExercise, {
      exerciseId,
      decision: "approved",
      reviewNotes:
        "Activities, measurement and finding are consistent with the evidence supplied.",
    });

    const detail = await getExercise(exerciseId);
    expect(detail.exercise.status).toBe("reviewed");
    expect(detail.history.some((event) => event.type === "exercise_reviewed")).toBe(true);

    // Verified capability is derived from the reviewed exercise, per strategy.
    const capabilities = (await manager.query(api.continuityPlans.getPlan, {
      planId,
    })) as {
      strategies: Array<{
        reference: string;
        exerciseVerified: boolean;
        exerciseVerificationReasons: string[];
      }>;
      strategyCapabilitySummary: { total: number; exerciseVerified: number };
    };
    const covered = capabilities.strategies.find(
      (row) => row.exerciseVerified,
    );
    expect(covered).toBeDefined();
    expect(capabilities.strategyCapabilitySummary.exerciseVerified).toBe(1);
    expect(capabilities.strategyCapabilitySummary.total).toBe(2);
    const uncovered = capabilities.strategies.find((row) => !row.exerciseVerified);
    expect(uncovered?.exerciseVerificationReasons.join(" ")).toMatch(/reviewed exercise/i);
  }, 120000);

  test("a corrected version supersedes without rewriting the reviewed record", async () => {
    if (!manager) return;
    const created = (await manager.mutation(api.recoveryExercises.supersedeExercise, {
      exerciseId,
      reason:
        "The reviewed record omitted a second recovery activity; a corrected version is required.",
    })) as { exerciseId: Id<"recoveryExercises">; version: number };
    approvedExerciseId = created.exerciseId;
    expect(created.version).toBe(2);

    const previous = await getExercise(exerciseId);
    expect(previous.exercise.supersededByExerciseId).toBe(String(created.exerciseId));
    expect(previous.exercise.status).toBe("reviewed");

    const next = await getExercise(created.exerciseId);
    expect(next.exercise.status).toBe("planned");
    expect(next.exercise.version).toBe(2);
    expect(next.exercise.counts.measurements).toBe(0);
    expect(
      next.history.some((event) => event.type === "exercise_superseded"),
    ).toBe(true);
  }, 120000);

  test("read-only roles can read but cannot write, and foreign ids are refused", async () => {
    if (!readOnly || !other) return;
    const listed = (await readOnly.query(api.recoveryExercises.listExercises, {
      limit: 10,
    })) as { rows: unknown[]; canManage: boolean };
    expect(Array.isArray(listed.rows)).toBe(true);
    expect(listed.canManage).toBe(false);

    await expect(
      readOnly.mutation(api.recoveryExercises.createExercise, exerciseInput(planId)),
    ).rejects.toThrow(/Permission denied/i);

    await expect(
      other.query(api.recoveryExercises.getExercise, { exerciseId }),
    ).rejects.toThrow(/not found in your organization/i);
    await expect(
      other.query(api.recoveryExercises.getExercise, {
        exerciseId: approvedExerciseId,
      }),
    ).rejects.toThrow(/not found in your organization/i);
  }, 120000);

  test("the register pages with a keyset cursor and never duplicates", async () => {
    if (!manager) return;
    const first = (await manager.query(api.recoveryExercises.listExercises, {
      limit: 2,
    })) as {
      rows: Array<{ _id: string; reference: string }>;
      nextCursor: number | null;
      hasMore: boolean;
      counts: { total: number };
    };
    expect(first.rows.length).toBeLessThanOrEqual(2);
    if (!first.hasMore || first.nextCursor === null) {
      expect(first.rows.length).toBeGreaterThan(0);
      return;
    }
    const second = (await manager.query(api.recoveryExercises.listExercises, {
      limit: 2,
      cursor: first.nextCursor,
    })) as { rows: Array<{ _id: string }> };
    const ids = [...first.rows, ...second.rows].map((row) => row._id);
    expect(new Set(ids).size).toBe(ids.length);
  }, 120000);

  test("plan-level exercise verification never mutates the approved strategies", async () => {
    if (!manager) return;
    const detail = (await manager.query(api.continuityPlans.getPlan, {
      planId,
    })) as {
      plan: { status: string };
      strategies: Array<{ capabilityEvidence: string; exerciseVerified: boolean }>;
    };
    expect(detail.plan.status).toBe("approved");
    // The stored evidence stays an estimate; verification is derived evidence.
    expect(detail.strategies.every((row) => row.capabilityEvidence === "estimate")).toBe(
      true,
    );
    expect(detail.strategies.some((row) => row.exerciseVerified)).toBe(true);
  }, 120000);

  test("a measurement only verifies the strategy it was measured against", async () => {
    if (!manager || !reviewer) return;
    const created = (await manager.mutation(api.recoveryExercises.createExercise, {
      ...exerciseInput(planId),
      title: `${RUN_TAG} two-strategy walkthrough`,
    })) as { exerciseId: Id<"recoveryExercises"> };
    const multiId = created.exerciseId;
    await manager.mutation(api.recoveryExercises.scheduleExercise, { exerciseId: multiId });
    await manager.mutation(api.recoveryExercises.startExercise, { exerciseId: multiId });

    // A strategy whose steps were never walked cannot be measured.
    await expect(
      manager.mutation(api.recoveryExercises.recordExerciseMeasurement, {
        exerciseId: multiId,
        strategyId: secondStrategyId,
        objective: "rto",
        measuredMinutes: 200,
        observedValue: "Standby switch accepted payment traffic.",
        outcome: "met",
        justification:
          "Attempting to measure a strategy with no recorded coverage must be refused.",
        evidenceReference: "Exercise log page 2",
        limitations: "No coverage was recorded for this strategy.",
      }),
    ).rejects.toThrow(/steps were walked/i);

    // Both strategies are walked, but only the first is measured.
    for (const covered of [strategyId, secondStrategyId]) {
      await manager.mutation(api.recoveryExercises.recordStrategyCoverage, {
        exerciseId: multiId,
        strategyId: covered,
        stepsRecorded:
          "Fail over to the standby switch, re-point the reconciliation batch and confirm receipting.",
        stepsPerformed: true,
        observation: "The documented steps were walked in order by the participants.",
        limitations: "No production system was touched; the walkthrough was facilitated.",
      });
    }
    await manager.mutation(api.recoveryExercises.recordExerciseMeasurement, {
      exerciseId: multiId,
      strategyId,
      objective: "rto",
      measuredMinutes: 200,
      observedValue: "Standby switch accepted payment traffic after 200 minutes.",
      outcome: "met",
      justification:
        "Payment intake was demonstrated on the standby switch within the approved objective.",
      evidenceReference: "Exercise log page 2",
      limitations: "The supplier failover step was read from the procedure, not executed.",
    });
    await manager.mutation(api.recoveryExercises.addExerciseActivity, {
      exerciseId: multiId,
      plannedActivity:
        "Walk the participants through failover to the standby switch in order.",
      expectedResponse:
        "Each step is confirmed by the responsible role within the documented window.",
      performed: true,
      actualObservation:
        "Every step was confirmed by the nominated role during the walkthrough.",
      evidenceReference: "Exercise log page 2",
      limitations: "Discussion-based only; no infrastructure was touched.",
    });
    await manager.mutation(api.recoveryExercises.completeExercise, {
      exerciseId: multiId,
      outcomeSummary:
        "Both documented strategies were walked; only the standby switch was measured.",
      outcomeJustification:
        "The session reached the end of both procedures and recorded one timed observation.",
    });
    await manager.mutation(api.recoveryExercises.submitExercise, { exerciseId: multiId });
    await reviewer.mutation(api.recoveryExercises.reviewExercise, {
      exerciseId: multiId,
      decision: "approved",
      reviewNotes:
        "Coverage, measurement and limitations agree with the exercise log supplied.",
    });

    const plan = (await manager.query(api.continuityPlans.getPlan, { planId })) as {
      strategies: Array<{
        _id: string;
        exerciseVerified: boolean;
        exerciseVerificationReasons: string[];
      }>;
    };
    const measuredStrategy = plan.strategies.find(
      (row) => row._id === String(strategyId),
    );
    const unmeasuredStrategy = plan.strategies.find(
      (row) => row._id === String(secondStrategyId),
    );
    expect(measuredStrategy?.exerciseVerified).toBe(true);
    // The second strategy was walked but never measured, so the same reviewed
    // exercise cannot establish its capability.
    expect(unmeasuredStrategy?.exerciseVerified).toBe(false);
    expect(unmeasuredStrategy?.exerciseVerificationReasons.join(" ")).toMatch(
      /no reviewed exercise recorded a measurement/i,
    );
  }, 180000);
});
