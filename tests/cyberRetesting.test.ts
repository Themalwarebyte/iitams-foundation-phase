import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  CYBER_REPORT_TRANSITIONS,
  CYBER_RETEST_TRANSITIONS,
  canTransitionReport,
  canTransitionRetest,
  isRetestEligible,
  retestExecutionStatus,
} from "../src/lib/cyber";
import {
  buildAssuranceReportContent,
  isRetestVerified,
} from "../src/lib/cyberReport";

/**
 * Phase 4A — Batch 2B: security retesting, independent verification and
 * assurance reporting.
 *
 * Structural guarantees first, then runtime checks against the development
 * backend using the disposable fixture organizations:
 *
 *  - a retest follows a recorded failure/inconclusive result and never rewrites
 *    the original test;
 *  - execution respects the written authorization (scope, window, exclusions);
 *  - a recorded retest pass closes nothing: the vulnerability keeps its own
 *    lifecycle, and only a different reviewer verifies the retest;
 *  - a finalized report keeps its snapshot when later work changes the data;
 *  - cross-tenant ids and read-only roles are refused.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("retest and report vocabulary is explicit", () => {
  test("a retest is terminal after review and never reopens", () => {
    expect(canTransitionRetest("planned", "in_progress")).toBe(true);
    expect(canTransitionRetest("planned", "completed")).toBe(false);
    expect(canTransitionRetest("in_progress", "completed")).toBe(true);
    expect(canTransitionRetest("completed", "reviewed")).toBe(true);
    expect(canTransitionRetest("completed", "rejected")).toBe(true);
    expect(canTransitionRetest("reviewed", "in_progress")).toBe(false);
    expect(canTransitionRetest("rejected", "reviewed")).toBe(false);
    for (const [from, targets] of Object.entries(CYBER_RETEST_TRANSITIONS)) {
      expect(from.length).toBeGreaterThan(0);
      expect(Array.isArray(targets)).toBe(true);
    }
  });

  test("only a recorded failure or inconclusive result can be retested", () => {
    expect(isRetestEligible("completed", "fail")).toBe(true);
    expect(isRetestEligible("completed", "inconclusive")).toBe(true);
    expect(isRetestEligible("completed", "pass")).toBe(false);
    expect(isRetestEligible("in_progress", "fail")).toBe(false);
    expect(isRetestEligible("planned", "not_tested")).toBe(false);
    expect(isRetestVerified("reviewed")).toBe(true);
    expect(isRetestVerified("completed")).toBe(false);
  });

  test("report lifecycle never reopens a finalized report", () => {
    expect(canTransitionReport("draft", "in_review")).toBe(true);
    // Finalization is only reachable through an approved independent review.
    expect(canTransitionReport("in_review", "finalized")).toBe(false);
    expect(canTransitionReport("in_review", "reviewed")).toBe(true);
    expect(canTransitionReport("reviewed", "finalized")).toBe(true);
    expect(canTransitionReport("in_review", "draft")).toBe(true);
    expect(canTransitionReport("finalized", "in_review")).toBe(false);
    expect(canTransitionReport("finalized", "superseded")).toBe(true);
    expect(canTransitionReport("superseded", "draft")).toBe(false);
    for (const [from, targets] of Object.entries(CYBER_REPORT_TRANSITIONS)) {
      expect(from.length).toBeGreaterThan(0);
      expect(Array.isArray(targets)).toBe(true);
    }
  });

  test("retest execution requires a live authorization for the target", () => {
    const base = {
      assessmentStatus: "completed" as const,
      scopeStatus: "authorized" as const,
      systemsInScope: "portal.gov.example",
      exclusions: "None recorded for this engagement",
      authorizedStartAt: 100,
      authorizedEndAt: 200,
      target: "portal.gov.example",
      now: 150,
    };
    expect(retestExecutionStatus(base).allowed).toBe(true);
    expect(
      retestExecutionStatus({ ...base, now: 400 }).reason,
    ).toMatch(/outside the authorized testing window/);
    expect(
      retestExecutionStatus({ ...base, scopeStatus: "draft" }).reason,
    ).toMatch(/authorized testing scope/);
    expect(
      retestExecutionStatus({ ...base, assessmentStatus: "cancelled" }).reason,
    ).toMatch(/cancelled assessment/);
    expect(
      retestExecutionStatus({ ...base, target: "other.gov.example" }).reason,
    ).toMatch(/not listed in the authorized testing scope/);
    expect(
      retestExecutionStatus({
        ...base,
        exclusions: "portal.gov.example is excluded",
      }).reason,
    ).toMatch(/explicit exclusions/);
  });

  test("report aggregation counts only what was recorded", () => {
    const content = buildAssuranceReportContent({
      assessment: {
        name: "Portal penetration test",
        reference: "CSA-001",
        typeLabel: "Penetration test",
        status: "completed",
        scope: null,
        objectives: null,
        systemsInScope: "portal.gov.example",
        exclusions: "None",
        methodology: "PTES",
        authorizationReference: "AUTH-1",
        authorizedStartAt: 1,
        authorizedEndAt: 2,
        leadTesterLabel: "Tester",
        ownerLabel: "Owner",
      },
      tests: [
        {
          reference: "CT-001",
          title: "MFA",
          status: "completed",
          outcome: "fail",
          systemUnderTest: "portal.gov.example",
          vulnerabilityId: "v1",
        },
        {
          reference: "CT-002",
          title: "TLS",
          status: "completed",
          outcome: "pass",
          systemUnderTest: "portal.gov.example",
          vulnerabilityId: null,
        },
        {
          reference: "CT-003",
          title: "Headers",
          status: "planned",
          outcome: "not_tested",
          systemUnderTest: "portal.gov.example",
          vulnerabilityId: null,
        },
      ],
      retests: [
        {
          reference: "RT-001",
          originalTestReference: "CT-001",
          status: "reviewed",
          outcome: "pass",
          reviewedAt: 10,
          reviewDecision: "approved",
        },
        {
          reference: "RT-002",
          originalTestReference: "CT-001",
          status: "completed",
          outcome: "pass",
          reviewedAt: null,
          reviewDecision: null,
        },
      ],
      vulnerabilities: [
        {
          reference: "VUL-001",
          title: "MFA bypass",
          severity: "high",
          status: "confirmed",
          verifiedAt: null,
          closedAt: null,
        },
      ],
      actions: [{ status: "open", vulnerabilityReference: "VUL-001" }],
      evidence: [
        {
          reference: "ev-1",
          filename: "claims.txt",
          classification: "internal",
          accessible: true,
        },
        {
          reference: "ev-2",
          filename: "restricted.txt",
          classification: "restricted",
          accessible: false,
        },
      ],
      generatedAt: 99,
    });
    expect(content.tests.total).toBe(3);
    expect(content.tests.failed).toBe(1);
    expect(content.tests.passed).toBe(1);
    expect(content.tests.planned).toBe(1);
    expect(content.tests.testedSystems).toEqual(["portal.gov.example"]);
    expect(content.retests.reviewed).toBe(1);
    expect(content.retests.awaitingReview).toBe(1);
    expect(content.linkedVulnerabilities.confirmed).toBe(1);
    expect(content.severityDistribution.high).toBe(1);
    expect(content.outstandingRemediation.outstandingActions).toBe(1);
    expect(content.evidence.accessible).toBe(1);
    expect(content.evidence.withheld).toBe(1);
    expect(content.limitations.notTestedCases).toBe(1);
    // Counts are reported; no security score is manufactured anywhere.
    expect(Object.keys(content)).not.toContain("score");
  });
});

describe("retest and report backend invariants", () => {
  const retesting = read("src/convex/cyberRetesting.ts");
  const reports = read("src/convex/cyberReports.ts");
  const schema = read("src/convex/schema.ts");

  test("reads and writes use the canonical cyber permissions", () => {
    for (const source of [retesting, reports]) {
      expect(source).toContain("resolveCyberAccess(ctx)");
      expect(source).toContain("requireCyberManager(ctx)");
      const mutations = source.split("= mutation({").length - 1;
      const managerCalls = source.split("requireCyberManager(ctx)").length - 1;
      expect(managerCalls).toBe(mutations);
    }
  });

  test("no function accepts a client-supplied organization or role", () => {
    for (const source of [retesting, reports]) {
      expect(source).not.toMatch(/organizationId:\s*v\.id\("organizations"\)/);
      expect(source).not.toMatch(/role:\s*v\./);
      expect(source).not.toMatch(/permission:\s*v\./);
    }
  });

  test("retests extend the existing testing and vulnerability registers", () => {
    expect(schema).toContain("cyberRetests: defineTable({");
    expect(schema).toContain("originalTestCaseId: v.id(\"cyberTestCases\")");
    expect(schema).toContain("retestId: v.optional(v.id(\"cyberRetests\"))");
    expect(retesting).not.toMatch(/insert\("securityAssessments"/);
    expect(retesting).not.toMatch(/insert\("cyberTestCases"/);
    expect(retesting).not.toMatch(/insert\("vulnerabilities"/);
    // A retest never patches a vulnerability row.
    expect(retesting).not.toMatch(/patch\(\s*(row\.)?vulnerab/i);
    expect(retesting).not.toMatch(/verifyVulnerability|closeVulnerability/);
  });

  test("no write ever reaches the ICT risk register", () => {
    for (const source of [retesting, reports]) {
      expect(source).not.toMatch(/patch\(\s*risk/i);
      expect(source).not.toMatch(/insert\("risks"/);
      expect(source).not.toMatch(/residualScore|inherentScore|residualRisk/);
    }
  });

  test("no scanner or exploitation is performed", () => {
    for (const source of [retesting, reports]) {
      expect(source).not.toMatch(/child_process|execSync|spawn\(|nmap|metasploit/i);
      expect(source).not.toMatch(/fetch\(/);
    }
  });

  test("independent review refuses the tester and the executor", () => {
    expect(retesting).toContain("cannot review their own retest");
    expect(retesting).toContain("row.completedByUserId === manager.userId");
    expect(retesting).toContain("isRetestEligible(original.status, original.outcome)");
  });

  test("a finalized snapshot is written once and never patched", () => {
    // `snapshot` appears in exactly one patch — the finalization.
    const snapshotPatches = reports
      .split("ctx.db.patch(")
      .filter((chunk) => chunk.slice(0, 400).includes("snapshot"));
    expect(snapshotPatches.length).toBe(1);
    // The frozen copy is the content the independent reviewer approved.
    expect(reports).toContain("snapshot: row.reviewedSnapshot");
    expect(reports).toContain("reviewedSnapshot: content");
    expect(reports).toContain("row.snapshot ??");
  });

  test("queries are bounded and index-backed", () => {
    expect(retesting).toContain("PAGE_SCAN_LIMIT = 250");
    expect(retesting).toContain("PAGE_LIMIT_MAX = 100");
    expect(retesting).toContain(".take(SCAN_LIMIT)");
    expect(reports).toContain("PAGE_LIMIT_MAX = 100");
    for (const index of [
      "by_organization_assessment",
      "by_organization_original",
      "by_organization_created",
    ]) {
      expect(schema).toContain(index);
    }
  });

  test("no development authentication shortcut in the new modules", () => {
    for (const source of [retesting, reports]) {
      expect(source).not.toContain("IITAMS_ALLOW_GUEST_AUTH");
      expect(source).not.toContain("devOtp");
      expect(source).not.toContain("VLY_OTP_API_KEY");
    }
  });
});

// ---------------------------------------------------------------------------
// Runtime checks against the development backend
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `RT-${suffix.toUpperCase().slice(-6)}`;

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
const LONG_OBSERVATIONS =
  "Repeated the documented sign-in flow with a valid password and no second factor; a privileged session was still established";

type RetestDetail = {
  retest: {
    _id: string;
    status: string;
    outcome: string;
    executionAllowed: boolean;
    executionBlockedReason: string | null;
    verified: boolean;
    reviewDecision: string | null;
    vulnerabilityId: string | null;
    vulnerabilityStatus: string | null;
  };
  events: Array<{ type: string; actorLabel: string }>;
  canManage: boolean;
};

type ReportDetail = {
  report: {
    status: string;
    version: number;
    supersededByReportId: string | null;
    frozen: boolean;
    reviewedByLabel: string | null;
    reviewDecision: string | null;
    independentlyApproved: boolean;
  };
  content: {
    tests: { total: number; failed: number; passed: number };
    retests: { total: number; reviewed: number; awaitingReview: number };
    linkedVulnerabilities: { total: number; confirmed: number };
    severityDistribution: Record<string, number>;
  };
  frozen: boolean;
};

runtime("security retesting and assurance reporting (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);
  const managerAPromise = signInEmailOtp(MANAGER_A_EMAIL);

  let assessmentId: Id<"securityAssessments">;
  let testCaseId: Id<"cyberTestCases">;
  let vulnerabilityId: Id<"vulnerabilities">;
  let retestId: Id<"cyberRetests">;
  let reportId: Id<"cyberTestReports">;

  test("a retest requires a recorded failure and keeps the original result", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const created = await manager.mutation(
      api.cyberAssessments.createAssessment,
      {
        name: `${RUN_TAG} authorized retest engagement`,
        type: "penetration_test",
        scope: "External perimeter of the citizen payment portal",
        objectives: "Identify exploitable weaknesses before the public launch",
        relatedAssetOrService: "Citizen payment portal",
        plannedStartAt: Date.now(),
        plannedEndAt: Date.now() + 14 * DAY,
      },
    );
    assessmentId = created.assessmentId;
    await manager.mutation(api.cyberTesting.authorizeTestingScope, {
      assessmentId,
      systemsInScope: "portal.gov.example and api.gov.example",
      exclusions: "legacy-billing.gov.example is out of scope",
      methodology: "PTES, OWASP WSTG v4.2",
      rulesOfEngagement:
        "Testing 08:00-18:00 EAT only; stop on service degradation; escalate to the CISO",
      authorizationReference: `AUTH-${RUN_TAG}`,
      authorizedStartAt: Date.now(),
      authorizedEndAt: Date.now() + 7 * DAY,
    });
    await manager.mutation(api.cyberAssessments.startAssessment, {
      assessmentId,
    });

    const planned = await manager.mutation(
      api.cyberTesting.createTestCase,
      {
        assessmentId,
        title: `${RUN_TAG} MFA enforcement check`,
        category: "identity_authentication",
        systemUnderTest: "portal.gov.example",
        objective:
          "Determine whether a privileged session can be established without a second factor",
        procedure:
          "Attempt the documented login flow with a valid password and no second factor, then inspect the session claims",
        expectedBehaviour:
          "A second factor is required for every privileged session",
        plannedDate: Date.now(),
      },
    );
    testCaseId = planned.testCaseId;

    // Nothing to retest yet: the test has no recorded result.
    await expect(
      manager.mutation(api.cyberRetesting.createRetest, {
        originalTestCaseId: testCaseId,
        reason: "Remediation was claimed before any result was recorded",
        scope: "portal.gov.example sign-in",
        systemUnderTest: "portal.gov.example",
        procedure:
          "Repeat the original sign-in attempt and inspect the session claims again",
      }),
    ).rejects.toThrow(/recorded outcome is fail or inconclusive/);

    await manager.mutation(api.cyberTesting.startTestCase, { testCaseId });
    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId,
      outcome: "fail",
      observations: LONG_OBSERVATIONS,
      executionDate: Date.now(),
    });

    const vulnerability = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} privileged session without a second factor`,
        assetName: "portal.gov.example",
        severity: "high",
        assessmentId,
      },
    );
    vulnerabilityId = vulnerability.vulnerabilityId;
    await manager.mutation(api.cyberTesting.linkTestCaseVulnerability, {
      testCaseId,
      vulnerabilityId,
    });

    const retest = await manager.mutation(api.cyberRetesting.createRetest, {
      originalTestCaseId: testCaseId,
      reason:
        "Remediation was claimed for the missing second factor; verify it independently",
      scope: "Admin console sign-in on the citizen portal only",
      systemUnderTest: "portal.gov.example",
      procedure:
        "Repeat the original sign-in attempt with a valid password and no second factor, then inspect the session claims",
      plannedDate: Date.now(),
    });
    retestId = retest.retestId;
    expect(retest.reference).toMatch(/^RT-\d{3,}$/);

    const detail = (await manager.query(api.cyberRetesting.getRetest, {
      retestId,
    })) as RetestDetail;
    expect(detail.retest.status).toBe("planned");
    expect(detail.retest.vulnerabilityId).toBe(vulnerabilityId);
    expect(detail.events.every((e) => typeof e.actorLabel === "string")).toBe(
      true,
    );

    // The original test is untouched and still reports its failure.
    const original = (await manager.query(api.cyberTesting.getTestCase, {
      testCaseId,
    })) as { testCase: { status: string; outcome: string } };
    expect(original.testCase.status).toBe("completed");
    expect(original.testCase.outcome).toBe("fail");
  });

  test("retest execution refuses targets outside the recorded authorization", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const outside = await manager.mutation(api.cyberRetesting.createRetest, {
      originalTestCaseId: testCaseId,
      reason: "Attempt a retest against a host that is not in the written scope",
      scope: "Unlisted host",
      systemUnderTest: "unlisted-host.gov.example",
      procedure:
        "Attempt the original sign-in flow against a host outside the authorization",
    });
    await expect(
      manager.mutation(api.cyberRetesting.startRetest, {
        retestId: outside.retestId,
      }),
    ).rejects.toThrow(/not listed in the authorized testing scope/);

    const blocked = (await manager.query(api.cyberRetesting.getRetest, {
      retestId: outside.retestId,
    })) as RetestDetail;
    expect(blocked.retest.status).toBe("planned");
    expect(blocked.retest.executionAllowed).toBe(false);
    expect(blocked.retest.executionBlockedReason).toMatch(/not listed/);

    const started = await manager.mutation(api.cyberRetesting.startRetest, {
      retestId,
    });
    expect(started.status).toBe("in_progress");
  });

  test("a recorded pass does not close the vulnerability and self-review is refused", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    await expect(
      manager.mutation(api.cyberRetesting.completeRetest, {
        retestId,
        outcome: "not_tested",
        observations: LONG_OBSERVATIONS,
        actualDate: Date.now(),
      }),
    ).rejects.toThrow(/recorded outcome/);

    await manager.mutation(api.cyberRetesting.completeRetest, {
      retestId,
      outcome: "pass",
      observations:
        "A second factor was required for every privileged sign-in attempt during the retest",
      actualDate: Date.now(),
    });

    // The tester cannot review their own retest.
    await expect(
      manager.mutation(api.cyberRetesting.reviewRetest, {
        retestId,
        decision: "approved",
        reviewNotes: "Approving my own retest result should be impossible",
      }),
    ).rejects.toThrow(/cannot review their own retest/);

    await reviewer.mutation(api.cyberRetesting.reviewRetest, {
      retestId,
      decision: "approved",
      reviewNotes:
        "Repeated the sign-in attempt independently; the second factor is enforced",
    });

    const verified = (await manager.query(api.cyberRetesting.getRetest, {
      retestId,
    })) as RetestDetail;
    expect(verified.retest.status).toBe("reviewed");
    expect(verified.retest.verified).toBe(true);
    expect(verified.retest.reviewDecision).toBe("approved");

    // A passing, independently reviewed retest still closes nothing.
    const vulnerability = (await manager.query(
      api.cyberVulnerabilities.getVulnerability,
      { vulnerabilityId },
    )) as { vulnerability: { status: string } };
    expect(vulnerability.vulnerability.status).toBe("open");

    // The trace records the chain without inventing closure.
    const trace = (await manager.query(api.cyberRetesting.testTrace, {
      testCaseId,
    })) as {
      vulnerability: { status: string } | null;
      retests: Array<{ status: string }>;
    };
    expect(trace.vulnerability?.status).toBe("open");
    expect(trace.retests.some((row) => row.status === "reviewed")).toBe(true);
  });

  test("cross-tenant retests and read-only roles are refused", async () => {
    const manager = await managerPromise;
    const readOnly = await readOnlyPromise;
    const managerA = await managerAPromise;
    expect(manager).not.toBeNull();
    expect(readOnly).not.toBeNull();
    expect(managerA).not.toBeNull();
    if (!manager || !readOnly || !managerA) return;

    await expect(
      managerA.query(api.cyberRetesting.getRetest, { retestId }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      managerA.mutation(api.cyberRetesting.startRetest, { retestId }),
    ).rejects.toThrow(/not found in your organization/);
    await expect(
      readOnly.mutation(api.cyberRetesting.startRetest, { retestId }),
    ).rejects.toThrow(/Permission denied/);

    // The owner still has the untouched record.
    const detail = (await manager.query(api.cyberRetesting.getRetest, {
      retestId,
    })) as RetestDetail;
    expect(detail.retest.status).toBe("reviewed");
  });

  test("a finalized report keeps its snapshot after later work", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    const preview = (await manager.query(api.cyberReports.previewReport, {
      assessmentId,
    })) as {
      content: {
        tests: { total: number; failed: number };
        retests: { total: number; reviewed: number };
        linkedVulnerabilities: { total: number };
        severityDistribution: Record<string, number>;
      };
    };
    expect(preview.content.tests.total).toBe(1);
    expect(preview.content.tests.failed).toBe(1);
    expect(preview.content.retests.total).toBe(2);
    expect(preview.content.retests.reviewed).toBe(1);
    expect(preview.content.linkedVulnerabilities.total).toBe(1);
    expect(preview.content.severityDistribution.high).toBe(1);

    const created = await manager.mutation(api.cyberReports.createReport, {
      assessmentId,
      title: `${RUN_TAG} security testing assurance report`,
      conclusions:
        "Testing recorded one failed control and one independently reviewed retest; the vulnerability remains open pending its own verification.",
      recommendations:
        "Close the vulnerability through the verification workflow once remediation evidence is accepted.",
      limitations: "Testing was limited to the authorized portal scope.",
      untestedScope: "No denial-of-service testing was performed.",
    });
    reportId = created.reportId;
    expect(created.reference).toMatch(/^STR-\d{3,}$/);

    // Finalizing straight from draft is refused.
    await expect(
      manager.mutation(api.cyberReports.finalizeReport, {
        reportId,
        reviewNotes: "Attempting to skip the review stage entirely",
      }),
    ).rejects.toThrow(/approved independent review/);

    await manager.mutation(api.cyberReports.submitReport, { reportId });

    // Separation of duties: the preparer cannot approve their own report, and
    // approval alone does not finalize it.
    await expect(
      manager.mutation(api.cyberReports.reviewReport, {
        reportId,
        decision: "approved",
        reviewNotes: "Approving my own report should be impossible",
      }),
    ).rejects.toThrow(/preparer cannot review their own report/);
    await expect(
      manager.mutation(api.cyberReports.finalizeReport, {
        reportId,
        reviewNotes: "Trying to finalize while the review is still outstanding",
      }),
    ).rejects.toThrow(/approved independent review/);

    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId,
      decision: "approved",
      reviewNotes:
        "Checked the counts against the recorded tests and retests independently",
    });
    await manager.mutation(api.cyberReports.finalizeReport, {
      reportId,
      reviewNotes: "Finalizing the independently approved version",
    });

    const finalized = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(finalized.report.status).toBe("finalized");
    expect(finalized.frozen).toBe(true);
    expect(finalized.report.reviewDecision).toBe("approved");
    expect(finalized.report.reviewedByLabel).toBeTruthy();
    expect(finalized.content.tests.total).toBe(1);

    // Later work changes the records, not the finalized report.
    const later = await manager.mutation(api.cyberTesting.createTestCase, {
      assessmentId,
      title: `${RUN_TAG} late TLS configuration check`,
      category: "configuration_hardening",
      systemUnderTest: "api.gov.example",
      objective:
        "Confirm that the API gateway still refuses obsolete TLS versions",
      procedure:
        "Attempt a connection with TLS 1.0 and 1.1 and inspect the negotiated protocol",
      expectedBehaviour: "Only TLS 1.2 and above are accepted",
    });
    await manager.mutation(api.cyberTesting.startTestCase, {
      testCaseId: later.testCaseId,
    });
    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId: later.testCaseId,
      outcome: "pass",
      observations:
        "Only TLS 1.2 and above were accepted during the late configuration check",
      executionDate: Date.now(),
    });

    const unchanged = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(unchanged.content.tests.total).toBe(1);
    expect(unchanged.content.tests.passed).toBe(0);

    const livePreview = (await manager.query(api.cyberReports.previewReport, {
      assessmentId,
    })) as { content: { tests: { total: number } } };
    expect(livePreview.content.tests.total).toBe(2);

    // A finalized report cannot be edited.
    await expect(
      manager.mutation(api.cyberReports.updateReport, {
        reportId,
        title: "Rewritten after finalization",
      }),
    ).rejects.toThrow(/immutable/);
  });

  test("a revision is a new version and supersedes the earlier report", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    const revision = await manager.mutation(api.cyberReports.reviseReport, {
      reportId,
    });
    expect(revision.version).toBe(2);
    const draft = (await manager.query(api.cyberReports.getReport, {
      reportId: revision.reportId,
    })) as ReportDetail;
    expect(draft.report.status).toBe("draft");
    expect(draft.frozen).toBe(false);
    // The revision previews the CURRENT records (2 tests).
    expect(draft.content.tests.total).toBe(2);

    await manager.mutation(api.cyberReports.submitReport, {
      reportId: revision.reportId,
    });
    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId: revision.reportId,
      decision: "approved",
      reviewNotes:
        "Revision includes the late TLS check; counts re-verified independently",
    });
    await manager.mutation(api.cyberReports.finalizeReport, {
      reportId: revision.reportId,
      reviewNotes: "Finalizing the reviewed revision",
    });

    const previous = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(previous.report.status).toBe("superseded");
    expect(previous.report.supersededByReportId).toBe(revision.reportId);
    // The earlier snapshot is still exactly what was approved.
    expect(previous.content.tests.total).toBe(1);

    const list = (await manager.query(api.cyberReports.listReports, {
      assessmentId,
      limit: 1000,
    })) as { rows: Array<{ _id: string }>; canManage: boolean };
    expect(list.rows.length).toBeLessThanOrEqual(100);
    expect(list.canManage).toBe(true);
  });

  test("a foreign tester and concurrent transitions are refused", async () => {
    const manager = await managerPromise;
    const readOnly = await readOnlyPromise;
    expect(manager).not.toBeNull();
    expect(readOnly).not.toBeNull();
    if (!manager || !readOnly) return;

    // A tester must be an ACTIVE member of the caller's organization: an id from
    // another tenant is refused even though the account exists.
    const otherOrgUser = (await readOnly.query(
      api.cyberTesting.testingSummary,
      {},
    )) as { currentUserId: string };
    await expect(
      manager.mutation(api.cyberRetesting.createRetest, {
        originalTestCaseId: testCaseId,
        reason: "Attempt to assign a tester who belongs to another organization",
        scope: "portal.gov.example sign-in",
        systemUnderTest: "portal.gov.example",
        procedure:
          "Repeat the original sign-in attempt and inspect the session claims again",
        testerUserId: otherOrgUser.currentUserId as Id<"users">,
      }),
    ).rejects.toThrow(/not an active member of your organization/);

    // Two concurrent starts cannot both win: the second sees the moved state.
    const planned = await manager.mutation(api.cyberRetesting.createRetest, {
      originalTestCaseId: testCaseId,
      reason:
        "Concurrency fixture: verify only one start can move the retest state",
      scope: "portal.gov.example sign-in",
      systemUnderTest: "portal.gov.example",
      procedure:
        "Repeat the original sign-in attempt and inspect the session claims again",
    });
    const results = await Promise.allSettled([
      manager.mutation(api.cyberRetesting.startRetest, {
        retestId: planned.retestId,
      }),
      manager.mutation(api.cyberRetesting.startRetest, {
        retestId: planned.retestId,
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const detail = (await manager.query(api.cyberRetesting.getRetest, {
      retestId: planned.retestId,
    })) as RetestDetail;
    expect(detail.retest.status).toBe("in_progress");
  });
});
