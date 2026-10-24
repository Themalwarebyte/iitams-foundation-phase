import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { ConvexHttpClient } from "convex/browser";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { api } from "../src/convex/_generated/api";
import type { Id } from "../src/convex/_generated/dataModel";
import {
  BCM_IMPACT_CATEGORIES,
  type BcmImpacts,
} from "../src/lib/bcm";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
} from "./e2e-harness";

/**
 * Phase 4A Batch 4.3 — Business Continuity: recovery exercises (browser).
 * =====================================================================
 * Real Chromium journey. Prerequisites (an approved plan with a strategy) are
 * seeded through the trusted development harness so the journey stays focused
 * on the exercise workflow itself:
 *
 *   preparer: plans an exercise in the UI, schedules and starts it, records a
 *             performed activity, a measured RTO, strategy coverage and a low
 *             finding, completes and submits it.
 *   reviewer: a separate elevated identity opens the same exercise, accepts it
 *             after an independent review.
 *   preparer: reloads and confirms the reviewed status and the derived
 *             exercise-verified capability label.
 *
 * The exercise is a tabletop: nothing is executed, failed over or restored.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS = process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:bcm-exercises" ||
  process.argv.some((a) => a.includes("test:e2e:bcm-exercises"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

const RUN_ID = Date.now().toString(36).toUpperCase();
const DAY = 24 * 60 * 60 * 1000;

let browser: Browser | null = null;
let serverUp = false;

function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    return "";
  }
}

function sampleImpacts(): BcmImpacts {
  return Object.fromEntries(
    BCM_IMPACT_CATEGORIES.map((category) => [
      category,
      { severity: "high", notes: `${category} impact rationale for the browser suite` },
    ]),
  ) as BcmImpacts;
}

/** A guest session elevated to the demo administrator role through the harness. */
async function seededClient(): Promise<ConvexHttpClient | null> {
  const token = testerToken();
  if (!token) return null;
  const client = new ConvexHttpClient(CONVEX_URL);
  const result = (await (client as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (!jwt) return null;
  (client as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
  await client.mutation(api.session.joinDemoOrganization, {});
  const session = (await client.query(api.session.getSession, {})) as {
    userId?: string;
  };
  if (!session.userId) return null;
  const res = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId: session.userId, role: "admin", ttlMinutes: 60 }),
  });
  if (!res.ok) return null;
  return client;
}

