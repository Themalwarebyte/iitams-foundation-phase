import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3C — Batch 3: compliance assessments.
 * ==========================================
 * Structural guards plus runtime checks against the development backend using
 * the disposable IITAMS-TEST-M fixture organization:
 *
 *  - a cycle snapshots every control in scope; register edits never rewrite it;
 *  - the assessor's conclusion is independent of any control-test outcome;
 *  - finalised cycles are immutable and corrections supersede them;
 *  - independent review cannot be recorded by the assessor;
 *  - counts are real record counts (no compliance percentage);
 *  - tenant isolation holds for reads, writes and evidence links;
 *  - fixture cleanup removes only this suite's records.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `CA3-${suffix.toUpperCase().slice(-6)}`;

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

async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const auth = guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    setAuth: (value: string) => void;
  };
  const result = (await auth.action(api.auth.signIn, {
    provider: "anonymous",
    params: {},
  })) as { tokens?: { token?: string; accessToken?: string } };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) auth.setAuth(jwt);
  return guest;
}

type AssessmentRow = {
  _id: string;
  reference: string;
  title: string;
  status: string;
  statusLabel: string;
  reviewRequired: boolean;
  assessorLabel: string;
  superseded: boolean;
  supersededByAssessmentId: string | null;
  supersedesAssessmentId: string | null;
  summary: Summary;
};

type Summary = {
  total: number;
  assessed: number;
  compliant: number;
  partiallyCompliant: number;
  nonCompliant: number;
  notAssessed: number;
  notApplicable: number;
  evidenceGaps: number;
  outstandingRemediation: number;
};

type Item = {
  _id: string;
  controlId: string;
  snapshot: { code: string; title: string; domainLabel?: string; effectiveness?: string };
  outcome: string;
  outcomeLabel: string;
  rationale: string | null;
  assessorLabel: string | null;
  controlTestIds: string[];
  evidence: Array<{ mappingId: string; evidenceId: string; active: boolean }>;
  activeEvidenceCount: number;
};

type AssessmentDetail = AssessmentRow & {
  framework: { _id: string; code: string; name: string };
  items: Item[];
  canManage: boolean;
  canReview: boolean;
  reviewBlockedReason: string | null;
  completedByLabel: string | null;
  reviewedByLabel: string | null;
  supersededAssessment: AssessmentRow | null;
};

let manager: ConvexHttpClient | null = null;
let reviewer: ConvexHttpClient | null = null;
let readOnly: ConvexHttpClient | null = null;
let tenantAViewer: ConvexHttpClient | null = null;

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
    console.warn(`[complianceAssessments:WARN] cleanup skipped: ${String(e).slice(0, 200)}`);
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
    complianceReviewer: { email: string; userId: string } | null;
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
  await resetFixtures();
  manager = await signInEmailOtp(fixtures.complianceAdmin.email);
  reviewer = await signInEmailOtp(fixtures.complianceReviewer.email);
  readOnly = await signInEmailOtp(tenantM.email);
  tenantAViewer = await signInEmailOtp(tenantA.email);
}, 240000);

afterAll(async () => {
  await resetFixtures();
}, 120000);

