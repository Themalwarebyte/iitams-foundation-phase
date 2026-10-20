import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import type { Id } from "../src/convex/_generated/dataModel";
import { api, internal } from "../src/convex/_generated/api";
import {
  CYBER_REPORT_STATUSES,
  CYBER_REPORT_TRANSITIONS,
  canTransitionReport,
} from "../src/lib/cyber";
import {
  buildAssuranceReportContent,
  redactReportContentForViewer,
  reportContentFingerprint,
  type AssuranceReportContent,
} from "../src/lib/cyberReport";
import {
  buildCyberReportHtml,
  buildCyberReportWordHtml,
  reportExportFilename,
} from "../src/lib/cyberReportExport";

/**
 * Phase 4A Batch 2B (Stage 2) + Batch 3 — independent report review, the
 * reporting hub, posture summaries and export.
 *
 * The security property under test: a report can only be finalized after a
 * DIFFERENT authenticated member approved the exact content being frozen.
 *
 * Structural checks come first (they depend on no backend), then runtime checks
 * against the development deployment using disposable fixtures.
 */

const root = process.cwd();
function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const assessmentMeta = {
  name: "Portal penetration test",
  reference: "CSA-001",
  typeLabel: "Penetration test",
  status: "completed",
  scope: "External perimeter",
  objectives: null,
  systemsInScope: "portal.gov.example",
  exclusions: "legacy-billing.gov.example is out of scope",
  methodology: "PTES",
  authorizationReference: "AUTH-1",
  authorizedStartAt: 1_700_000_000_000,
  authorizedEndAt: 1_700_600_000_000,
  leadTesterLabel: "Lead Tester",
  ownerLabel: "Owner",
};

function sampleContent(generatedAt = 1): AssuranceReportContent {
  return buildAssuranceReportContent({
    assessment: assessmentMeta,
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
        filename: "session-claims.txt",
        classification: "internal",
        accessible: true,
      },
      {
        reference: "ev-2",
        filename: "restricted-pcap.bin",
        classification: "restricted",
        accessible: false,
      },
    ],
    generatedAt,
  });
}

const reportMeta = {
  reference: "STR-001",
  title: "Citizen portal assurance report",
  status: "finalized",
  statusLabel: "Finalized",
  version: 2,
  frozen: true,
  preparedByLabel: "Preparer M",
  preparedAt: 1_700_000_000_000,
  submittedByLabel: "Preparer M",
  submittedAt: 1_700_000_100_000,
  reviewedByLabel: "Reviewer M",
  reviewedAt: 1_700_000_200_000,
  reviewDecision: "approved",
  reviewNotes: "Checked the counts against the records independently",
  finalizedByLabel: "Preparer M",
  finalizedAt: 1_700_000_300_000,
  supersededByReportId: null,
  conclusions: "One control failed and was retested.",
  recommendations: "Close the vulnerability through its verification workflow.",
  limitations: "Testing was limited to the authorized scope.",
  untestedScope: "No denial-of-service testing.",
};

