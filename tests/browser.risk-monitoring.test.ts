import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { grantDemoTestRole, revokeAllEscalatedGuests } from "./e2e-harness";

/**
 * Phase 3B Batch 2C — Risk Monitoring (browser).
 * =============================================
 * Real Chromium journey against /risk/monitoring:
 *   guest sign-in → trusted-runner admin grant → monitoring page loads KPI
 *   cards, band distribution, assessment trend and treatment oversight →
 *   a filter narrows the monitored risk list → "Open" deep-links into the
 *   exact Risk Register record (one editable register, no duplicate).
 *
 * Strict via `bun run test:e2e:risk-monitoring` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:risk-monitoring" ||
  process.argv.some((a) => a.includes("test:e2e:risk-monitoring"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

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
  // Launching Chromium is not a 5-second operation on a loaded host: without
  // an explicit budget the suite fails in the hook instead of testing the UI.
}, 60000);

afterAll(async () => {
  await browser?.close();
  await revokeAllEscalatedGuests();
}, 60000);

function requireEnv(): void {
  if (!serverUp) {
    const msg = `dev server unreachable at ${BASE}`;
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
  if (!browser) {
    const msg = "chromium unavailable";
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
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
    await locator.waitFor({ state: "visible", timeout });
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

describe("IITAMS risk monitoring (browser)", () => {
  test(
    "monitoring dashboard shows real organization figures and deep-links to the register",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Monitoring page renders with its KPI strip.
      await page.goto(`${BASE}/risk/monitoring`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Risk Monitoring" }), 20000),
      ).toBe(true);
      for (const label of [
        "Active risks",
        "High & critical",
        "Overdue reassessments",
        "Overdue actions",
        "Completed actions",
        "Awaiting reassessment",
      ]) {
        expect(await visible(page.getByText(label, { exact: true }).first(), 15000)).toBe(
          true,
        );
      }

      // 3. Band distribution and assessment-trend section are present.
      expect(
        await visible(page.getByText("Residual risk by band"), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/Assessment trend/i), 15000),
      ).toBe(true);

      // 4. Filtering narrows the monitored list. High priority may legitimately
      //    be empty in a healthy demo tenant, so accept a real table row or the
      //    explicit "nothing needs attention" empty state.
      const filter = page.getByLabel("Monitoring filter");
      expect(await visible(filter, 15000)).toBe(true);
      await filter.click();
      await page.getByRole("option", { name: "High priority" }).click();
      await page.waitForTimeout(1200);
      const hasRow =
        (await visible(page.locator("tbody tr").first(), 12000)) ||
        (await visible(page.getByText(/Nothing needs attention/i), 8000));
      expect(hasRow).toBe(true);

      // 5. Switch back to all active risks and open the exact register record.
      await filter.click();
      await page.getByRole("option", { name: "All active risks" }).click();
      await page.waitForTimeout(1200);

      const openLink = page.locator('a[href^="/risk/register?risk="]').first();
      expect(await visible(openLink, 15000)).toBe(true);
      await openLink.click();
      await page.waitForURL("**/risk/register?risk=*", { timeout: 20000 });
      expect(await visible(page.getByRole("dialog"), 20000)).toBe(true);
      // The register detail (assessment + treatment sections) is the single
      // editable surface — monitoring itself never duplicates it.
      expect(
        await visible(page.getByText(/Risk assessments/i).first(), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/Treatment plans/i).first(), 15000),
      ).toBe(true);
      expect(page.url()).toContain("/risk/register?risk=");

      // 6. No runtime page errors along the journey.
      expect(errors).toEqual([]);
    },
    180000,
  );
});
