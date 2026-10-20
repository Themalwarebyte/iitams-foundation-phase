import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  CYBER_TEST_TRANSITIONS,
  canTransitionTest,
  isConfirmedVulnerabilityStatus,
  isOutstandingTest,
  isRecordedOutcome,
  isTargetExcluded,
  isTargetInAuthorizedScope,
  isWithinTestingWindow,
  mayExecuteTests,
  testingExecutionStatus,
} from "../src/lib/cyber";

/**
 * Phase 4A — Batch 2A: security testing engagements and test cases.
 * ================================================================
 * Structural guarantees first, then runtime checks against the development
 * backend using the disposable fixture organizations:
 *
 *  - a recorded engagement is NOT an authorized one, and execution is refused
 *    until the scope, exclusions, window, lead tester, methodology, rules of
 *    engagement and authorization reference are recorded;
 *  - status and outcome stay distinct; a completed result is immutable;
 *  - a failed test never creates or verifies a vulnerability;
 *  - a completed test is reviewed by someone other than the tester/executor;
 *  - assessment completion is blocked while test cases are outstanding;
 *  - cross-tenant ids are refused even when they are valid, and a role without
 *    cyber.manage cannot write;
 *  - team listing is bounded, paginated and index-backed.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("security testing vocabulary is explicit", () => {
  test("test lifecycle is terminal after a recorded result", () => {
    expect(canTransitionTest("planned", "in_progress")).toBe(true);
    expect(canTransitionTest("planned", "completed")).toBe(false);
    expect(canTransitionTest("in_progress", "completed")).toBe(true);
    expect(canTransitionTest("completed", "in_progress")).toBe(false);
    expect(canTransitionTest("completed", "cancelled")).toBe(false);
    expect(canTransitionTest("not_applicable", "completed")).toBe(false);
    expect(canTransitionTest("cancelled", "in_progress")).toBe(false);
    for (const [from, targets] of Object.entries(CYBER_TEST_TRANSITIONS)) {
      expect(from.length).toBeGreaterThan(0);
      expect(Array.isArray(targets)).toBe(true);
    }
  });

  test("status and outcome are separate concepts", () => {
    // A completed test is not a result on its own.
    expect(isRecordedOutcome("not_tested")).toBe(false);
    expect(isRecordedOutcome("pass")).toBe(true);
    expect(isRecordedOutcome("fail")).toBe(true);
    expect(isRecordedOutcome("inconclusive")).toBe(true);
    expect(isOutstandingTest("planned")).toBe(true);
    expect(isOutstandingTest("in_progress")).toBe(true);
    expect(isOutstandingTest("completed")).toBe(false);
    expect(isOutstandingTest("not_applicable")).toBe(false);
    expect(isOutstandingTest("cancelled")).toBe(false);
  });

  test("execution requires an authorized scope on a started assessment", () => {
    expect(mayExecuteTests("in_progress", "authorized")).toBe(true);
    expect(mayExecuteTests("in_progress", "draft")).toBe(false);
    expect(mayExecuteTests("in_progress", undefined)).toBe(false);
    expect(mayExecuteTests("scheduled", "authorized")).toBe(false);
    expect(mayExecuteTests("completed", "authorized")).toBe(false);
  });

  test("scope membership, exclusions and the written window share one gate", () => {
    expect(
      isTargetExcluded(
        "legacy-billing.gov.example is out of scope for this engagement",
        "legacy-billing.gov.example",
      ),
    ).toBe(true);
    expect(isTargetExcluded("None", "portal.gov.example")).toBe(false);
    expect(isTargetExcluded(undefined, "portal.gov.example")).toBe(false);
    expect(
      isTargetInAuthorizedScope(
        "portal.gov.example and api.gov.example",
        "portal.gov.example",
      ),
    ).toBe(true);
    expect(
      isTargetInAuthorizedScope(
        "portal.gov.example and api.gov.example",
        "unknown-host.gov.example",
      ),
    ).toBe(false);
    expect(isWithinTestingWindow(100, 200, 150)).toBe(true);
    expect(isWithinTestingWindow(100, 200, 201)).toBe(false);
    expect(isWithinTestingWindow(undefined, 200, 150)).toBe(false);

    const base = {
      assessmentStatus: "in_progress" as const,
      scopeStatus: "authorized" as const,
      systemsInScope: "portal.gov.example",
      exclusions: "None",
      authorizedStartAt: 100,
      authorizedEndAt: 200,
      target: "portal.gov.example",
      now: 150,
    };
    expect(testingExecutionStatus(base).allowed).toBe(true);
    expect(
      testingExecutionStatus({ ...base, now: 250 }).reason,
    ).toMatch(/outside the authorized testing window/);
    expect(
      testingExecutionStatus({ ...base, target: "other.gov.example" }).reason,
    ).toMatch(/not listed in the authorized testing scope/);
    expect(
      testingExecutionStatus({
        ...base,
        exclusions: "body-portal.gov.example is excluded",
      }).reason,
    ).toMatch(/explicit exclusions/);
  });

  test("an open or false-positive record is not a confirmed vulnerability", () => {
    expect(isConfirmedVulnerabilityStatus("open")).toBe(false);
    expect(isConfirmedVulnerabilityStatus("false_positive")).toBe(false);
    expect(isConfirmedVulnerabilityStatus("confirmed")).toBe(true);
    expect(isConfirmedVulnerabilityStatus("verified")).toBe(true);
  });
});

describe("security testing backend invariants", () => {
  const testing = read("src/convex/cyberTesting.ts");
  const assessments = read("src/convex/cyberAssessments.ts");
  const schema = read("src/convex/schema.ts");
  const vocabulary = read("src/lib/cyber.ts");

  test("reads and writes go through the canonical cyber permissions", () => {
    expect(testing).toContain("resolveCyberAccess(ctx)");
    expect(testing).toContain("requireCyberManager(ctx)");
    // Every exported mutation obtains authority from the manager helper (the
    // read handlers use resolveCyberAccess instead).
    const mutations = testing.split("= mutation({").length - 1;
    const managerCalls = testing.split("requireCyberManager(ctx)").length - 1;
    expect(mutations).toBeGreaterThanOrEqual(10);
    expect(managerCalls).toBe(mutations);
  });

  test("no function accepts a client-supplied organization or role", () => {
    expect(testing).not.toMatch(/organizationId:\s*v\.id\("organizations"\)/);
    expect(testing).not.toMatch(/role:\s*v\./);
    expect(testing).not.toMatch(/permission:\s*v\./);
    expect(testing).toMatch(/organizationId: (manager|access)\.organizationId/);
  });

  test("test cases extend the existing assessment and vulnerability registers", () => {
    expect(testing).not.toMatch(/insert\("securityAssessments"/);
    expect(testing).not.toMatch(/insert\("vulnerabilities"/);
    expect(testing).not.toMatch(/patch\(\s*vulnerab/i);
    expect(schema).toContain("cyberTestCases: defineTable({");
    expect(schema).toContain("assessmentId: v.id(\"securityAssessments\")");
    // Test history reuses the append-only events table.
    expect(schema).toContain("testCaseId: v.optional(v.id(\"cyberTestCases\"))");
  });

  test("no scanner or tool execution is performed by the application", () => {
    expect(testing).not.toMatch(/child_process|execSync|spawn\(|nmap|metasploit/i);
    expect(testing).not.toMatch(/fetch\(/);
  });

  test("a failed test never raises or resolves a vulnerability", () => {
    expect(testing).not.toMatch(/autoCreate|createVulnerability|verifyVulnerability/i);
    expect(testing).not.toMatch(/insert\("vulnerabilities"/);
    expect(testing).toContain("Linking\n *    an existing vulnerability is traceability only");
  });

  test("completion of an assessment respects outstanding test cases", () => {
    expect(assessments).toContain("outstandingTestsForAssessment");
    expect(assessments).toContain("still planned or in progress");
  });

  test("independent review and immutable results are enforced server-side", () => {
    expect(testing).toContain("cannot review their own test result");
    expect(testing).toContain("already been reviewed");
    expect(testing).toContain("started and completed results are immutable");
    // The execution gate is shared with the presenter, so the reason a start is
    // refused is the very text the UI shows.
    expect(testing).toContain("testingExecutionStatus");
    expect(vocabulary).toContain(
      "Testing can only start inside an authorized scope",
    );
  });

  test("no development authentication shortcut in the testing module", () => {
    expect(testing).not.toContain("IITAMS_ALLOW_GUEST_AUTH");
    expect(testing).not.toContain("devOtp");
    expect(testing).not.toContain("VLY_OTP_API_KEY");
  });
});

// ---------------------------------------------------------------------------
// Runtime checks against the development backend
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `TST-${suffix.toUpperCase().slice(-6)}`;

const MANAGER_EMAIL = "compliance-manager-m@iitams.test";
const REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";
const READ_ONLY_EMAIL = "risk-tenant-a@iitams.test";
const MANAGER_A_EMAIL = "cyber-manager-a@iitams.test";

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
      readFileSync(
        join(process.cwd(), ".convex/local/default/config.json"),
        "utf8",
      ),
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
  const c = new ConvexHttpClient(CONVEX_URL);
  const auth = c as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    setAuth: (value: string) => void;
  };
  try {
    await auth.action(api.auth.signIn, {
      provider: "email-otp",
      params: { email },
    });
    let code: string | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1200));
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
    const finished = (await auth.action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) auth.setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

async function prepareFixtures(): Promise<boolean> {
  const adminKey = devAdminKey();
  if (!adminKey || !(await serverUp())) return false;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(
    adminKey,
  );
  try {
    await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {});
    return true;
  } catch {
    return false;
  }
}

const fixturesReady = await prepareFixtures();
const runtime = fixturesReady ? describe : describe.skip;

const DAY = 86_400_000;

type TestSummaryShape = {
  total: number;
  planned: number;
  inProgress: number;
  completed: number;
  notApplicable: number;
  cancelled: number;
  passed: number;
  failed: number;
  inconclusive: number;
  notTested: number;
  outstanding: number;
  linkedVulnerability: number;
  linkedConfirmedVulnerability: number;
};

type AssessmentDetail = {
  assessment: {
    _id: string;
    status: string;
    completedAt: number | null;
    outcomeSummary: string | null;
    vulnerabilityCount: number;
    reference: string | null;
  };
  testingScope: {
    scopeStatus: string;
    authorizationReference: string | null;
    systemsInScope: string | null;
    exclusions: string | null;
    leadTesterLabel: string | null;
    methodology: string | null;
    rulesOfEngagement: string | null;
    authorizedStartAt: number | null;
    authorizedEndAt: number | null;
  };
  testSummary: {
    total: number;
    planned: number;
    inProgress: number;
    completed: number;
    passed: number;
    failed: number;
    outstanding: number;
    linkedConfirmedVulnerability: number;
  };
  outstandingTests: number;
  testCases: Array<{
    _id: string;
    status: string;
    outcome: string;
    evidenceIds: string[];
    vulnerabilityId: string | null;
  }>;
};

type TestDetail = {
  testCase: {
    _id: string;
    status: string;
    outcome: string;
    outcomeLabel: string;
    observations: string | null;
    evidenceIds: string[];
    vulnerabilityId: string | null;
    vulnerabilityConfirmed: boolean;
    reviewedAt: number | null;
    reviewedByLabel: string | null;
    reviewNotes: string | null;
    executionAllowed: boolean;
    reference: string;
    testerLabel: string;
  };
  events: Array<{ type: string; actorLabel: string; summary: string }>;
  evidence: Array<{ _id: string; filename: string }>;
  canManage: boolean;
};

runtime("security testing engagements and test cases (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);
  const managerAPromise = signInEmailOtp(MANAGER_A_EMAIL);

  let assessmentId: Id<"securityAssessments">;
  let testCaseId: Id<"cyberTestCases">;
  let evidenceId: Id<"cyberEvidence">;
  let vulnerabilityId: Id<"vulnerabilities">;
  let assessmentAId: Id<"securityAssessments">;
  let testCaseAId: Id<"cyberTestCases">;
  let vulnerabilityAId: Id<"vulnerabilities">;

  test("a recorded engagement is not authorized, and nothing can start yet", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const created = await manager.mutation(
      api.cyberAssessments.createAssessment,
      {
        name: `${RUN_TAG} external penetration test`,
        type: "penetration_test",
        scope: "External perimeter of the citizen payment portal",
        objectives: "Identify exploitable weaknesses before the public launch",
        relatedAssetOrService: "Citizen payment portal",
        plannedStartAt: Date.now(),
        plannedEndAt: Date.now() + 14 * DAY,
      },
    );
    assessmentId = created.assessmentId;
    expect(created.reference).toMatch(/^CSA-\d{3,}$/);

    const draft = (await manager.query(api.cyberAssessments.getAssessment, {
      assessmentId: created.assessmentId,
    })) as AssessmentDetail;
    expect(draft.testingScope.scopeStatus).toBe("draft");
    expect(draft.testingScope.authorizationReference).toBeNull();
    expect(draft.testSummary.total).toBe(0);

    const testCase = await manager.mutation(
      api.cyberTesting.createTestCase,
      {
        assessmentId,
        title: `${RUN_TAG} MFA bypass on admin console`,
        category: "identity_authentication",
        systemUnderTest: "portal.gov.example",
        objective:
          "Determine whether a privileged session can be established without a second factor",
        procedure:
          "Attempt the documented login flow with a valid password and no second factor, then inspect the resulting session claims",
        expectedBehaviour:
          "A second factor is required for every privileged session",
        plannedDate: Date.now() + 2 * DAY,
      },
    );
    testCaseId = testCase.testCaseId;
    expect(testCase.reference).toMatch(/^CT-\d{3,}$/);

    // Planned, but execution is refused: the scope is a draft.
    await expect(
      manager.mutation(api.cyberTesting.startTestCase, { testCaseId }),
    ).rejects.toThrow(/authorized scope/);

    // Starting the assessment alone still does not authorize testing.
    await manager.mutation(api.cyberAssessments.startAssessment, {
      assessmentId,
    });
    await expect(
      manager.mutation(api.cyberTesting.startTestCase, { testCaseId }),
    ).rejects.toThrow(/authorized scope/);

    // Incomplete authorization input is refused rather than silently accepted.
    await expect(
      manager.mutation(api.cyberTesting.authorizeTestingScope, {
        assessmentId,
        systemsInScope: "portal.gov.example",
        exclusions: "None",
        methodology: "PTES",
        rulesOfEngagement: "Testing during business hours only",
        authorizationReference: "AUTH-1",
        authorizedStartAt: Date.now(),
        authorizedEndAt: Date.now() + 7 * DAY,
      }),
    ).rejects.toThrow(/at least/);

    // A window that ends before it starts is refused.
    await expect(
      manager.mutation(api.cyberTesting.authorizeTestingScope, {
        assessmentId,
        systemsInScope:
          "portal.gov.example and the public API gateway api.gov.example",
        exclusions: "No denial-of-service testing against production",
        methodology: "PTES, OWASP WSTG v4.2",
        rulesOfEngagement:
          "Testing 08:00-18:00 EAT only; stop on service degradation; escalate to the CISO",
        authorizationReference: "AUTH-2026-001",
        authorizedStartAt: Date.now() + 7 * DAY,
        authorizedEndAt: Date.now(),
      }),
    ).rejects.toThrow(/end after it starts/);

    await manager.mutation(api.cyberTesting.authorizeTestingScope, {
      assessmentId,
      subtype: "External",
      systemsInScope:
        "portal.gov.example and the public API gateway api.gov.example",
      exclusions: "No denial-of-service testing against production",
      methodology: "PTES, OWASP WSTG v4.2",
      rulesOfEngagement:
        "Testing 08:00-18:00 EAT only; stop on service degradation; escalate to the CISO",
      authorizationReference: "AUTH-2026-001",
      authorizedStartAt: Date.now(),
      authorizedEndAt: Date.now() + 7 * DAY,
    });

    const authorized = (await manager.query(
      api.cyberAssessments.getAssessment,
      { assessmentId },
    )) as AssessmentDetail;
    expect(authorized.testingScope.scopeStatus).toBe("authorized");
    expect(authorized.testingScope.authorizationReference).toBe("AUTH-2026-001");
    expect(authorized.testingScope.exclusions).toMatch(/denial-of-service/);
    expect(authorized.testingScope.leadTesterLabel).toBeTruthy();

    // A scope can be authorized once; it is not silently re-authorized.
    await expect(
      manager.mutation(api.cyberTesting.authorizeTestingScope, {
        assessmentId,
        systemsInScope:
          "portal.gov.example and the public API gateway api.gov.example",
        exclusions: "No denial-of-service testing against production",
        methodology: "PTES",
        rulesOfEngagement:
          "Testing 08:00-18:00 EAT only; stop on service degradation; escalate to the CISO",
        authorizationReference: "AUTH-2026-002",
        authorizedStartAt: Date.now(),
        authorizedEndAt: Date.now() + 7 * DAY,
      }),
    ).rejects.toThrow(/already authorized/);

    const started = await manager.mutation(
      api.cyberTesting.startTestCase,
      { testCaseId },
    );
    expect(started.status).toBe("in_progress");
  });

  test("execution refuses excluded targets, unlisted targets and a closed window", async () => {
    const m = await managerPromise;
    expect(m).not.toBeNull();
    if (!m) return;

    async function authorize(
      name: string,
      systemsInScope: string,
      exclusions: string,
      windowStart: number,
      windowEnd: number,
    ): Promise<Id<"securityAssessments">> {
      const created = await m!.mutation(
        api.cyberAssessments.createAssessment,
        {
          name: `${RUN_TAG} ${name}`,
          type: "penetration_test",
          scope: "Fixture engagement for authorization-refusal coverage",
          objectives:
            "Prove that execution respects the recorded written authorization",
          plannedStartAt: windowStart,
          plannedEndAt: windowEnd,
        },
      );
      await m!.mutation(api.cyberTesting.authorizeTestingScope, {
        assessmentId: created.assessmentId,
        systemsInScope,
        exclusions,
        methodology: "PTES, OWASP WSTG v4.2",
        rulesOfEngagement:
          "Testing inside the authorized window only; stop on service degradation",
        authorizationReference: `AUTH-REFUSAL-${RUN_TAG}`,
        authorizedStartAt: windowStart,
        authorizedEndAt: windowEnd,
      });
      await m!.mutation(api.cyberAssessments.startAssessment, {
        assessmentId: created.assessmentId,
      });
      return created.assessmentId;
    }

    async function plan(
      assessmentId: Id<"securityAssessments">,
      systemUnderTest: string,
    ): Promise<Id<"cyberTestCases">> {
      const planned = await m!.mutation(api.cyberTesting.createTestCase, {
        assessmentId,
        title: `${RUN_TAG} refusal fixture ${systemUnderTest}`,
        category: "network_security",
        systemUnderTest,
        objective:
          "Confirm that the server refuses execution outside the written authorization",
        procedure:
          "Attempt to start the test without changing the recorded authorization",
        expectedBehaviour: "The server refuses execution with an explicit reason",
      });
      return planned.testCaseId;
    }

    // 1. A target named in the exclusions is refused even when the same text
    //    also appears in the in-scope list: exclusions always win.
    const exclusionAssessment = await authorize(
      "exclusion fixture",
      "portal.gov.example and legacy-billing.gov.example",
      "legacy-billing.gov.example is out of scope for this engagement",
      Date.now(),
      Date.now() + 7 * DAY,
    );
    const excludedCase = await plan(
      exclusionAssessment,
      "legacy-billing.gov.example",
    );
    await expect(
      m.mutation(api.cyberTesting.startTestCase, {
        testCaseId: excludedCase,
      }),
    ).rejects.toThrow(/explicit exclusions/);

    // 2. A target that is not declared in the authorized scope is refused.
    const unlistedCase = await plan(
      exclusionAssessment,
      "unknown-host.gov.example",
    );
    await expect(
      m.mutation(api.cyberTesting.startTestCase, {
        testCaseId: unlistedCase,
      }),
    ).rejects.toThrow(/not listed in the authorized testing scope/);

    // 3. A closed authorization window refuses execution even for an in-scope
    //    target on an assessment that is in progress.
    const expiredAssessment = await authorize(
      "expired window fixture",
      "portal.gov.example and api.gov.example",
      "None — no exclusions are recorded for this fixture",
      Date.now() - 3 * DAY,
      Date.now() - 2 * DAY,
    );
    const expiredCase = await plan(expiredAssessment, "portal.gov.example");
    await expect(
      m.mutation(api.cyberTesting.startTestCase, {
        testCaseId: expiredCase,
      }),
    ).rejects.toThrow(/outside the authorized testing window/);

    // The refused fixtures remain planned: no state moved on a refusal.
    const refused = (await m.query(api.cyberTesting.getTestCase, {
      testCaseId: expiredCase,
    })) as TestDetail;
    expect(refused.testCase.status).toBe("planned");
    expect(refused.testCase.executionAllowed).toBe(false);
  });

  test("outstanding tests block assessment completion", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;
    await expect(
      manager.mutation(api.cyberAssessments.completeAssessment, {
        assessmentId,
        outcomeSummary:
          "Attempted completion while the authorized test case is still running",
      }),
    ).rejects.toThrow(/still planned or in progress/);
    const detail = (await manager.query(api.cyberAssessments.getAssessment, {
      assessmentId,
    })) as AssessmentDetail;
    expect(detail.assessment.status).toBe("in_progress");
    expect(detail.outstandingTests).toBe(1);
    expect(detail.testSummary.inProgress).toBe(1);
  });

  test("observations, evidence and a recorded outcome complete the test", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    await expect(
      manager.mutation(api.cyberTesting.recordTestObservations, {
        testCaseId,
        observations: "too short",
      }),
    ).rejects.toThrow(/at least/);
    await manager.mutation(api.cyberTesting.recordTestObservations, {
      testCaseId,
      observations:
        "A privileged session was established with a valid password and no second factor; the session carried the admin role",
    });

    // Server-side evidence upload (real blob) then association with the test.
    const uploadUrl = await manager.mutation(
      api.cyberEvidence.generateEvidenceUploadUrl,
      {},
    );
    const body = `security test evidence ${RUN_TAG}`;
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body,
    });
    expect(uploadResponse.ok).toBe(true);
    const { storageId } = (await uploadResponse.json()) as {
      storageId: string;
    };
    const evidence = await manager.mutation(
      api.cyberEvidence.confirmEvidenceUpload,
      {
        storageId: storageId as Id<"_storage">,
        assessmentId,
        filename: `test-evidence-${RUN_TAG}.txt`,
        fileType: "text/plain",
        sizeBytes: body.length,
        classification: "internal",
        description: "Session claims captured during the test",
      },
    );
    evidenceId = evidence.evidenceId;
    await manager.mutation(api.cyberTesting.attachTestEvidence, {
      testCaseId,
      evidenceIds: [evidenceId],
    });

    // Filter evidence association: an unknown id is refused.
    await expect(
      manager.mutation(api.cyberTesting.attachTestEvidence, {
        testCaseId,
        evidenceIds: ["not-a-real-evidence-id" as never],
      }),
    ).rejects.toThrow();

    // A completed test cannot be completed twice, and a not-tested outcome is
    // not a result.
    await expect(
      manager.mutation(api.cyberTesting.completeTestCase, {
        testCaseId,
        outcome: "not_tested",
        observations:
          "Attempted completion without a recorded outcome value at all",
        executionDate: Date.now(),
      }),
    ).rejects.toThrow(/recorded outcome/);

    const vulnerabilitiesBefore = (await manager.query(
      api.cyberVulnerabilities.listVulnerabilities,
      { assessmentId },
    )) as { summary: { total: number } };

    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId,
      outcome: "fail",
      observations:
        "A privileged session was established without a second factor; the expected control did not hold",
      recommendations:
        "Enforce a second factor for every privileged session and re-test",
      executionDate: Date.now(),
    });

    // A failed test NEVER produces a vulnerability record by itself.
    const vulnerabilitiesAfter = (await manager.query(
      api.cyberVulnerabilities.listVulnerabilities,
      { assessmentId },
    )) as { summary: { total: number } };
    expect(vulnerabilitiesAfter.summary.total).toBe(
      vulnerabilitiesBefore.summary.total,
    );

    const detail = (await manager.query(api.cyberTesting.getTestCase, {
      testCaseId,
    })) as TestDetail;
    expect(detail.testCase.status).toBe("completed");
    expect(detail.testCase.outcome).toBe("fail");
    expect(detail.testCase.outcomeLabel).toBe("Fail");
    expect(detail.testCase.evidenceIds).toContain(evidenceId);
    expect(detail.evidence[0]?.filename).toContain(RUN_TAG);
    expect(detail.events.some((e) => e.type === "test_completed")).toBe(true);
    expect(detail.events.every((e) => typeof e.actorLabel === "string")).toBe(
      true,
    );
    expect(detail.canManage).toBe(true);

    // Completed results are immutable: no silent rewriting of history.
    await expect(
      manager.mutation(api.cyberTesting.updateTestCase, {
        testCaseId,
        title: "Rewritten after the fact",
      }),
    ).rejects.toThrow(/immutable/);
    await expect(
      manager.mutation(api.cyberTesting.recordTestObservations, {
        testCaseId,
        observations: "Rewriting the recorded observations after completion",
      }),
    ).rejects.toThrow(/in progress/);
    await expect(
      manager.mutation(api.cyberTesting.attachTestEvidence, {
        testCaseId,
        evidenceIds: [evidenceId],
      }),
    ).rejects.toThrow(/planned or in progress/);
  });

  test("the tester cannot review their own result; a second reviewer can", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    await expect(
      manager.mutation(api.cyberTesting.reviewTestCase, {
        testCaseId,
        reviewNotes: "Reviewing my own recorded result as the tester",
      }),
    ).rejects.toThrow(/cannot review their own test result/);
    await expect(
      reviewer.mutation(api.cyberTesting.reviewTestCase, {
        testCaseId,
        reviewNotes: "short",
      }),
    ).rejects.toThrow(/at least/);

    await reviewer.mutation(api.cyberTesting.reviewTestCase, {
      testCaseId,
      reviewNotes:
        "Checked the recorded observations against the attached evidence; the failure is supported",
    });
    await expect(
      reviewer.mutation(api.cyberTesting.reviewTestCase, {
        testCaseId,
        reviewNotes: "A second review of the same completed result",
      }),
    ).rejects.toThrow(/already been reviewed/);

    const detail = (await reviewer.query(api.cyberTesting.getTestCase, {
      testCaseId,
    })) as TestDetail;
    expect(detail.testCase.reviewedAt).not.toBeNull();
    expect(detail.testCase.reviewNotes).toContain("supported");
    expect(detail.events.some((e) => e.type === "test_reviewed")).toBe(true);
  });

  test("vulnerability linkage is traceability only and never changes the record", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const vulnerability = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} privileged session without a second factor`,
        assetName: "admin-console",
        severity: "high",
        cvssScore: 8.1,
        assessmentId,
        remediationDue: Date.now() + 14 * DAY,
      },
    );
    vulnerabilityId = vulnerability.vulnerabilityId;

    await manager.mutation(api.cyberTesting.linkTestCaseVulnerability, {
      testCaseId,
      vulnerabilityId,
    });

    const detail = (await manager.query(api.cyberTesting.getTestCase, {
      testCaseId,
    })) as TestDetail;
    expect(detail.testCase.vulnerabilityId).toBe(vulnerabilityId);
    // Created unconfirmed: linking never implies confirmation.
    expect(detail.testCase.vulnerabilityConfirmed).toBe(false);

    const vuln = (await manager.query(api.cyberVulnerabilities.getVulnerability, {
      vulnerabilityId,
    })) as { vulnerability: { status: string; severity: string } };
    expect(vuln.vulnerability.status).toBe("open");
    expect(vuln.vulnerability.severity).toBe("high");

    const summary = (await manager.query(api.cyberTesting.listTestCases, {
      assessmentId,
    })) as {
      summary: TestSummaryShape;
    };
    expect(summary.summary.linkedVulnerability).toBe(1);
    expect(summary.summary.linkedConfirmedVulnerability).toBe(0);
  });

  test("the assessment completes only after the test policy is satisfied", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    await expect(
      manager.mutation(api.cyberAssessments.completeAssessment, {
        assessmentId,
        outcomeSummary: "short",
      }),
    ).rejects.toThrow(/at least/);

    await manager.mutation(api.cyberAssessments.completeAssessment, {
      assessmentId,
      outcomeSummary:
        "External testing completed under AUTH-2026-001; one high-severity weakness recorded and linked",
    });

    const detail = (await manager.query(api.cyberAssessments.getAssessment, {
      assessmentId,
    })) as AssessmentDetail;
    expect(detail.assessment.status).toBe("completed");
    expect(detail.testSummary.completed).toBe(1);
    expect(detail.testSummary.failed).toBe(1);
    expect(detail.outstandingTests).toBe(0);

    // A completed assessment accepts no new test cases.
    await expect(
      manager.mutation(api.cyberTesting.createTestCase, {
        assessmentId,
        title: `${RUN_TAG} late test case`,
        category: "authorization_access",
        systemUnderTest: "Billing service",
        objective:
          "Attempt to add test work to an assessment that is already completed",
        procedure:
          "Create a test case against a completed assessment to prove the gate holds",
        expectedBehaviour: "The completed assessment refuses new test work",
      }),
    ).rejects.toThrow(/completed or cancelled/);
  });

  test("cross-tenant ids are refused even when they are valid", async () => {
    const manager = await managerPromise;
    const managerA = await managerAPromise;
    expect(manager).not.toBeNull();
    expect(managerA).not.toBeNull();
    if (!manager || !managerA) return;

    // Tenant A records its own engagement, test and vulnerability.
    const assessmentA = await managerA.mutation(
      api.cyberAssessments.createAssessment,
      {
        name: `${RUN_TAG} tenant A network review`,
        type: "network_assessment",
        scope: "Tenant A internal network segment",
        objectives: "Review the segregation of the tenant A management network",
        plannedStartAt: Date.now(),
        plannedEndAt: Date.now() + 7 * DAY,
      },
    );
    assessmentAId = assessmentA.assessmentId;
    const testA = await managerA.mutation(api.cyberTesting.createTestCase, {
      assessmentId: assessmentAId,
      title: `${RUN_TAG} tenant A segmentation check`,
      category: "network_security",
      systemUnderTest: "Tenant A management VLAN",
      objective:
        "Verify that the management VLAN cannot be reached from the user segment",
      procedure:
        "Attempt a routed connection from the user segment to a management host",
      expectedBehaviour: "The connection is refused by the segmentation policy",
    });
    testCaseAId = testA.testCaseId;
    const vulnA = await managerA.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} tenant A reachable management host`,
        assetName: "mgmt-a-01",
        severity: "medium",
        assessmentId: assessmentAId,
      },
    );
    vulnerabilityAId = vulnA.vulnerabilityId;

    // Tenant M can read its own records but not tenant A's.
    await expect(
      manager.query(api.cyberAssessments.getAssessment, {
        assessmentId: assessmentAId,
      }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      manager.query(api.cyberTesting.getTestCase, {
        testCaseId: testCaseAId,
      }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      manager.query(api.cyberVulnerabilities.getVulnerability, {
        vulnerabilityId: vulnerabilityAId,
      }),
    ).rejects.toThrow(/not found in your organization/);

    // And cannot write to them, with a role that DOES hold cyber.manage.
    await expect(
      manager.mutation(api.cyberTesting.startTestCase, {
        testCaseId: testCaseAId,
      }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      manager.mutation(api.cyberTesting.authorizeTestingScope, {
        assessmentId: assessmentAId,
        systemsInScope: "Attempting to authorize another organization's scope",
        exclusions: "Attempting to authorize another organization's scope",
        methodology: "PTES",
        rulesOfEngagement:
          "Attempting to authorize another organization's engagement scope",
        authorizationReference: "AUTH-X",
        authorizedStartAt: Date.now(),
        authorizedEndAt: Date.now() + DAY,
      }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      manager.mutation(api.cyberTesting.linkTestCaseVulnerability, {
        testCaseId,
        vulnerabilityId: vulnerabilityAId,
      }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      manager.mutation(api.cyberTesting.attachTestEvidence, {
        testCaseId: testCaseAId,
        evidenceIds: [evidenceId],
      }),
    ).rejects.toThrow(/not found in your organization/);

    // The tenant A records are untouched by the refused attempts.
    const detailA = (await managerA.query(api.cyberTesting.getTestCase, {
      testCaseId: testCaseAId,
    })) as TestDetail;
    expect(detailA.testCase.status).toBe("planned");
    expect(detailA.evidence).toHaveLength(0);
    const assessmentDetailA = (await managerA.query(
      api.cyberAssessments.getAssessment,
      { assessmentId: assessmentAId },
    )) as AssessmentDetail;
    expect(assessmentDetailA.testingScope.scopeStatus).toBe("draft");
  });

  test("a role without cyber.manage cannot write, but can read", async () => {
    const readOnly = await readOnlyPromise;
    expect(readOnly).not.toBeNull();
    if (!readOnly) return;

    await expect(
      readOnly.mutation(api.cyberTesting.createTestCase, {
        assessmentId: assessmentAId,
        title: `${RUN_TAG} read-only write attempt`,
        category: "authorization_access",
        systemUnderTest: "Tenant A portal",
        objective:
          "Attempt a write with a role that only holds the cyber view permission",
        procedure:
          "Invoke the test-case creation mutation with a read-only role",
        expectedBehaviour: "The mutation is refused server-side",
      }),
    ).rejects.toThrow(/Permission denied/);
    await expect(
      readOnly.mutation(api.cyberTesting.startTestCase, {
        testCaseId: testCaseAId,
      }),
    ).rejects.toThrow(/Permission denied/);

    // Reading is still permitted inside the caller's own organization.
    const list = (await readOnly.query(api.cyberTesting.listTestCases, {
      assessmentId: assessmentAId,
    })) as { rows: Array<{ _id: string }>; canManage: boolean };
    expect(list.canManage).toBe(false);
    expect(list.rows.some((row) => row._id === testCaseAId)).toBe(true);
  });

  test("the test-case register is bounded, paginated and organization-scoped", async () => {
    const managerA = await managerAPromise;
    expect(managerA).not.toBeNull();
    if (!managerA) return;

    for (let i = 0; i < 25; i++) {
      await managerA.mutation(api.cyberTesting.createTestCase, {
        assessmentId: assessmentAId,
        title: `${RUN_TAG} bulk test case ${String(i + 1).padStart(2, "0")}`,
        category: "configuration_hardening",
        systemUnderTest: `tenant-a-host-${i + 1}`,
        objective:
          "Exercise bounded pagination of the organization test-case register",
        procedure:
          "Create a synthetic planned test case and page through the register",
        expectedBehaviour: "The register pages in bounded, ordered batches",
      });
    }

    const firstPage = (await managerA.query(
      api.cyberTesting.listTestCases,
      { limit: 10 },
    )) as {
      rows: Array<{ _id: string; reference: string; createdAt: number }>;
      summary: TestSummaryShape;
      nextCursor: number | null;
      hasMore: boolean;
    };
    expect(firstPage.rows).toHaveLength(10);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.nextCursor).not.toBeNull();
    // Summary covers the whole organization, not only this page.
    expect(firstPage.summary.total).toBeGreaterThanOrEqual(26);
    expect(firstPage.summary.planned).toBeGreaterThanOrEqual(26);

    const secondPage = (await managerA.query(
      api.cyberTesting.listTestCases,
      { limit: 10, cursor: firstPage.nextCursor as number },
    )) as { rows: Array<{ _id: string; createdAt: number }>; hasMore: boolean };
    expect(secondPage.rows).toHaveLength(10);
    const firstIds = new Set(firstPage.rows.map((row) => row._id));
    expect(secondPage.rows.some((row) => firstIds.has(row._id))).toBe(false);

    // Ordered newest-first across the page boundary.
    const ordered = [...firstPage.rows, ...secondPage.rows].map(
      (row) => row.createdAt,
    );
    expect([...ordered].sort((a, b) => b - a)).toEqual(ordered);

    // The limit is clamped server-side; one call cannot read everything.
    const clamped = (await managerA.query(api.cyberTesting.listTestCases, {
      limit: 10_000,
    })) as { rows: unknown[] };
    expect(clamped.rows.length).toBeLessThanOrEqual(100);

    // Search and filters narrow the register honestly.
    const searched = (await managerA.query(api.cyberTesting.listTestCases, {
      search: `${RUN_TAG} bulk test case 07`,
    })) as { rows: Array<{ title: string }>; summary: TestSummaryShape };
    expect(searched.rows).toHaveLength(1);
    expect(searched.rows[0].title).toContain("bulk test case 07");

    const filtered = (await managerA.query(api.cyberTesting.listTestCases, {
      status: "completed",
    })) as { rows: unknown[]; summary: TestSummaryShape };
    expect(filtered.rows).toHaveLength(0);
    expect(filtered.summary.completed).toBe(0);

    // Tenant M's register never sees tenant A's rows.
    const manager = await managerPromise;
    if (!manager) return;
    const otherTenant = (await manager.query(api.cyberTesting.listTestCases, {
      limit: 100,
    })) as { rows: Array<{ _id: string }>; summary: TestSummaryShape };
    expect(otherTenant.summary.total).toBeGreaterThanOrEqual(1);
    expect(otherTenant.rows.some((row) => row._id === testCaseAId)).toBe(false);
  });
});
