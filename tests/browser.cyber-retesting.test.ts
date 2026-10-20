import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
} from "./e2e-harness";

/**
 * Phase 4A Batch 2B — security retesting and assurance reporting (browser).
 * ======================================================================
 * Real Chromium journey:
 *   guest sign-in → trusted-runner admin grant → assessment with an authorized
 *   testing scope → a test recorded as failed → a retest planned, started and
 *   completed → the same user is shown "awaiting independent review" and is NOT
 *   offered the independent-review action (self-review refusal) → an assurance
 *   report is drafted and submitted for independent review, and the preparer is
 *   offered neither approval nor finalization (Batch 2B separation of duties).
 *
 * Strict via `bun run test:e2e:cyber-retesting` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:cyber-retesting" ||
  process.argv.some((a) => a.includes("test:e2e:cyber-retesting"));
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

/** Close any open dialogs without guessing how many are stacked. */
async function closeDialogs(page: Page, times = 3) {
  for (let i = 0; i < times; i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
}

describe("IITAMS security retesting (browser)", () => {
  test(
    "retests a failed result and submits the report for independent review",
    async () => {
      if (!requireEnv()) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Assessment → started → authorized scope.
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
      const assessmentTitle = `Browser retest engagement ${RUN_ID}`;
      await page.locator("#cyber-assessment-title").fill(assessmentTitle);
      await page
        .locator("#cyber-assessment-asset")
        .fill("Citizen payment portal");
      await page.getByRole("button", { name: "Plan assessment" }).last().click();
      expect(await visible(page.getByText(assessmentTitle).first(), 20000)).toBe(
        true,
      );

      await page.getByRole("button", { name: "Open" }).first().click();
      const start = page.getByRole("button", { name: "Start assessment" });
      expect(await visible(start, 15000)).toBe(true);
      await start.click();

      const authorize = page.getByRole("button", {
        name: "Authorize testing scope",
      });
      expect(await visible(authorize, 15000)).toBe(true);
      await authorize.click();
      await page
        .locator("#scope-systems")
        .fill("portal.gov.example and api.gov.example");
      await page
        .locator("#scope-exclusions")
        .fill("legacy-billing.gov.example is out of scope for this engagement");
      await page.locator("#scope-methodology").fill("PTES and OWASP WSTG");
      await page
        .locator("#scope-roe")
        .fill("Business hours only; stop on service degradation");
      await page.locator("#scope-authref").fill(`AUTH-${RUN_ID}`);
      await page.locator("#scope-start").fill(isoDate(0));
      await page.locator("#scope-end").fill(isoDate(7));
      await page.getByRole("button", { name: "Authorize scope" }).click();
      expect(await visible(page.getByText(/Authorized/).first(), 20000)).toBe(
        true,
      );

      // 3. A test case recorded as FAILED.
      await page.getByRole("button", { name: "Add test case" }).click();
      await visible(page.locator("#ct-title"), 10000);
      await page.locator("#ct-title").fill(`Browser MFA check ${RUN_ID}`);
      await page.locator("#ct-system").fill("portal.gov.example");
      await page
        .locator("#ct-objective")
        .fill("Determine whether a privileged session requires a second factor");
      await page
        .locator("#ct-procedure")
        .fill(
          "Attempt the documented sign-in flow with a valid password and no second factor, then inspect the session claims",
        );
      await page
        .locator("#ct-expected")
        .fill("A second factor is required for every privileged session");
      await page.locator("#ct-planned").fill(isoDate(0));
      await page.getByRole("button", { name: "Plan test case" }).click();
      expect(
        await visible(page.getByText(/^CT-\d{3,}$/).first(), 20000),
      ).toBe(true);

      await page.getByRole("button", { name: "Open" }).last().click();
      const startTest = page.getByRole("button", { name: "Start test" });
      expect(await visible(startTest, 15000)).toBe(true);
      await startTest.click();
      await page.getByRole("button", { name: "Complete test" }).click();
      await page.locator("#ct-outcome").click();
      await page.getByRole("option", { name: "Fail", exact: true }).click();
      await page
        .locator("#ct-observations")
        .fill(
          "A privileged session was established without a second factor; the expected control did not hold",
        );
      await page.getByRole("button", { name: "Record result" }).click();
      expect(
        await visible(page.getByText(/not a verified vulnerability/i).first(), 20000),
      ).toBe(true);

      // 4. The failed test is eligible: plan the retest from its detail.
      expect(
        await visible(page.getByText(/Eligible for retest/i).first(), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "Plan retest" }).click();
      await visible(page.locator("#rt-reason"), 10000);
      await page
        .locator("#rt-reason")
        .fill("Remediation was claimed for the missing second factor");
      await page.locator("#rt-system").fill("portal.gov.example");
      await page.locator("#rt-scope").fill("Admin console sign-in only");
      await page
        .locator("#rt-procedure")
        .fill(
          "Repeat the original sign-in attempt with a valid password and no second factor, then inspect the session claims",
        );
      await page.getByRole("button", { name: "Plan retest" }).last().click();
      expect(
        await visible(page.getByText(/^RT-\d{3,}$/).first(), 20000),
      ).toBe(true);

      // 5. Start the retest and record a passing result.
      await page.getByRole("button", { name: "Open" }).last().click();
      const startRetest = page.getByRole("button", { name: "Start retest" });
      expect(await visible(startRetest, 15000)).toBe(true);
      await startRetest.click();
      await page.getByRole("button", { name: "Record result" }).click();
      await page.locator("#rt-outcome").click();
      await page.getByRole("option", { name: "Pass", exact: true }).click();
      await page
        .locator("#rt-obs")
        .fill(
          "A second factor was required for every privileged sign-in attempt during the retest",
        );
      await page.getByRole("button", { name: "Record result" }).click();
      expect(
        await visible(
          page.getByText(/Awaiting independent review/i).first(),
          20000,
        ),
      ).toBe(true);
      // The tester is never offered their own independent review.
      expect(
        await page.getByRole("button", { name: "Independent review" }).count(),
      ).toBe(0);
      expect(
        await visible(
          page.getByText(/verifies the retest record only/i).first(),
          10000,
        ),
      ).toBe(true);

      // 6. Close the retest and test dialogs; the assessment detail (which owns
      //    the report section) must stay open.
      await closeDialogs(page, 2);
      const newReport = page.getByRole("button", { name: "New report" });
      expect(await visible(newReport, 20000)).toBe(true);
      await newReport.click();
      await visible(page.locator("#str-conclusions"), 10000);
      await page
        .locator("#str-conclusions")
        .fill(
          "Testing recorded one failed control and one retest awaiting independent review",
        );
      await page
        .locator("#str-recommendations")
        .fill(
          "Independently review the retest before claiming the control is effective",
        );
      await page.getByRole("button", { name: "Create draft" }).click();
      expect(
        await visible(page.getByText(/^STR-\d{3,}$/).first(), 20000),
      ).toBe(true);

      // 7. Submit for independent review. The preparer can neither approve nor
      //    finalize their own report: the review gate is enforced by the backend
      //    and the UI does not offer the actions.
      await page.getByRole("button", { name: "Open" }).last().click();
      const submit = page.getByRole("button", { name: "Submit for review" });
      expect(await visible(submit, 15000)).toBe(true);
      await submit.click();
      expect(
        await visible(page.getByText(/Awaiting independent review/i).first(), 20000),
      ).toBe(true);
      expect(
        await visible(
          page.getByText(/You prepared this report, so you cannot review or approve it/i).first(),
          10000,
        ),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Approve review" }).count(),
      ).toBe(0);
      expect(
        await page.getByRole("button", { name: "Finalize" }).count(),
      ).toBe(0);

      // 8. No runtime crashes during the journey.
      expect(
        errors.filter((e) => !/ResizeObserver|convex.*WebSocket/i.test(e)),
      ).toEqual([]);
    },
    180000,
  );
});