describe("report review vocabulary and export", () => {
  test("a finalized report cannot be re-opened, only superseded", () => {
    expect(CYBER_REPORT_STATUSES).toContain("reviewed");
    expect(canTransitionReport("draft", "in_review")).toBe(true);
    expect(canTransitionReport("draft", "finalized")).toBe(false);
    expect(canTransitionReport("in_review", "finalized")).toBe(false);
    expect(canTransitionReport("in_review", "reviewed")).toBe(true);
    expect(canTransitionReport("reviewed", "finalized")).toBe(true);
    expect(canTransitionReport("reviewed", "superseded")).toBe(false);
    expect(canTransitionReport("finalized", "reviewed")).toBe(false);
    expect(canTransitionReport("finalized", "superseded")).toBe(true);
    expect(canTransitionReport("superseded", "draft")).toBe(false);
    for (const [from, targets] of Object.entries(CYBER_REPORT_TRANSITIONS)) {
      expect(from.length).toBeGreaterThan(0);
      expect(Array.isArray(targets)).toBe(true);
    }
  });

  test("the approval fingerprint ignores rendering time and key order", () => {
    const a = sampleContent(1);
    const b = sampleContent(999);
    expect(reportContentFingerprint(a)).toBe(reportContentFingerprint(b));
    // Convex does not promise object key order when a stored snapshot is read
    // back, so the same data with reordered keys must fingerprint identically.
    const reordered = JSON.parse(
      JSON.stringify({ generatedAt: 5, tests: a.tests, assessment: a.assessment }),
    ) as { tests: unknown; assessment: unknown };
    const reorderedAgain = {
      assessment: reordered.assessment,
      tests: reordered.tests,
      generatedAt: 6,
    };
    expect(reportContentFingerprint(reorderedAgain)).toBe(
      reportContentFingerprint(reordered),
    );
    const changed = sampleContent(1);
    changed.tests.total = 99;
    expect(reportContentFingerprint(changed)).not.toBe(
      reportContentFingerprint(a),
    );
  });

  test("a finalized export carries the snapshot, reviewer and version", () => {
    const html = buildCyberReportHtml({
      report: reportMeta,
      content: sampleContent(),
      organizationName: "IITAMS-DEMO",
      generatedBy: "Reviewer M",
      generatedAt: 1_700_000_400_000,
    });
    expect(html).toContain("FINALIZED");
    expect(html).toContain("version 2");
    expect(html).toContain("STR-001");
    expect(html).toContain("Reviewer M");
    expect(html).toContain("approved");
    expect(html).toContain("session-claims.txt");
    // Restricted evidence is excluded from the exported document.
    expect(html).not.toContain("restricted-pcap.bin");
    expect(html).toContain("withheld");
    // No score or effectiveness claim is manufactured.
    expect(html.toLowerCase()).not.toContain("security score of");
    // Print-to-PDF mechanism, not a fabricated binary.
    expect(html).toContain("window.print()");
  });

  test("a draft export is labelled as a draft", () => {
    const html = buildCyberReportHtml({
      report: { ...reportMeta, status: "draft", statusLabel: "Draft", frozen: false },
      content: sampleContent(),
      generatedBy: "Preparer M",
      generatedAt: 1_700_000_400_000,
    });
    expect(html).toContain("DRAFT / NOT FINALIZED");
    expect(html).not.toContain("FINALIZED — the content below");
  });

  test("the Word export and filename encode the version and state", () => {
    const word = buildCyberReportWordHtml({
      report: reportMeta,
      content: sampleContent(),
      generatedBy: "Preparer M",
      generatedAt: 1_700_000_400_000,
    });
    expect(word).toContain("urn:schemas-microsoft-com:office:word");
    expect(word).toContain("FINALIZED");
    expect(reportExportFilename(reportMeta, "doc")).toBe(
      "STR-001-v2-finalized-citizen-portal-assurance-report.doc",
    );
    expect(
      reportExportFilename({ ...reportMeta, frozen: false }, "html"),
    ).toContain("-draft-");
  });

  test("user-supplied report text cannot inject markup into an export", () => {
    const html = buildCyberReportHtml({
      report: {
        ...reportMeta,
        title: "Portal </td><script>alert(1)</script>",
        conclusions: '<img src=x onerror="alert(2)">',
        limitations: "Test <b>only</b> the authorized scope",
      },
      content: sampleContent(),
      generatedBy: "Preparer <script>alert(3)</script>",
      generatedAt: 1_700_000_400_000,
    });
    // Everything user-supplied is escaped; the only live script is the print
    // trigger this module adds itself.
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain('onerror="');
    expect(html).not.toContain("<script>alert(3)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(2)&quot;&gt;");
    expect(html).toContain("Test &lt;b&gt;only&lt;/b&gt; the authorized scope");
    expect(html.match(/<script>/g) ?? []).toHaveLength(1);
    // No storage URLs, tokens or evidence file links in the payload.
    expect(html).not.toMatch(/https?:\/\//);
  });

  test("truncated aggregation is disclosed, never presented as a total", () => {
    const content = buildAssuranceReportContent({
      assessment: assessmentMeta,
      tests: [],
      retests: [],
      vulnerabilities: [],
      actions: [],
      evidence: [],
      truncatedDatasets: ["test cases", "evidence records"],
      generatedAt: 1,
    });
    expect(content.limitations.truncatedDatasets).toEqual([
      "evidence records",
      "test cases",
    ]);
    const html = buildCyberReportHtml({
      report: reportMeta,
      content,
      generatedBy: "Preparer M",
      generatedAt: 1_700_000_400_000,
    });
    expect(html).toContain("AGGREGATION CAP REACHED");
    expect(html).toContain("lower bounds, not exact totals");
    expect(html).toContain("evidence records, test cases");
  });

  test("a frozen snapshot is redacted for an unauthorized viewer", () => {
    // The preparer could read restricted evidence when the snapshot was
    // captured; a read-only viewer of the same finalized report cannot.
    const captured = sampleContent();
    // Simulate a preparer with restricted clearance: the captured snapshot
    // marks every recorded item accessible.
    captured.evidence.items = captured.evidence.items.map((item) => ({
      ...item,
      accessible: true,
    }));
    captured.evidence.accessible = 2;
    captured.evidence.withheld = 0;
    expect(captured.evidence.accessible).toBe(2);
    const redacted = redactReportContentForViewer(captured, false);
    expect(redacted.evidence.total).toBe(2);
    expect(redacted.evidence.accessible).toBe(1);
    expect(redacted.evidence.withheld).toBe(1);
    expect(
      redacted.evidence.items.find((item) => item.reference === "ev-2")
        ?.accessible,
    ).toBe(false);
    // Everything except evidence visibility is the captured content.
    expect(redacted.tests).toEqual(captured.tests);
    expect(redacted.linkedVulnerabilities).toEqual(captured.linkedVulnerabilities);
    // A cleared viewer keeps the full evidence set.
    const cleared = redactReportContentForViewer(captured, true);
    expect(cleared.evidence.withheld).toBe(0);
    expect(cleared.evidence.accessible).toBe(2);
  });

  test("reviewer separation is enforced in the backend module", () => {
    const reports = read("src/convex/cyberReports.ts");
    expect(reports).toContain("preparer cannot review their own report");
    expect(reports).toContain("row.reviewedByUserId === row.preparedByUserId");
    expect(reports).toContain(
      "Finalization requires an approved independent review",
    );
    expect(reports).toContain("changed after the independent review");
    expect(reports).toContain("snapshot: row.reviewedSnapshot");
  });
});

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const RUN_TAG = `RP-${Date.now().toString(36).toUpperCase().slice(-6)}`;

const MANAGER_EMAIL = "compliance-manager-m@iitams.test";
const REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";
const MANAGER_A_EMAIL = "cyber-manager-a@iitams.test";
const READ_ONLY_EMAIL = "risk-tenant-a@iitams.test";
// Same organization as the reporting fixtures, but the ordinary `user` role
// holds cyber.view without cyber.manage: a genuine read-only cyber viewer.
const SAME_ORG_VIEWER_EMAIL = "risk-tenant-m@iitams.test";

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

type ReportDetail = {
  report: {
    _id: string;
    status: string;
    version: number;
    reviewDecision: string | null;
    reviewedByLabel: string | null;
    independentlyApproved: boolean;
    frozen: boolean;
    supersededByReportId: string | null;
  };
  content: {
    tests: { total: number; failed: number; passed: number };
    retests: { total: number };
    linkedVulnerabilities: { total: number };
    evidence: {
      total: number;
      accessible: number;
      withheld: number;
      items: Array<{
        reference: string;
        filename: string;
        classification: string;
        accessible: boolean;
      }>;
    };
  };
  history: Array<{ type: string; summary: string; actorLabel: string }>;
  canManage: boolean;
  currentUserId: string;
  currentUserLabel: string;
};

runtime("report independent review and reporting hub (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const managerAPromise = signInEmailOtp(MANAGER_A_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);
  const viewerPromise = signInEmailOtp(SAME_ORG_VIEWER_EMAIL);

  let assessmentId: Id<"securityAssessments">;
  let testCaseId: Id<"cyberTestCases">;
  let reportId: Id<"cyberTestReports">;
  let rejectedReportId: Id<"cyberTestReports">;

  test("a report cannot be reviewed or finalized by its preparer", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const created = await manager.mutation(
      api.cyberAssessments.createAssessment,
      {
        name: `${RUN_TAG} reporting engagement`,
        type: "penetration_test",
        scope: "External perimeter of the citizen payment portal",
        objectives: "Support the assurance report review workflow with real records",
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
        "Testing inside the authorized window only; stop on service degradation",
      authorizationReference: `AUTH-${RUN_TAG}`,
      authorizedStartAt: Date.now(),
      authorizedEndAt: Date.now() + 7 * DAY,
    });
    await manager.mutation(api.cyberAssessments.startAssessment, {
      assessmentId,
    });
    const planned = await manager.mutation(api.cyberTesting.createTestCase, {
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
    });
    testCaseId = planned.testCaseId;
    await manager.mutation(api.cyberTesting.startTestCase, { testCaseId });
    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId,
      outcome: "fail",
      observations:
        "A privileged session was established without a second factor; the expected control did not hold",
      executionDate: Date.now(),
    });

    const report = await manager.mutation(api.cyberReports.createReport, {
      assessmentId,
      title: `${RUN_TAG} portal assurance report`,
      conclusions:
        "One recorded control failure remains open and requires independent verification after remediation.",
      recommendations:
        "Close the vulnerability through its own verification workflow once evidence is accepted.",
      limitations: "Testing was limited to the authorized portal scope.",
      untestedScope: "No denial-of-service testing was performed.",
    });
    reportId = report.reportId;

    // No review exists yet: neither submit-skip nor finalize may succeed.
    await expect(
      manager.mutation(api.cyberReports.finalizeReport, { reportId }),
    ).rejects.toThrow(/approved independent review/);

    await manager.mutation(api.cyberReports.submitReport, { reportId });

    // The preparer is refused a self-review.
    await expect(
      manager.mutation(api.cyberReports.reviewReport, {
        reportId,
        decision: "approved",
        reviewNotes: "Approving my own report must be impossible",
      }),
    ).rejects.toThrow(/preparer cannot review their own report/);

    // A reviewer from another organization cannot see or review it.
    const managerA = await managerAPromise;
    expect(managerA).not.toBeNull();
    if (managerA) {
      await expect(
        managerA.mutation(api.cyberReports.reviewReport, {
          reportId,
          decision: "approved",
          reviewNotes: "Cross-tenant review attempt with a foreign organization id",
        }),
      ).rejects.toThrow(/not found in your organization/);
    }

    // Still not finalizable while the review is outstanding.
    await expect(
      manager.mutation(api.cyberReports.finalizeReport, { reportId }),
    ).rejects.toThrow(/approved independent review/);
  });

  test("an independent reviewer approves, and data changes invalidate it", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId,
      decision: "approved",
      reviewNotes:
        "Checked every count against the recorded test cases independently",
    });

    const approved = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(approved.report.status).toBe("reviewed");
    expect(approved.report.reviewDecision).toBe("approved");
    expect(approved.report.reviewedByLabel).toBeTruthy();
    expect(approved.report.independentlyApproved).toBe(true);
    expect(approved.report.frozen).toBe(false);

    // A late recorded test changes the data the reviewer approved.
    const late = await manager.mutation(api.cyberTesting.createTestCase, {
      assessmentId,
      title: `${RUN_TAG} late TLS configuration check`,
      category: "configuration_hardening",
      systemUnderTest: "api.gov.example",
      objective:
        "Confirm that the API gateway refuses obsolete TLS versions",
      procedure:
        "Attempt a connection with TLS 1.0 and 1.1 and inspect the negotiated protocol",
      expectedBehaviour: "Only TLS 1.2 and above are accepted",
    });
    await manager.mutation(api.cyberTesting.startTestCase, {
      testCaseId: late.testCaseId,
    });
    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId: late.testCaseId,
      outcome: "pass",
      observations:
        "Only TLS 1.2 and above were accepted during the late configuration check",
      executionDate: Date.now(),
    });

    await expect(
      manager.mutation(api.cyberReports.finalizeReport, { reportId }),
    ).rejects.toThrow(/changed after the independent review/);

    // The approval can be invalidated, the content re-reviewed, and only then
    // finalized — with exactly the reviewed snapshot.
    await manager.mutation(api.cyberReports.returnReport, {
      reportId,
      reviewNotes:
        "Invalidating the earlier approval because the recorded data changed",
    });
    const draft = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(draft.report.status).toBe("draft");
    expect(draft.report.reviewDecision).toBeNull();

    await manager.mutation(api.cyberReports.submitReport, { reportId });
    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId,
      decision: "approved",
      reviewNotes:
        "Re-reviewed including the late TLS check; counts re-verified independently",
    });
    await manager.mutation(api.cyberReports.finalizeReport, {
      reportId,
      reviewNotes: "Finalizing the re-reviewed version",
    });

    const finalized = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(finalized.report.status).toBe("finalized");
    expect(finalized.frozen).toBe(true);
    expect(finalized.content.tests.total).toBe(2);

    // Finalization is a one-way transition: a repeat (or racing) call cannot
    // re-stamp an already frozen snapshot.
    await expect(
      manager.mutation(api.cyberReports.finalizeReport, { reportId }),
    ).rejects.toThrow(/approved independent review/);

    // Audit attribution: the preparer and the reviewer are recorded separately.
    const submitted = finalized.history.find((e) => e.type === "report_submitted");
    const reviewed = finalized.history.find((e) => e.type === "report_reviewed");
    expect(submitted?.actorLabel).toBeTruthy();
    expect(reviewed?.actorLabel).toBeTruthy();
    expect(reviewed?.actorLabel).not.toBe(submitted?.actorLabel);
    expect(reviewed?.summary).toMatch(/independently approved/i);

    // Later records do not change the frozen snapshot.
    const after = await manager.mutation(api.cyberTesting.createTestCase, {
      assessmentId,
      title: `${RUN_TAG} post-finalization observation`,
      category: "logging_monitoring",
      systemUnderTest: "api.gov.example",
      objective:
        "Confirm that authentication failures are logged with an actor reference",
      procedure:
        "Trigger a failed sign-in and inspect the recorded audit entry",
      expectedBehaviour: "Every failed sign-in is recorded with a timestamp",
    });
    await manager.mutation(api.cyberTesting.startTestCase, {
      testCaseId: after.testCaseId,
    });
    await manager.mutation(api.cyberTesting.completeTestCase, {
      testCaseId: after.testCaseId,
      outcome: "pass",
      observations:
        "Each failed sign-in produced an audit entry with a timestamp and actor",
      executionDate: Date.now(),
    });

    const unchanged = (await manager.query(api.cyberReports.getReport, {
      reportId,
    })) as ReportDetail;
    expect(unchanged.content.tests.total).toBe(2);
    expect(unchanged.content.tests.passed).toBe(1);

    // The exported document carries the frozen snapshot, not the live numbers.
    const html = buildCyberReportHtml({
      report: {
        ...reportMeta,
        reference: "STR-TEST",
        version: unchanged.report.version,
      },
      content: unchanged.content as unknown as AssuranceReportContent,
      generatedBy: unchanged.currentUserLabel,
      generatedAt: Date.now(),
    });
    expect(html).toContain("FINALIZED");
    expect(html).toContain("Total test cases");
    expect(html).toContain("2");
  });

  test("a rejected report cannot be finalized and returns to draft", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    if (!manager || !reviewer) return;

    const second = await manager.mutation(api.cyberReports.createReport, {
      assessmentId,
      title: `${RUN_TAG} second report for rejection`,
      conclusions:
        "The recorded testing supports a limited conclusion until the open finding is verified.",
      recommendations:
        "Verify the open finding before relying on the portal control set.",
      limitations: "Limited to the authorized scope.",
      untestedScope: "Denial-of-service behaviour was not tested.",
    });
    rejectedReportId = second.reportId;
    await manager.mutation(api.cyberReports.submitReport, {
      reportId: rejectedReportId,
    });
    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId: rejectedReportId,
      decision: "rejected",
      reviewNotes:
        "The conclusions overstate assurance; the open finding is not reflected",
    });

    const rejected = (await manager.query(api.cyberReports.getReport, {
      reportId: rejectedReportId,
    })) as ReportDetail & { report: { reviewNotes: string | null } };
    expect(rejected.report.status).toBe("draft");
    expect(rejected.report.reviewDecision).toBe("rejected");
    expect(rejected.report.independentlyApproved).toBe(false);

    await expect(
      manager.mutation(api.cyberReports.finalizeReport, {
        reportId: rejectedReportId,
      }),
    ).rejects.toThrow(/approved independent review/);

    // A rejected draft remains editable; editing clears the stale decision.
    await manager.mutation(api.cyberReports.updateReport, {
      reportId: rejectedReportId,
      conclusions:
        "The open finding remains unresolved, so the tested portal does not yet demonstrate the required control.",
    });
    const edited = (await manager.query(api.cyberReports.getReport, {
      reportId: rejectedReportId,
    })) as ReportDetail;
    expect(edited.report.reviewDecision).toBeNull();
  });

  test("the hub is organization-scoped, searchable and bounded", async () => {
    const manager = await managerPromise;
    const managerA = await managerAPromise;
    const readOnly = await readOnlyPromise;
    expect(manager).not.toBeNull();
    expect(managerA).not.toBeNull();
    expect(readOnly).not.toBeNull();
    if (!manager || !managerA || !readOnly) return;

    const hub = (await manager.query(api.cyberReports.reportHub, {
      limit: 25,
    })) as {
      rows: Array<{
        _id: string;
        reference: string;
        status: string;
        assessmentName: string;
        preparedByLabel: string;
        reviewedByLabel: string | null;
      }>;
      counts: { total: number; finalized: number; draft: number };
      canManage: boolean;
      hasMore: boolean;
    };
    expect(hub.rows.some((row) => row._id === reportId)).toBe(true);
    expect(hub.canManage).toBe(true);
    expect(hub.counts.finalized).toBeGreaterThanOrEqual(1);

    const bySearch = (await manager.query(api.cyberReports.reportHub, {
      search: RUN_TAG,
    })) as { rows: Array<{ _id: string }> };
    expect(bySearch.rows.some((row) => row._id === rejectedReportId)).toBe(true);

    const byStatus = (await manager.query(api.cyberReports.reportHub, {
      status: "finalized",
    })) as { rows: Array<{ status: string }> };
    expect(byStatus.rows.every((row) => row.status === "finalized")).toBe(true);

    const byAssessment = (await manager.query(api.cyberReports.reportHub, {
      assessmentId,
    })) as { rows: Array<{ _id: string }> };
    expect(byAssessment.rows.some((row) => row._id === reportId)).toBe(true);

    const clamped = (await manager.query(api.cyberReports.reportHub, {
      limit: 1000,
    })) as { rows: unknown[] };
    expect(clamped.rows.length).toBeLessThanOrEqual(100);

    // Another organization sees none of these reports.
    const foreign = (await managerA.query(api.cyberReports.reportHub, {})) as {
      rows: Array<{ _id: string }>;
    };
    expect(foreign.rows.some((row) => row._id === reportId)).toBe(false);

    // A read-only viewer cannot manage, and a foreign id is refused outright.
    const viewer = (await readOnly.query(api.cyberReports.reportHub, {})) as {
      canManage: boolean;
    };
    expect(viewer.canManage).toBe(false);
    await expect(
      managerA.query(api.cyberReports.getReport, { reportId }),
    ).rejects.toThrow(/not found in your organization/);
  });

  test("the posture summary reports recorded counts only", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const posture = (await manager.query(api.cyberReports.postureSummary, {})) as {
      tests: { total: number; completed: number; passed: number; failed: number };
      vulnerabilities: { confirmed: number; bySeverity: Record<string, number> };
      remediation: { outstandingActions: number };
      retests: { total: number; awaitingReview: number };
      reports: { finalized: number; superseded: number };
      canManage: boolean;
    };
    expect(posture.canManage).toBe(true);
    expect(posture.tests.total).toBeGreaterThanOrEqual(3);
    expect(posture.tests.completed).toBeGreaterThanOrEqual(3);
    expect(posture.tests.failed).toBeGreaterThanOrEqual(1);
    expect(posture.tests.passed).toBeGreaterThanOrEqual(2);
    expect(posture.reports.finalized).toBeGreaterThanOrEqual(1);
    expect(typeof posture.remediation.outstandingActions).toBe("number");
    expect(posture.vulnerabilities.bySeverity.critical).toBeGreaterThanOrEqual(0);
    // No score-like field is exposed.
    expect(Object.keys(posture)).not.toContain("score");
    expect(Object.keys(posture)).not.toContain("effectiveness");
  });

  test("a finalized snapshot withholds restricted evidence per viewer", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    const readOnly = await viewerPromise;
    expect(manager).not.toBeNull();
    expect(reviewer).not.toBeNull();
    expect(readOnly).not.toBeNull();
    if (!manager || !reviewer || !readOnly) return;

    // Restricted evidence captured while the preparer held clearance.
    const uploadUrl = (await manager.mutation(
      api.cyberEvidence.generateEvidenceUploadUrl,
      {},
    )) as string;
    const upload = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: `${RUN_TAG} restricted packet capture summary`,
    });
    const { storageId } = (await upload.json()) as { storageId: string };
    await manager.mutation(api.cyberEvidence.confirmEvidenceUpload, {
      storageId: storageId as never,
      assessmentId,
      filename: `${RUN_TAG}-restricted-capture.txt`,
      fileType: "text/plain",
      sizeBytes: 48,
      classification: "restricted",
      description: "Restricted capture summary retained for the independent reviewer",
    });

    const report = await manager.mutation(api.cyberReports.createReport, {
      assessmentId,
      title: `${RUN_TAG} restricted evidence report`,
      conclusions:
        "The recorded evidence supports the tested controls; restricted material is referenced but not disclosed.",
      recommendations:
        "Retain the restricted capture with the same classification until the finding is verified.",
      limitations: "Limited to the authorized scope.",
      untestedScope: "Denial-of-service behaviour was not tested.",
    });
    await manager.mutation(api.cyberReports.submitReport, {
      reportId: report.reportId,
    });
    await reviewer.mutation(api.cyberReports.reviewReport, {
      reportId: report.reportId,
      decision: "approved",
      reviewNotes:
        "Counts and restricted evidence references checked against the records",
    });
    await manager.mutation(api.cyberReports.finalizeReport, {
      reportId: report.reportId,
    });

    const asManager = (await manager.query(api.cyberReports.getReport, {
      reportId: report.reportId,
    })) as ReportDetail;
    expect(asManager.frozen).toBe(true);
    expect(asManager.content.evidence.withheld).toBe(0);

    const asViewer = (await readOnly.query(api.cyberReports.getReport, {
      reportId: report.reportId,
    })) as ReportDetail;
    // The frozen content is preserved, but restricted evidence is withheld from
    // a viewer whose permissions do not cover the classification.
    expect(asViewer.content.tests).toEqual(asManager.content.tests);
    expect(asViewer.content.evidence.withheld).toBeGreaterThanOrEqual(1);
    expect(
      asViewer.content.evidence.items.some(
        (item) => item.accessible && item.classification === "restricted",
      ),
    ).toBe(false);
    const viewerExport = buildCyberReportHtml({
      report: { ...reportMeta, reference: "STR-VIEW", version: 1 },
      content: asViewer.content as unknown as AssuranceReportContent,
      generatedBy: "Read-only viewer",
      generatedAt: Date.now(),
    });
    expect(viewerExport).not.toContain(`${RUN_TAG}-restricted-capture.txt`);
    expect(viewerExport).toContain("withheld");
  });
});
