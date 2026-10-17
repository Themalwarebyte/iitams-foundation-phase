import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";
import { riskBand, riskScore } from "../src/lib/risk";

/**
 * Phase 3B Batch 1 — ICT Risk Register foundation.
 * ===============================================
 * Structural guards (always run) plus runtime behaviour against the deployed
 * development backend:
 *  - creation assigns a unique organization-scoped identifier;
 *  - the 5×5 scoring model produces the canonical bands;
 *  - validation rejects out-of-range factors, short titles and past review dates;
 *  - updates are field-validated and append a second audit entry;
 *  - read-only roles can read but cannot write;
 *  - tenant isolation is structural (same-organization re-check on every id).
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

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
const DAY = 24 * 60 * 60 * 1000;

type Risk = {
  _id: string;
  code: string;
  title: string;
  category: string;
  inherentScore: number;
  inherentBand: string;
  residualScore: number;
  residualBand: string;
  status: string;
  ownerName?: string;
  reviewDue?: number;
  reviewOverdue: boolean;
};

// ============================================================================
// Structural
// ============================================================================

describe("Risk register — structural guards", () => {
  const src = readFileSync("src/convex/risks.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const libSrc = readFileSync("src/lib/risk.ts", "utf8");
  const pageSrc = readFileSync(
    "src/components/iitams/risk/RiskRegisterPage.tsx",
    "utf8",
  );
  const httpSrc = readFileSync("src/convex/http.ts", "utf8");

  test("reads require risk.view and writes require risk.manage, server-side", () => {
    expect(src).toContain('requirePermission(ctx, "risk.view")');
    expect(src).toContain('requirePermission(ctx, "risk.manage")');
    const fns = [...src.matchAll(/export const (\w+) = (query|mutation)\(\{/g)];
    expect(fns.length).toBe(5);
    // Three reads resolve risk.view; two writes resolve risk.manage.
    expect(src.match(/await requireRiskViewer\(ctx\)/g)?.length).toBe(3);
    expect(src.match(/await requireRiskManager\(ctx\)/g)?.length).toBe(2);
    // Write path additionally refuses inactive memberships.
    expect(src).toContain("access.isProvisioned");
  });

  test("every id-addressed risk lookup re-checks the caller's organization", () => {
    expect(src).toContain("risk.organizationId !== org.organizationId");
    expect(src).toContain("risk.organizationId !== manager.organizationId");
    expect(src).toContain("Risk not found in your organization");
  });

  test("scoring is shared with the UI — one 5×5 model, no duplicates", () => {
    expect(libSrc).toContain("riskScore");
    expect(libSrc).toContain("if (score >= 15) return \"critical\"");
    expect(src).toContain('from "../lib/risk"');
    expect(pageSrc).toContain('from "@/lib/risk"');
    // The page never re-implements the band thresholds.
    expect(pageSrc).not.toContain(">= 15");
    expect(riskBand(riskScore(3, 5))).toBe("critical");
    expect(riskBand(riskScore(3, 4))).toBe("high");
    expect(riskBand(riskScore(2, 3))).toBe("medium");
    expect(riskBand(riskScore(1, 2))).toBe("low");
  });

  test("risk identifiers are unique per organization", () => {
    expect(schemaSrc).toContain('by_organization_code');
    expect(src).toContain("nextRiskCode");
    expect(src).toContain(".eq(\"code\", candidate)");
  });

  test("audit history is append-only for risk writes", () => {
    expect(src).toContain('action: "risk.created"');
    expect(src).toContain('action: "risk.updated"');
    expect(src).toContain("entityType: \"risks\"");
    // No update/delete path for audit rows in this module.
    expect(src).not.toContain("ctx.db.patch(entry");
    expect(src).not.toContain('ctx.db.delete("auditLogs"');
  });

  test("the register is not exposed on the HTTP router", () => {
    expect(httpSrc).not.toContain("risks:");
    expect(httpSrc).not.toContain("createRisk");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Risk register — runtime", () => {
  test(
    "creates, scores, validates, updates and audits an organization risk",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      const reviewDue = Date.now() + 30 * DAY;

      // 1. Creation with inherent 4×4 = 16 (critical) and residual 3×3 = 9.
      const created = (await admin.mutation(api.risks.createRisk, {
        title: `Test ransomware risk ${suffix}`,
        category: "Cyber",
        description: "Encryption of production file shares.",
        assetOrService: "Citizen services portal",
        threat: "Ransomware operator",
        vulnerability: "Unpatched internet-facing service",
        inherentLikelihood: 4,
        inherentImpact: 4,
        residualLikelihood: 3,
        residualImpact: 3,
        existingControls: "EDR and offline backups",
        treatmentRecommendation: "Patch and segment",
        ownerName: "ICT Security",
        reviewDue,
      })) as { ok?: boolean; riskId: string; code: string };
      expect(created.ok).toBe(true);
      expect(created.code).toMatch(/^R-\d{3,}$/);

      // 2. Unique identifiers: a second creation gets a different code.
      const second = (await admin.mutation(api.risks.createRisk, {
        title: `Test availability risk ${suffix}`,
        category: "Infrastructure",
        inherentLikelihood: 3,
        inherentImpact: 5,
        residualLikelihood: 2,
        residualImpact: 4,
      })) as { code: string };
      expect(second.code).not.toBe(created.code);

      // 3. Derived scores and canonical bands.
      const detail = (await admin.query(api.risks.getRisk, {
        riskId: created.riskId as never,
      })) as Risk & { history: Array<{ action: string }> };
      expect(detail.inherentScore).toBe(16);
      expect(detail.inherentBand).toBe("critical");
      expect(detail.residualScore).toBe(9);
      expect(detail.residualBand).toBe("medium");
      expect(detail.status).toBe("open");
      expect(detail.reviewOverdue).toBe(false);
      const createdEntry = detail.history.find((h) => h.action === "risk.created");
      expect(createdEntry).toBeDefined();
      // Actor attribution is present and never blank (the acting principal is
      // recorded alongside the affected record id).
      expect((createdEntry?.actorLabel ?? "").length).toBeGreaterThan(0);

      // 4. Validation: out-of-range factors, short titles, past review dates.
      await expect(
        admin.mutation(api.risks.createRisk, {
          title: "Invalid factor risk",
          category: "Cyber",
          inherentLikelihood: 6,
          inherentImpact: 3,
          residualLikelihood: 2,
          residualImpact: 2,
        }),
      ).rejects.toThrow(/between 1 and 5/i);
      await expect(
        admin.mutation(api.risks.createRisk, {
          title: "ab",
          category: "Cyber",
          inherentLikelihood: 2,
          inherentImpact: 2,
          residualLikelihood: 1,
          residualImpact: 1,
        }),
      ).rejects.toThrow(/Title must be/i);
      await expect(
        admin.mutation(api.risks.createRisk, {
          title: "Past review risk",
          category: "Cyber",
          inherentLikelihood: 2,
          inherentImpact: 2,
          residualLikelihood: 1,
          residualImpact: 1,
          reviewDue: Date.now() - DAY,
        }),
      ).rejects.toThrow(/future/i);

      // 5. Update: residual 5×5 becomes critical; the identifier is stable and
      //    a second audit entry exists.
      const updated = (await admin.mutation(api.risks.updateRisk, {
        riskId: created.riskId as never,
        residualLikelihood: 5,
        residualImpact: 5,
        status: "mitigating",
        ownerName: "ICT Security (updated)",
      })) as { ok?: boolean; changed: string[] };
      expect(updated.ok).toBe(true);
      expect(updated.changed).toContain("residualScore");
      expect(updated.changed).toContain("status");

      const after = (await admin.query(api.risks.getRisk, {
        riskId: created.riskId as never,
      })) as Risk & { history: Array<{ action: string }> };
      expect(after.code).toBe(created.code);
      expect(after.residualScore).toBe(25);
      expect(after.residualBand).toBe("critical");
      expect(after.status).toBe("mitigating");
      expect(after.history.some((h) => h.action === "risk.updated")).toBe(true);

      // 6. List + summary reflect the new records for authorized readers.
      const list = (await admin.query(api.risks.listRisks, {})) as Risk[];
      expect(list.some((r) => r._id === created.riskId)).toBe(true);
      const summary = (await admin.query(api.risks.riskSummary, {})) as {
        total: number;
        bands: { critical: number };
      };
      expect(summary.total).toBeGreaterThan(0);
      expect(summary.bands.critical).toBeGreaterThan(0);

      // 7. Read-only role: a plain demo member can read but not write.
      const member = await signInAnonymous();
      await member.mutation(api.session.joinDemoOrganization, {});
      const memberList = (await member.query(api.risks.listRisks, {})) as Risk[];
      expect(Array.isArray(memberList)).toBe(true);
      await expect(
        member.mutation(api.risks.createRisk, {
          title: "Member attempt risk",
          category: "Cyber",
          inherentLikelihood: 2,
          inherentImpact: 2,
          residualLikelihood: 1,
          residualImpact: 1,
        }),
      ).rejects.toThrow(/Permission denied/i);
    },
    120000,
  );

  test(
    "concurrent creation never allocates a duplicate risk identifier",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClient();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const suffix = uniq();
      // Fire several creations in the same tick: Convex serializes the
      // transactions and retries conflicting reads, so the max-suffix scan plus
      // the unique-index re-check must still hand out distinct codes.
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          admin.mutation(api.risks.createRisk, {
            title: `Concurrent allocation check ${suffix} #${i}`,
            category: "Process",
            inherentLikelihood: 2,
            inherentImpact: 3,
            residualLikelihood: 1,
            residualImpact: 2,
          }),
        ),
      );
      const payloads = results as Array<{ code: string; riskId: string }>;
      const codes = payloads.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
      const ids = payloads.map((r) => r.riskId);
      expect(new Set(ids).size).toBe(ids.length);

      const list = (await admin.query(api.risks.listRisks, {})) as Risk[];
      for (const id of ids) {
        expect(list.filter((r) => r._id === id)).toHaveLength(1);
      }
      // No duplicate codes exist in the register at all.
      const allCodes = list.map((r) => r.code);
      expect(new Set(allCodes).size).toBe(allCodes.length);
    },
    120000,
  );
});
