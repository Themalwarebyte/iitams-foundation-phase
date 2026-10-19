import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3C — Batch 4: compliance findings and remediation tracking.
 * ===============================================================
 * Structural guards plus runtime checks against the development backend using
 * the disposable IITAMS-TEST-M fixture organization:
 *
 *  - no finding is ever created automatically from an assessment outcome;
 *  - findings are organization-scoped and every linked id is re-validated;
 *  - an assigned action is not completed work, and completion is not
 *    verification (the implementer can never verify their own action);
 *  - a finding cannot be submitted or closed while a mandatory action is
 *    outstanding, and a verified closure needs an independent verifier;
 *  - a documented exception is the only honest route when verification
 *    evidence is missing — it is never recorded as verified;
 *  - reopening and failed verification keep the earlier history readable;
 *  - cross-tenant reads return nothing and cross-tenant writes are refused;
 *  - the compliance assessment module is unaffected by finding work.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `CF4-${suffix.toUpperCase().slice(-6)}`;

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

type FindingRow = {
  _id: string;
  reference: string;
  title: string;
  severity: string;
  status: string;
  statusLabel: string;
  controlId: string | null;
  assessmentId: string | null;
  assessmentItemId: string | null;
  evidenceIds: string[];
  ownerLabel: string;
  recordedByLabel: string;
  overdue: boolean;
  reopenCount: number;
  closureMethod: "verified" | "exception" | null;
  closureNotes: string | null;
  actions: {
    total: number;
    outstanding: number;
    mandatoryOutstanding: number;
    completedUnverified: number;
    verified: number;
    overdue: number;
  };
};

type ActionRow = {
  _id: string;
  reference: string;
  description: string;
  status: string;
  mandatory: boolean;
  overdue: boolean;
  evidenceIds: string[];
  canVerify: boolean;
  completedByLabel: string | null;
  verifiedByLabel: string | null;
};

type FindingDetail = FindingRow & {
  framework: { _id: string; code: string; name: string };
  control: { _id: string; code: string; name: string } | null;
  assessment: { _id: string; reference: string } | null;
  assessmentItem: { _id: string; controlCode: string; outcome: string } | null;
  actionRows: ActionRow[];
  history: Array<{ type: string; actorLabel: string; summary: string }>;
  canManage: boolean;
  gates: {
    canSubmit: boolean;
    submitBlockedReason: string | null;
    canClose: boolean;
    closeBlockedReason: string | null;
    canCloseWithException: boolean;
    exceptionBlockedReason: string | null;
    canReopen: boolean;
    canAddActions: boolean;
  };
};

let manager: ConvexHttpClient | null = null;
let reviewer: ConvexHttpClient | null = null;
let readOnly: ConvexHttpClient | null = null;
let tenantAViewer: ConvexHttpClient | null = null;
let tenantANonMemberUserId: string | null = null;
let foreignFrameworkId: string | null = null;