async function seedApprovedPlan(): Promise<{
  planReference: string;
  planTitle: string;
} | null> {
  const preparer = await seededClient();
  const reviewer = await seededClient();
  if (!preparer || !reviewer) return null;
  const preparerSession = (await preparer.query(api.session.getSession, {})) as {
    userId: string;
  };
  const reviewerSession = (await reviewer.query(api.session.getSession, {})) as {
    userId: string;
  };
  const ownerId = preparerSession.userId as Id<"users">;
  const reviewerId = reviewerSession.userId as Id<"users">;

  const service = (await preparer.mutation(api.businessServices.createService, {
    name: `Exercise journey service ${RUN_ID}`,
    description: "Citizen payment intake used by the recovery exercise journey.",
    department: "Revenue operations",
    ownerUserId: ownerId,
    operationalStatus: "active",
    criticality: "critical",
    ictDependencies: "Payment switch, core banking API and reconciliation scheduler.",
    keyDependencies:
      "Revenue operations staff, payment switch supplier and the banking interface.",
    singlePointsOfFailure: "Single vendor-hosted payment switch instance",
  })) as { serviceId: Id<"businessServices"> };

  const bia = (await preparer.mutation(api.businessImpactAnalyses.createBia, {
    serviceId: service.serviceId,
    title: `Exercise journey baseline ${RUN_ID}`,
    ownerUserId: reviewerId,
    assessmentDate: Date.now() - 2 * DAY,
    reviewDueAt: Date.now() + 180 * DAY,
    disruptionScenario:
      "The primary payment switch is unavailable during the settlement window.",
    scope: "Citizen payment intake and the nightly reconciliation feed",
    impacts: sampleImpacts(),
    keyDependencies: "Payment switch supplier and the core banking interface",
    singlePointsOfFailure: "Vendor-hosted switch has no active-active pair",
    existingRecoveryArrangements: "Nightly backups and a manual receipting workaround.",
    assumptions: "Staff can reach the alternate site.",
    limitations: "No recovery exercise has been performed.",
    criticalityRationale: "Revenue collection stops and statutory deadlines are missed.",
    rtoMinutes: 240,
    rpoMinutes: 60,
    mtpdMinutes: 480,
    minimumServiceLevel:
      "Manual receipting continues for critical payments with daily reconciliation.",
    recoveryPriority: "p1",
    objectiveRationale:
      "Statutory settlement cut-off requires restoration within the same business day.",
  })) as { biaId: Id<"businessImpactAnalyses"> };
  await preparer.mutation(api.businessImpactAnalyses.submitBia, { biaId: bia.biaId });
  await reviewer.mutation(api.businessImpactAnalyses.reviewBia, {
    biaId: bia.biaId,
    decision: "approved",
    reviewNotes:
      "Impacts, dependencies and recovery objectives are consistent with the recorded scope.",
  });

  const planTitle = `Exercise journey plan ${RUN_ID}`;
  const plan = (await preparer.mutation(api.continuityPlans.createPlan, {
    title: planTitle,
    purpose:
      "Restore revenue collection for citizens and statutory settlement within the agreed objectives.",
    primaryServiceId: service.serviceId,
    additionalServiceIds: [],
    ownerUserId: reviewerId,
    biaId: bia.biaId,
    disruptionScenarios:
      "Extended loss of the payment switch, including the nightly reconciliation batch.",
    recoveryPriority: "p1",
    scope: "Citizen payment intake, receipting and the nightly reconciliation feed.",
    exclusions: "Counter service at district offices is out of scope for this plan.",
    assumptions: "The alternate site is available and the supplier honours its window.",
    reviewDueAt: Date.now() + 180 * DAY,
  })) as { planId: Id<"continuityPlans">; reference: string };

  await preparer.mutation(api.continuityPlans.createStrategy, {
    planId: plan.planId,
    title: `Exercise journey standby switch ${RUN_ID}`,
    objective: "Restore citizen payment intake on the standby switch.",
    disruptionScenario: "Primary payment switch unavailable for more than four hours.",
    recoveryApproach:
      "Fail over to the warm standby switch and re-point the reconciliation batch.",
    personnelRequirements: "Two payment operations engineers and one finance reconciler.",
    minimumServiceLevel:
      "Critical payments continue within the minimum service level agreed in the analysis.",
    expectedRecoveryMinutes: 300,
    targetRtoMinutes: 240,
    targetRpoMinutes: 60,
    targetMtpdMinutes: 480,
    capabilityEvidence: "estimate",
    capabilityRationale:
      "Based on the supplier's documented failover procedure; never exercised here.",
    ownerUserId: reviewerId,
    statusRationale: "Proposed by the plan owner; adoption is a separate decision.",
  });

  await preparer.mutation(api.continuityPlans.submitPlan, { planId: plan.planId });
  await reviewer.mutation(api.continuityPlans.reviewPlan, {
    planId: plan.planId,
    decision: "approved",
    reviewNotes:
      "Plan, strategy and baseline are complete and consistent with the approved analysis.",
  });

  return { planReference: plan.reference, planTitle };
}

beforeAll(async () => {
  try {
    const res = await fetch(BASE);
    serverUp = res.ok;
  } catch {
    serverUp = false;
  }
  if (!serverUp) return;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: CHROME,
      args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
    });
  } catch (e) {
    browser = null;
    console.warn(`[e2e:WARN] chromium launch failed: ${String(e).slice(0, 200)}`);
  }
}, 60000);

afterAll(async () => {
  await browser?.close();
  await revokeAllEscalatedGuests();
}, 60000);

