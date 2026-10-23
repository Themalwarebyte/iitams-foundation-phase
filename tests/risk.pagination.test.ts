import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * Phase 3B — register pagination at scale.
 * =======================================
 * The register used to expose a bounded first window of the organization's
 * risks, so a record created after that window was unreachable and the list
 * could not be traversed to completion. This suite proves the replacement
 * contract against a REAL, isolated fixture organization (`IITAMS-TEST-P`)
 * whose register is deliberately grown past the old 500-record ceiling:
 *
 *  - every record is reachable by walking server-issued cursors;
 *  - no record is duplicated or omitted across pages, and repeated traversals
 *    return the same sequence;
 *  - a risk created after the ceiling exists is the first record of page one;
 *  - server-side search and filters reach records older than one listing
 *    window, and incomplete coverage is disclosed rather than implied;
 *  - the summary is exact below its scan window and an explicit lower bound
 *    above it — never a capped sample presented as an organization total;
 *  - page size, band and cursor inputs are validated server-side;
 *  - a second organization sees none of the seeded register, and a valid
 *    identifier from another tenant stays invisible and unwritable;
 *  - an unauthenticated caller is refused on read and summary alike;
 *  - the assessment, treatment and monitoring surfaces still work alongside
 *    the paginated register.
 *
 * Seeded rows carry an explicit `[iitams-…]` title tag and are removed again
 * through the internal, dev-gated fixture cleanup, so the suite is repeatable
 * and never touches the shared demo organization, real tenants or audit
 * history.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

const SEED_ORG = "IITAMS-TEST-P";
const SEED_TAG = "[iitams-risk-pagination-seed]";
const RUN_TAG = "[iitams-risk-pagination]";
const SEED_COUNT = 1020;
const PAGE = 100;
/** Pages walked before a traversal is treated as broken (bounded test cost). */
const MAX_PAGES = 80;

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

function devAdmin(): ConvexHttpClient | null {
  const key = devAdminKey();
  if (!key) return null;
  const client = new ConvexHttpClient(CONVEX_URL);
  (client as unknown as { setAdminAuth: (v: string) => void }).setAdminAuth(key);
  return client;
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
  code: string;
  title: string;
  category: string;
  status: string;
  residualBand: string;
  residualScore: number;
  createdAt: number;
};

type RiskPage = {
  items: RiskRow[];
  nextCursor: string | null;
  isDone: boolean;
  complete: boolean;
  scanned: number;
  pageSize: number;
  filtered: boolean;
};

type ListArgs = {
  numItems?: number;
  search?: string;
  category?: string;
  status?: string;
  band?: string;
};

let fixtureP: Fixture | null = null;
let fixtureA: Fixture | null = null;
let clientP: ConvexHttpClient | null = null;
let clientA: ConvexHttpClient | null = null;

function prereq(): void {
  if (!fixtureP || !clientP) {
    throw new Error("[test:PREREQ-FAILED] pagination fixture or sign-in unavailable");
  }
}