async function resetFixtures(): Promise<void> {
  try {
    const adminKey = devAdminKey();
    if (!adminKey || !(await serverUp())) return;
    const admin = new ConvexHttpClient(CONVEX_URL);
    (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
    for (let i = 0; i < 80; i += 1) {
      const result = (await admin.mutation(
        internal.devTenantFixtures.resetComplianceFixtures,
        { maxRecords: 50 },
      )) as { remaining: number };
      if (result.remaining === 0) return;
    }
  } catch (e) {
    console.warn(`[complianceFindings:WARN] cleanup skipped: ${String(e).slice(0, 200)}`);
  }
}

beforeAll(async () => {
  if (!(await serverUp()) || !token) return;
  const adminKey = devAdminKey();
  if (!adminKey) return;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
  const fixtures = (await admin.mutation(
    internal.devTenantFixtures.ensureTenantFixtures,
    {},
  )) as {
    organizations: Array<{ organizationCode: string; email: string; userId: string }>;
    complianceAdmin: { email: string } | null;
    complianceReviewer: { email: string } | null;
  };
  const tenantM = fixtures.organizations.find(
    (o) => o.organizationCode === "IITAMS-TEST-M",
  );
  const tenantA = fixtures.organizations.find(
    (o) => o.organizationCode === "IITAMS-TEST-A",
  );
  if (!tenantM || !tenantA || !fixtures.complianceAdmin || !fixtures.complianceReviewer) {
    return;
  }
  tenantANonMemberUserId = tenantA.userId;
  await resetFixtures();
  manager = await signInEmailOtp(fixtures.complianceAdmin.email);
  reviewer = await signInEmailOtp(fixtures.complianceReviewer.email);
  readOnly = await signInEmailOtp(tenantM.email);
  tenantAViewer = await signInEmailOtp(tenantA.email);
  // A real framework id from ANOTHER organization, used to prove cross-tenant
  // ids are refused. Read through tenant A's own session (never fabricated).
  try {
    const foreign = (await tenantAViewer.query(api.compliance.listFrameworks, {
      numItems: 3,
    })) as { rows: Array<{ _id: string }> } | null;
    foreignFrameworkId = foreign?.rows?.[0]?._id ?? null;
  } catch {
    foreignFrameworkId = null;
  }
}, 240000);

afterAll(async () => {
  await resetFixtures();
}, 120000);

async function newFramework(controls = 2): Promise<{
  frameworkId: string;
  controlIds: string[];
}> {
  if (!manager) throw new Error("manager unavailable");
  const identifier = `${RUN_TAG}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const framework = (await manager.mutation(api.compliance.createFramework, {
    name: `Findings framework ${identifier}`,
    identifier,
  })) as { frameworkId: string };
  const controlIds: string[] = [];
  for (let i = 0; i < controls; i += 1) {
    const control = (await manager.mutation(api.compliance.createControl, {
      frameworkId: framework.frameworkId as never,
      identifier: `B.${i + 1}`,
      title: `Findable control ${i + 1} ${suffix}`,
      domain: "operations",
      implementationStatus: "in_progress",
    })) as { controlId: string };
    controlIds.push(control.controlId);
  }
  return { frameworkId: framework.frameworkId, controlIds };
}

async function newFinding(frameworkId: string, controlId?: string) {
  if (!manager) throw new Error("manager unavailable");
  return (await manager.mutation(api.complianceFindings.createFinding, {
    title: `Compliance gap ${suffix}`,
    description:
      "The sampled period shows the control was not operating as documented.",
    severity: "high",
    frameworkId: frameworkId as never,
    ...(controlId ? { controlId: controlId as never } : {}),
    gap: "No evidence of the periodic review during the sampled quarter",
    requirement: "B.1",
    rootCause: "The review was not scheduled after the process change",
    recommendation: "Add the review to the quarterly assurance calendar",
  })) as { findingId: string; reference: string };
}

async function detailOf(findingId: string): Promise<FindingDetail> {
  if (!manager) throw new Error("manager unavailable");
  return (await manager.query(api.complianceFindings.getFinding, {
    findingId: findingId as never,
  })) as FindingDetail;
}

// ============================================================================
// Structural
// ============================================================================

describe("Compliance findings — structural guards", () => {
  const src = readFileSync("src/convex/complianceFindings.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const pageSrc = readFileSync(
    "src/components/iitams/compliance/ComplianceFindingsPage.tsx",
    "utf8",
  );
  const mainSrc = readFileSync("src/main.tsx", "utf8");
  const navSrc = readFileSync("src/lib/nav.ts", "utf8");
  const assessmentSrc = readFileSync("src/convex/complianceAssessments.ts", "utf8");

  test("reads require compliance.view; writes require compliance.manage and an active membership", () => {
    const queries = [...src.matchAll(/export const (\w+) = query\(\{/g)];
    expect(queries.length).toBeGreaterThanOrEqual(4);
    for (const fn of queries) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("resolveAccess(ctx)");
    }
    expect(src).toContain('requirePermission(ctx, "compliance.view")');
    expect(src).toContain('requirePermission(ctx, "compliance.manage")');
    expect(src).toContain('throw new Error("Caller membership is not active")');

    const mutations = [...src.matchAll(/export const (\w+) = mutation\(\{/g)];
    expect(mutations.length).toBeGreaterThanOrEqual(10);
    for (const fn of mutations) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("requireManager(ctx)");
      expect(scoped).toContain("logAudit(ctx, {");
      expect(scoped).toContain("actorLabel: manager.label");
    }
  });

  test("organization context is server-derived and every linked id is re-validated", () => {
    expect(src).not.toContain('organizationId: v.id("organizations")');
    expect(src).toContain("Finding not found in your organization");
    expect(src).toContain("Remediation action not found in your organization");
    expect(src).toContain("Framework not found in your organization");
    expect(src).toContain("Control not found in this framework and organization");
    expect(src).toContain("Assessment not found in this framework and organization");
    expect(src).toContain("The assessment item does not belong to that assessment");
    expect(src).toContain("is not an active member of your organization");
    expect(src).toContain(
      "A control test can only be referenced when it belongs to this control and organization",
    );
    expect(src).toContain(
      "Evidence can only be referenced when it belongs to this control and organization",
    );
    // A foreign finding discloses nothing on read.
    expect(src).toContain("return null;");
  });

  test("no finding is fabricated from an assessment outcome", () => {
    // The assessment module never writes findings, and this module never
    // derives one from an outcome.
    expect(assessmentSrc).not.toContain("complianceFindings");
    expect(src).not.toMatch(/outcome === "non_compliant"[\s\S]{0,200}insert\("complianceFindings"/);
    expect(src).toContain("A finding is a person's record of a compliance GAP");
    expect(src).toContain('status: "open"');
    expect(src).toContain("Record at least one remediation action before submitting");
  });

  test("completion is never treated as verification", () => {
    expect(src).toContain('status: "completed"');
    expect(src).toContain('status: "verified"');
    expect(src).toContain(
      "Independent verification must be recorded by someone other than the action owner or the implementer",
    );
    expect(src).toContain(
      "Independent verification must be recorded by someone other than the owner or the implementer of the remediation",
    );
    expect(src).toContain("canIndependentlyVerify");
    expect(src).toContain("are only complete, not independently verified");
    expect(src).toContain("implementation recorded complete");
  });

  test("closure gates: no unresolved mandatory action, and an honest exception route", () => {
    expect(src).toContain(
      "mandatory action(s) must be complete before the finding can be closed",
    );
    expect(src).toContain("mandatory action(s) are not complete yet");
    expect(src).toContain("Submit the finding for verification before closing it");
    expect(src).toContain("A verified closure requires verification evidence");
    expect(src).toContain("closureMethod: args.method");
    expect(src).toContain('v.union(v.literal("verified"), v.literal("exception"))');
    expect(src).toContain("FINDING_EXCEPTION_MIN");
  });

  test("history is append-only and every mutation is attributed", () => {
    expect(src).toContain("recordEvent");
    expect(src).toContain("complianceFindingEvents");
    expect(src).toContain('type: "reopened"');
    expect(src).toContain('type: "action_verification_failed"');
    expect(src).not.toContain("ctx.db.delete(");
    for (const action of [
      "compliance.finding_created",
      "compliance.finding_updated",
      "compliance.finding_submitted_for_verification",
      "compliance.finding_closed",
      "compliance.finding_reopened",
      "compliance.remediation_assigned",
      "compliance.remediation_updated",
      "compliance.remediation_started",
      "compliance.remediation_completed",
      "compliance.remediation_verified",
      "compliance.remediation_verification_failed",
      "compliance.remediation_cancelled",
    ]) {
      expect(src).toContain(action);
    }
  });

  test("findings are separate organization-scoped tables with bounded reads", () => {
    expect(schemaSrc).toContain("complianceFindings: defineTable({");
    expect(schemaSrc).toContain("complianceRemediationActions: defineTable({");
    expect(schemaSrc).toContain("complianceFindingEvents: defineTable({");
    expect(schemaSrc).toContain(
      '.index("by_organization_finding", ["organizationId", "findingId"])',
    );
    expect(src).toContain("PAGE_MAX");
    expect(src).toContain(".paginate({ numItems, cursor: args.cursor ?? null })");
    expect(src).toContain("FINDING_LIST_LIMIT");
    expect(src).toContain("ACTION_LIST_LIMIT");
    // A remediation figure with an undefined denominator is never published.
    expect(src).not.toMatch(/remediationRate|closureRatePct|compliancePercentage/);
    expect(src).toContain("no such figure is invented");
  });

  test("the UI gates writes on complianceManage, exposes read-only access and no percentage", () => {
    expect(mainSrc).toContain('path="/compliance/findings"');
    expect(mainSrc).toContain("ComplianceFindingsPage");
    expect(navSrc).toContain('"/compliance/findings"');
    expect(pageSrc).toContain("canManage");
    expect(pageSrc).toContain("ComplianceUnauthorized");
    expect(pageSrc).toContain("EmptyState");
    expect(pageSrc).toContain("ListSkeleton");
    const pageText = pageSrc.replace(/\s+/g, " ");
    expect(pageText).toContain("No overall remediation rate is calculated");
    expect(pageText).toContain("Completion is not verification");
    expect(pageText).toContain("Verification must be recorded by someone other than");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Compliance findings — runtime", () => {
  test(
    "a finding is linked to real records and never created by an assessment outcome",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(2);

      // An assessment marks a control partially compliant — no finding appears.
      const assessment = (await manager.mutation(
        api.complianceAssessments.createAssessment,
        {
          frameworkId: framework.frameworkId as never,
          title: `Findings linkage cycle ${suffix}`,
          reviewRequired: true,
        },
      )) as { assessmentId: string };
      const assessmentDetail = (await manager.query(
        api.complianceAssessments.getAssessment,
        { assessmentId: assessment.assessmentId as never },
      )) as { items: Array<{ _id: string; controlId: string }> };
      const item = assessmentDetail.items[0];
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: assessment.assessmentId as never,
        itemId: item._id as never,
        outcome: "partially_compliant",
        rationale: "The control operates in part; the review step was skipped twice",
      });

      const list = (await manager.query(api.complianceFindings.listFindings, {
        numItems: 100,
      })) as { rows: FindingRow[]; summary: { findings: number } };
      expect(
        list.rows.some((row) => row.assessmentId === assessment.assessmentId),
      ).toBe(false);

      // Recording a finding against the item derives the control.
      const created = (await manager.mutation(
        api.complianceFindings.createFinding,
        {
          title: `Gap recorded from the cycle ${suffix}`,
          description:
            "The periodic access review was not performed in the sampled period.",
          severity: "critical",
          frameworkId: framework.frameworkId as never,
          assessmentId: assessment.assessmentId as never,
          assessmentItemId: item._id as never,
          gap: "No review evidence for the quarter",
          requirement: "B.1",
        },
      )) as { findingId: string; reference: string };
      expect(created.reference).toMatch(/^CF-\d+$/);

      const detail = await detailOf(created.findingId);
      expect(detail.controlId).toBe(item.controlId);
      expect(detail.assessment?.reference).toBeTruthy();
      expect(detail.assessmentItem?.controlCode).toBe("B.1");
      expect(detail.status).toBe("open");
      expect(detail.severity).toBe("critical");
      expect(detail.recordedByLabel).toBeTruthy();
      expect(detail.ownerLabel).toBeTruthy();
      expect(detail.history.some((h) => h.type === "created")).toBe(true);
      expect(detail.gates.canAddActions).toBe(true);

      // Validation is server-side.
      await expect(
        manager
          .mutation(api.complianceFindings.createFinding, {
            title: "Too short",
            description: "nope",
            severity: "low",
            frameworkId: framework.frameworkId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Finding description must be at least/i);
      await expect(
        manager
          .mutation(api.complianceFindings.createFinding, {
            title: "Bad dates",
            description: "A gap recorded with an impossible target date window",
            severity: "low",
            frameworkId: framework.frameworkId as never,
            identifiedAt: Date.now(),
            targetDate: Date.now() - 86_400_000,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/cannot precede/i);
      if (foreignFrameworkId) {
        await expect(
          manager
            .mutation(api.complianceFindings.createFinding, {
              title: "Foreign framework",
              description: "A gap recorded against a framework of another tenant",
              severity: "low",
              frameworkId: foreignFrameworkId as never,
            })
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/Framework not found/i);
      }

      // The owner must be an active member of THIS organization.
      if (tenantANonMemberUserId) {
        await expect(
          manager
            .mutation(api.complianceFindings.createFinding, {
              title: "Foreign owner",
              description: "A gap whose owner belongs to a different tenant",
              severity: "low",
              frameworkId: framework.frameworkId as never,
              ownerUserId: tenantANonMemberUserId as never,
            })
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/is not an active member/i);
      }
    },
    180000,
  );

  test(
    "an assigned action is not completed work, and completion is not verification",
    async () => {
      if (!manager || !reviewer) {
        throw new Error("[test:PREREQ-FAILED] sign-in unavailable");
      }
      const framework = await newFramework(1);
      const finding = await newFinding(framework.frameworkId, framework.controlIds[0]);

      // A past due date is real overdue; verified work is never overdue.
      const action = (await manager.mutation(
        api.complianceFindings.assignRemediationAction,
        {
          findingId: finding.findingId as never,
          description: "Schedule the review and record the evidence",
          dueDate: Date.now() - 86_400_000,
          mandatory: true,
        },
      )) as { actionId: string; reference: string };
      expect(action.reference).toMatch(/^RA-\d+$/);

      let detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("in_remediation");
      expect(detail.actions.overdue).toBe(1);
      expect(detail.actionRows[0].overdue).toBe(true);
      expect(detail.gates.canSubmit).toBe(false);
      expect(detail.gates.submitBlockedReason).toContain("mandatory action");

      // Completing requires a real completion narrative.
      await expect(
        manager
          .mutation(api.complianceFindings.completeRemediationAction, {
            actionId: action.actionId as never,
            completionNotes: "done",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Completion notes must be at least/i);

      await manager.mutation(api.complianceFindings.startRemediationAction, {
        actionId: action.actionId as never,
      });
      await manager.mutation(api.complianceFindings.completeRemediationAction, {
        actionId: action.actionId as never,
        completionNotes: "Review scheduled and the signed minutes were filed",
      });

      detail = await detailOf(finding.findingId);
      expect(detail.actionRows[0].status).toBe("completed");
      expect(detail.actionRows[0].overdue).toBe(false);
      expect(detail.actions.completedUnverified).toBe(1);
      expect(detail.actions.verified).toBe(0);
      expect(detail.gates.canClose).toBe(false);
      expect(detail.gates.closeBlockedReason).toContain(
        "Submit the finding for verification before closing it",
      );
      // The implementer cannot verify their own action.
      expect(detail.actionRows[0].canVerify).toBe(false);
      await expect(
        manager
          .mutation(api.complianceFindings.verifyRemediationAction, {
            actionId: action.actionId as never,
            verificationNotes: "Looks fine to me",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/someone other than the action owner or the implementer/i);

      // An independent reviewer verifies it, with a statement.
      await reviewer.mutation(api.complianceFindings.verifyRemediationAction, {
        actionId: action.actionId as never,
        verificationNotes: "Inspected the signed minutes and the calendar entry",
      });
      const reviewerDetail = (await reviewer.query(
        api.complianceFindings.getFinding,
        { findingId: finding.findingId as never },
      )) as FindingDetail;
      expect(reviewerDetail.actionRows[0].status).toBe("verified");
      expect(reviewerDetail.actions.verified).toBe(1);
      expect(reviewerDetail.actionRows[0].verifiedByLabel).toBeTruthy();
    },
    180000,
  );

  test(
    "mandatory work blocks submission, and a verified closure needs an independent verifier",
    async () => {
      if (!manager || !reviewer) {
        throw new Error("[test:PREREQ-FAILED] sign-in unavailable");
      }
      const framework = await newFramework(1);
      const finding = await newFinding(framework.frameworkId, framework.controlIds[0]);

      const complete = (await manager.mutation(
        api.complianceFindings.assignRemediationAction,
        {
          findingId: finding.findingId as never,
          description: "Implement the missing review control",
          mandatory: true,
        },
      )) as { actionId: string };
      const outstanding = (await manager.mutation(
        api.complianceFindings.assignRemediationAction,
        {
          findingId: finding.findingId as never,
          description: "Update the assurance calendar owner",
          mandatory: true,
        },
      )) as { actionId: string };

      await expect(
        manager
          .mutation(api.complianceFindings.submitFindingForVerification, {
            findingId: finding.findingId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/mandatory action\(s\) are not complete/i);

      await manager.mutation(api.complianceFindings.completeRemediationAction, {
        actionId: complete.actionId as never,
        completionNotes: "Review control implemented and operating since this quarter",
      });
      await manager.mutation(api.complianceFindings.completeRemediationAction, {
        actionId: outstanding.actionId as never,
        completionNotes: "Calendar ownership reassigned to the assurance lead",
      });

      await manager.mutation(api.complianceFindings.submitFindingForVerification, {
        findingId: finding.findingId as never,
        notes: "Both mandatory actions are implemented; please verify independently",
      });
      let detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("awaiting_verification");
      expect(detail.gates.canSubmit).toBe(false);

      // The implementer cannot close their own work as verified.
      await expect(
        manager
          .mutation(api.complianceFindings.closeFinding, {
            findingId: finding.findingId as never,
            method: "verified",
            notes: "Verified by me after implementing the work myself",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/someone other than the owner or the implementer/i);

      await reviewer.mutation(api.complianceFindings.verifyRemediationAction, {
        actionId: complete.actionId as never,
        verificationNotes: "Walked through the control and inspected the first run",
      });
      await expect(
        reviewer
          .mutation(api.complianceFindings.closeFinding, {
            findingId: finding.findingId as never,
            method: "verified",
            notes: "One mandatory action is still not verified",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/only complete, not independently verified/i);

      await reviewer.mutation(api.complianceFindings.verifyRemediationAction, {
        actionId: outstanding.actionId as never,
        verificationNotes: "Confirmed the ownership change in the calendar",
      });
      await reviewer.mutation(api.complianceFindings.closeFinding, {
        findingId: finding.findingId as never,
        method: "verified",
        notes:
          "Both mandatory actions were inspected; the review ran in the current quarter",
      });

      detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("closed");
      expect(detail.closureMethod).toBe("verified");
      expect(detail.closedByLabel).toBeTruthy();
      expect(detail.history.some((h) => h.type === "closed")).toBe(true);
      expect(detail.gates.canReopen).toBe(true);
    },
    180000,
  );

  test(
    "a documented exception closes honestly and reopening preserves history",
    async () => {
      if (!manager || !reviewer) {
        throw new Error("[test:PREREQ-FAILED] sign-in unavailable");
      }
      const framework = await newFramework(1);
      const finding = await newFinding(framework.frameworkId);

      const action = (await manager.mutation(
        api.complianceFindings.assignRemediationAction,
        {
          findingId: finding.findingId as never,
          description: "Backfill the missing review minutes",
          mandatory: true,
        },
      )) as { actionId: string };
      await manager.mutation(api.complianceFindings.completeRemediationAction, {
        actionId: action.actionId as never,
        completionNotes: "Minutes backfilled; the paper records were filed",
      });

      // Before submission a closure is refused outright.
      await expect(
        reviewer
          .mutation(api.complianceFindings.closeFinding, {
            findingId: finding.findingId as never,
            method: "verified",
            notes: "Closing an open finding without a verification step",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Submit the finding for verification before closing/i);

      await manager.mutation(api.complianceFindings.submitFindingForVerification, {
        findingId: finding.findingId as never,
      });

      // A verified closure is refused when only completion exists; a short
      // exception is refused too.
      await expect(
        reviewer
          .mutation(api.complianceFindings.closeFinding, {
            findingId: finding.findingId as never,
            method: "verified",
            notes: "Closing without an independent verification",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/only complete, not independently verified/i);
      await expect(
        manager
          .mutation(api.complianceFindings.closeFinding, {
            findingId: finding.findingId as never,
            method: "exception",
            notes: "too short",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Closure notes must be at least/i);
      await manager.mutation(api.complianceFindings.closeFinding, {
        findingId: finding.findingId as never,
        method: "exception",
        notes:
          "Paper records were destroyed by the records office; the exception is documented and accepted by the risk committee",
      });
      let detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("closed");
      expect(detail.closureMethod).toBe("exception");
      expect(detail.closureNotes).toContain("records office");

      // Reopening preserves the closure in the history.
      await manager.mutation(api.complianceFindings.reopenFinding, {
        findingId: finding.findingId as never,
        reason: "The committee reconsidered the accepted exception this quarter",
      });
      detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("in_remediation");
      expect(detail.reopenCount).toBe(1);
      expect(detail.history.some((h) => h.type === "closed")).toBe(true);
      expect(detail.history.some((h) => h.type === "reopened")).toBe(true);
    },
    180000,
  );

  test(
    "failed verification returns the work and never leaves a finding closure-ready",
    async () => {
      if (!manager || !reviewer) {
        throw new Error("[test:PREREQ-FAILED] sign-in unavailable");
      }
      const framework = await newFramework(1);
      const finding = await newFinding(framework.frameworkId);
      const action = (await manager.mutation(
        api.complianceFindings.assignRemediationAction,
        {
          findingId: finding.findingId as never,
          description: "Reconfigure the review workflow",
          mandatory: true,
        },
      )) as { actionId: string };
      await manager.mutation(api.complianceFindings.completeRemediationAction, {
        actionId: action.actionId as never,
        completionNotes: "Workflow reconfigured and deployed to production",
      });
      await manager.mutation(api.complianceFindings.submitFindingForVerification, {
        findingId: finding.findingId as never,
      });
      expect((await detailOf(finding.findingId)).status).toBe(
        "awaiting_verification",
      );

      await reviewer.mutation(
        api.complianceFindings.failRemediationVerification,
        {
          actionId: action.actionId as never,
          reason: "The deployed configuration does not match the approved design",
        },
      );
      const detail = await detailOf(finding.findingId);
      expect(detail.status).toBe("in_remediation");
      expect(detail.actionRows[0].status).toBe("in_progress");
      expect(detail.actionRows[0].completedByLabel).toBeNull();
      expect(detail.actions.completedUnverified).toBe(0);
      expect(detail.gates.canSubmit).toBe(false);
      expect(
        detail.history.some((h) => h.type === "action_verification_failed"),
      ).toBe(true);
      expect(
        detail.history.some((h) => h.type === "submitted_for_verification"),
      ).toBe(true);
    },
    180000,
  );

  test(
    "cross-tenant and read-only callers get no writes and no foreign data",
    async () => {
      if (!manager || !readOnly || !tenantAViewer) {
        throw new Error("[test:PREREQ-FAILED] sign-in unavailable");
      }
      const framework = await newFramework(1);
      const finding = await newFinding(framework.frameworkId);

      // A read-only member cannot write.
      await expect(
        readOnly
          .mutation(api.complianceFindings.updateFinding, {
            findingId: finding.findingId as never,
            title: "Attempted change by a read-only role",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow();
      await expect(
        readOnly
          .mutation(api.complianceFindings.createFinding, {
            title: "Read-only attempt",
            description: "A read-only role attempting to record a finding here",
            severity: "low",
            frameworkId: framework.frameworkId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow();

      // A cross-tenant caller sees nothing and cannot reach the record.
      const foreignList = (await tenantAViewer.query(
        api.complianceFindings.listFindings,
        { numItems: 100 },
      )) as { rows: FindingRow[] } | null;
      expect(
        (foreignList?.rows ?? []).some((row) => row._id === finding.findingId),
      ).toBe(false);
      const foreignDetail = await tenantAViewer.query(
        api.complianceFindings.getFinding,
        { findingId: finding.findingId as never },
      );
      expect(foreignDetail).toBeNull();
      await expect(
        tenantAViewer
          .mutation(api.complianceFindings.assignRemediationAction, {
            findingId: finding.findingId as never,
            description: "Cross-tenant write attempt on a foreign finding",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow();
    },
    180000,
  );

  test(
    "evidence references are organization-scoped and the assessment module is unaffected",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(2);
      const controlId = framework.controlIds[0];

      // Evidence for the control this finding cites.
      const uploadUrl = (await manager.mutation(
        api.complianceTesting.generateEvidenceUploadUrl,
        {},
      )) as string;
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: `findings evidence ${suffix}`,
      });
      const { storageId } = (await res.json()) as { storageId: string };
      const evidence = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: controlId as never,
          filename: `finding-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 24,
          classification: "internal",
        },
      )) as { evidenceId: string };

      const finding = (await manager.mutation(
        api.complianceFindings.createFinding,
        {
          title: `Evidence-backed gap ${suffix}`,
          description:
            "The control was not operating during the sampled period, as the evidence shows.",
          severity: "medium",
          frameworkId: framework.frameworkId as never,
          controlId: controlId as never,
          evidenceIds: [evidence.evidenceId as never],
        },
      )) as { findingId: string };
      const detail = await detailOf(finding.findingId);
      expect(detail.evidenceIds).toContain(evidence.evidenceId);

      const references = (await manager.query(
        api.complianceFindings.findingReferences,
        {
          frameworkId: framework.frameworkId as never,
          controlId: controlId as never,
        },
      )) as { evidence: Array<{ _id: string }> };
      expect(references.evidence.some((e) => e._id === evidence.evidenceId)).toBe(
        true,
      );

      // Evidence recorded against a DIFFERENT control cannot be attached.
      const otherControlId = framework.controlIds[1];
      const otherUpload = (await manager.mutation(
        api.complianceTesting.generateEvidenceUploadUrl,
        {},
      )) as string;
      const otherRes = await fetch(otherUpload, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: `other control evidence ${suffix}`,
      });
      const otherStorage = (await otherRes.json()) as { storageId: string };
      const otherEvidence = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: otherStorage.storageId as never,
          controlId: otherControlId as never,
          filename: `other-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 24,
          classification: "internal",
        },
      )) as { evidenceId: string };
      await expect(
        manager
          .mutation(api.complianceFindings.createFinding, {
            title: "Cross-control evidence",
            description:
              "A gap citing evidence recorded against another control of the framework.",
            severity: "low",
            frameworkId: framework.frameworkId as never,
            controlId: controlId as never,
            evidenceIds: [otherEvidence.evidenceId as never],
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/belongs to this control and organization/i);

      // Assessment regression: assessment cycles still read and count normally,
      // and finding work did not alter any assessed record.
      const summary = (await manager.query(
        api.complianceAssessments.assessmentSummary,
        {},
      )) as { assessments: number; controlsInScope: number };
      expect(typeof summary.assessments).toBe("number");
      expect(typeof summary.controlsInScope).toBe("number");

      const findingsSummary = (await manager.query(
        api.complianceFindings.findingsSummary,
        {},
      )) as { findings: number; open: number; closed: number };
      expect(findingsSummary.findings).toBeGreaterThanOrEqual(1);
      expect(findingsSummary.open + findingsSummary.closed).toBe(
        findingsSummary.findings,
      );
    },
    180000,
  );
});
