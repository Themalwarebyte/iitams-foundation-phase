import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
} from "./e2e-harness";

/**
 * Phase 4A Batch 4.2 — Business Continuity: continuity plans (browser).
 * ====================================================================
 * Real Chromium journey with independent demo-organization identities:
 *
 *   preparer: registers a business service, creates a continuity plan against
 *             it, then submits the plan for independent review.
 *   reviewer: separate elevated session → finds the plan by reference and
 *             approves it.
 *   preparer: reopens the approved plan and confirms the version is frozen
 *             (no edit, a revision is offered instead).
 *   viewer:   an un-elevated guest sees the register read-only — no create
 *             control, no review actions.
 *
 * The plan is created without a linked analysis on purpose: the journey also
 * proves that "no approved baseline" is disclosed in the UI rather than
 * implied away.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:bcm-plans" ||
  process.argv.some((a) => a.includes("test:e2e:bcm-plans"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

const RUN_ID = Date.now().toString(36).toUpperCase();

let browser: Browser | null = null;
let serverUp = false;

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

describe("IITAMS continuity plans (browser)", () => {
  test(
    "registers a service, drafts and submits a plan, then an independent reviewer approves it",
    async () => {
      if (!requireEnv()) return;
      const preparer = await elevatedPage();
      const page = preparer.page;
      const serviceName = `Plan journey service ${RUN_ID}`;
      const planTitle = `Plan journey continuity plan ${RUN_ID}`;

      // 1. A service is required before a plan can cover one.
      await page.goto(`${BASE}/bcm/critical-services`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Critical services and processes" }),
          60000,
        ),
      ).toBe(true);
      await page.getByTestId("bcm-service-new").click();
      await visible(page.locator("#svc-name"), 10000);
      await page.locator("#svc-name").fill(serviceName);
      await page
        .locator("#svc-description")
        .fill("Continuity planning journey for citizen payment intake.");
      await page.locator("#svc-dept").fill("Revenue operations");
      await page.locator("#svc-owner").click();
      await page.getByRole("option").first().click();
      await page.locator("#svc-criticality").click();
      await page.getByRole("option", { name: "Critical", exact: true }).click();
      await page
        .locator("#svc-dependencies")
        .fill("Revenue operations staff, payment switch supplier and banking interface.");
      await page.getByRole("button", { name: "Register service" }).last().click();
      expect(await visible(page.getByText(serviceName).first(), 20000)).toBe(true);

      // 2. Create the plan through the register.
      await page.goto(`${BASE}/bcm/plans`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page.getByRole("heading", { name: "Continuity plans" }),
          60000,
        ),
      ).toBe(true);
      await page.getByTestId("bcm-plan-new").click();
      await visible(page.locator("#plan-title"), 10000);
      await page.locator("#plan-title").fill(planTitle);
      await page
        .locator("#plan-purpose")
        .fill(
          "Restore citizen payment intake and statutory settlement within the agreed objectives.",
        );
      await page.locator("#plan-primary-service").click();
      await page
        .getByRole("option")
        .filter({ hasText: serviceName })
        .first()
        .click();
      await page.locator("#plan-owner").click();
      await page.getByRole("option").first().click();
      await page
        .locator("#plan-scenarios")
        .fill(
          "Extended loss of the payment switch, including the nightly reconciliation batch.",
        );
      await page
        .locator("#plan-scope")
        .fill("Citizen payment intake, receipting and nightly reconciliation.");
      await page
        .locator("#plan-exclusions")
        .fill("Counter service at district offices is out of scope.");
      await page
        .locator("#plan-assumptions")
        .fill("The alternate site is available and the supplier honours its support window.");
      await page.getByTestId("bcm-plan-save").click();

      // 3. The new plan opens on its detail page as a draft, with no baseline.
      expect(await visible(page.getByText(planTitle).first(), 20000)).toBe(true);
      expect(await visible(page.getByText(/Draft/).first(), 10000)).toBe(true);
      expect(
        await visible(page.getByText(/No business impact analysis is linked/).first(), 10000),
      ).toBe(true);

      const referenceText =
        (await page.locator("text=/BCP-\\d+/").first().textContent()) ?? "";
      const reference = (referenceText.match(/BCP-\d+/) ?? [""])[0];
      expect(reference).toMatch(/^BCP-\d+$/);

      // 4. Submit for independent review.
      await page.getByTestId("bcm-plan-submit").click();
      expect(
        await visible(page.getByText(/Submitted for review/).first(), 20000),
      ).toBe(true);
      // The preparer is never offered the review actions.
      expect(
        await visible(page.getByTestId("bcm-plan-approve"), 1500),
      ).toBe(false);

      // 5. A separate identity approves the plan.
      const reviewer = await elevatedPage();
      const reviewPage = reviewer.page;
      await reviewPage.goto(`${BASE}/bcm/plans`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          reviewPage.getByRole("heading", { name: "Continuity plans" }),
          60000,
        ),
      ).toBe(true);
      await reviewPage.locator("#audit-search").fill(reference);
      await reviewPage.waitForTimeout(800);
      expect(
        await visible(reviewPage.getByTestId(`bcm-plan-row-${reference}`), 20000),
      ).toBe(true);
      await reviewPage.getByTestId(`bcm-plan-row-${reference}`).click();
      expect(await visible(reviewPage.getByText(planTitle).first(), 20000)).toBe(
        true,
      );
      await reviewPage.getByTestId("bcm-plan-approve").click();
      await visible(reviewPage.locator("#reason-input"), 10000);
      await reviewPage
        .locator("#reason-input")
        .fill(
          "Plan content, scenarios and assumptions are consistent with the recorded scope.",
        );
      await reviewPage.getByTestId("bcm-reason-submit").click();
      expect(
        await visible(reviewPage.getByText(/Approved/).first(), 20000),
      ).toBe(true);
      // Approval freezes the version: no edit, revision offered instead.
      expect(await visible(reviewPage.getByTestId("bcm-plan-revise"), 10000)).toBe(
        true,
      );
      expect(await visible(reviewPage.getByText("Edit plan").first(), 1500)).toBe(
        false,
      );
      expect(reviewer.errors, `reviewer page errors: ${reviewer.errors.join(" | ")}`).toHaveLength(0);

      // 6. The preparer reopens the approved version and sees it frozen.
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await visible(page.getByText(planTitle).first(), 20000)).toBe(true);
      expect(await visible(page.getByText(/Approved/).first(), 20000)).toBe(true);
      expect(await visible(page.getByTestId("bcm-plan-revise"), 10000)).toBe(true);
      expect(await visible(page.getByText("Edit plan").first(), 1500)).toBe(false);

      // 7. An un-elevated guest gets a read-only register.
      const viewer = await newPage();
      expect(await signInAsGuest(viewer.page)).toBe(true);
      await viewer.page.goto(`${BASE}/bcm/plans`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          viewer.page.getByRole("heading", { name: "Continuity plans" }),
          60000,
        ),
      ).toBe(true);
      expect(
        await visible(viewer.page.getByTestId("bcm-plan-new"), 2000),
      ).toBe(false);
      expect(
        viewer.errors,
        `viewer page errors: ${viewer.errors.join(" | ")}`,
      ).toHaveLength(0);

      expect(preparer.errors, `preparer page errors: ${preparer.errors.join(" | ")}`).toHaveLength(0);
      await page.close();
      await reviewPage.close();
      await viewer.page.close();
    },
    150000,
  );
});
