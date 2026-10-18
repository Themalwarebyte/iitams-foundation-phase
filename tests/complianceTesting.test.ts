import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3C — Batch 2: compliance control testing and evidence mapping.
 * ===================================================================
 * Structural guards (permission model, organization from the access context,
 * bounded reads, audited writes, no fabricated verdicts, evidence isolation
 * from the audit evidence model) plus runtime checks against the development
 * backend using the disposable IITAMS-TEST-M fixture organization:
 *
 *  - a test records an outcome; it never changes the control's effectiveness;
 *  - state transitions and completion requirements are enforced server-side
 *    (verdict + adequate completion notes + evidence or a documented
 *    exception);
 *  - completed tests are immutable and corrections are superseding records;
 *  - evidence is organization-scoped, integrity-hashed server-side, mapped and
 *    unlinkable without deleting history;
 *  - restricted evidence is not downloadable by a read-only role;
 *  - access-gated test/evidence and mapping writes, downloads and integrity
 *    checks are all audited;
 *  - cleanup removes only this suite's fixture records.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `CT2-${suffix.toUpperCase().slice(-6)}`;

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
    const raw = readFileSync(
      join(process.cwd(), ".convex/local/default/config.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { adminKey?: unknown };
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

async function harnessPost(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-iitams-tester-token": token },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
  const c = new ConvexHttpClient(CONVEX_URL);
  try {
    await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, { provider: "email-otp", params: { email } });
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
    const finished = (await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) (c as unknown as { setAuth: (value: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const result = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) (guest as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
  return guest;
}

type TestRow = {
  _id: string;
  reference: string;
  title: string;
  status: string;
  outcome: string;
  outcomeLabel: string;
  superseded: boolean;
  supersededByTestId: string | null;
  supersedesTestId: string | null;
  evidenceException: string | null;
  completionNotes: string | null;
  testerLabel: string;
};

type TestPage = {
  rows: TestRow[];
  continueCursor: string;
  isDone: boolean;
  summary: {
    total: number;
    byStatus: Record<string, number>;
    byOutcome: Record<string, number>;
  } | null;
};

type TestDetail = TestRow & {
  control: { _id: string; code: string; title: string; effectiveness: string };
  framework: { _id: string; code: string; name: string };
  evidence: Array<{
    mappingId: string;
    _id: string;
    filename: string;
    classification: string;
    sha256: string | null;
    integrity: string;
    active: boolean;
    downloadable: boolean;
    unlinkedAt: number | null;
  }>;
  activeEvidenceCount: number;
  supersededTest: TestRow | null;
  canManage: boolean;
};

let manager: ConvexHttpClient | null = null;
let readOnly: ConvexHttpClient | null = null;
let tenantAViewer: ConvexHttpClient | null = null;
let fixtureAUserId: string | null = null;

async function resetFixtures(): Promise<void> {
  try {
    const adminKey = devAdminKey();
    if (!adminKey || !(await serverUp())) return;
    const admin = new ConvexHttpClient(CONVEX_URL);
    (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
    for (let i = 0; i < 60; i += 1) {
      const result = (await admin.mutation(
        internal.devTenantFixtures.resetComplianceFixtures,
        { maxRecords: 50 },
      )) as { remaining: number };
      if (result.remaining === 0) return;
    }
  } catch (e) {
    console.warn(`[complianceTesting:WARN] cleanup skipped: ${String(e).slice(0, 200)}`);
  }
}

/** Upload bytes to Convex storage and return the storage id. */
async function uploadBytes(
  client: ConvexHttpClient,
  content: string,
  contentType = "text/plain",
): Promise<string> {
  const uploadUrl = (await client.mutation(
    api.complianceTesting.generateEvidenceUploadUrl,
    {},
  )) as string;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: content,
  });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  const { storageId } = (await res.json()) as { storageId: string };
  return storageId;
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
    complianceAdmin: { email: string; userId: string } | null;
  };
  const tenantM = fixtures.organizations.find(
    (o) => o.organizationCode === "IITAMS-TEST-M",
  );
  const tenantA = fixtures.organizations.find(
    (o) => o.organizationCode === "IITAMS-TEST-A",
  );
  if (!tenantM || !tenantA || !fixtures.complianceAdmin) return;
  fixtureAUserId = tenantA.userId;
  await resetFixtures();
  manager = await signInEmailOtp(fixtures.complianceAdmin.email);
  readOnly = await signInEmailOtp(tenantM.email);
  tenantAViewer = await signInEmailOtp(tenantA.email);
}, 180000);

afterAll(async () => {
  await resetFixtures();
}, 120000);

/** A fresh framework + control for the scenario under test. */
async function newControl(): Promise<{ frameworkId: string; controlId: string }> {
  if (!manager) throw new Error("manager unavailable");
  const framework = (await manager.mutation(api.compliance.createFramework, {
    name: `Testing framework ${suffix}`,
    identifier: `${RUN_TAG}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`,
  })) as { frameworkId: string };
  const control = (await manager.mutation(api.compliance.createControl, {
    frameworkId: framework.frameworkId as never,
    identifier: `T.${Math.random().toString(36).slice(2, 5)}`,
    title: `Testable control ${suffix}`,
    domain: "access_control",
    implementationStatus: "implemented",
  })) as { controlId: string };
  return { frameworkId: framework.frameworkId, controlId: control.controlId };
}

// ============================================================================
// Structural
// ============================================================================

describe("Compliance testing — structural guards", () => {
  const src = readFileSync("src/convex/complianceTesting.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const panelSrc = readFileSync(
    "src/components/iitams/compliance/ComplianceTestingPanel.tsx",
    "utf8",
  );
  const controlsPage = readFileSync(
    "src/components/iitams/compliance/ComplianceControlsPage.tsx",
    "utf8",
  );

  test("reads require compliance.view and writes require compliance.manage with active membership", () => {
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
        /export const (createControlTest|updateControlTest|startControlTest|completeControlTest|supersedeControlTest|generateEvidenceUploadUrl|confirmEvidenceUpload|linkEvidenceToTest|unlinkEvidenceMapping) = mutation\(\{/g,
      ),
    ];
    expect(mutations.length).toBe(9);
    for (const fn of mutations) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      expect(scoped).toContain("requireManager(ctx)");
    }
  });

  test("organization comes from the access context and every referenced id is re-validated", () => {
    expect(src).not.toContain('organizationId: v.id("organizations")');
    expect(src).toContain("Control not found in your organization");
    expect(src).toContain("Control test not found in your organization");
    expect(src).toContain("Tester is not an active member of your organization");
    expect(src).toContain(
      "Evidence can only be mapped to a test of the control it was recorded against",
    );
    // Foreign ids disclose nothing on read either.
    expect(src).toContain('return { rows: [], continueCursor: "", isDone: true, summary: null }');
  });

  test("no write fabricates a verdict or touches control effectiveness", () => {
    // Tests record outcomes; they never patch the control row.
    expect(src).not.toContain("ctx.db.patch(control._id");
    expect(src).not.toContain('ctx.db.insert("controls"');
    // The control's effectiveness is only ever READ into a projection; no
    // mutation argument can write it.
    expect(src).not.toContain("effectiveness: args.");
    expect(src).toContain("effectiveness: control.effectiveness");
    expect(src).not.toContain("complianceScorePct");
    // A test carries no verdict before completion.
    expect(src).toContain('outcome: "not_tested"');
    expect(src).toContain("isControlTestVerdict(args.outcome)");
    // Completion demands a real verdict, notes and evidence or an exception.
    expect(src).toContain("CONTROL_TEST_COMPLETION_MIN");
    expect(src).toContain("CONTROL_TEST_EXCEPTION_MIN");
    expect(src).toContain("documented exception of at least");
    // Immutability of completed tests and superseding amendments.
    expect(src).toContain("A completed control test cannot be edited");
    expect(src).toContain("supersedesTestId");
    expect(src).toContain("is already superseded by");
  });

  test("bounded, index-backed reads and append-only audit on every write", () => {
    expect(src).toContain("TEST_PAGE_MAX");
    expect(src).toContain(".paginate({ numItems, cursor: args.cursor ?? null })");
    expect(src).toContain("TEST_LIST_LIMIT");
    expect(src).toContain("EVIDENCE_SCAN_LIMIT");
    const writes = [...src.matchAll(/export const (\w+) = mutation\(\{/g)];
    for (const fn of writes) {
      const body = src.slice(fn.index ?? 0);
      const nextExport = body.indexOf("\nexport const", 10);
      const scoped = nextExport === -1 ? body : body.slice(0, nextExport);
      if (scoped.includes("generateEvidenceUploadUrl")) continue; // no state change
      expect(scoped).toContain("logAudit(ctx, {");
      expect(scoped).toContain("actorLabel: ");
    }
    for (const action of [
      "compliance.control_test_created",
      "compliance.control_test_updated",
      "compliance.control_test_started",
      "compliance.control_test_completed",
      "compliance.control_test_superseded",
      "compliance.evidence_uploaded",
      "compliance.evidence_mapped",
      "compliance.evidence_unmapped",
      "compliance.evidence_downloaded",
      "compliance.evidence_integrity_checked",
    ]) {
      expect(src).toContain(action);
    }
  });

  test("compliance evidence is separate from the audit evidence model and hashes server-side", () => {
    // The audit `evidence` table is engagement/working-paper shaped: Batch 2
    // defines its own records rather than leaking compliance files into it.
    expect(src).not.toContain('ctx.db.query("evidence")');
    expect(src).not.toContain('ctx.db.insert("evidence"');
    expect(src).not.toContain("engagementId");
    expect(src).toContain('ctx.db.insert("complianceEvidence"');
    expect(src).toContain('ctx.db.insert("complianceEvidenceMappings"');
    // Integrity is computed from the stored blob by a scheduled action.
    expect(src).toContain("crypto.subtle.digest");
    expect(src).toContain("computeEvidenceHash");
    expect(src).toContain("hash_mismatch");
    expect(src).toContain("blob_missing");
    // Unlinking is an event, never a delete.
    expect(src).toContain("compliance.evidence_unmapped");
    expect(src).not.toContain('ctx.db.delete(mapping');
    expect(schemaSrc).not.toContain("complianceEvidence: defineTable({\n      organizationId: v.id(\"organizations\"),\n      engagementId");
  });

  test("the UI gates writes on complianceManage and states no compliance percentage", () => {
    expect(controlsPage).toContain("ComplianceTestingSummary");
    expect(controlsPage).toContain("ControlTestingPanel");
    expect(controlsPage).toContain("canManage");
    expect(panelSrc).toContain("canManage");
    expect(panelSrc).toContain("EmptyState");
    expect(panelSrc).toContain("Completed tests are immutable");
    expect(panelSrc).toContain("No overall compliance percentage");
    expect(panelSrc).toContain("Downloads are recorded in the audit trail");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Compliance testing — runtime", () => {
  test(
    "a planned test follows validated transitions and cannot claim a verdict early",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const { controlId } = await newControl();

      const created = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Access provisioning test ${suffix}`,
        objective: "Confirm access provisioning follows documented approval",
        procedure: "Select 25 requests from the period and inspect approvals",
        periodLabel: "2026-Q1",
        sampleSize: 25,
        sampleDescription: "25 access requests",
      })) as { testId: string; reference: string; status: string };
      expect(created.reference).toMatch(/^CT-\d+$/);
      expect(created.status).toBe("planned");

      let detail = (await manager.query(api.complianceTesting.getControlTest, {
        testId: created.testId as never,
      })) as TestDetail | null;
      // A verdict is never assumed from the existence of a test record.
      expect(detail!.outcome).toBe("not_tested");
      expect(detail!.status).toBe("planned");
      expect(detail!.control.effectiveness).toBe("not_tested");

      // Completing without an outcome verdict is refused.
      await expect(
        manager
          .mutation(api.complianceTesting.completeControlTest, {
            testId: created.testId as never,
            outcome: "not_tested",
            completionNotes: "Attempted completion without a verdict",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires an outcome of effective/i);

      // Too-short completion notes are refused.
      await expect(
        manager
          .mutation(api.complianceTesting.completeControlTest, {
            testId: created.testId as never,
            outcome: "effective",
            completionNotes: "done",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/at least 20 characters/i);

      // No evidence and no documented exception → refused.
      await expect(
        manager
          .mutation(api.complianceTesting.completeControlTest, {
            testId: created.testId as never,
            outcome: "effective",
            completionNotes:
              "Inspected the sample and found every approval in place",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/documented exception of at least/i);

      // A non-effective outcome must be justified.
      await expect(
        manager
          .mutation(api.complianceTesting.completeControlTest, {
            testId: created.testId as never,
            outcome: "ineffective",
            completionNotes:
              "Inspected the sample and found approvals missing in three cases",
            evidenceException:
              "Documented exception: the request system was decommissioned",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires the observations or exceptions/i);

      // Valid transition: planned → in_progress.
      const started = (await manager.mutation(api.complianceTesting.startControlTest, {
        testId: created.testId as never,
      })) as { status: string };
      expect(started.status).toBe("in_progress");
      await expect(
        manager
          .mutation(api.complianceTesting.startControlTest, {
            testId: created.testId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/in progress control test cannot start/i);

      detail = (await manager.query(api.complianceTesting.getControlTest, {
        testId: created.testId as never,
      })) as TestDetail;
      expect(detail.status).toBe("in_progress");
      expect(detail.actualStart).toBeTruthy();
    },
    120000,
  );

  test(
    "evidence upload, server-side hashing, mapping and audited download",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const { controlId } = await newControl();
      // The named tester must be an ACTIVE member of THIS organization, so a
      // user from another tenant is refused outright.
      await expect(
        manager
          .mutation(api.complianceTesting.createControlTest, {
            controlId: controlId as never,
            title: `Foreign tester ${suffix}`,
            objective: "Confirm cross-tenant testers are refused",
            procedure: "Attempt to assign a tester from another organization",
            testerUserId: fixtureAUserId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not an active member of your organization/i);

      const test = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Evidence test ${suffix}`,
        objective: "Confirm evidence can be recorded against a control test",
        procedure: "Upload the approval log excerpt and inspect its integrity",
      })) as { testId: string; reference: string };

      const storageId = await uploadBytes(
        manager,
        `approval log excerpt ${suffix}`,
      );
      const uploaded = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: controlId as never,
          testId: test.testId as never,
          filename: `approval-log-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 80,
          classification: "internal",
          description: "Approval log excerpt for the sample",
        },
      )) as { evidenceId: string; mappingId: string | null; integrity: string };
      expect(uploaded.mappingId).toBeTruthy();
      expect(uploaded.integrity).toBe("pending");

      // The scheduled action computes the hash; the UI subscribes to it.
      let hashed: TestDetail | null = null;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 500));
        hashed = (await manager.query(api.complianceTesting.getControlTest, {
          testId: test.testId as never,
        })) as TestDetail | null;
        const record = hashed?.evidence.find((e) => e._id === uploaded.evidenceId);
        if (record?.sha256) break;
      }
      const record = hashed!.evidence.find((e) => e._id === uploaded.evidenceId)!;
      expect(record.integrity).toBe("intact");
      // SHA-256 of "approval log excerpt <suffix>" — recomputed independently.
      const expected = new Bun.CryptoHasher("sha256")
        .update(`approval log excerpt ${suffix}`)
        .digest("hex");
      expect(record.sha256).toBe(expected);
      expect(hashed!.activeEvidenceCount).toBe(1);
      expect(record.downloadable).toBe(true);

      // Downloads are audited and return a real URL.
      const download = (await manager.mutation(
        api.complianceTesting.evidenceDownloadUrl,
        { evidenceId: uploaded.evidenceId as never },
      )) as { url: string; sha256: string | null };
      expect(download.url).toContain("http");
      expect(download.sha256).toBe(expected);

      // Integrity re-verification keeps reporting intact for the stored blob.
      await manager.mutation(api.complianceTesting.verifyEvidenceIntegrity, {
        evidenceId: uploaded.evidenceId as never,
      });
      await new Promise((r) => setTimeout(r, 1500));
      const rechecked = (await manager.query(api.complianceTesting.listEvidence, {
        testId: test.testId as never,
      })) as { rows: Array<{ _id: string; integrity: string }>; activeCount: number };
      expect(rechecked.rows.find((r) => r._id === uploaded.evidenceId)!.integrity).toBe(
        "intact",
      );

      // A deliberately wrong stored hash is reported as a mismatch, so a
      // tampered record can never be presented as verified.
      const adminKey = devAdminKey();
      if (adminKey) {
        const admin = new ConvexHttpClient(CONVEX_URL);
        (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(
          adminKey,
        );
        await admin.mutation(internal.complianceTesting.recordEvidenceIntegrity, {
          evidenceId: uploaded.evidenceId as never,
          sha256: "0".repeat(64),
          integrity: "intact",
        });
        await manager.mutation(api.complianceTesting.verifyEvidenceIntegrity, {
          evidenceId: uploaded.evidenceId as never,
        });
        await new Promise((r) => setTimeout(r, 1500));
        const mismatch = (await manager.query(api.complianceTesting.listEvidence, {
          testId: test.testId as never,
        })) as { rows: Array<{ _id: string; integrity: string; sha256: string | null }> };
        const tampered = mismatch.rows.find((r) => r._id === uploaded.evidenceId)!;
        expect(tampered.integrity).toBe("hash_mismatch");
        expect(tampered.sha256).toBe(expected);
      }
    },
    180000,
  );

  test(
    "completion requires evidence or a documented exception, and results are preserved",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");

      // 1. Complete WITH evidence.
      const withEvidence = await newControl();
      const testA = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: withEvidence.controlId as never,
        title: `Effective test ${suffix}`,
        objective: "Confirm the control operates as described",
        procedure: "Inspect the sample and the configuration",
      })) as { testId: string; reference: string };
      const storageId = await uploadBytes(manager, `evidence body ${suffix}`);
      await manager.mutation(api.complianceTesting.confirmEvidenceUpload, {
        storageId: storageId as never,
        controlId: withEvidence.controlId as never,
        testId: testA.testId as never,
        filename: `evidence-${suffix}.txt`,
        fileType: "text/plain",
        sizeBytes: 80,
        classification: "internal",
      });
      const completed = (await manager.mutation(
        api.complianceTesting.completeControlTest,
        {
          testId: testA.testId as never,
          outcome: "effective",
          completionNotes:
            "Inspected the configuration and the sample; all approvals were present",
          observations: "No exceptions found in the sample",
          recommendations: "Repeat quarterly",
        },
      )) as { outcome: string; evidenceMapped: number };
      expect(completed.outcome).toBe("effective");
      expect(completed.evidenceMapped).toBe(1);

      // 2. Complete WITH a documented missing-evidence exception.
      const withException = await newControl();
      const testB = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: withException.controlId as never,
        title: `Exception test ${suffix}`,
        objective: "Confirm the exception path is honest",
        procedure: "Attempt to obtain the vendor report",
      })) as { testId: string; reference: string };
      const completedB = (await manager.mutation(
        api.complianceTesting.completeControlTest,
        {
          testId: testB.testId as never,
          outcome: "partially_effective",
          observations: "Vendor report unavailable during the test period",
          completionNotes:
            "Reviewed the available configuration evidence without the vendor report",
          evidenceException:
            "Documented exception: the vendor declined to release the report for this period",
        },
      )) as { outcome: string };
      expect(completedB.outcome).toBe("partially_effective");
      const detailB = (await manager.query(api.complianceTesting.getControlTest, {
        testId: testB.testId as never,
      })) as TestDetail;
      expect(detailB.evidenceException).toContain("vendor declined");
      expect(detailB.completionNotes).toContain("Reviewed the available");

      // 3. Completed tests are immutable…
      await expect(
        manager
          .mutation(api.complianceTesting.updateControlTest, {
            testId: testA.testId as never,
            title: "Rewriting a completed test",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/completed control test cannot be edited/i);
      await expect(
        manager
          .mutation(api.complianceTesting.completeControlTest, {
            testId: testA.testId as never,
            outcome: "ineffective",
            completionNotes: "Trying to change the verdict after the fact",
            evidenceException: "documented exception long enough to pass",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/cannot be completed again/i);

      // …while the original result stays readable.
      const original = (await manager.query(api.complianceTesting.getControlTest, {
        testId: testA.testId as never,
      })) as TestDetail;
      expect(original.outcome).toBe("effective");
      expect(original.completionNotes).toContain("all approvals were present");

      // 4. A correction is a NEW superseding record; the original is untouched.
      const superseding = (await manager.mutation(
        api.complianceTesting.supersedeControlTest,
        {
          testId: testA.testId as never,
          title: `Repeat of ${testA.reference}`,
          objective: "Re-run the test after the control was changed",
          procedure: "Inspect the updated configuration and a fresh sample",
          amendmentReason: "The control configuration changed after the first test",
        },
      )) as { testId: string; reference: string; supersedesTestId: string };
      expect(superseding.reference).not.toBe(testA.reference);
      expect(superseding.supersedesTestId).toBe(testA.testId);

      const after = (await manager.query(api.complianceTesting.getControlTest, {
        testId: testA.testId as never,
      })) as TestDetail;
      expect(after.outcome).toBe("effective"); // unchanged history
      expect(after.superseded).toBe(true);
      expect(after.supersededByTestId).toBe(superseding.testId);

      const supersedingDetail = (await manager.query(
        api.complianceTesting.getControlTest,
        { testId: superseding.testId as never },
      )) as TestDetail;
      expect(supersedingDetail.supersededTest?.outcome).toBe("effective");
      expect(supersedingDetail.status).toBe("planned");

      // A second amendment of the same record is refused.
      await expect(
        manager
          .mutation(api.complianceTesting.supersedeControlTest, {
            testId: testA.testId as never,
            title: "Second amendment",
            objective: "Not allowed",
            procedure: "Not allowed",
            amendmentReason: "Double amendment attempt",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already superseded/i);
    },
    180000,
  );

  test(
    "unlinking evidence preserves the record and its history",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const { controlId } = await newControl();
      const test = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Unlink test ${suffix}`,
        objective: "Confirm unlinking never deletes history",
        procedure: "Upload evidence, unlink it, inspect both records",
      })) as { testId: string };
      const storageId = await uploadBytes(manager, `unlink body ${suffix}`);
      const uploaded = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: controlId as never,
          testId: test.testId as never,
          filename: `unlink-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 80,
          classification: "confidential",
        },
      )) as { evidenceId: string; mappingId: string };

      // Unlink requires a reason.
      await expect(
        manager
          .mutation(api.complianceTesting.unlinkEvidenceMapping, {
            mappingId: uploaded.mappingId as never,
            reason: "",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/reason is required/i);

      await manager.mutation(api.complianceTesting.unlinkEvidenceMapping, {
        mappingId: uploaded.mappingId as never,
        reason: "Replaced by the revised extract",
      });

      const detail = (await manager.query(api.complianceTesting.getControlTest, {
        testId: test.testId as never,
      })) as TestDetail;
      const record = detail.evidence.find((e) => e._id === uploaded.evidenceId)!;
      expect(record.active).toBe(false);
      expect(record.unlinkedAt).toBeTruthy();
      expect(detail.activeEvidenceCount).toBe(0);
      // The evidence record and its bytes still exist and are downloadable.
      const download = (await manager.mutation(
        api.complianceTesting.evidenceDownloadUrl,
        { evidenceId: uploaded.evidenceId as never },
      )) as { url: string };
      expect(download.url).toContain("http");

      // Re-linking is possible; duplicating the ACTIVE link is not.
      await manager.mutation(api.complianceTesting.linkEvidenceToTest, {
        evidenceId: uploaded.evidenceId as never,
        testId: test.testId as never,
      });
      await expect(
        manager
          .mutation(api.complianceTesting.linkEvidenceToTest, {
            evidenceId: uploaded.evidenceId as never,
            testId: test.testId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/already mapped/i);

      // Unlinked evidence no longer satisfies the completion requirement.
      const other = await newControl();
      const otherTest = (await manager.mutation(
        api.complianceTesting.createControlTest,
        {
          controlId: other.controlId as never,
          title: `Cross-control mapping ${suffix}`,
          objective: "Confirm mapping is control-scoped",
          procedure: "Attempt to map evidence recorded for another control",
        },
      )) as { testId: string };
      await expect(
        manager
          .mutation(api.complianceTesting.linkEvidenceToTest, {
            evidenceId: uploaded.evidenceId as never,
            testId: otherTest.testId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/only be mapped to a test of the control/i);
    },
    180000,
  );

  test(
    "restricted evidence is not downloadable by a read-only role, and cross-tenant access is denied",
    async () => {
      if (!manager || !readOnly || !tenantAViewer) {
        throw new Error("[test:PREREQ-FAILED] fixture clients unavailable");
      }
      const { controlId, frameworkId } = await newControl();
      const test = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Restricted evidence test ${suffix}`,
        objective: "Confirm restricted evidence stays restricted",
        procedure: "Upload a restricted record and inspect visibility",
      })) as { testId: string };
      const storageId = await uploadBytes(manager, `restricted body ${suffix}`);
      const uploaded = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: controlId as never,
          testId: test.testId as never,
          filename: `restricted-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 80,
          classification: "restricted",
        },
      )) as { evidenceId: string };

      // A read-only member of the SAME organization can read the test but not
      // the restricted file: no URL, and the audited mutation refuses.
      const readOnlyDetail = (await readOnly.query(
        api.complianceTesting.getControlTest,
        { testId: test.testId as never },
      )) as TestDetail;
      expect(readOnlyDetail.canManage).toBe(false);
      expect(
        readOnlyDetail.evidence.find((e) => e._id === uploaded.evidenceId)!
          .downloadable,
      ).toBe(false);
      await expect(
        readOnly
          .mutation(api.complianceTesting.evidenceDownloadUrl, {
            evidenceId: uploaded.evidenceId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/requires compliance.manage/i);
      // …and cannot re-check integrity or manage tests at all.
      await expect(
        readOnly
          .mutation(api.complianceTesting.verifyEvidenceIntegrity, {
            evidenceId: uploaded.evidenceId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/compliance manager/i);
      await expect(
        readOnly
          .mutation(api.complianceTesting.createControlTest, {
            controlId: controlId as never,
            title: "Read-only attempt",
            objective: "Should be refused",
            procedure: "Should be refused",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Permission denied/i);

      // Another organization sees nothing at all.
      expect(
        await tenantAViewer.query(api.complianceTesting.getControlTest, {
          testId: test.testId as never,
        }),
      ).toBeNull();
      const foreignPage = (await tenantAViewer.query(
        api.complianceTesting.listControlTests,
        { controlId: controlId as never },
      )) as TestPage;
      expect(foreignPage.rows).toHaveLength(0);
      expect(
        await tenantAViewer.query(api.complianceTesting.listEvidence, {
          controlId: controlId as never,
        }),
      ).toEqual({ rows: [], activeCount: 0 });

      // A DEMO administrator (a real compliance manager elsewhere) cannot write
      // into tenant M either.
      const demoAdmin = await signInAnonymous();
      await demoAdmin.mutation(api.session.joinDemoOrganization, {});
      const demoSession = (await demoAdmin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (!demoSession?.userId) throw new Error("[test:PREREQ-FAILED] demo session");
      expect(
        await harnessPost("/api/dev-grant-demo-role", {
          userId: demoSession.userId,
          role: "admin",
          ttlMinutes: 60,
        }),
      ).toBe(true);
      await expect(
        demoAdmin
          .mutation(api.complianceTesting.startControlTest, {
            testId: test.testId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);
      await expect(
        demoAdmin
          .mutation(api.complianceTesting.evidenceDownloadUrl, {
            evidenceId: uploaded.evidenceId as never,
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);
      await expect(
        demoAdmin
          .mutation(api.complianceTesting.confirmEvidenceUpload, {
            storageId: (await uploadBytes(demoAdmin, "foreign body")) as never,
            controlId: controlId as never,
            filename: "foreign.txt",
            fileType: "text/plain",
            sizeBytes: 12,
            classification: "internal",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/not found in your organization/i);

      // File metadata is validated server-side, not just in the browser.
      const badType = await uploadBytes(manager, "binary-ish");
      await expect(
        manager
          .mutation(api.complianceTesting.confirmEvidenceUpload, {
            storageId: badType as never,
            controlId: controlId as never,
            filename: "payload.exe",
            fileType: "application/x-msdownload",
            sizeBytes: 0,
            classification: "internal",
          })
          .then((r) => JSON.stringify(r)),
      ).rejects.toThrow(/Unsupported file type/i);

      // Summary reporting counts real records and never a percentage.
      const summary = (await manager.query(api.complianceTesting.testingSummary, {
        frameworkId: frameworkId as never,
      })) as Record<string, number>;
      expect(summary.evidenceRecords).toBeGreaterThanOrEqual(1);
      expect(summary.controls).toBeGreaterThanOrEqual(1);
      expect(Object.keys(summary)).not.toContain("complianceScorePct");
    },
    180000,
  );

  test(
    "every testing and evidence action is attributed in the audit trail",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      const { controlId } = await newControl();
      const test = (await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Audited test ${suffix}`,
        objective: "Confirm every action is attributed",
        procedure: "Create, start, complete and inspect the audit trail",
      })) as { testId: string; reference: string };
      const storageId = await uploadBytes(manager, `audit body ${suffix}`);
      const evidence = (await manager.mutation(
        api.complianceTesting.confirmEvidenceUpload,
        {
          storageId: storageId as never,
          controlId: controlId as never,
          testId: test.testId as never,
          filename: `audit-${suffix}.txt`,
          fileType: "text/plain",
          sizeBytes: 80,
          classification: "internal",
        },
      )) as { evidenceId: string; mappingId: string };
      await manager.mutation(api.complianceTesting.evidenceDownloadUrl, {
        evidenceId: evidence.evidenceId as never,
      });
      await manager.mutation(api.complianceTesting.unlinkEvidenceMapping, {
        mappingId: evidence.mappingId as never,
        reason: "Superseded by a revised extract",
      });
      await manager.mutation(api.complianceTesting.startControlTest, {
        testId: test.testId as never,
      });

      type LogRow = {
        action: string;
        entityType: string;
        entityId?: string;
        actorLabel?: string;
        summary?: string;
        relatedEntityType?: string;
        relatedEntityId?: string;
      };
      const logsFor = async (action: string): Promise<LogRow[]> =>
        (await manager!.query(api.admin.listAuditLogs, {
          action,
          limit: 200,
        })) as LogRow[];

      const created = (await logsFor("compliance.control_test_created")).find(
        (l) => l.entityId === test.testId,
      );
      expect(created).toBeDefined();
      expect(created!.entityType).toBe("complianceControlTests");
      expect(created!.actorLabel).toBeTruthy();
      expect(created!.relatedEntityType).toBe("controls");
      expect(created!.relatedEntityId).toBe(controlId);

      const started = (await logsFor("compliance.control_test_started")).find(
        (l) => l.entityId === test.testId,
      );
      expect(started).toBeDefined();
      expect(started!.summary).toContain(test.reference);

      const upload = (await logsFor("compliance.evidence_uploaded")).find(
        (l) => l.entityId === evidence.evidenceId,
      );
      expect(upload).toBeDefined();
      expect(upload!.relatedEntityType).toBe("controls");
      expect(upload!.relatedEntityId).toBe(controlId);
      expect(upload!.actorLabel).toBeTruthy();

      const downloaded = (await logsFor("compliance.evidence_downloaded")).find(
        (l) => l.entityId === evidence.evidenceId,
      );
      expect(downloaded).toBeDefined();

      const unlinked = (await logsFor("compliance.evidence_unmapped")).find(
        (l) => l.entityId === evidence.mappingId,
      );
      expect(unlinked).toBeDefined();
      expect(unlinked!.relatedEntityType).toBe("complianceEvidence");
      expect(unlinked!.relatedEntityId).toBe(evidence.evidenceId);
      expect(unlinked!.actorLabel).toBeTruthy();
      // The removal is described as retaining history, not deleting it.
      expect(unlinked!.summary).toContain("retained");
    },
    180000,
  );

  test(
    "cleanup removes only this suite's fixture records",
    async () => {
      if (!manager) throw new Error("[test:PREREQ-FAILED] manager sign-in unavailable");
      // Self-contained: create this suite's own records first.
      const { controlId } = await newControl();
      await manager.mutation(api.complianceTesting.createControlTest, {
        controlId: controlId as never,
        title: `Cleanup test ${suffix}`,
        objective: "Confirm fixture cleanup is scoped",
        procedure: "Create records, run the cleanup, inspect what remains",
      });

      const before = (await manager.query(api.complianceTesting.listControlTests, {})) as TestPage;
      expect(before.rows.length).toBeGreaterThan(0);
      const evidenceBefore = (await manager.query(api.compliance.listControls, {})) as {
        rows: unknown[];
      };
      expect(evidenceBefore.rows.length).toBeGreaterThan(0);

      await resetFixtures();

      const afterTests = (await manager.query(api.complianceTesting.listControlTests, {})) as TestPage;
      expect(afterTests.rows).toHaveLength(0);
      const afterControls = (await manager.query(api.compliance.listControls, {})) as {
        rows: unknown[];
      };
      expect(afterControls.rows).toHaveLength(0);
      const afterFrameworks = (await manager.query(api.compliance.listFrameworks, {})) as {
        rows: unknown[];
      };
      expect(afterFrameworks.rows).toHaveLength(0);
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