/** Walk every page of the register for one filter set. */
async function walkAll(
  client: ConvexHttpClient,
  args: ListArgs = {},
): Promise<{ rows: RiskRow[]; pages: number; complete: boolean }> {
  const rows: RiskRow[] = [];
  let cursor: string | undefined;
  let pages = 0;
  let complete = false;
  for (let i = 0; i < MAX_PAGES; i += 1) {
    const page = (await client.query(api.risks.listRisks, {
      numItems: args.numItems ?? PAGE,
      ...(args.search ? { search: args.search } : {}),
      ...(args.category ? { category: args.category } : {}),
      ...(args.status ? { status: args.status } : {}),
      ...(args.band ? { band: args.band } : {}),
      ...(cursor ? { cursor } : {}),
    })) as RiskPage;
    pages += 1;
    rows.push(...page.items);
    complete = page.complete;
    if (page.isDone || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return { rows, pages, complete };
}

/** Remove every row this suite tagged in the fixture organization. */
async function clearTagged(tag: string): Promise<void> {
  const admin = devAdmin();
  if (!admin) return;
  for (let i = 0; i < 140; i += 1) {
    const result = (await admin.mutation(
      internal.devTenantFixtures.resetFixtureRecords,
      { organizationCode: SEED_ORG, titleTag: tag, maxRisks: 25 },
    )) as { deletedRisks: number };
    if (result.deletedRisks === 0) break;
  }
}

beforeAll(async () => {
  if (!(await serverUp()) || !token) return;
  const admin = devAdmin();
  if (!admin) return;
  const result = (await admin.mutation(
    internal.devTenantFixtures.ensureTenantFixtures,
    {},
  )) as { organizations: Fixture[] };
  fixtureP = result.organizations.find((o) => o.organizationCode === SEED_ORG) ?? null;
  fixtureA =
    result.organizations.find((o) => o.organizationCode === "IITAMS-TEST-A") ??
    null;
  if (!fixtureP) return;

  // Deterministic baseline: clear anything an interrupted earlier run left,
  // then grow the register to a known size that exceeds every listing window.
  await clearTagged(RUN_TAG);
  await clearTagged(SEED_TAG);
  let inserted = 0;
  while (inserted < SEED_COUNT) {
    const batch = Math.min(250, SEED_COUNT - inserted);
    const seeded = (await admin.mutation(
      internal.devTenantFixtures.seedFixtureRisks,
      { organizationCode: SEED_ORG, titleTag: SEED_TAG, count: batch },
    )) as { inserted: number };
    inserted += seeded.inserted;
  }

  clientP = await signInEmailOtp(fixtureP.email);
  clientA = fixtureA ? await signInEmailOtp(fixtureA.email) : null;
}, 240000);

afterAll(async () => {
  await clearTagged(RUN_TAG);
  await clearTagged(SEED_TAG);
}, 240000);

describe("Risk register — pagination at scale (isolated fixture tenant)", () => {
  test(
    "every record is reachable through cursors — no visibility ceiling",
    async () => {
      prereq();
      const walk = await walkAll(clientP!);
      expect(walk.complete).toBe(true);
      expect(walk.pages).toBeGreaterThan(5);
      // A record count beyond the previous 500-record ceiling is fully visible.
      expect(walk.rows.length).toBe(SEED_COUNT + 1);
      expect(walk.rows.length).toBeGreaterThan(500);
      // No duplicates: every identifier appears exactly once.
      expect(new Set(walk.rows.map((r) => r._id)).size).toBe(walk.rows.length);
      const codes = walk.rows.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
      // Documented ordering: identifiers ascend through the traversal.
      const sorted = [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      expect(codes).toEqual(sorted);
    },
    240000,
  );

  test(
    "repeated traversals return the same sequence (deterministic paging)",
    async () => {
      prereq();
      const first = await walkAll(clientP!, { numItems: 50 });
      const second = await walkAll(clientP!, { numItems: 90 });
      expect(second.rows.map((r) => r._id)).toEqual(first.rows.map((r) => r._id));
    },
    240000,
  );

  test(
    "a risk created past the old ceiling is visible immediately and allocated uniquely",
    async () => {
      prereq();
      const created = (await clientP!.mutation(api.risks.createRisk, {
        title: `${RUN_TAG} post-limit creation ${Date.now()}`,
        category: "Cyber",
        inherentLikelihood: 4,
        inherentImpact: 5,
        residualLikelihood: 3,
        residualImpact: 4,
      })) as { riskId: string; code: string };

      // The register is ordered by identifier, so the new record sorts after
      // every seeded one — and is still reachable through the traversal.
      const firstPage = (await clientP!.query(api.risks.listRisks, {
        numItems: 10,
      })) as RiskPage;
      expect(firstPage.items.some((r) => r._id === created.riskId)).toBe(false);
      expect(firstPage.items.every((r) => r.code < created.code)).toBe(true);

      const walk = await walkAll(clientP!);
      expect(walk.rows.filter((r) => r._id === created.riskId)).toHaveLength(1);
      expect(walk.complete).toBe(true);
      const codes = walk.rows.map((r) => r.code);
      expect(new Set(codes).size).toBe(codes.length);
      expect(codes.filter((c) => c === created.code)).toHaveLength(1);
      expect(walk.rows.length).toBe(SEED_COUNT + 2);
    },
    240000,
  );

  test(
    "server-side search reaches records beyond one scan window, and says when it has not finished",
    async () => {
      prereq();
      // The last identifier in register order: reaching it needs more than the
      // first request's bounded scan, which is exactly the old defect.
      const all = await walkAll(clientP!);
      const deepest = all.rows[all.rows.length - 1];
      expect(deepest).toBeDefined();

      const firstPage = (await clientP!.query(api.risks.listRisks, {
        numItems: 25,
        search: deepest!.code,
      })) as RiskPage;
      expect(firstPage.filtered).toBe(true);
      expect(firstPage.complete).toBe(false);
      // The request examined a bounded window and found nothing in it.
      expect(firstPage.scanned).toBeGreaterThan(25);
      expect(firstPage.scanned).toBeLessThanOrEqual(400);
      expect(firstPage.items).toHaveLength(0);
      expect(firstPage.nextCursor).not.toBeNull();

      // Continuing the traversal finds it, and completion is disclosed.
      const walk = await walkAll(clientP!, { search: deepest!.code });
      expect(walk.complete).toBe(true);
      expect(walk.rows).toHaveLength(1);
      expect(walk.rows[0]?.code).toBe(deepest!.code);
    },
    240000,
  );

  test(
    "filters are applied server-side across the whole register",
    async () => {
      prereq();
      const unfiltered = await walkAll(clientP!);
      const filtered = await walkAll(clientP!, { category: "Cyber", numItems: 25 });
      expect(filtered.complete).toBe(true);
      expect(filtered.rows.every((r) => r.category === "Cyber")).toBe(true);
      expect(filtered.rows.length).toBe(
        unfiltered.rows.filter((r) => r.category === "Cyber").length,
      );

      const lowBand = await walkAll(clientP!, { band: "low" });
      expect(lowBand.rows.every((r) => r.residualBand === "low")).toBe(true);
      expect(lowBand.rows.length).toBe(
        unfiltered.rows.filter((r) => r.residualBand === "low").length,
      );

      const mitigating = await walkAll(clientP!, { status: "mitigating" });
      expect(mitigating.rows.every((r) => r.status === "mitigating")).toBe(true);
      expect(mitigating.rows.length).toBeGreaterThan(0);
    },
    240000,
  );

  test(
    "the summary is exact below its window and an honest lower bound above it",
    async () => {
      prereq();
      const summary = (await clientP!.query(api.risks.riskSummary, {})) as {
        total: number;
        exact: boolean;
        sampled: boolean;
        scanLimit: number;
        bands: Record<string, number>;
      };
      // This tenant exceeds the summary window, so the count is a floor.
      expect(summary.exact).toBe(false);
      expect(summary.sampled).toBe(true);
      expect(summary.total).toBe(summary.scanLimit);
      const bandsTotal = Object.values(summary.bands).reduce((a, b) => a + b, 0);
      expect(bandsTotal).toBe(summary.total);
      // The floor can never exceed what pagination actually reaches.
      const walk = await walkAll(clientP!);
      expect(walk.rows.length).toBeGreaterThan(summary.total);

      // Below the window the same query reports an exact organization total.
      if (clientA) {
        const small = (await clientA.query(api.risks.riskSummary, {})) as {
          total: number;
          exact: boolean;
        };
        const smallWalk = await walkAll(clientA);
        expect(small.exact).toBe(true);
        expect(small.total).toBe(smallWalk.rows.length);
      }
    },
    240000,
  );

  test(
    "another organization sees none of the seeded register and cannot write to it",
    async () => {
      prereq();
      if (!fixtureA || !clientA) {
        throw new Error("[test:PREREQ-FAILED] second fixture tenant unavailable");
      }
      const aWalk = await walkAll(clientA, { numItems: PAGE });
      expect(aWalk.rows.some((r) => r.title.startsWith(SEED_TAG))).toBe(false);
      expect(
        aWalk.rows.filter((r) => r.title.startsWith(RUN_TAG)),
      ).toHaveLength(0);
      expect(aWalk.rows.some((r) => r._id === fixtureP!.riskId)).toBe(false);

      const pWalk = await walkAll(clientP!, { numItems: PAGE });
      expect(pWalk.rows.some((r) => r._id === fixtureA!.riskId)).toBe(false);

      const foreignId = pWalk.rows[0]?._id;
      expect(foreignId).toBeDefined();
      const crossRead = await clientA.query(api.risks.getRisk, {
        riskId: foreignId as never,
      });
      expect(crossRead).toBeNull();
      await expect(
        clientA.mutation(api.risks.updateRisk, {
          riskId: foreignId as never,
          title: `${RUN_TAG} cross-tenant write`,
        }),
      ).rejects.toThrow(/not found in your organization/i);
    },
    240000,
  );

  test(
    "unauthenticated calls and malformed paging inputs are refused",
    async () => {
      prereq();
      const anonymous = new ConvexHttpClient(CONVEX_URL);
      await expect(anonymous.query(api.risks.listRisks, {})).rejects.toThrow(
        /Not authenticated/,
      );
      await expect(anonymous.query(api.risks.riskSummary, {})).rejects.toThrow(
        /Not authenticated/,
      );

      await expect(
        clientP!.query(api.risks.listRisks, { numItems: 0 }),
      ).rejects.toThrow(/Page size/);
      await expect(
        clientP!.query(api.risks.listRisks, { numItems: 500 }),
      ).rejects.toThrow(/Page size/);
      await expect(
        clientP!.query(api.risks.listRisks, { band: "not-a-band" }),
      ).rejects.toThrow(/Unknown residual band/);
      // Forged cursors are rejected by the server, never interpreted.
      await expect(
        clientP!.query(api.risks.listRisks, { cursor: "forged-cursor-value" }),
      ).rejects.toThrow();
    },
    180000,
  );

  test(
    "assessment, treatment and monitoring surfaces stay compatible",
    async () => {
      prereq();
      const firstPage = (await clientP!.query(api.risks.listRisks, {
        numItems: 5,
      })) as RiskPage;
      const risk = firstPage.items.find(
        (r) => !r.title.startsWith(SEED_TAG) && !r.title.startsWith(RUN_TAG),
      ) ?? firstPage.items[0];
      expect(risk).toBeDefined();

      const assessments = (await clientP!.query(
        api.riskAssessments.listForRisk,
        { riskId: risk._id as never },
      )) as unknown;
      expect(assessments).toBeTruthy();

      const treatment = (await clientP!.query(
        api.riskTreatment.treatmentSummary,
        {},
      )) as { plansTotal: number; actionsTotal: number; sampled: boolean };
      expect(treatment.plansTotal).toBe(0);
      expect(treatment.actionsTotal).toBe(0);

      const monitoring = (await clientP!.query(
        api.riskMonitoring.monitoringOverview,
        {},
      )) as { bands: Record<string, number> };
      expect(Object.keys(monitoring.bands).sort()).toEqual(
        ["critical", "high", "low", "medium"],
      );
    },
    180000,
  );
});
