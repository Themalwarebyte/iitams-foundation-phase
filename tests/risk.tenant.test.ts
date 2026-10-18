import { afterAll, describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3B — behavioural cross-tenant isolation for the ICT Risk Register.
 * =======================================================================
 * Unlike the structural guards in tests/risk.test.ts, this suite runs against
 * TWO REAL, INDEPENDENT organizations on the isolated local development
 * deployment and drives the public API as two ordinary authenticated members:
 *
 *   - each member reads only their own organization's register;
 *   - a VALID risk id from the other organization resolves to `null` on read
 *     and is refused on update (indistinguishable from "not found");
 *   - identifiers are allocated per organization, so both tenants legitimately
 *     hold `R-001` with independent sequences.
 *
 * Fixtures are created by the internal, dev-gated `devTenantFixtures`
 * mutation (deployment-credential only) and are never deleted or migrated;
 * the shared demo organization is not touched.
 *
 * Every record this suite creates carries the explicit RUN_TAG title tag and
 * is removed again through the internal, dev-gated fixture cleanup (scoped to
 * these two fixture organizations, refusing real tenants and never touching
 * audit history), so repeat runs leave the fixtures at their baseline.
 */

const RUN_TAG = "[iitams-risk-tenant-test]";

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

/** Local development deployment admin key (deployment credential only). */
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
    if (jwt) (c as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

type Fixture = {
  organizationId: string;
  organizationCode: string;
  userId: string;
  email: string;
  riskId: string;
  riskCode: string;
};

type RiskRow = {
  _id: string;
  organizationId?: string;
  code: string;
  title: string;
  residualScore: number;
};

let fixtureA: Fixture | null = null;
let fixtureB: Fixture | null = null;
let clientA: ConvexHttpClient | null = null;
let clientB: ConvexHttpClient | null = null;
/** Treatment plan this run created in tenant B, removed again in teardown. */
let fixturePlanId: string | null = null;
let fixturePlanReference: string | null = null;

/**
 * Remove this run's tagged records again so the fixtures stay at their
 * baseline. Best-effort: teardown never replaces a real verification result
 * with an error, because the assertions above do not depend on it.
 */
async function cleanUpFixtureRecords(): Promise<void> {
  try {
    const adminKey = devAdminKey();
    if (!adminKey || !(await serverUp())) return;
    const admin = new ConvexHttpClient(CONVEX_URL);
    (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
    for (let i = 0; i < 10; i += 1) {
      const result = (await admin.mutation(
        internal.devTenantFixtures.resetFixtureRecords,
        { organizationCode: "IITAMS-TEST-A", titleTag: RUN_TAG, maxRisks: 25 },
      )) as { remaining: number };
      if (result.remaining === 0) break;
    }
    if (fixturePlanId) {
      await admin.mutation(internal.devTenantFixtures.deleteFixtureTreatmentPlan, {
        planId: fixturePlanId as never,
      });
      fixturePlanId = null;
    }
  } catch (e) {
    console.warn(`[risk.tenant:WARN] fixture cleanup skipped: ${String(e).slice(0, 200)}`);
  }
}

beforeAll(async () => {
  if (!(await serverUp()) || !token) return;
  const adminKey = devAdminKey();
  if (!adminKey) return;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(adminKey);
  const result = (await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {})) as {
    organizations: Fixture[];
  };
  fixtureA = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-A") ?? null;
  fixtureB = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-B") ?? null;
  if (!fixtureA || !fixtureB) return;
  clientA = await signInEmailOtp(fixtureA.email);
  clientB = await signInEmailOtp(fixtureB.email);
});

afterAll(async () => {
  await cleanUpFixtureRecords();
});

describe("Risk register — cross-tenant isolation (two real organizations)", () => {
  test(
    "each tenant reads only its own register, with independent identifiers",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }
      const aRows = (await clientA.query(api.risks.listRisks, {})) as RiskRow[];
      const bRows = (await clientB.query(api.risks.listRisks, {})) as RiskRow[];

      expect(aRows.length).toBeGreaterThanOrEqual(1);
      expect(bRows.length).toBeGreaterThanOrEqual(1);
      expect(aRows.every((r) => r.title.includes("Tenant A"))).toBe(true);
      expect(bRows.every((r) => r.title.includes("Tenant B"))).toBe(true);
      expect(aRows.some((r) => r._id === fixtureB!.riskId)).toBe(false);
      expect(bRows.some((r) => r._id === fixtureA!.riskId)).toBe(false);

      // Per-organization sequences: both tenants legitimately hold R-001.
      expect(aRows.some((r) => r.code === fixtureA!.riskCode)).toBe(true);
      expect(bRows.some((r) => r.code === fixtureB!.riskCode)).toBe(true);

      const aSummary = (await clientA.query(api.risks.riskSummary, {})) as {
        total: number;
      };
      const bSummary = (await clientB.query(api.risks.riskSummary, {})) as {
        total: number;
      };
      expect(aSummary.total).toBe(aRows.length);
      expect(bSummary.total).toBe(bRows.length);
    },
    120000,
  );

  test(
    "a valid record id from the other tenant cannot be read or modified",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }

      // Reads: the foreign id is indistinguishable from a deleted record.
      const crossRead = await clientA.query(api.risks.getRisk, {
        riskId: fixtureB!.riskId as never,
      });
      expect(crossRead).toBeNull();
      const crossReadReverse = await clientB.query(api.risks.getRisk, {
        riskId: fixtureA!.riskId as never,
      });
      expect(crossReadReverse).toBeNull();

      // Writes: refused with the same "not found in your organization" error.
      await expect(
        clientA.mutation(api.risks.updateRisk, {
          riskId: fixtureB!.riskId as never,
          residualLikelihood: 5,
          residualImpact: 5,
        }),
      ).rejects.toThrow(/not found in your organization/i);
      await expect(
        clientB.mutation(api.risks.updateRisk, {
          riskId: fixtureA!.riskId as never,
          status: "closed",
        }),
      ).rejects.toThrow(/not found in your organization/i);

      // The foreign record is provably unchanged: Tenant B still reads its own
      // record with the original residual score (2×2 = 4) and status "open".
      const bOwn = (await clientB.query(api.risks.getRisk, {
        riskId: fixtureB!.riskId as never,
      })) as (RiskRow & { status: string }) | null;
      expect(bOwn).not.toBeNull();
      expect(bOwn!.residualScore).toBe(4);
      expect(bOwn!.status).toBe("open");
    },
    120000,
  );

  test(
    "creating a risk in tenant A allocates only in A and leaves B untouched",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }
      const bBefore = (await clientB.query(api.risks.listRisks, {})) as RiskRow[];

      const created = (await clientA.mutation(api.risks.createRisk, {
        title: `${RUN_TAG} Tenant A isolation check ${Date.now()}`,
        category: "Data",
        inherentLikelihood: 3,
        inherentImpact: 3,
        residualLikelihood: 2,
        residualImpact: 2,
        ownerName: "Tenant A owner",
        reviewDue: Date.now() + 14 * DAY,
      })) as { riskId: string; code: string };
      expect(created.code).toMatch(/^R-\d{3,}$/);

      const aRows = (await clientA.query(api.risks.listRisks, {})) as RiskRow[];
      const bAfter = (await clientB.query(api.risks.listRisks, {})) as RiskRow[];
      expect(aRows.some((r) => r._id === created.riskId)).toBe(true);
      expect(bAfter.map((r) => r._id)).toEqual(bBefore.map((r) => r._id));

      // Tenant B cannot read the new record either.
      expect(
        await clientB.query(api.risks.getRisk, { riskId: created.riskId as never }),
      ).toBeNull();

      const detail = (await clientA.query(api.risks.getRisk, {
        riskId: created.riskId as never,
      })) as {
        _id: string;
        history: Array<{ action: string }>;
      } | null;
      expect(detail?.history.some((h) => h.action === "risk.created")).toBe(true);
    },
    120000,
  );

  test(
    "assessment history and overdue reviews never leak across organizations",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }

      // Reads of another tenant's assessment history resolve to null.
      expect(
        await clientA.query(api.riskAssessments.listForRisk, {
          riskId: fixtureB!.riskId as never,
        }),
      ).toBeNull();
      expect(
        await clientB.query(api.riskAssessments.listForRisk, {
          riskId: fixtureA!.riskId as never,
        }),
      ).toBeNull();

      // Recording an assessment against a foreign risk id is refused.
      await expect(
        clientA.mutation(api.riskAssessments.createAssessment, {
          riskId: fixtureB!.riskId as never,
          assessmentDate: Date.now(),
          inherentLikelihood: 5,
          inherentImpact: 5,
          residualLikelihood: 5,
          residualImpact: 5,
          justification: "Cross-tenant assessment attempt must be refused",
          nextReviewDate: Date.now() + 30 * DAY,
        }),
      ).rejects.toThrow(/not found in your organization/i);

      // Overdue review identification is organization-scoped: tenant B has an
      // overdue fixture, tenant A has none.
      const aSummary = (await clientA.query(api.risks.riskSummary, {})) as {
        overdueReviews: number;
      };
      const bSummary = (await clientB.query(api.risks.riskSummary, {})) as {
        overdueReviews: number;
      };
      expect(aSummary.overdueReviews).toBe(0);
      expect(bSummary.overdueReviews).toBeGreaterThanOrEqual(1);
    },
    120000,
  );

  test(
    "treatment plans, actions and owners are refused across organizations",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }

      // Foreign treatment plans are invisible on read.
      expect(
        await clientA.query(api.riskTreatment.listForRisk, {
          riskId: fixtureB!.riskId as never,
        }),
      ).toBeNull();
      expect(
        await clientB.query(api.riskTreatment.listForRisk, {
          riskId: fixtureA!.riskId as never,
        }),
      ).toBeNull();

      // Tenant A cannot plan treatment for tenant B's risk.
      await expect(
        clientA.mutation(api.riskTreatment.createPlan, {
          riskId: fixtureB!.riskId as never,
          strategy: "mitigate",
          objective: "Cross-tenant treatment attempt must be refused",
          justification: "Foreign risk ids are indistinguishable from missing ones",
          ownerUserId: fixtureA!.userId as never,
          targetDate: Date.now() + 30 * DAY,
        }),
      ).rejects.toThrow(/not found in your organization/i);

      // Tenant B creates a real plan and action for its own risk.
      const plan = (await clientB.mutation(api.riskTreatment.createPlan, {
        riskId: fixtureB!.riskId as never,
        strategy: "mitigate",
        objective: "Reduce the archive exposure in tenant B only",
        justification: "Tenant B owns this risk and its treatment evidence",
        ownerUserId: fixtureB!.userId as never,
        targetDate: Date.now() + 30 * DAY,
      })) as { planId: string; reference: string };
      fixturePlanId = plan.planId;
      fixturePlanReference = plan.reference;
      const action = (await clientB.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Tenant B action that tenant A must never reach",
        ownerUserId: fixtureB!.userId as never,
        dueDate: Date.now() + 15 * DAY,
      })) as { actionId: string };

      // Tenant A cannot read or mutate B's plan or action by id.
      expect(
        await clientA.query(api.riskTreatment.getPlan, {
          planId: plan.planId as never,
        }),
      ).toBeNull();
      await expect(
        clientA.mutation(api.riskTreatment.updatePlanStatus, {
          planId: plan.planId as never,
          status: "in_progress",
        }),
      ).rejects.toThrow(/not found in your organization/i);
      await expect(
        clientA.mutation(api.riskTreatment.updateActionStatus, {
          actionId: action.actionId as never,
          status: "in_progress",
        }),
      ).rejects.toThrow(/not found in your organization/i);

      // Owner validation: a member of another organization cannot be assigned.
      await expect(
        clientB.mutation(api.riskTreatment.createPlan, {
          riskId: fixtureB!.riskId as never,
          strategy: "mitigate",
          objective: "Assign an owner from a different organization",
          justification: "Cross-tenant ownership must be refused outright",
          ownerUserId: fixtureA!.userId as never,
          targetDate: Date.now() + 30 * DAY,
        }),
      ).rejects.toThrow(/not a member of your organization/i);

      // Tenant B's plan is untouched by the failed attempts.
      const bList = (await clientB.query(api.riskTreatment.listForRisk, {
        riskId: fixtureB!.riskId as never,
      })) as {
        plans: Array<{ reference: string; status: string; actions: unknown[] }>;
      };
      const bPlan = bList.plans.find((p) => p.reference === plan.reference);
      expect(bPlan?.status).toBe("planned");
      expect(bPlan?.actions).toHaveLength(1);

      // Tenant A's own treatment view does not contain tenant B's plan.
      const aList = (await clientA.query(api.riskTreatment.listForRisk, {
        riskId: fixtureA!.riskId as never,
      })) as { plans: Array<{ reference: string }> };
      expect(aList.plans.some((p) => p.reference === plan.reference)).toBe(false);
    },
    120000,
  );

  test(
    "fixture cleanup leaves both tenants at their baseline after the run",
    async () => {
      if (!fixtureA || !fixtureB || !clientA || !clientB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures or OTP sign-in unavailable");
      }
      await cleanUpFixtureRecords();

      // Tenant A: this run's tagged risk is gone, its fixture baseline stays.
      const aRows = (await clientA.query(api.risks.listRisks, {})) as RiskRow[];
      expect(aRows.some((r) => r.title.startsWith(RUN_TAG))).toBe(false);
      expect(aRows.some((r) => r.code === fixtureA!.riskCode)).toBe(true);

      // Tenant B: this run's treatment plan is gone, its fixture risk stays.
      const bList = (await clientB!.query(api.riskTreatment.listForRisk, {
        riskId: fixtureB!.riskId as never,
      })) as { plans: Array<{ reference: string }> };
      if (fixturePlanReference) {
        expect(bList.plans.some((p) => p.reference === fixturePlanReference)).toBe(
          false,
        );
      }
      fixturePlanReference = null;

      // Cross-tenant denial still holds after cleanup.
      expect(
        await clientB!.query(api.risks.getRisk, { riskId: fixtureA!.riskId as never }),
      ).toBeNull();
    },
    120000,
  );
});