async function newFramework(controls = 2): Promise<{
  frameworkId: string;
  controlIds: string[];
  identifier: string;
}> {
  if (!manager) throw new Error("manager unavailable");
  const identifier = `${RUN_TAG}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  const framework = (await manager.mutation(api.compliance.createFramework, {
    name: `Assessment framework ${identifier}`,
    identifier,
  })) as { frameworkId: string };
  const controlIds: string[] = [];
  for (let i = 0; i < controls; i += 1) {
    const control = (await manager.mutation(api.compliance.createControl, {
      frameworkId: framework.frameworkId as never,
      identifier: `A.${i + 1}`,
      title: `Assessable control ${i + 1} ${suffix}`,
      domain: "access_control",
      implementationStatus: "implemented",
    })) as { controlId: string };
    controlIds.push(control.controlId);
  }
  return { frameworkId: framework.frameworkId, controlIds, identifier };
}

async function createAssessment(frameworkId: string, title = `Cycle ${suffix}`) {
  if (!manager) throw new Error("manager unavailable");
  return (await manager.mutation(api.complianceAssessments.createAssessment, {
    frameworkId: frameworkId as never,
    title,
    periodLabel: "2026-Q1",
    reviewRequired: true,
  })) as { assessmentId: string; reference: string; controls: number };
}

// ============================================================================
// Structural
// ============================================================================

describe("Compliance assessments — structural guards", () => {
  const src = readFileSync("src/convex/complianceAssessments.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const pageSrc = readFileSync(
    "src/components/iitams/compliance/ComplianceAssessmentsPage.tsx",
    "utf8",
  );
  const mainSrc = readFileSync("src/main.tsx", "utf8");

  test("reads require compliance.view; writes require compliance.manage and active membership", () => {
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
    const mutations = [
      ...src.matchAll(
        /export const (createAssessment|updateAssessment|startAssessment|assessControl|completeAssessment|reviewAssessment|supersedeAssessment|unlinkAssessmentEvidence) = mutation\(\{/g,
      ),
    ];
    expect(mutations.length).toBe(8);
    for (const fn of mutations) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("requireManager(ctx)");
    }
  });

  test("organization comes from the access context and every id is re-validated", () => {
    expect(src).not.toContain('organizationId: v.id("organizations")');
    expect(src).toContain("Framework not found in your organization");
    expect(src).toContain("Assessment not found in your organization");
    expect(src).toContain("Assessment item not found in this assessment");
    expect(src).toContain("is not an active member of your organization");
    expect(
      src,
    ).toContain(
      "A control test can only be referenced when it belongs to this control and organization",
    );
    expect(
      src,
    ).toContain(
      "Evidence can only be linked when it belongs to this control and organization",
    );
    // A foreign assessment discloses nothing on read.
    expect(src).toContain("return null;");
  });

  test("no assessed verdict is fabricated and no compliance percentage exists", () => {
    expect(src).not.toContain("ctx.db.patch(control._id");
    expect(src).toContain("effectiveness: control.effectiveness");
    expect(src).toContain('outcome: "not_assessed"');
    expect(src).toContain("isAssessmentVerdict(args.outcome)");
    expect(src).toContain("ASSESSMENT_RATIONALE_MIN");
    expect(src).toContain("A non-compliant outcome requires the findings");
    expect(src).not.toMatch(/complianceScorePct|compliancePercentage|scorePct/);
    expect(src).toContain("No compliance percentage is");
    // A control test is referenced, never applied as the verdict.
    expect(src).toContain("controlTestIds");
    expect(src).not.toContain("test.outcome === \"effective\"");
  });

  test("finalised cycles are immutable; corrections are superseding cycles", () => {
    expect(src).toContain(
      "A finalised assessment cannot be edited — record a superseding assessment instead",
    );
    expect(src).toContain(
      "A finalised assessment cannot be changed — record a superseding assessment instead",
    );
    expect(src).toContain("supersedesAssessmentId");
    expect(src).toContain("is already superseded by");
    expect(src).toContain("isFinalAssessment(assessment.status)");
  });

  test("independent review enforces separation of duties and completion gates", () => {
    expect(src).toContain(
      "Independent review must be recorded by someone other than the assessor or the person who completed the assessment",
    );
    expect(src).toContain("assessment.assessorUserId === manager.userId");
    expect(src).toContain("assessment.completedByUserId === manager.userId");
    expect(src).toContain("are still not assessed");
    expect(src).toContain("awaiting independent review");
    expect(src).toContain("canReview:");
  });

  test("bounded, index-backed reads and append-only audit on every write", () => {
    expect(src).toContain("PAGE_MAX");
    expect(src).toContain(".paginate({ numItems, cursor: args.cursor ?? null })");
    expect(src).toContain("ASSESSMENT_LIST_LIMIT");
    expect(src).toContain("ITEM_SCAN_LIMIT");
    const writes = [...src.matchAll(/export const (\w+) = mutation\(\{/g)];
    for (const fn of writes) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("logAudit(ctx, {");
      expect(scoped).toContain("actorLabel: manager.label");
    }
    for (const action of [
      "compliance.assessment_created",
      "compliance.assessment_updated",
      "compliance.assessment_started",
      "compliance.assessment_control_assessed",
      "compliance.assessment_completed",
      "compliance.assessment_reviewed",
      "compliance.assessment_superseded",
      "compliance.assessment_evidence_linked",
      "compliance.assessment_evidence_unlinked",
    ]) {
      expect(src).toContain(action);
    }
    expect(src).not.toContain('ctx.db.delete("auditLogs"');
  });

  test("assessment records are separate tables with immutable control snapshots", () => {
    expect(schemaSrc).toContain("complianceAssessments: defineTable({");
    expect(schemaSrc).toContain("complianceAssessmentItems: defineTable({");
    expect(schemaSrc).toContain("complianceAssessmentEvidence: defineTable({");
    expect(schemaSrc).toContain("controlSnapshot: v.object({");
    expect(schemaSrc).toContain("by_organization_assessment_control");
    // Evidence links are rows (unlink is an event), never a delete.
    expect(src).not.toContain("ctx.db.delete(mapping._id)");
    expect(src).toContain("evidence record and audit history retained");
  });

  test("the UI gates writes on complianceManage and shows no percentage", () => {
    expect(mainSrc).toContain('path="/compliance/assessments"');
    expect(mainSrc).toContain("ComplianceAssessmentsPage");
    expect(pageSrc).toContain("canManage");
    expect(pageSrc).toContain("ComplianceUnauthorized");
    expect(pageSrc).toContain("EmptyState");
    expect(pageSrc).toContain("ListSkeleton");
    const pageText = pageSrc.replace(/\s+/g, " ");
    expect(pageText).toContain("No overall compliance percentage is calculated");
    expect(pageText).toContain(
      "A control-test outcome informs this conclusion; it never sets it",
    );
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Compliance assessments — runtime", () => {
  test(
    "a cycle snapshots every control in scope and stays snapshot-stable",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(3);

      const created = await createAssessment(framework.frameworkId, `Snapshot cycle ${suffix}`);
      expect(created.reference).toMatch(/^CA-\d+$/);
      expect(created.controls).toBe(3);

      let detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      expect(detail.status).toBe("draft");
      expect(detail.reviewRequired).toBe(true);
      expect(detail.items).toHaveLength(3);
      expect(detail.items.every((i) => i.outcome === "not_assessed")).toBe(true);
      expect(detail.items[0].snapshot.title).toContain("Assessable control");
      expect(detail.items[0].snapshot.frameworkCode).toBe(frameworkIdentifierOf(framework.identifier));
      // Snapshot carries implementation state, never a verdict.
      expect(detail.items[0].snapshot.effectiveness).toBe("not_tested");

      // Editing the register must not rewrite the snapshot already recorded.
      const firstItem = detail.items[0];
      await manager.mutation(api.compliance.updateControl, {
        controlId: firstItem.controlId as never,
        title: `Renamed after snapshot ${suffix}`,
        implementationStatus: "planned",
      });
      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const after = detail.items.find((i) => i.controlId === firstItem.controlId)!;
      expect(after.snapshot.title).toBe(firstItem.snapshot.title);
      expect(after.snapshot.implementationStatus).toBe("implemented");

      // A framework with no controls cannot be assessed.
      const emptyFramework = (await manager.mutation(api.compliance.createFramework, {
        name: `Empty framework ${suffix}`,
        identifier: `${RUN_TAG}-E${Math.random().toString(36).slice(2, 5).toUpperCase()}`,
      })) as { frameworkId: string };
      await expect(
        manager
          .mutation(api.complianceAssessments.createAssessment, {
            frameworkId: emptyFramework.frameworkId as never,
            title: "No controls",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/no controls/i);

      // Date validation is server-side.
      await expect(
        manager
          .mutation(api.complianceAssessments.createAssessment, {
            frameworkId: framework.frameworkId as never,
            title: "Bad dates",
            startDate: Date.now(),
            dueDate: Date.now() - 86_400_000,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Due date cannot precede/i);
    },
    120000,
  );

  test(
    "outcomes require justification and the assessor's conclusion is independent of testing",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(2);
      const created = await createAssessment(framework.frameworkId);
      let detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const [itemOne, itemTwo] = detail.items;

      // Too-short rationale is refused for a real verdict.
      await expect(
        manager
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: itemOne._id as never,
            outcome: "compliant",
            rationale: "fine",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires a rationale of at least/i);

      // Non-compliant needs findings or remediation.
      await expect(
        manager
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: itemOne._id as never,
            outcome: "non_compliant",
            rationale: "The control was not operating during the period sampled",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires the findings/i);

      // A control test is recorded for the SAME control, then referenced.
      const takenAt = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: itemOne.controlId as never,
        title: `Independent test ${suffix}`,
        objective: "Confirm the control operates as described",
        procedure: "Inspect the configuration and a sample",
      })) as { testId: string };
      await manager.mutation(api.complianceTesting.completeControlTest, {
        testId: takenAt.testId as never,
        outcome: "effective",
        completionNotes: "Inspected configuration and sample; no exceptions found",
        evidenceException:
          "Documented exception: the sample extract could not be released for this period",
      });

      // The assessor may conclude non-compliant even though the test was
      // effective: the test informs, it never decides.
      const assessed = (await manager.mutation(
        api.complianceAssessments.assessControl,
        {
          assessmentId: created.assessmentId as never,
          itemId: itemOne._id as never,
          outcome: "non_compliant",
          rationale:
            "The configuration inspected by the test was not the production path in scope",
          findings: "Production uses a separate, undocumented approval route",
          remediation: "Route production approvals through the documented workflow",
          controlTestIds: [takenAt.testId as never],
        },
      )) as { evidenceLinked: number; testsReferenced: number };
      expect(assessed.testsReferenced).toBe(1);
      expect(assessed.evidenceLinked).toBe(0);

      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const assessedItem = detail.items.find((i) => i._id === itemOne._id)!;
      expect(assessedItem.outcome).toBe("non_compliant");
      expect(assessedItem.controlTestIds).toContain(takenAt.testId);
      expect(detail.status).toBe("in_progress"); // a draft starts on first assessment

      // A test from ANOTHER control cannot be referenced.
      const otherTest = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: itemTwo.controlId as never,
        title: `Other control test ${suffix}`,
        objective: "Belongs to a different control",
        procedure: "Not applicable",
      })) as { testId: string };
      await expect(
        manager
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: itemOne._id as never,
            outcome: "partially_compliant",
            rationale: "Attempting to reference a test from another control",
            controlTestIds: [otherTest.testId as never],
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/belongs to this control and organization/i);

      // Not applicable requires a rationale too.
      await expect(
        manager
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: itemTwo._id as never,
            outcome: "not_applicable",
            rationale: "",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires a rationale/i);

      // Not assessed (the default) is always allowed.
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: itemTwo._id as never,
        outcome: "not_assessed",
      });
    },
    180000,
  );

  test(
    "evidence is linked as auditable rows and unlinking retains the record",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(1);
      const created = await createAssessment(framework.frameworkId);
      let detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const item = detail.items[0];

      // Upload evidence for the control (Batch 2 storage + hashing path).
      const uploadUrl = (await manager.mutation(
        api.complianceTesting.generateEvidenceUploadUrl,
        {},
      )) as string;
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: `assessment evidence ${suffix}`,
      });
      const { storageId } = (await res.json()) as { storageId: string };
      const evidence = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: item.controlId as never,
          filename: `assess-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 30,
          classification: "internal",
        },
      )) as { evidenceId: string };

      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: item._id as never,
        outcome: "partially_compliant",
        rationale:
          "Examined the approval log and found two requests missing a second approver",
        evidenceIds: [evidence.evidenceId as never],
      });

      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const withEvidence = detail.items[0];
      expect(withEvidence.activeEvidenceCount).toBe(1);
      expect(detail.summary.partiallyCompliant).toBe(1);
      expect(detail.summary.evidenceGaps).toBe(0);

      const refs = (await manager.query(api.complianceAssessments.assessmentReferences, {
        assessmentId: created.assessmentId as never,
        controlId: item.controlId as never,
      })) as { evidence: Array<{ _id: string; filename: string }> };
      expect(refs.evidence.some((e) => e._id === evidence.evidenceId)).toBe(true);

      // Unlinking is an event: the evidence record survives and the gap appears.
      const mapping = withEvidence.evidence.find((e) => e.active)!;
      await expect(
        manager
          .mutation(api.complianceAssessments.unlinkAssessmentEvidence, {
            mappingId: mapping.mappingId as never,
            reason: "",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Unlink reason is required/i);
      await manager.mutation(api.complianceAssessments.unlinkAssessmentEvidence, {
        mappingId: mapping.mappingId as never,
        reason: "Replaced by the revised extract",
      });
      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      expect(detail.items[0].activeEvidenceCount).toBe(0);
      expect(detail.summary.evidenceGaps).toBe(1);
      // The evidence itself is untouched and still retrievable (audited).
      const download = (await manager.mutation(
        api.complianceTesting.evidenceDownloadUrl,
        { evidenceId: evidence.evidenceId as never },
      )) as { url: string };
      expect(download.url).toContain("http");
    },
    180000,
  );

  test(
    "completion, independent review and immutable history",
    async () => {
      if (!manager || !reviewer) {
        throw new Error("[test:PREREQ-FAILED] fixture clients unavailable");
      }
      const framework = await newFramework(2);
      const created = await createAssessment(framework.frameworkId);
      let detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;

      // Explicit start first (draft → in progress), then only the first
      // control is assessed → completion is refused.
      const [first, second] = detail.items;
      const started = (await manager.mutation(
        api.complianceAssessments.startAssessment,
        { assessmentId: created.assessmentId as never },
      )) as { status: string };
      expect(started.status).toBe("in_progress");
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: first._id as never,
        outcome: "compliant",
        rationale: "Inspected the configuration and the sample; all approvals present",
      });
      await expect(
        manager
          .mutation(api.complianceAssessments.completeAssessment, {
            assessmentId: created.assessmentId as never,
            completionNotes: "Assessed the first control only",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/still not assessed/i);

      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: second._id as never,
        outcome: "not_applicable",
        rationale: "The control concerns a service this organization does not operate",
      });

      // Short completion notes are refused.
      await expect(
        manager
          .mutation(api.complianceAssessments.completeAssessment, {
            assessmentId: created.assessmentId as never,
            completionNotes: "done",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/at least 20 characters/i);

      await manager.mutation(api.complianceAssessments.completeAssessment, {
        assessmentId: created.assessmentId as never,
        completionNotes:
          "Assessed both controls in scope over the Q1 period; no limitations",
      });

      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      expect(detail.status).toBe("completed");
      expect(detail.completedByLabel).toBeTruthy();
      // The assessor cannot review their own cycle.
      expect(detail.canReview).toBe(false);
      expect(detail.reviewBlockedReason).toMatch(/someone other than the assessor/i);

      // A finalised cycle rejects further assessment.
      await expect(
        manager
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: first._id as never,
            outcome: "non_compliant",
            rationale: "Attempting to change a finalised assessment record",
            findings: "Not allowed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/finalised assessment cannot be changed/i);
      await expect(
        manager
          .mutation(api.complianceAssessments.updateAssessment, {
            assessmentId: created.assessmentId as never,
            title: "Rewriting a finalised assessment",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/finalised assessment cannot be edited/i);

      // The assessor cannot review; a different manager can.
      await expect(
        manager
          .mutation(api.complianceAssessments.reviewAssessment, {
            assessmentId: created.assessmentId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/someone other than the assessor/i);
      const reviewed = (await reviewer.mutation(
        api.complianceAssessments.reviewAssessment,
        {
          assessmentId: created.assessmentId as never,
          reviewNotes: "Reviewed the rationale and evidence; conclusions supported",
        },
      )) as { status: string };
      expect(reviewed.status).toBe("reviewed");

      detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      expect(detail.status).toBe("reviewed");
      expect(detail.reviewedByLabel).toBeTruthy();

      // A correction is a NEW cycle; the reviewed original is untouched.
      const superseding = (await manager.mutation(
        api.complianceAssessments.supersedeAssessment,
        {
          assessmentId: created.assessmentId as never,
          title: `Reassessment of ${created.reference}`,
          amendmentReason: "The scope changed after the first assessment",
        },
      )) as { assessmentId: string; reference: string; supersedesAssessmentId: string };
      expect(superseding.reference).not.toBe(created.reference);
      expect(superseding.supersedesAssessmentId).toBe(created.assessmentId);

      const original = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      expect(original.status).toBe("reviewed"); // unchanged
      expect(original.superseded).toBe(true);
      expect(original.supersededByAssessmentId).toBe(superseding.assessmentId);
      expect(original.items.find((i) => i._id === first._id)!.outcome).toBe(
        "compliant",
      );

      const replacement = (await manager.query(
        api.complianceAssessments.getAssessment,
        { assessmentId: superseding.assessmentId as never },
      )) as AssessmentDetail;
      expect(replacement.status).toBe("draft");
      expect(replacement.supersededAssessment?.reference).toBe(created.reference);

      // No double amendments.
      await expect(
        manager
          .mutation(api.complianceAssessments.supersedeAssessment, {
            assessmentId: created.assessmentId as never,
            title: "Second amendment",
            amendmentReason: "Not allowed",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already superseded/i);
    },
    240000,
  );

  test(
    "read-only and cross-tenant callers get no writes and no data",
    async () => {
      if (!manager || !readOnly || !tenantAViewer) {
        throw new Error("[test:PREREQ-FAILED] fixture clients unavailable");
      }
      const framework = await newFramework(1);
      const created = await createAssessment(framework.frameworkId);

      // Read-only member of the same organization can read, not write.
      const readable = (await readOnly.query(
        api.complianceAssessments.getAssessment,
        { assessmentId: created.assessmentId as never },
      )) as AssessmentDetail;
      expect(readable.canManage).toBe(false);
      expect(readable.items).toHaveLength(1);
      await expect(
        readOnly
          .mutation(api.complianceAssessments.assessControl, {
            assessmentId: created.assessmentId as never,
            itemId: readable.items[0]._id as never,
            outcome: "compliant",
            rationale: "A read-only member must not be able to record this",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);
      await expect(
        readOnly
          .mutation(api.complianceAssessments.createAssessment, {
            frameworkId: framework.frameworkId as never,
            title: "Read-only attempt",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);

      // Another organization sees nothing at all.
      expect(
        await tenantAViewer.query(api.complianceAssessments.getAssessment, {
          assessmentId: created.assessmentId as never,
        }),
      ).toBeNull();
      const foreignPage = (await tenantAViewer.query(
        api.complianceAssessments.listAssessments,
        { frameworkId: framework.frameworkId as never },
      )) as { rows: unknown[] };
      expect(foreignPage.rows).toHaveLength(0);
      // A role without compliance.manage is refused before ownership is even
      // considered; a manager in ANOTHER organization gets the ownership
      // refusal instead, so a foreign id is indistinguishable from a missing one.
      await expect(
        tenantAViewer
          .mutation(api.complianceAssessments.startAssessment, {
            assessmentId: created.assessmentId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);

      const demoAdmin = await signInAnonymous();
      await demoAdmin.mutation(api.session.joinDemoOrganization, {});
      const demoSession = (await demoAdmin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (!demoSession?.userId) throw new Error("[test:PREREQ-FAILED] demo session");
      const escalated = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({
          userId: demoSession.userId,
          role: "admin",
          ttlMinutes: 60,
        }),
      });
      expect(escalated.ok).toBe(true);
      await expect(
        demoAdmin
          .mutation(api.complianceAssessments.startAssessment, {
            assessmentId: created.assessmentId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);
      expect(
        await demoAdmin.query(api.complianceAssessments.getAssessment, {
          assessmentId: created.assessmentId as never,
        }),
      ).toBeNull();
    },
    180000,
  );

  test(
    "summaries report real counts and never a percentage",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const before = (await manager.query(
        api.complianceAssessments.assessmentSummary,
        {},
      )) as Record<string, number>;

      const framework = await newFramework(3);
      const created = await createAssessment(framework.frameworkId);
      const detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      const [a, b, c] = detail.items;
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: a._id as never,
        outcome: "compliant",
        rationale: "Inspected the configuration; the control operates as described",
      });
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: b._id as never,
        outcome: "non_compliant",
        rationale: "The sampled approvals were missing for two of ten requests",
        remediation: "Automate the approval check",
      });
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: c._id as never,
        outcome: "not_applicable",
        rationale: "This control concerns a system outside the assessed scope",
      });

      const after = (await manager.query(
        api.complianceAssessments.assessmentSummary,
        {},
      )) as Record<string, number>;

      expect(after.assessments).toBe(before.assessments + 1);
      expect(after.controlsInScope).toBe(before.controlsInScope + 3);
      expect(after.assessed).toBe(before.assessed + 2);
      expect(after.compliant).toBe(before.compliant + 1);
      expect(after.nonCompliant).toBe(before.nonCompliant + 1);
      expect(after.notApplicable).toBe(before.notApplicable + 1);
      expect(after.evidenceGaps).toBe(before.evidenceGaps + 2);
      expect(after.outstandingRemediation).toBe(before.outstandingRemediation + 1);
      expect(Object.keys(after)).not.toContain("compliancePercentage");
      expect(Object.keys(after)).not.toContain("complianceScorePct");
    },
    180000,
  );

  test(
    "every assessment action is attributed in the audit trail",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(1);
      const created = await createAssessment(framework.frameworkId);
      const detail = (await manager.query(api.complianceAssessments.getAssessment, {
        assessmentId: created.assessmentId as never,
      })) as AssessmentDetail;
      await manager.mutation(api.complianceAssessments.assessControl, {
        assessmentId: created.assessmentId as never,
        itemId: detail.items[0]._id as never,
        outcome: "partially_compliant",
        rationale: "Two of ten sampled items lacked the documented approval",
      });

      type LogRow = {
        action: string;
        entityId?: string;
        entityType: string;
        actorLabel?: string;
        relatedEntityType?: string;
        relatedEntityId?: string;
      };
      const logsFor = async (action: string): Promise<LogRow[]> =>
        (await manager!.query(api.admin.listAuditLogs, {
          action,
          limit: 200,
        })) as LogRow[];

      const createdLog = (await logsFor("compliance.assessment_created")).find(
        (l) => l.entityId === created.assessmentId,
      );
      expect(createdLog).toBeDefined();
      expect(createdLog!.entityType).toBe("complianceAssessments");
      expect(createdLog!.relatedEntityType).toBe("complianceFrameworks");
      expect(createdLog!.relatedEntityId).toBe(framework.frameworkId);
      expect(createdLog!.actorLabel).toBeTruthy();

      const assessedLog = (await logsFor(
        "compliance.assessment_control_assessed",
      )).find((l) => l.entityId === detail.items[0]._id);
      expect(assessedLog).toBeDefined();
      expect(assessedLog!.relatedEntityType).toBe("complianceAssessments");
      expect(assessedLog!.relatedEntityId).toBe(created.assessmentId);
      expect(assessedLog!.actorLabel).toBeTruthy();
    },
    180000,
  );

  test(
    "cleanup removes only this suite's fixture records",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const framework = await newFramework(1);
      await createAssessment(framework.frameworkId);

      const before = (await manager.query(
        api.complianceAssessments.listAssessments,
        {},
      )) as { rows: AssessmentRow[] };
      expect(before.rows.length).toBeGreaterThan(0);

      await resetFixtures();

      const after = (await manager.query(
        api.complianceAssessments.listAssessments,
        {},
      )) as { rows: AssessmentRow[] };
      expect(after.rows).toHaveLength(0);
      const controls = (await manager.query(api.compliance.listControls, {})) as {
        rows: unknown[];
      };
      expect(controls.rows).toHaveLength(0);
      // Audit history and the tenant's risk baseline survive the cleanup.
      const logs = (await manager.query(api.admin.listAuditLogs, {
        limit: 50,
      })) as Array<{ action: string }>;
      expect(logs.length).toBeGreaterThan(0);
      const risks = (await manager.query(api.risks.listRisks, {})) as unknown[];
      expect(risks.length).toBeGreaterThanOrEqual(1);
    },
    180000,
  );
});

/** Framework code is the canonicalized identifier. */
function frameworkIdentifierOf(identifier: string): string {
  return identifier.trim().toUpperCase().replace(/\s+/g, "-");
}

