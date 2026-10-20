import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 4A Batch 2A — security testing engagements and test cases (browser).
 * ========================================================================
 * Real Chromium journey:
 *   guest sign-in → trusted-runner admin grant → plan an assessment and start
 *   it → authorize the testing scope through the UI → plan a test case →
 *   start it → record observations → record a failed result → the register
 *   states that a failure is not a verified vulnerability → revoking the role
 *   leaves the register readable with no write controls.
 *
 * Strict via `bun run test:e2e:cyber-testing` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:cyber-testing" ||
  process.argv.some((a) => a.includes("test:e2e:cyber-testing"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

const RUN_ID = Date.now().toString(36).toUpperCase();
const DAY = 86_400_000;

function isoDate(offsetDays: number): string {
  return new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
}

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

describe("IITAMS security testing (browser)", () => {
  test(
    "authorizes a scope, executes a test case and records a failed result",
    async () => {
      if (!requireEnv()) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Plan an assessment through the register.
      await page.goto(`${BASE}/cyber/assessments`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Security assessments" }),
          60000,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Plan assessment" }).click();
      expect(await visible(page.locator("#cyber-assessment-title"), 10000)).toBe(
        true,
      );
      const assessmentTitle = `Browser testing engagement ${RUN_ID}`;
      await page.locator("#cyber-assessment-title").fill(assessmentTitle);
      await page
        .locator("#cyber-assessment-asset")
        .fill("Citizen payment portal");
      await page.getByRole("button", { name: "Plan assessment" }).last().click();
      expect(await visible(page.getByText(assessmentTitle).first(), 20000)).toBe(
        true,
      );

      // 3. Start it, then authorize the testing scope.
      await page.getByRole("button", { name: "Open" }).first().click();
      const start = page.getByRole("button", { name: "Start assessment" });
      expect(await visible(start, 15000)).toBe(true);
      await start.click();
      expect(await visible(page.getByText("In progress").first(), 15000)).toBe(
        true,
      );
      // The scope is still a draft: testing is blocked and says so.
      expect(
        await visible(
          page.getByText(/No testing is authorized for this engagement/i).first(),
          15000,
        ),
      ).toBe(true);

      const authorize = page.getByRole("button", {
        name: "Authorize testing scope",
      });
      expect(await visible(authorize, 15000)).toBe(true);
      await authorize.click();
      expect(await visible(page.locator("#scope-systems"), 10000)).toBe(true);
      await page
        .locator("#scope-systems")
        .fill("portal.gov.example and the public API gateway api.gov.example");
      await page
        .locator("#scope-exclusions")
        .fill("No denial-of-service testing against live services");
      await page
        .locator("#scope-methodology")
        .fill("PTES and OWASP WSTG v4.2");
      await page
        .locator("#scope-roe")
        .fill(
          "Testing 08:00-18:00 only; stop on service degradation; escalate to the CISO",
        );
      await page.locator("#scope-authref").fill(`AUTH-${RUN_ID}`);
      await page.locator("#scope-start").fill(isoDate(0));
      await page.locator("#scope-end").fill(isoDate(7));
      await page.getByRole("button", { name: "Authorize scope" }).click();
      expect(
        await visible(page.getByText(/Authorized/).first(), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByText(`AUTH-${RUN_ID}`).first(), 10000),
      ).toBe(true);

      // 4. Plan a test case inside the authorized engagement.
      const testTitle = `Browser MFA check ${RUN_ID}`;
      await page.getByRole("button", { name: "Add test case" }).click();
      expect(await visible(page.locator("#ct-title"), 10000)).toBe(true);
      await page.locator("#ct-title").fill(testTitle);
      await page.locator("#ct-system").fill("portal.gov.example");
      await page
        .locator("#ct-objective")
        .fill(
          "Determine whether a privileged session can be established without a second factor",
        );
      await page
        .locator("#ct-procedure")
        .fill(
          "Attempt the documented login flow with a valid password and no second factor, then inspect the session claims",
        );
      await page
        .locator("#ct-expected")
        .fill("A second factor is required for every privileged session");
      await page.locator("#ct-planned").fill(isoDate(1));
      await page.getByRole("button", { name: "Plan test case" }).click();
      expect(await visible(page.getByText(testTitle).first(), 20000)).toBe(true);
      expect(await visible(page.getByText(/^CT-\d{3,}$/).first(), 10000)).toBe(
        true,
      );

      // 5. Start the test and record observations.
      await page.getByRole("button", { name: "Open" }).last().click();
      const startTest = page.getByRole("button", { name: "Start test" });
      expect(await visible(startTest, 15000)).toBe(true);
      await startTest.click();
      const record = page.getByRole("button", { name: "Record observations" });
      expect(await visible(record, 15000)).toBe(true);
      await record.click();
      await page
        .locator("#ct-obs-note")
        .fill(
          "A privileged session was established with a valid password and no second factor",
        );
      await page.getByRole("button", { name: "Save observations" }).click();
      expect(
        await visible(page.getByText(/no second factor/).first(), 15000),
      ).toBe(true);

      // 6. Record a failed result. A failure is a result, not a vulnerability.
      await page.getByRole("button", { name: "Complete test" }).click();
      expect(await visible(page.locator("#ct-outcome"), 10000)).toBe(true);
      await page.locator("#ct-outcome").click();
      await page.getByRole("option", { name: "Fail", exact: true }).click();
      await page
        .locator("#ct-observations")
        .fill(
          "The privileged session was established without a second factor; the expected control did not hold",
        );
      await page.getByRole("button", { name: "Record result" }).click();
      expect(
        await visible(
          page.getByText(/not a verified vulnerability/i).first(),
          20000,
        ),
      ).toBe(true);
      expect(await visible(page.getByText("Fail", { exact: true }).first(), 10000)).toBe(
        true,
      );

      // 7. Revoking the grant leaves the register readable, without writes.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.waitForTimeout(1200);
      await page.goto(`${BASE}/cyber/assessments`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Security assessments" }),
          60000,
        ),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Plan assessment" }).count(),
      ).toBe(0);

      // 8. No runtime crashes during the journey.
      expect(
        errors.filter((e) => !/ResizeObserver|convex.*WebSocket/i.test(e)),
      ).toEqual([]);
    },
    240000,
  );
});
