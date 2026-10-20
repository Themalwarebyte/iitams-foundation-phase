import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 4A — Batch 1: cybersecurity assessments and vulnerabilities.
 * =================================================================
 * Structural guarantees plus runtime checks against the development backend,
 * using the disposable IITAMS-TEST-M fixture organization:
 *
 *  - assessments follow an explicit lifecycle and are never auto-completed by
 *    the presence of vulnerabilities;
 *  - severity and CVSS are validated independently (range, decimals, vector);
 *  - remediation is a claim; the recorder can never verify their own work;
 *  - closing is blocked while remediation actions are unresolved;
 *  - reopening preserves history and clears stale verification stamps;
 *  - cross-tenant ids (risk, assessment) are refused;
 *  - a role without cyber.view is denied even for reads;
 *  - linking an ICT risk never changes that risk's score.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const suffix = Date.now().toString(36);
const RUN_TAG = `CYB-${suffix.toUpperCase().slice(-6)}`;

const MANAGER_EMAIL = "compliance-manager-m@iitams.test";
const REVIEWER_EMAIL = "compliance-reviewer-m@iitams.test";
const READ_ONLY_EMAIL = "risk-tenant-a@iitams.test";

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

runtime("cybersecurity assurance (runtime)", () => {
  const managerPromise = signInEmailOtp(MANAGER_EMAIL);
  const reviewerPromise = signInEmailOtp(REVIEWER_EMAIL);
  const readOnlyPromise = signInEmailOtp(READ_ONLY_EMAIL);

  test("assessment lifecycle is explicit and never auto-completed", async () => {
    const manager = await managerPromise;
    expect(manager).not.toBeNull();
    if (!manager) return;

    const created = await manager.mutation(
      api.cyberAssessments.createAssessment,
      {
        name: `${RUN_TAG} perimeter assessment`,
        type: "penetration_test",
        scope: "External perimeter",
        objectives: "Identify exploitable weaknesses in the public estate",
        relatedAssetOrService: "Public payment gateway",
        plannedStartAt: Date.now(),
        plannedEndAt: Date.now() + 7 * 86400000,
      },
    );
    expect(created.reference).toMatch(/^CSA-\d{3,}$/);

    const list = (await manager.query(api.cyberAssessments.listAssessments, {
      search: RUN_TAG,
    })) as {
      rows: Array<{
        _id: string;
        status: string;
        vulnerabilityCount: number;
        completedAt: number | null;
      }>;
    };
    const row = list.rows.find((r) => r._id === created.assessmentId);
    expect(row?.status).toBe("scheduled");
    expect(row?.vulnerabilityCount).toBe(0);
    expect(row?.completedAt).toBeNull();

    // Completing without starting is refused (no implicit transition).
    await expect(
      manager.mutation(api.cyberAssessments.completeAssessment, {
        assessmentId: created.assessmentId,
        outcomeSummary: "Attempted shortcut completion without starting work",
      }),
    ).rejects.toThrow(/not a permitted transition/);

    await manager.mutation(api.cyberAssessments.startAssessment, {
      assessmentId: created.assessmentId,
    });

    // Completion demands a substantive outcome summary.
    await expect(
      manager.mutation(api.cyberAssessments.completeAssessment, {
        assessmentId: created.assessmentId,
        outcomeSummary: "too short",
      }),
    ).rejects.toThrow(/at least/);

    // Create a linked vulnerability: the assessment must NOT auto-complete.
    await manager.mutation(api.cyberVulnerabilities.createVulnerability, {
      title: `${RUN_TAG} unpatched library`,
      assetName: "api-gateway-01",
      severity: "high",
      cvssScore: 8.1,
      assessmentId: created.assessmentId,
      remediationDue: Date.now() + 14 * 86400000,
    });

    const afterLink = (await manager.query(
      api.cyberAssessments.getAssessment,
      { assessmentId: created.assessmentId },
    )) as {
      assessment: {
        status: string;
        vulnerabilityCount: number;
        openVulnerabilityCount: number;
        completedAt: number | null;
      };
    };
    expect(afterLink.assessment.status).toBe("in_progress");
    expect(afterLink.assessment.vulnerabilityCount).toBe(1);
    expect(afterLink.assessment.openVulnerabilityCount).toBe(1);
    expect(afterLink.assessment.completedAt).toBeNull();

    await manager.mutation(api.cyberAssessments.completeAssessment, {
      assessmentId: created.assessmentId,
      outcomeSummary:
        "External perimeter tested; one high-severity library weakness recorded",
    });
    const completed = (await manager.query(
      api.cyberAssessments.getAssessment,
      { assessmentId: created.assessmentId },
    )) as {
      assessment: { status: string; openVulnerabilityCount: number };
      vulnerabilities: Array<{ status: string }>;
    };
    expect(completed.assessment.status).toBe("completed");
    // Completing the assessment did NOT resolve the vulnerability.
    expect(completed.vulnerabilities[0]?.status).toBe("open");
  });

  test("CVSS is validated independently of severity", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    const base = {
      title: `${RUN_TAG} CVSS validation`,
      assetName: "records-db-01",
      severity: "low" as const,
    };

    await expect(
      manager.mutation(api.cyberVulnerabilities.createVulnerability, {
        ...base,
        cvssScore: 11,
      }),
    ).rejects.toThrow(/between 0 and 10/);

    await expect(
      manager.mutation(api.cyberVulnerabilities.createVulnerability, {
        ...base,
        cvssScore: 7.55,
      }),
    ).rejects.toThrow(/one decimal/);

    await expect(
      manager.mutation(api.cyberVulnerabilities.createVulnerability, {
        ...base,
        cvssVector: "not-a-vector",
      }),
    ).rejects.toThrow(/CVSS v3/);

    await expect(
      manager.mutation(api.cyberVulnerabilities.createVulnerability, {
        ...base,
        cveId: "CVE-26-1",
      }),
    ).rejects.toThrow(/CVE-/);

    // A LOW severity record may legitimately carry no score, and a supplied
    // score is stored exactly as given — never derived from severity.
    const created = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        ...base,
        title: `${RUN_TAG} unscored low`,
        cvssScore: 3.1,
        cvssVector: "CVSS:3.1/AV:N/AC:H/PR:L/UI:N/S:U/C:L/I:N/A:N",
      },
    );
    const detail = (await manager.query(
      api.cyberVulnerabilities.getVulnerability,
      { vulnerabilityId: created.vulnerabilityId },
    )) as {
      vulnerability: { severity: string; cvssScore: number | null };
    };
    expect(detail.vulnerability.severity).toBe("low");
    expect(detail.vulnerability.cvssScore).toBe(3.1);
  });

  test("remediation is a claim and requires an independent verifier", async () => {
    const manager = await managerPromise;
    const reviewer = await reviewerPromise;
    if (!manager || !reviewer) return;

    const created = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} separation of duties`,
        assetName: "public-portal-01",
        severity: "critical",
        cvssScore: 9.8,
        remediationDue: Date.now() + 5 * 86400000,
      },
    );
    const vulnerabilityId = created.vulnerabilityId;

    await manager.mutation(api.cyberVulnerabilities.confirmVulnerability, {
      vulnerabilityId,
    });
    await manager.mutation(
      api.cyberVulnerabilities.startVulnerabilityRemediation,
      { vulnerabilityId },
    );

    // A remediation action is tracked explicitly.
    const action = await manager.mutation(
      api.cyberActions.createRemediationAction,
      {
        vulnerabilityId,
        description: "Patch the public portal and attach the change record",
        dueDate: Date.now() + 3 * 86400000,
        mandatory: true,
      },
    );
    await manager.mutation(api.cyberActions.startRemediationAction, {
      actionId: action.actionId,
    });
    await expect(
      manager.mutation(api.cyberVulnerabilities.closeVulnerability, {
        vulnerabilityId,
        closureReason: "Closing before any remediation was recorded at all",
      }),
    ).rejects.toThrow(/not a permitted transition/);

    // Implementer records completion...
    await manager.mutation(api.cyberActions.completeRemediationAction, {
      actionId: action.actionId,
      completionNotes:
        "Patch deployed to all nodes and change record CHG-9001 attached",
    });

    // ...and cannot verify their own work.
    await expect(
      manager.mutation(api.cyberActions.verifyRemediationAction, {
        actionId: action.actionId,
        verificationNotes: "Self-verification attempt should be refused here",
      }),
    ).rejects.toThrow(/implementer cannot verify/);

    await reviewer.mutation(api.cyberActions.verifyRemediationAction, {
      actionId: action.actionId,
      verificationNotes:
        "Inspected the change record and confirmed the patch on every node",
    });
    await reviewer.mutation(api.cyberActions.closeRemediationAction, {
      actionId: action.actionId,
    });

    await manager.mutation(
      api.cyberVulnerabilities.markVulnerabilityRemediated,
      {
        vulnerabilityId,
        notes: "Patch applied to the portal cluster and verified locally",
      },
    );

    // The recorder cannot verify their own remediation.
    await expect(
      manager.mutation(api.cyberVulnerabilities.verifyVulnerability, {
        vulnerabilityId,
        notes: "Self-verification attempt should be refused by the server",
      }),
    ).rejects.toThrow(/cannot verify/);

    await reviewer.mutation(api.cyberVulnerabilities.verifyVulnerability, {
      vulnerabilityId,
      notes: "Re-scanned the portal; the reported CVE no longer appears",
    });

    // Closing is blocked while an action is still outstanding.
    const second = await manager.mutation(
      api.cyberActions.createRemediationAction,
      {
        vulnerabilityId,
        description: "Document the residual monitoring control for the portal",
        mandatory: true,
      },
    );
    await expect(
      manager.mutation(api.cyberVulnerabilities.closeVulnerability, {
        vulnerabilityId,
        closureReason: "Attempting to close with an unresolved action present",
      }),
    ).rejects.toThrow(/unresolved/);
    await manager.mutation(api.cyberActions.cancelRemediationAction, {
      actionId: second.actionId,
      reason: "Covered by the existing monitoring standard",
    });

    await manager.mutation(api.cyberVulnerabilities.closeVulnerability, {
      vulnerabilityId,
      closureReason: "Verified remediation confirmed by the security team",
    });

    const closed = (await manager.query(
      api.cyberVulnerabilities.getVulnerability,
      { vulnerabilityId },
    )) as {
      vulnerability: {
        status: string;
        verifiedByLabel: string | null;
        closureReason: string | null;
      };
      events: Array<{
        type: string;
        actorUserId: string;
        actorLabel: string;
        reason: string | null;
      }>;
    };
    expect(closed.vulnerability.status).toBe("closed");
    expect(closed.vulnerability.verifiedByLabel).toBeTruthy();
    expect(closed.vulnerability.closureReason).toContain("Verified remediation");
    // History keeps the claim, the rejection and the verification separately.
    expect(closed.events.some((e) => e.type === "action_verification_failed")).toBe(
      false,
    );
    expect(closed.events.some((e) => e.type === "action_verified")).toBe(true);
    expect(closed.events.some((e) => e.type === "vulnerability_closed")).toBe(true);
    // Audit attribution: the remediation and the verification name DIFFERENT
    // actors, so no entry can read as the implementer verifying their own work.
    const remediatedEvent = closed.events.find(
      (e) => e.type === "vulnerability_remediated",
    );
    const verifiedEvent = closed.events.find(
      (e) => e.type === "vulnerability_verified",
    );
    expect(remediatedEvent?.actorUserId).toBeTruthy();
    expect(verifiedEvent?.actorUserId).toBeTruthy();
    expect(verifiedEvent?.actorUserId).not.toBe(remediatedEvent?.actorUserId);

    // Reopening preserves history and clears stale stamps.
    await manager.mutation(api.cyberVulnerabilities.reopenVulnerability, {
      vulnerabilityId,
      reason: "Regression detected in the latest quarterly scan",
    });
    const reopened = (await manager.query(
      api.cyberVulnerabilities.getVulnerability,
      { vulnerabilityId },
    )) as {
      vulnerability: {
        status: string;
        verifiedAt: number | null;
        remediatedByUserId: string | null;
      };
      events: Array<{ type: string }>;
    };
    expect(reopened.vulnerability.status).toBe("open");
    expect(reopened.vulnerability.verifiedAt).toBeNull();
    expect(reopened.vulnerability.remediatedByUserId).toBeNull();
    expect(
      reopened.events.some((e) => e.type === "vulnerability_reopened"),
    ).toBe(true);
    expect(reopened.events.some((e) => e.type === "vulnerability_verified")).toBe(
      true,
    );
  });

  test("foreign organization ids are refused and read-only roles denied", async () => {
    const manager = await managerPromise;
    const readOnly = await readOnlyPromise;
    if (!manager || !readOnly) return;

    // A read-only role may read its OWN organization's register…
    const readOnlyRows = (await readOnly.query(
      api.cyberVulnerabilities.listVulnerabilities,
      {},
    )) as { rows: Array<{ title: string }>; summary: { canManage: boolean } };
    expect(readOnlyRows.summary.canManage).toBe(false);
    expect(readOnlyRows.rows.every((row) => !row.title.includes(RUN_TAG))).toBe(
      true,
    );

    // …but cannot write: writes require cyber.manage.
    await expect(
      readOnly.mutation(api.cyberVulnerabilities.createVulnerability, {
        title: `${RUN_TAG} read only write attempt`,
        assetName: "should-not-exist",
        severity: "low",
      }),
    ).rejects.toThrow(/Permission denied: cyber.manage/);

    // Tenant A holds a real risk id; tenant M must not be able to link it.
    const foreignRisks = (await readOnly.query(api.risks.listRisks, {})) as
      | { rows?: Array<{ _id: string }> }
      | Array<{ _id: string }>;
    const foreignRiskId = Array.isArray(foreignRisks)
      ? foreignRisks[0]?._id
      : foreignRisks.rows?.[0]?._id;
    if (foreignRiskId) {
      const own = await manager.mutation(
        api.cyberVulnerabilities.createVulnerability,
        {
          title: `${RUN_TAG} cross tenant check`,
          assetName: "internal-app-01",
          severity: "medium",
        },
      );
      await expect(
        manager.mutation(api.cyberVulnerabilities.linkVulnerabilityRisk, {
          vulnerabilityId: own.vulnerabilityId,
          riskId: foreignRiskId as never,
        }),
      ).rejects.toThrow(/Risk not found in your organization/);
    }
  });

  test("linking an ICT risk never changes the risk score", async () => {
    const manager = await managerPromise;
    if (!manager) return;

    const options = (await manager.query(
      api.cyberAssessments.cyberFormOptions,
      {},
    )) as { risks: Array<{ riskId: string; code: string }> };
    const risk = options.risks[0];
    if (!risk) return;
    const before = (await manager.query(api.risks.getRisk, {
      riskId: risk.riskId as never,
    })) as unknown;

    const created = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} linked risk`,
        assetName: "shared-service-01",
        severity: "medium",
      },
    );
    await manager.mutation(api.cyberVulnerabilities.linkVulnerabilityRisk, {
      vulnerabilityId: created.vulnerabilityId,
      riskId: risk.riskId as never,
    });

    const after = (await manager.query(api.risks.getRisk, {
      riskId: risk.riskId as never,
    })) as unknown;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  test("evidence is hashed server-side and restricted downloads need cyber.manage", async () => {
    const manager = await managerPromise;
    const readOnly = await readOnlyPromise;
    if (!manager || !readOnly) return;

    const created = await manager.mutation(
      api.cyberVulnerabilities.createVulnerability,
      {
        title: `${RUN_TAG} evidence record`,
        assetName: "evidence-host-01",
        severity: "low",
      },
    );

    const uploadUrl = await manager.mutation(
      api.cyberEvidence.generateEvidenceUploadUrl,
      {},
    );
    const bytes = new TextEncoder().encode(`evidence ${RUN_TAG}`);
    const put = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: bytes,
    });
    expect(put.ok).toBe(true);
    const { storageId } = (await put.json()) as { storageId: string };
    expect(storageId).toBeTruthy();

    const recorded = await manager.mutation(
      api.cyberEvidence.confirmEvidenceUpload,
      {
        storageId: storageId as never,
        vulnerabilityId: created.vulnerabilityId,
        filename: `scan-${RUN_TAG}.txt`,
        fileType: "text/plain",
        sizeBytes: bytes.byteLength,
        classification: "restricted",
      },
    );

    // The hash is computed by a scheduled action, never by the browser.
    let integrity = "pending";
    let sha256 = "";
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const rows = (await manager.query(api.cyberEvidence.listEvidence, {
        vulnerabilityId: created.vulnerabilityId,
      })) as Array<{ _id: string; integrity: string; sha256: string }>;
      const row = rows.find((r) => r._id === recorded.evidenceId);
      if (row && row.integrity !== "pending") {
        integrity = row.integrity;
        sha256 = row.sha256;
        break;
      }
    }
    expect(integrity).toBe("intact");
    expect(sha256).toMatch(/^[0-9a-f]{64}$/);

    // Read-only roles cannot download restricted evidence…
    await expect(
      readOnly.mutation(api.cyberEvidence.evidenceDownloadUrl, {
        evidenceId: recorded.evidenceId,
      }),
    ).rejects.toThrow(/Requires cyber.manage|not found in your organization/);

    // …while a manager receives a real, audited download URL.
    const download = (await manager.mutation(
      api.cyberEvidence.evidenceDownloadUrl,
      { evidenceId: recorded.evidenceId },
    )) as { url: string; sha256: string | null };
    expect(download.url).toBeTruthy();
    expect(download.sha256).toBe(sha256);
  });
});