function requireEnv(): boolean {
  if (!serverUp) {
    const msg = `dev server unreachable at ${BASE}`;
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return false;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
  if (!browser) {
    const msg = "chromium unavailable";
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return false;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
  return true;
}

async function newPage() {
  if (!browser) throw new Error("browser unavailable");
  const ctx = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 900 },
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  return { page, errors };
}

async function visible(
  locator: ReturnType<Page["locator"]>,
  timeout = 15000,
): Promise<boolean> {
  try {
    await locator.first().waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function signInAsGuest(page: Page): Promise<boolean> {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const guest = page.getByRole("button", { name: /Continue as Guest/ });
  if (!(await visible(guest, 10000))) return false;
  await guest.first().click();
  try {
    await page.waitForURL("**/dashboard", { timeout: 20000 });
    return true;
  } catch {
    return false;
  }
}

async function elevatedPage(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors } = await newPage();
  expect(await signInAsGuest(page)).toBe(true);
  expect(await grantDemoTestRole(page, "admin")).toBe(true);
  await page.waitForTimeout(1500);
  return { page, errors };
}

describe("IITAMS recovery exercises (browser)", () => {
  test(
    "plans, executes, completes and independently reviews a tabletop exercise",
    async () => {
      if (!requireEnv()) return;
      const seeded = await seedApprovedPlan();
      if (!seeded) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] trusted harness unavailable for prerequisites");
          return;
        }
        throw new Error("E2E GATE FAILED: prerequisites could not be seeded");
      }

      const preparer = await elevatedPage();
      const page = preparer.page;
      const title = `Tabletop exercise journey ${RUN_ID}`;

      // 1. The exercise register is a real page, not a placeholder.
      await page.goto(`${BASE}/bcm/dr-tests`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByRole("heading", { name: "Recovery exercises" }), 60000),
      ).toBe(true);

      // 2. Plan the exercise against the approved plan version.
      await page.getByTestId("bcm-exercise-new").click();
      await visible(page.getByTestId("bcm-exercise-title"), 10000);
      await page.getByTestId("bcm-exercise-title").fill(title);
      await page.getByTestId("bcm-exercise-plan").click();
      await page
        .getByRole("option")
        .filter({ hasText: seeded.planReference })
        .first()
        .click();
      await page
        .getByTestId("bcm-exercise-objectives")
        .fill(
          "Establish whether the documented recovery steps restore citizen payment intake.",
        );
      await page
        .getByTestId("bcm-exercise-scope")
        .fill("Payment intake, receipting and the reconciliation batch during an outage.");
      await page
        .getByTestId("bcm-exercise-exclusions")
        .fill("District counter service and supplier internal operations are excluded.");
      await page
        .getByTestId("bcm-exercise-scenario")
        .fill(
          "The primary payment switch is unavailable for six hours during settlement.",
        );
      await page
        .getByTestId("bcm-exercise-methodology")
        .fill("Discussion-based walkthrough of each recovery step against the plan.");
      await page
        .getByTestId("bcm-exercise-resources")
        .fill("Continuity plan, supplier failover procedure and two operations engineers.");
      await page
        .getByTestId("bcm-exercise-constraints")
        .fill("No infrastructure is touched: this tabletop has no system access at all.");
      await page.getByTestId("bcm-exercise-save").click();

      // 3. The detail page opens on the new exercise.
      await page.waitForURL(/\/bcm\/dr-tests\/[a-z0-9]+$/i, { timeout: 30000 });
      const exerciseUrl = page.url();
      expect(await visible(page.getByRole("heading", { name: title }), 30000)).toBe(
        true,
      );

      // 4. Schedule and start it (recording only — nothing is executed).
      await page.getByTestId("bcm-exercise-schedule").click();
      expect(await visible(page.getByText("Scheduled").first(), 20000)).toBe(true);
      await page.getByTestId("bcm-exercise-start").click();
      expect(await visible(page.getByText("In progress").first(), 20000)).toBe(true);

      // 5. Record a reported activity.
      await page.getByRole("button", { name: "Add activity" }).click();
      await visible(page.getByTestId("bcm-activity-planned"), 10000);
      await page
        .getByTestId("bcm-activity-planned")
        .fill("Notify the payment operations duty engineer.");
      await page
        .getByTestId("bcm-activity-expected")
        .fill("The duty engineer acknowledges within fifteen minutes and opens the bridge.");
      await page.getByTestId("bcm-activity-performed").click();
      await page
        .getByTestId("bcm-activity-observation")
        .fill("The duty engineer acknowledged after eight minutes and opened the bridge.");
      await page.getByTestId("bcm-activity-save").click();
      expect(await visible(page.getByText("Reported performed"), 20000)).toBe(true);

      // 6. Record a measured RTO that missed the approved objective.
      await page.getByTestId("bcm-measurement-new").click();
      await visible(page.getByTestId("bcm-measurement-minutes"), 10000);
      await page.getByTestId("bcm-measurement-minutes").fill("300");
      await page
        .getByTestId("bcm-measurement-observed")
        .fill("Payment intake restored on the standby switch.");
      await page.getByTestId("bcm-measurement-outcome").click();
      await page
        .getByRole("option", { name: /Objective missed/ })
        .first()
        .click();
      await page
        .getByTestId("bcm-measurement-justification")
        .fill("Restoration took 300 minutes against an approved objective of 240 minutes.");
      await page.getByTestId("bcm-measurement-evidence").fill("Exercise log page 4");
      await page
        .getByTestId("bcm-measurement-limitations")
        .fill("The supplier failover step was simulated by the facilitator.");
      await page.getByTestId("bcm-measurement-save").click();
      expect(
        await visible(page.getByText("Objective missed — record a finding"), 20000),
      ).toBe(true);

      // 7. Record strategy coverage: capability is still an estimate.
      await page.getByTestId("bcm-coverage-new").click();
      await visible(page.getByTestId("bcm-coverage-steps"), 10000);
      await page
        .getByTestId("bcm-coverage-steps")
        .fill(
          "Failover to the standby switch, re-point the reconciliation batch and confirm receipting.",
        );
      await page.getByTestId("bcm-coverage-performed").click();
      await page
        .getByTestId("bcm-coverage-observation")
        .fill("The steps were walked in order; the supplier failover step was read aloud.");
      await page.getByTestId("bcm-coverage-save").click();
      expect(await visible(page.getByText("Estimate — not verified"), 20000)).toBe(true);

      // 8. Raise a low finding (high findings block verified capability).
      await page.getByTestId("bcm-finding-new").click();
      await visible(page.getByTestId("bcm-finding-description"), 10000);
      await page
        .getByTestId("bcm-finding-description")
        .fill("The exercise pack referenced an out-of-date contact list for the supplier.");
      await page.getByTestId("bcm-finding-severity").click();
      await page.getByRole("option", { name: "Low", exact: true }).first().click();
      await page
        .getByTestId("bcm-finding-action")
        .fill("Refresh the supplier contact list and re-circulate the exercise pack.");
      await page.getByTestId("bcm-finding-save").click();
      expect(await visible(page.getByText(/^EXF-\d+/), 20000)).toBe(true);

      // 9. Complete and submit for independent review.
      await page.getByTestId("bcm-exercise-complete").click();
      await visible(page.getByTestId("bcm-exercise-outcome"), 10000);
      await page
        .getByTestId("bcm-exercise-outcome")
        .fill("The walkthrough restored payment intake, 60 minutes beyond the objective.");
      await page
        .getByTestId("bcm-exercise-justification")
        .fill("The observed RTO of 300 minutes exceeds the approved 240-minute objective.");
      await page.getByTestId("bcm-exercise-complete-confirm").click();
      expect(
        await visible(page.getByText("Completed — awaiting review").first(), 20000),
      ).toBe(true);
      await page.getByTestId("bcm-exercise-submit").click();
      expect(
        await visible(page.getByText("Submitted for review").first(), 20000),
      ).toBe(true);

      // 10. An independent reviewer accepts the results.
      const reviewer = await elevatedPage();
      await reviewer.page.goto(exerciseUrl, { waitUntil: "domcontentloaded" });
      expect(
        await visible(reviewer.page.getByTestId("bcm-exercise-approve"), 60000),
      ).toBe(true);
      await reviewer.page.getByTestId("bcm-exercise-approve").click();
      const dialog = reviewer.page.getByRole("dialog");
      await dialog.locator("textarea").fill(
        "Activities, measurement and finding are consistent with the evidence supplied.",
      );
      await reviewer.page.getByTestId("bcm-exercise-note-submit").click();
      expect(
        await visible(
          reviewer.page.getByText("Reviewed / accepted").first(),
          20000,
        ),
      ).toBe(true);

      // 11. The preparer sees the reviewed record and the derived capability.
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByText("Reviewed / accepted").first(), 30000),
      ).toBe(true);
      expect(await visible(page.getByText("Exercise-verified").first(), 30000)).toBe(
        true,
      );

      expect(
        preparer.errors,
        `preparer page errors: ${preparer.errors.join(" | ")}`,
      ).toHaveLength(0);
      expect(
        reviewer.errors,
        `reviewer page errors: ${reviewer.errors.join(" | ")}`,
      ).toHaveLength(0);

      await page.close();
      await reviewer.page.close();
    },
    180000,
  );
});
