import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 3C Batch 2 — control testing and evidence mapping (browser).
 * ================================================================
 * Real Chromium journey against /compliance/controls:
 *   guest sign-in → trusted-runner admin grant → framework + control created
 *   through the register → open the control's test history → plan a test →
 *   start it → upload evidence (server-side hash stamped, "Integrity verified")
 *   → complete the test with an outcome and notes → the completed result is
 *   immutable and is corrected only by a superseding test → revoking the grant
 *   leaves the same history visible with no write controls.
 *
 * Strict via `bun run test:e2e:compliance-testing` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:compliance-testing" ||
  process.argv.some((a) => a.includes("test:e2e:compliance-testing"));
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

describe("IITAMS compliance control testing (browser)", () => {
  test(
    "administrator plans, evidences and completes a control test, corrects it by supersession, and a revoked role stays read-only",
    async () => {
      if (!requireEnv()) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Create a framework and a control through the register UI.
      const frameworkIdentifier = `E2ET-${RUN_ID}`;
      const controlTitle = `Testable control ${RUN_ID}`;
      await page.goto(`${BASE}/compliance/frameworks`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("button", { name: "Add framework" }), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "Add framework" }).click();
      await page.locator("#framework-name").fill(`Testing framework ${RUN_ID}`);
      await page.locator("#framework-identifier").fill(frameworkIdentifier);
      await page.getByRole("button", { name: "Create framework" }).click();
      expect(
        await visible(page.getByText(frameworkIdentifier).first(), 20000),
      ).toBe(true);

      await page.goto(`${BASE}/compliance/controls`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Control register" }), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "Add control" }).click();
      await page.locator("#control-framework").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      await page.locator("#control-identifier").fill("TST.1");
      await page.locator("#control-title").fill(controlTitle);
      await page.getByRole("button", { name: "Create control" }).click();
      expect(await visible(page.getByText(controlTitle).first(), 20000)).toBe(true);

      // Narrow the register so the row under test is unambiguous.
      await page.locator("#control-framework-filter").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      await page.waitForTimeout(1200);

      const controlRow = page.getByRole("row", { name: new RegExp(controlTitle) });
      expect(await visible(controlRow, 15000)).toBe(true);

      // 3. Open the control's test history.
      await controlRow.getByRole("button", { name: /Test history/ }).click();
      expect(
        await visible(page.getByText(/Control testing —/).first(), 15000),
      ).toBe(true);
      expect(await visible(page.getByText(/No control tests yet/i), 15000)).toBe(
        true,
      );

      // 4. Plan a test.
      await page.getByRole("button", { name: "Plan a test" }).first().click();
      expect(await visible(page.locator("#test-title"), 10000)).toBe(true);
      const testTitle = `Provisioning walkthrough ${RUN_ID}`;
      await page.locator("#test-title").fill(testTitle);
      await page
        .locator("#test-objective")
        .fill("Confirm access provisioning follows the documented approval");
      await page
        .locator("#test-procedure")
        .fill("Select 25 access requests from the period and inspect approvals");
      await page.locator("#test-period").fill("2026-Q1");
      await page.getByRole("button", { name: "Plan test" }).last().click();
      expect(await visible(page.getByText(testTitle).first(), 20000)).toBe(true);
      expect(
        await visible(page.getByText(/^CT-\d{3}$/).first(), 10000),
      ).toBe(true);

      // 5. Start it → in progress.
      await page
        .getByRole("row", { name: new RegExp(testTitle) })
        .getByRole("button", { name: "Open" })
        .click();
      expect(
        await visible(page.getByRole("button", { name: "Start test" }), 15000),
      ).toBe(true);
      await page.getByRole("button", { name: "Start test" }).click();
      expect(await visible(page.getByText("In progress").first(), 15000)).toBe(
        true,
      );

      // 6. Upload evidence: the server hashes it and the row says so.
      const evidenceName = `approval-log-${RUN_ID}.txt`;
      await page.locator("#evidence-file").setInputFiles({
        name: evidenceName,
        mimeType: "text/plain",
        buffer: Buffer.from(`approval log excerpt ${RUN_ID}\n`),
      });
      await page.locator("#evidence-description").fill("Approval log excerpt");
      await page.getByRole("button", { name: "Upload and map" }).click();
      expect(await visible(page.getByText(evidenceName), 20000)).toBe(true);
      expect(
        await visible(page.getByText("Integrity verified").first(), 30000),
      ).toBe(true);
      // Metadata is real: a SHA-256 digest is shown for the record.
      expect(
        await visible(page.locator("td.font-mono").filter({ hasText: /^[0-9a-f]{64}$/ }).first(), 20000),
      ).toBe(true);

      // 7. Complete the test with an outcome and notes (evidence is mapped).
      await page.getByRole("button", { name: "Complete test" }).first().click();
      expect(await visible(page.locator("#test-outcome"), 10000)).toBe(true);
      await page.locator("#test-outcome").click();
      await page.getByRole("option", { name: "Effective", exact: true }).click();
      await page
        .locator("#test-completion-notes")
        .fill("Inspected the approval log and confirmed every request was approved");
      await page.getByRole("button", { name: "Complete test" }).last().click();
      expect(await visible(page.getByText("Effective").first(), 20000)).toBe(true);

      // 8. The completed test is immutable and corrected by supersession only.
      expect(
        await visible(page.getByRole("button", { name: "Record superseding test" }), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Start test" }), 1500),
      ).toBe(false);
      await page.getByRole("button", { name: "Record superseding test" }).click();
      expect(await visible(page.locator("#test-amendment-reason"), 10000)).toBe(true);
      await page
        .locator("#test-objective")
        .fill("Re-run the test after the provisioning workflow changed");
      await page
        .locator("#test-procedure")
        .fill("Inspect the updated workflow and a fresh sample of 25 requests");
      await page
        .locator("#test-amendment-reason")
        .fill("The provisioning workflow changed after the first test");
      await page.getByRole("button", { name: "Record superseding test" }).last().click();
      await page.waitForTimeout(1500);
      // Close the detail dialog and inspect the control's history table.
      await page.getByRole("button", { name: "Close" }).last().click();
      expect(
        await visible(page.getByText("Superseded by a later test").first(), 20000),
      ).toBe(true);
      // The original result is still shown, never rewritten.
      expect(await visible(page.getByText("Effective").first(), 15000)).toBe(true);

      // 9. Revoke the grant: history stays readable, write controls disappear.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      const readOnlyRow = page.getByRole("row", { name: new RegExp(controlTitle) });
      expect(await visible(readOnlyRow, 20000)).toBe(true);
      await readOnlyRow.getByRole("button", { name: /Test history/ }).click();
      expect(
        await visible(page.locator("text=" + testTitle).first(), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Plan a test" }), 2500),
      ).toBe(false);
      expect(
        await visible(page.getByRole("button", { name: "Upload and map" }), 1500),
      ).toBe(false);

      // 10. No runtime page errors along the journey.
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    240000,
  );
});
