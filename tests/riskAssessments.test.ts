import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";
import { riskBand, riskScore } from "../src/lib/risk";

/**
 * Phase 3B — Batch 2A: ICT risk assessments and review history.
 * ============================================================
 * Structural guards for the insert-only history, plus runtime behaviour
 * against the development backend: authorized assessment creation, register
 * consistency, immutable prior evidence, date/factor/justification validation,
 * audit attribution, read-only refusal and the shared 5×5 scoring model.
 * Cross-tenant denial is exercised in tests/risk.tenant.test.ts where two real
 * organizations exist.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const DAY = 24 * 60 * 60 * 1000;

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
const harnessConfigured = Boolean(token);

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
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

async function adminClient(): Promise<ConvexHttpClient | null> {
  if (!token) return null;
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  const res = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId: session.userId, role: "admin", ttlMinutes: 60 }),
  });
  if (!res.ok) return null;
  return admin;
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 99999)}`;

type Assessment = {
  _id: string;
  assessmentDate: number;
  assessorLabel: string;
  inherentScore: number;
  inherentBand: string;
  residualScore: number;
  residualBand: string;
  previousResidualScore: number;
  previousResidualBand: string;
  controlsConsidered?: string;
  justification: string;
  observations?: string;
  nextReviewDate: number;
};

type RiskDetail = {
  _id: string;
  code: string;
  inherentScore: number;
  residualScore: number;
  reviewDue?: number;
  reviewOverdue: boolean;
  history: Array<{ action: string; actorLabel?: string; summary?: string }>;
};

// ============================================================================
// Structural
// ============================================================================

describe("Risk assessments — structural guards", () => {
  const src = readFileSync("src/convex/riskAssessments.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const uiSrc = readFileSync(
    "src/components/iitams/risk/RiskAssessments.tsx",
    "utf8",
  );
  const pageSrc = readFileSync(
    "src/components/iitams/risk/RiskRegisterPage.tsx",
    "utf8",
  );

  test("reads require risk.view and writes require risk.manage plus active membership", () => {
    expect(src).toContain('requirePermission(ctx, "risk.view")');
    expect(src).toContain('requirePermission(ctx, "risk.manage")');
    expect(src).toContain("access.isProvisioned");
    expect(src.match(/await requireViewer\(/g)?.length).toBe(1);
    expect(src.match(/await requireManager\(/g)?.length).toBe(1);
  });

  test("assessment history is insert-only and prior rows are never touched", () => {
    expect(schemaSrc).toContain("riskAssessments: defineTable({");
    expect(schemaSrc).toContain('index("by_organization_risk", ["organizationId", "riskId"])');
    // Only one patch exists in the module: the CURRENT register row.
    const patches = [...src.matchAll(/ctx\.db\.patch\(([^,]+),/g)].map((m) => m[1]);
    expect(patches).toEqual(["risk._id"]);
    expect(src).not.toContain("ctx.db.delete(");
    expect(src).not.toContain("export const updateAssessment");
    expect(src).not.toContain("export const deleteAssessment");
  });

  test("organization comes from access context and every risk id is re-checked", () => {
    expect(src).toContain("risk.organizationId !== manager.organizationId");
    expect(src).toContain("risk.organizationId !== viewer.organizationId");
    expect(src).toContain("return null;");
    expect(src).not.toContain("organizationId: v.id(\"organizations\")"); // never a client arg
  });

  test("scoring and validation reuse the shared model", () => {
    expect(src).toContain('from "../lib/risk"');
    expect(src).toContain("riskScore(");
    expect(src).toContain("riskBand(");
    expect(src).toContain("isValidRiskFactor(");
    // UI never re-implements the thresholds.
    expect(uiSrc).toContain('from "@/lib/risk"');
    expect(uiSrc).not.toContain(">= 15");
    expect(riskBand(riskScore(5, 5))).toBe("critical");
    expect(riskBand(riskScore(2, 2))).toBe("medium");
    expect(riskBand(riskScore(1, 2))).toBe("low");
  });

  test("audit attribution distinguishes assessor from the affected risk", () => {
    expect(src).toContain('action: "risk.assessment_recorded"');
    expect(src).toContain("actorId: manager.userId");
    expect(src).toContain("userId: risk.ownerUserId");
    expect(src).toContain("entityType: \"risks\"");
  });

  test("the register detail mounts the assessment section without a redesign", () => {
    expect(pageSrc).toContain("RiskAssessments");
    expect(uiSrc).toContain("Assessment history");
    expect(uiSrc).toContain("Record assessment");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Risk assessments — runtime", () => {
  test(
    "records assessments, applies them to the register and preserves immutable history",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Assessment fixture risk ${suffix}`,
        category: "Cyber",
        inherentLikelihood: 4,
        inherentImpact: 4,
        residualLikelihood: 1,
        residualImpact: 2,
        reviewDue: Date.now() + 30 * DAY,
        ownerName: "Assessment Owner",
      })) as { riskId: string; code: string };

      const firstReview = Date.now() + 60 * DAY;
      const first = (await admin.mutation(api.riskAssessments.createAssessment, {
        riskId: risk.riskId as never,
        // Today: an assessment cannot predate the risk record (validated).
        assessmentDate: Date.now(),
        inherentLikelihood: 5,
        inherentImpact: 4,
        residualLikelihood: 3,
        residualImpact: 3,
        controlsConsidered: "EDR, backups and segmentation reviewed",
        justification: "Threat activity increased and controls were partially effective",
        observations: "Two unpatched hosts remain in the DMZ",
        nextReviewDate: firstReview,
      })) as {
        assessmentId: string;
        previousResidualScore: number;
        residualScore: number;
        bandChanged: boolean;
      };
      expect(first.previousResidualScore).toBe(2); // 1×2 before the assessment
      expect(first.residualScore).toBe(9); // 3×3
      expect(first.bandChanged).toBe(true); // low → medium

      // Register is updated in the same transaction as the assessment.
      const afterFirst = (await admin.query(api.risks.getRisk, {
        riskId: risk.riskId as never,
      })) as RiskDetail;
      expect(afterFirst.inherentScore).toBe(20);
      expect(afterFirst.residualScore).toBe(9);
      expect(afterFirst.reviewDue).toBe(firstReview);
      expect(afterFirst.reviewOverdue).toBe(false);
      const auditEntry = afterFirst.history.find(
        (h) => h.action === "risk.assessment_recorded",
      );
      expect(auditEntry).toBeDefined();
      expect((auditEntry?.actorLabel ?? "").length).toBeGreaterThan(0);
      expect(auditEntry?.summary).toContain(risk.code);

      const history1 = (await admin.query(api.riskAssessments.listForRisk, {
        riskId: risk.riskId as never,
      })) as {
        risk: { residualScore: number };
        assessments: Assessment[];
        driftSinceLatestAssessment: number | null;
      };
      expect(history1.assessments).toHaveLength(1);
      expect(history1.risk.residualScore).toBe(9);
      expect(history1.driftSinceLatestAssessment).toBe(0);
      const snapshot = history1.assessments[0];

      // Second assessment: prior evidence must be byte-for-byte unchanged.
      const secondReview = Date.now() + 120 * DAY;
      const second = (await admin.mutation(api.riskAssessments.createAssessment, {
        riskId: risk.riskId as never,
        assessmentDate: Date.now(),
        inherentLikelihood: 5,
        inherentImpact: 4,
        residualLikelihood: 1,
        residualImpact: 2,
        justification: "Controls were remediated; residual exposure reduced",
        nextReviewDate: secondReview,
      })) as { previousResidualScore: number; residualScore: number; bandChanged: boolean };
      expect(second.previousResidualScore).toBe(9);
      expect(second.residualScore).toBe(2);
      expect(second.bandChanged).toBe(true); // medium → low

      const history2 = (await admin.query(api.riskAssessments.listForRisk, {
        riskId: risk.riskId as never,
      })) as { assessments: Assessment[]; risk: { residualScore: number } };
      expect(history2.assessments).toHaveLength(2);
      expect(history2.risk.residualScore).toBe(2);
      // Newest first, with the current score in sync with the latest row.
      expect(history2.assessments[0].residualScore).toBe(2);
      expect(history2.assessments[1].residualScore).toBe(snapshot.residualScore);
      expect(history2.assessments[1].justification).toBe(snapshot.justification);
      expect(history2.assessments[1].controlsConsidered).toBe(
        snapshot.controlsConsidered,
      );
      expect(history2.assessments[1].previousResidualScore).toBe(2);
      expect(history2.assessments[1].nextReviewDate).toBe(firstReview);

      const register = (await admin.query(api.risks.getRisk, {
        riskId: risk.riskId as never,
      })) as RiskDetail;
      expect(register.residualScore).toBe(2);
      expect(register.reviewDue).toBe(secondReview);
    },
    120000,
  );

  test(
    "rejects invalid factors, dates and justifications; read-only roles cannot assess",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const risk = (await admin.mutation(api.risks.createRisk, {
        title: `Assessment validation risk ${uniq()}`,
        category: "Data",
        inherentLikelihood: 3,
        inherentImpact: 3,
        residualLikelihood: 2,
        residualImpact: 2,
      })) as { riskId: string };

      const base = {
        riskId: risk.riskId as never,
        assessmentDate: Date.now(),
        inherentLikelihood: 3,
        inherentImpact: 3,
        residualLikelihood: 2,
        residualImpact: 2,
        justification: "Sufficient justification text",
        nextReviewDate: Date.now() + 30 * DAY,
      };

      await expect(
        admin.mutation(api.riskAssessments.createAssessment, {
          ...base,
          inherentLikelihood: 6,
        }),
      ).rejects.toThrow(/between 1 and 5/i);
      await expect(
        admin.mutation(api.riskAssessments.createAssessment, {
          ...base,
          assessmentDate: Date.now() + 10 * DAY,
        }),
      ).rejects.toThrow(/future/i);
      await expect(
        admin.mutation(api.riskAssessments.createAssessment, {
          ...base,
          nextReviewDate: Date.now() - DAY,
        }),
      ).rejects.toThrow(/future/i);
      await expect(
        admin.mutation(api.riskAssessments.createAssessment, {
          ...base,
          nextReviewDate: Date.now() + 60_000,
          assessmentDate: Date.now() + 120_000,
        }),
      ).rejects.toThrow(/assessment date cannot be in the future|after the assessment date/i);
      await expect(
        admin.mutation(api.riskAssessments.createAssessment, {
          ...base,
          justification: "short",
        }),
      ).rejects.toThrow(/at least 10 characters/i);

      // Read-only member: can read assessment history, cannot record one.
      const member = await signInAnonymous();
      await member.mutation(api.session.joinDemoOrganization, {});
      const memberHistory = (await member.query(api.riskAssessments.listForRisk, {
        riskId: risk.riskId as never,
      })) as { assessments: Assessment[] };
      expect(Array.isArray(memberHistory.assessments)).toBe(true);
      await expect(
        member.mutation(api.riskAssessments.createAssessment, base),
      ).rejects.toThrow(/Permission denied/i);
    },
    120000,
  );
});
