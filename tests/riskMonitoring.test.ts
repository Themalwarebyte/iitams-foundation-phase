import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3B — Batch 2C: ICT risk monitoring and treatment oversight.
 * ===============================================================
 * Structural guards (read-only module, `risk.view` on every query, bounded
 * indexed reads, pagination, no treatment-as-reduction) plus runtime checks
 * against the development backend using three isolated fixture organizations
 * (A and B for read-only isolation, M for the records this suite creates):
 *
 *  - KPI deltas track real register/assessment/treatment records exactly;
 *  - completing a treatment never lowers residual risk or resolves the risk;
 *  - filters return the records that actually match, with pagination;
 *  - tenants never see each other's monitoring figures;
 *  - read-only members can read monitoring but cannot mutate (enforced
 *    elsewhere by the write modules' own permission checks).
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";
const DAY = 24 * 60 * 60 * 1000;

/**
 * Explicit tag on every record this suite creates. Combined with tenant M
 * being this suite's own disposable fixture organization, it makes every
 * test-generated row identifiable in the deployment.
 */
const RUN_TAG = "[iitams-monitoring-test]";

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

async function adminClient(): Promise<ConvexHttpClient | null> {
  const key = devAdminKey();
  if (!key) return null;
  const admin = new ConvexHttpClient(CONVEX_URL);
  (admin as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(key);
  return admin;
}

/**
 * Delete the records this suite created previously in tenant M, so repeated
 * runs cannot grow the fixture organization indefinitely.
 *
 * Scoped server-side to the disposable IITAMS-TEST-M fixture organization
 * (never A, B, the shared demo organization or real data), limited to records
 * other than the fixture baseline risk, and it never touches audit history.
 *
 * The cleanup is best-effort: a failure is reported but never fails the run,
 * because the suite's assertions do not depend on the fixture being empty and
 * a cleanup must not replace a real verification result with an error.
 */
async function resetMonitoringFixtureData(): Promise<void> {
  try {
    const admin = await adminClient();
    if (!admin) return;
    for (let i = 0; i < 20; i += 1) {
      const result = (await admin.mutation(
        internal.devTenantFixtures.resetFixtureRecords,
        { organizationCode: "IITAMS-TEST-M", maxRisks: 25 },
      )) as { remaining: number };
      if (result.remaining === 0) return;
    }
  } catch (e) {
    console.warn(`[monitoring:WARN] fixture cleanup skipped: ${String(e).slice(0, 200)}`);
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
    if (jwt) (c as unknown as { setAuth: (value: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

async function harnessPost(
  path: string,
  body: Record<string, unknown>,
): Promise<boolean> {
  const res = await fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify(body),
  });
  return res.ok;
}

async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const result = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) (guest as unknown as { setAuth: (value: string) => void }).setAuth(jwt);
  return guest;
}

type Fixture = {
  organizationId: string;
  organizationCode: string;
  email: string;
  riskId: string;
};

type Overview = {
  kpis: {
    activeRisks: number;
    highCritical: number;
    overdueAssessments: number;
    risksWithOpenPlans: number;
    overdueActions: number;
    completedActions: number;
    increasingResidual: number;
    awaitingReassessment: number;
  };
  bands: Record<string, number>;
  movements: {
    increased: number;
    decreased: number;
    unchanged: number;
    noHistory: number;
  };
  treatment: {
    plansTotal: number;
    openPlans: number;
    completedPlans: number;
    actionsTotal: number;
    actionsCompleted: number;
    actionsOutstanding: number;
    actionsOverdue: number;
  };
  attention: {
    overdueActions: Array<{ riskCode: string; description: string }>;
  };
};

type RiskRow = {
  riskId: string;
  code: string;
  title: string;
  residualScore: number;
  residualBand: string;
  reviewOverdue: boolean;
  actionsOverdue: number;
  awaitingReassessment: boolean;
  trendDirection: string;
  trendChange: number | null;
  plansTotal: number;
};

type RiskPage = {
  rows: RiskRow[];
  continueCursor: string;
  isDone: boolean;
};

type Trends = {
  monthly: Array<{ month: string; assessments: number; avgResidual: number }>;
  movements: { increased: number; decreased: number; unchanged: number };
  riskMovements: Array<{
    riskId: string;
    change: number | null;
    direction: string;
  }>;
};

let fixtureA: Fixture | null = null;
let fixtureB: Fixture | null = null;
let fixtureM: Fixture | null = null;
let clientA: ConvexHttpClient | null = null;
let clientB: ConvexHttpClient | null = null;
let clientM: ConvexHttpClient | null = null;

beforeAll(async () => {
  if (!(await serverUp()) || !token) return;
  const admin = await adminClient();
  if (!admin) return;
  const result = (await admin.mutation(internal.devTenantFixtures.ensureTenantFixtures, {})) as {
    organizations: Fixture[];
  };
  // Start from a clean fixture organization: records from an earlier run are
  // removed before this run creates its own, so growth stays bounded even
  // when a previous run aborted before its teardown.
  await resetMonitoringFixtureData();
  fixtureA = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-A") ?? null;
  fixtureB = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-B") ?? null;
  fixtureM = result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-M") ?? null;
  if (!fixtureA || !fixtureB || !fixtureM) return;
  clientA = await signInEmailOtp(fixtureA.email);
  clientB = await signInEmailOtp(fixtureB.email);
  clientM = await signInEmailOtp(fixtureM.email);
});

afterAll(async () => {
  await resetMonitoringFixtureData();
});

// ============================================================================
// Structural
// ============================================================================

describe("Risk monitoring — structural guards", () => {
  const src = readFileSync("src/convex/riskMonitoring.ts", "utf8");
  const pageSrc = readFileSync(
    "src/components/iitams/risk/RiskMonitoringPage.tsx",
    "utf8",
  );
  const navSrc = readFileSync("src/lib/nav.ts", "utf8");
  const mainSrc = readFileSync("src/main.tsx", "utf8");

  test("every query requires risk.view and resolves the organization server-side", () => {
    const fns = [...src.matchAll(/export const (\w+) = query\(\{/g)];
    expect(fns.length).toBeGreaterThanOrEqual(4);
    for (const fn of fns) {
      const body = src.slice(fn.index ?? 0, (fn.index ?? 0) + 900);
      expect(body).toContain("requireViewer(ctx)");
    }
    expect(src).toContain('requirePermission(ctx, "risk.view")');
    expect(src).not.toContain('organizationId: v.id("organizations")');
    for (const index of [
      '.withIndex("by_organization", (q) =>\n        q.eq("organizationId", org.organizationId),',
      '.eq("organizationId", viewer.organizationId)',
    ]) {
      expect(src).toContain(index.split("\n")[0]);
    }
  });

  test("monitoring is read-only: it never writes, scores or approves", () => {
    expect(src).not.toContain("mutation(");
    expect(src).not.toContain("ctx.db.insert(");
    expect(src).not.toContain("ctx.db.patch(");
    expect(src).not.toContain("ctx.db.delete(");
    expect(src).not.toContain("logAudit(");
    // Residual movement comes only from assessments; the module reports it.
    expect(src).toContain("riskScore(");
    expect(src).toContain("riskBand(");
  });

  test("reads are bounded and the filtered list is cursor-paginated", () => {
    for (const limit of [
      "RISK_SCAN_LIMIT",
      "PLAN_SCAN_LIMIT",
      "ACTION_SCAN_LIMIT",
      "ASSESSMENT_SCAN_LIMIT",
    ]) {
      expect(src).toContain(`const ${limit} = `);
      expect(src).toContain(`.take(${limit})`);
    }
    expect(src).toContain("LIST_BATCH_MAX");
    // Exactly one paginated query per execution (a Convex requirement) — the
    // batch boundary is the page boundary, so no risk is skipped or re-read.
    expect(src.match(/\.paginate\(/g)?.length).toBe(1);
    expect(src).toContain(
      ".paginate({ numItems: batchSize, cursor: args.cursor ?? null })",
    );
    expect(src).toContain("continueCursor: page.continueCursor");
    expect(pageSrc).toContain("Load more");
    expect(pageSrc).toContain("api.riskMonitoring.monitoringRisks");
  });

  test("fixture cleanup is dev-gated, tenant-scoped and never touches audit history", () => {
    const fixturesSrc = readFileSync("src/convex/devTenantFixtures.ts", "utf8");
    const resetIdx = fixturesSrc.indexOf("export const resetFixtureRecords");
    expect(resetIdx).toBeGreaterThan(-1);
    const resetBody = fixturesSrc.slice(resetIdx);
    expect(resetBody).toContain("guestAuthEnabled()");
    expect(resetBody).toContain("fixtureOrganization(ctx, args.organizationCode)");
    // Only the three demo-flagged fixtures are reachable, and the baseline
    // rows plus the append-only audit trail survive.
    expect(fixturesSrc).toContain('"IITAMS-TEST-M": ["R-001"]');
    expect(resetBody).toContain("FIXTURE_BASELINE_CODES");
    expect(resetBody).not.toContain("auditLogs");
    // Cleanup is internal-only: no public mutation can trigger it.
    expect(resetBody).toContain("internalMutation(");
    expect(fixturesSrc).not.toContain("export const resetFixtureRecords = mutation(");
  });

  test("the monitoring page is routed, navigable and honest about proposals", () => {
    expect(navSrc).toContain('path: "/risk/monitoring"');
    expect(mainSrc).toContain('path="/risk/monitoring"');
    expect(pageSrc).toContain("Risk Monitoring");
    expect(pageSrc).toContain("/risk/register?risk=");
    expect(pageSrc).toContain("acceptanceProposal");
    expect(pageSrc).toContain("not an approved risk-acceptance");
    expect(pageSrc).toContain("risk.view");
    // Loading / empty / unauthorized states are all present.
    expect(pageSrc).toContain("ListSkeleton");
    expect(pageSrc).toContain("EmptyState");
    expect(pageSrc).toContain("not available for your role");
  });
});

// ============================================================================
// Runtime
// ============================================================================

describe("Risk monitoring — runtime", () => {
  test(
    "KPIs, trends and filters track real records and treatment never moves residual risk",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!clientM) {
        throw new Error("[test:PREREQ-FAILED] tenant fixture sign-in unavailable");
      }
      // Tenant M is this suite's own mutable fixture organization: the records
      // created below must never land in A or B, which the cross-tenant suite
      // asserts on, nor in the shared demo organization.
      const client = clientM;
      const before = (await client.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as Overview;

      // A high residual (4×4 = 16) risk with a scheduled review.
      const created = (await client.mutation(api.risks.createRisk, {
        title: `${RUN_TAG} Monitoring KPI risk ${Date.now()}`,
        category: "Cyber",
        inherentLikelihood: 4,
        inherentImpact: 5,
        residualLikelihood: 4,
        residualImpact: 4,
        ownerName: "Monitoring Owner",
        reviewDue: Date.now() + 20 * DAY,
      })) as { riskId: string; code: string };

      // Two assessments: residual 9 → 25 (an increase on the immutable chain).
      await new Promise((r) => setTimeout(r, 50));
      const firstAssessment = (await client.mutation(
        api.riskAssessments.createAssessment,
        {
          riskId: created.riskId as never,
          assessmentDate: Date.now(),
          inherentLikelihood: 4,
          inherentImpact: 5,
          residualLikelihood: 3,
          residualImpact: 3,
          justification: "Initial monitoring assessment for trend verification",
          nextReviewDate: Date.now() + 10 * DAY,
        },
      )) as { assessmentId: string };
      await new Promise((r) => setTimeout(r, 50));
      await client.mutation(api.riskAssessments.createAssessment, {
        riskId: created.riskId as never,
        assessmentDate: Date.now(),
        inherentLikelihood: 5,
        inherentImpact: 5,
        residualLikelihood: 5,
        residualImpact: 5,
        justification: "Escalation recorded as a second assessment snapshot",
        nextReviewDate: Date.now() + 15 * DAY,
      });

      // A treatment plan with one action, due in the past (overdue).
      const plan = (await client.mutation(api.riskTreatment.createPlan, {
        riskId: created.riskId as never,
        strategy: "mitigate",
        objective: "Contain the escalated exposure with a documented control",
        justification: "Residual score moved up since the previous assessment",
        ownerName: "Monitoring Owner",
        targetDate: Date.now() + 10 * DAY,
      })) as { planId: string };
      await client.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "in_progress",
      });
      const action = (await client.mutation(api.riskTreatment.addAction, {
        planId: plan.planId as never,
        description: "Deliver the containment control for monitoring",
        ownerName: "Monitoring Owner",
        dueDate: Date.now() - 3 * DAY,
      })) as { actionId: string };

      const afterCreate = (await client.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as Overview;

      // KPI deltas match the records just created — no invented statistics.
      expect(afterCreate.kpis.activeRisks).toBe(before.kpis.activeRisks + 1);
      expect(afterCreate.kpis.highCritical).toBe(before.kpis.highCritical + 1);
      expect(afterCreate.kpis.risksWithOpenPlans).toBe(
        before.kpis.risksWithOpenPlans + 1,
      );
      expect(afterCreate.kpis.overdueActions).toBe(
        before.kpis.overdueActions + 1,
      );
      expect(afterCreate.bands.critical).toBe(before.bands.critical + 1);
      expect(afterCreate.kpis.increasingResidual).toBe(
        before.kpis.increasingResidual + 1,
      );
      expect(afterCreate.treatment.openPlans).toBe(
        before.treatment.openPlans + 1,
      );
      expect(
        afterCreate.attention.overdueActions.some((a) => a.riskCode === created.code),
      ).toBe(true);

      // The trend view sees the same immutable assessment pair.
      const trends = (await client.query(
        api.riskMonitoring.assessmentTrends,
        {},
      )) as Trends;
      const movement = trends.riskMovements.find(
        (m) => m.riskId === created.riskId,
      );
      expect(movement).toBeDefined();
      expect(movement!.direction).toBe("increased");
      expect(movement!.change).toBe(16);
      expect(trends.movements.increased).toBe(
        before.movements.increased + 1,
      );
      expect(
        trends.monthly.reduce((n, m) => n + m.assessments, 0),
      ).toBeGreaterThanOrEqual(2);

      // Filters select the matching records only.
      const overdueFilter = (await client.query(
        api.riskMonitoring.monitoringRisks,
        { filter: "overdue_treatment", search: created.code },
      )) as RiskPage;
      expect(overdueFilter.rows.some((r) => r.riskId === created.riskId)).toBe(true);
      const highFilter = (await client.query(
        api.riskMonitoring.monitoringRisks,
        { filter: "high_priority", search: created.code },
      )) as RiskPage;
      expect(highFilter.rows.map((r) => r.riskId)).toContain(created.riskId);

      // Treatment oversight exposes owner/strategy/progress/current residual.
      const oversee = (await client.query(
        api.riskMonitoring.treatmentOversight,
        {},
      )) as {
        rows: Array<{
          planId: string;
          riskId: string;
          ownerName: string;
          strategy: string;
          total: number;
          completed: number;
          outstanding: number;
          overdue: number;
          residualScore: number;
          acceptanceProposal: boolean;
        }>;
      };
      const livePlan = oversee.rows.find((r) => r.planId === plan.planId);
      expect(livePlan).toBeDefined();
      expect(livePlan!.ownerName).toBe("Monitoring Owner");
      expect(livePlan!.strategy).toBe("mitigate");
      expect(livePlan!.total).toBe(1);
      expect(livePlan!.outstanding).toBe(1);
      expect(livePlan!.overdue).toBe(1);
      expect(livePlan!.residualScore).toBe(25);
      expect(livePlan!.acceptanceProposal).toBe(false);

      // Completing the plan does NOT reduce residual risk or resolve the risk.
      await client.mutation(api.riskTreatment.updateActionStatus, {
        actionId: action.actionId as never,
        status: "in_progress",
      });
      await client.mutation(api.riskTreatment.updateActionStatus, {
        actionId: action.actionId as never,
        status: "completed",
        completionNotes: "Containment control delivered and evidenced",
      });
      await client.mutation(api.riskTreatment.updatePlanStatus, {
        planId: plan.planId as never,
        status: "completed",
      });

      const afterCompletion = (await client.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as Overview;
      const riskAfter = (await client.query(api.risks.getRisk, {
        riskId: created.riskId as never,
      })) as { residualScore: number; status: string } | null;
      expect(riskAfter).not.toBeNull();
      expect(riskAfter!.residualScore).toBe(25);
      expect(riskAfter!.status).toBe("open");
      expect(afterCompletion.kpis.completedActions).toBe(
        afterCreate.kpis.completedActions + 1,
      );
      expect(afterCompletion.kpis.awaitingReassessment).toBe(
        afterCreate.kpis.awaitingReassessment + 1,
      );
      expect(afterCompletion.kpis.overdueActions).toBe(
        afterCreate.kpis.overdueActions - 1,
      );

      // Awaiting-reassessment filter surfaces exactly this risk.
      const awaiting = (await client.query(
        api.riskMonitoring.monitoringRisks,
        { filter: "awaiting_reassessment", search: created.code },
      )) as RiskPage;
      expect(awaiting.rows.length).toBe(1);
      expect(awaiting.rows[0].riskId).toBe(created.riskId);
      expect(awaiting.rows[0].awaitingReassessment).toBe(true);

      // A recorded assessment after completion clears the awaiting flag; the
      // plan completion itself never did.
      await client.mutation(api.riskAssessments.createAssessment, {
        riskId: created.riskId as never,
        assessmentDate: Date.now(),
        inherentLikelihood: 5,
        inherentImpact: 5,
        residualLikelihood: 2,
        residualImpact: 2,
        justification: "Post-treatment reassessment recorded as evidence",
        nextReviewDate: Date.now() + 30 * DAY,
      });
      const afterReassessment = (await client.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as Overview;
      expect(afterReassessment.kpis.awaitingReassessment).toBe(
        afterCompletion.kpis.awaitingReassessment - 1,
      );
      const cleared = (await client.query(api.riskMonitoring.monitoringRisks, {
        filter: "awaiting_reassessment",
        search: created.code,
      })) as RiskPage;
      expect(cleared.rows).toHaveLength(0);
      // Score reduction is now attributable to the assessment record.
      const riskReassessed = (await client.query(api.risks.getRisk, {
        riskId: created.riskId as never,
      })) as { residualScore: number } | null;
      expect(riskReassessed!.residualScore).toBe(4);
      expect(firstAssessment.assessmentId).toBeTruthy();
    },
    180000,
  );

  test(
    "fixture cleanup bounds test-data growth without touching the baseline or other tenants",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!clientM) {
        throw new Error("[test:PREREQ-FAILED] tenant fixture sign-in unavailable");
      }
      const client = clientM;
      const suffix = `${Date.now()}`;
      for (let i = 0; i < 3; i += 1) {
        await client.mutation(api.risks.createRisk, {
          title: `${RUN_TAG} Cleanup probe ${suffix}-${i}`,
          category: "Process",
          inherentLikelihood: 2,
          inherentImpact: 2,
          residualLikelihood: 1,
          residualImpact: 1,
        });
      }
      const beforeReset = (await client.query(api.riskMonitoring.monitoringRisks, {
        filter: "all",
        numItems: 50,
      })) as RiskPage;
      expect(beforeReset.rows.some((r) => r.title.startsWith(RUN_TAG))).toBe(true);

      await resetMonitoringFixtureData();

      // Walk what is left: this run's tagged rows are gone, the fixture
      // baseline risk survives, and no row from another organization appears.
      const seen: RiskRow[] = [];
      let page = (await client.query(api.riskMonitoring.monitoringRisks, {
        filter: "all",
        numItems: 50,
      })) as RiskPage;
      seen.push(...page.rows);
      let cursor: string | null = page.isDone ? null : page.continueCursor;
      let pages = 1;
      while (cursor && pages < 20) {
        page = (await client.query(api.riskMonitoring.monitoringRisks, {
          filter: "all",
          numItems: 50,
          cursor,
        })) as RiskPage;
        pages += 1;
        seen.push(...page.rows);
        cursor = page.isDone ? null : page.continueCursor;
      }
      expect(seen.some((r) => r.title.startsWith(RUN_TAG))).toBe(false);
      expect(seen.some((r) => r.code === "R-001")).toBe(true);
      expect(seen.some((r) => r.title.includes("Tenant B"))).toBe(false);
    },
    120000,
  );

  test(
    "organization isolation and permission denial",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      if (!clientA || !clientB || !fixtureB) {
        throw new Error("[test:PREREQ-FAILED] tenant fixtures unavailable");
      }

      // Tenant B's fixture risk never appears in tenant A's monitoring.
      const foreign = (await clientA.query(api.riskMonitoring.monitoringRisks, {
        search: "Tenant B fixture risk",
      })) as RiskPage;
      expect(foreign.rows.some((r) => r.title.includes("Tenant B"))).toBe(false);
      expect(foreign.rows.some((r) => r.riskId === fixtureB!.riskId)).toBe(false);

      const bRows = (await clientB.query(api.riskMonitoring.monitoringRisks, {
        filter: "all",
      })) as RiskPage;
      const aRows = (await clientA.query(api.riskMonitoring.monitoringRisks, {
        filter: "all",
      })) as RiskPage;
      const bIds = new Set(bRows.rows.map((r) => r.riskId));
      for (const row of aRows.rows) {
        expect(bIds.has(row.riskId)).toBe(false);
      }

      // No authenticated identity at all → every monitoring query fails closed.
      const stranger = new ConvexHttpClient(CONVEX_URL);
      for (const queryRef of [
        api.riskMonitoring.monitoringOverview,
        api.riskMonitoring.assessmentTrends,
        api.riskMonitoring.treatmentOversight,
      ]) {
        await expect(
          stranger
            .query(queryRef, {})
            .then((r) => JSON.stringify(r)),
        ).rejects.toThrow(/not authenticated/i);
      }

      // A role without risk.view is refused by the server, not just hidden in
      // the UI: executive viewers see dashboards and reports only.
      const suffix = `${Date.now()}`;
      const viewerEmail = `monitoring-viewer-${suffix}@check.example`;
      expect(
        await harnessPost("/api/dev-seed-test-user", { email: viewerEmail }),
      ).toBe(true);
      const admin = await signInAnonymous();
      await admin.mutation(api.session.joinDemoOrganization, {});
      const adminSession = (await admin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (adminSession?.userId) {
        await harnessPost("/api/dev-grant-demo-role", {
          userId: adminSession.userId,
          role: "admin",
          ttlMinutes: 60,
        });
        const provisioned = (await admin.mutation(api.admin.provisionMember, {
          email: viewerEmail,
          initialRole: "member",
        })) as { ok?: boolean; profileId?: string };
        if (provisioned.ok && provisioned.profileId) {
          await admin.mutation(api.admin.changeMemberRole, {
            profileId: provisioned.profileId as never,
            role: "executive_viewer",
          });
          const viewer = await signInEmailOtp(viewerEmail);
          if (viewer) {
            await expect(
              viewer
                .query(api.riskMonitoring.monitoringOverview, {})
                .then((r) => JSON.stringify(r)),
            ).rejects.toThrow(/Permission denied/i);
            await expect(
              viewer
                .query(api.riskMonitoring.monitoringRisks, {})
                .then((r) => JSON.stringify(r)),
            ).rejects.toThrow(/Permission denied/i);
          }
        }
      }

      // A read-only member of the demo organization can read monitoring.
      const member = await signInAnonymous();
      await member.mutation(api.session.joinDemoOrganization, {});
      const memberOverview = (await member.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as Overview;
      expect(typeof memberOverview.kpis.activeRisks).toBe("number");
      const memberPage = (await member.query(
        api.riskMonitoring.monitoringRisks,
        { numItems: 5 },
      )) as RiskPage;
      // Reads stay inside the requested scan batch.
      expect(memberPage.rows.length).toBeLessThanOrEqual(5);
    },
    120000,
  );

  test(
    "large registers paginate without duplicates or unbounded reads",
    async () => {
      if (!(await serverUp()) || !token) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      // The writable records below go to tenant M, this suite's own fixture
      // organization: never to A or B (the cross-tenant suite asserts on their
      // exact contents) and never to the shared demo organization.
      if (!clientM) {
        throw new Error("[test:PREREQ-FAILED] tenant fixture sign-in unavailable");
      }
      const admin = clientM;

      const suffix = `${Date.now()}`;
      const createdIds: string[] = [];
      for (let i = 0; i < 24; i += 1) {
        const row = (await admin.mutation(api.risks.createRisk, {
          title: `${RUN_TAG} Pagination risk ${suffix}-${i}`,
          category: "Process",
          inherentLikelihood: 2,
          inherentImpact: 2,
          residualLikelihood: 2,
          residualImpact: 2,
          ownerName: "Pagination Owner",
        })) as { riskId: string };
        createdIds.push(row.riskId);
      }

      // A small per-page batch is requested deliberately: the walk must cross
      // several pages of a register that no single execution can read whole.
      const batch = 10;
      const first = (await admin.query(api.riskMonitoring.monitoringRisks, {
        numItems: batch,
      })) as RiskPage;
      // One bounded scan batch per request: rows are the matches inside it.
      expect(first.rows.length).toBeLessThanOrEqual(batch);

      const seen: string[] = first.rows.map((r) => r.riskId);
      let cursor: string | null = first.isDone ? null : first.continueCursor;
      let pages = 1;
      while (cursor && pages < 200) {
        const next = (await admin.query(api.riskMonitoring.monitoringRisks, {
          numItems: batch,
          cursor,
        })) as RiskPage;
        pages += 1;
        expect(next.rows.length).toBeLessThanOrEqual(batch);
        for (const row of next.rows) seen.push(row.riskId);
        cursor = next.isDone ? null : next.continueCursor;
      }
      expect(cursor).toBeNull();
      expect(pages).toBeGreaterThan(1);
      expect(new Set(seen).size).toBe(seen.length);
      // Every newly created risk is reachable through pagination.
      for (const id of createdIds) {
        expect(seen).toContain(id);
      }

      // The scan batch is clamped server-side: a caller cannot request the
      // organization's whole register in one execution.
      const clamped = (await admin.query(
        api.riskMonitoring.monitoringRisks,
        { numItems: 10_000 },
      )) as RiskPage;
      expect(clamped.rows.length).toBeLessThanOrEqual(200);
    },
    180000,
  );
});
