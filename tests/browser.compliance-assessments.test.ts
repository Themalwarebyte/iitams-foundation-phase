import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 3C Batch 3 — compliance assessments (browser).
 * ===================================================
 * Real Chromium journey against /compliance/assessments:
 *   guest sign-in → trusted-runner admin grant → a framework with two controls
 *   is created through the register → a new assessment cycle is created for
 *   that framework → both controls are assessed with a rationale → the cycle
 *   is completed → the completed cycle is final (no assess controls) and shows
 *   that independent review is still required → revoking the grant leaves the
 *   list readable with no write controls.
 *
 * Strict via `bun run test:e2e:compliance-assessments` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:compliance-assessments" ||
  process.argv.some((a) => a.includes("test:e2e:compliance-assessments"));
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

async function createFrameworkAndControls(
  page: Page,
  frameworkIdentifier: string,
): Promise<void> {
  await page.goto(`${BASE}/compliance/frameworks`, {
    waitUntil: "domcontentloaded",
  });
  expect(
    await visible(page.getByRole("button", { name: "Add framework" }), 20000),
  ).toBe(true);
  await page.getByRole("button", { name: "Add framework" }).click();
  await page.locator("#framework-name").fill(`Assessment framework ${RUN_ID}`);
  await page.locator("#framework-identifier").fill(frameworkIdentifier);
  await page.getByRole("button", { name: "Create framework" }).click();
  expect(await visible(page.getByText(frameworkIdentifier).first(), 20000)).toBe(
    true,
  );

  await page.goto(`${BASE}/compliance/controls`, {
    waitUntil: "domcontentloaded",
  });
  expect(
    await visible(page.getByRole("heading", { name: "Control register" }), 20000),
  ).toBe(true);
  for (const [code, title] of [
    ["A.1", `Assessable alpha ${RUN_ID}`],
    ["A.2", `Assessable beta ${RUN_ID}`],
  ] as const) {
    await page.getByRole("button", { name: "Add control" }).click();
    await page.locator("#control-framework").click();
    await page
      .getByRole("option", { name: new RegExp(frameworkIdentifier) })
      .click();
    await page.locator("#control-identifier").fill(code);
    await page.locator("#control-title").fill(title);
    await page.getByRole("button", { name: "Create control" }).click();
    expect(await visible(page.getByText(title).first(), 20000)).toBe(true);
  }
}

describe("IITAMS compliance assessments (browser)", () => {
  test(
    "administrator creates a cycle, assesses every control, completes it, and a revoked role stays read-only",
    async () => {
      if (!requireEnv()) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Framework with two controls, created through the register UI.
      const frameworkIdentifier = `E2EA-${RUN_ID}`;
      await createFrameworkAndControls(page, frameworkIdentifier);

      // 3. Open the assessments page.
      await page.goto(`${BASE}/compliance/assessments`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Assessments" }), 20000),
      ).toBe(true);
      expect(
        await visible(
          page.locator('[aria-label="Compliance assessment summary"]'),
          15000,
        ),
      ).toBe(true);
      expect(
        await visible(page.getByText(/No overall compliance percentage/i).first(), 10000),
      ).toBe(true);

      // 4. Create a cycle for that framework.
      await page.getByRole("button", { name: "New assessment" }).first().click();
      expect(await visible(page.locator("#assessment-framework"), 10000)).toBe(true);
      await page.locator("#assessment-framework").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      const assessmentTitle = `Browser cycle ${RUN_ID}`;
      await page.locator("#assessment-title").fill(assessmentTitle);
      await page.locator("#assessment-period").fill("2026-Q1");
      await page.getByRole("button", { name: "Create assessment" }).click();
      expect(await visible(page.getByText(assessmentTitle).first(), 20000)).toBe(
        true,
      );
      expect(await visible(page.getByText(/^CA-\d{3}$/).first(), 10000)).toBe(true);

      // 5. Open the cycle: both controls are in scope and not assessed.
      await page.getByRole("button", { name: assessmentTitle }).first().click();
      expect(await visible(page.getByText(/Controls in scope/i).first(), 20000)).toBe(
        true,
      );
      expect(
        await visible(page.getByText(`Assessable alpha ${RUN_ID}`).first(), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(`Assessable beta ${RUN_ID}`).first(), 15000),
      ).toBe(true);

      // 6. Assess the first control as compliant.
      const alphaRow = page.getByRole("row", {
        name: new RegExp(`Assessable alpha ${RUN_ID}`),
      });
      await alphaRow.getByRole("button", { name: "Assess" }).click();
      expect(await visible(page.locator("#item-outcome"), 10000)).toBe(true);
      await page.locator("#item-outcome").click();
      await page.getByRole("option", { name: "Compliant", exact: true }).click();
      await page
        .locator("#item-rationale")
        .fill("Inspected the configuration and the sample; every approval was present");
      await page.getByRole("button", { name: "Record outcome" }).click();
      expect(await visible(page.getByText("Compliant").first(), 20000)).toBe(true);

      // 7. Assess the second control as not applicable.
      const betaRow = page.getByRole("row", {
        name: new RegExp(`Assessable beta ${RUN_ID}`),
      });
      await betaRow.getByRole("button", { name: "Assess" }).click();
      expect(await visible(page.locator("#item-outcome"), 10000)).toBe(true);
      await page.locator("#item-outcome").click();
      await page.getByRole("option", { name: "Not applicable", exact: true }).click();
      await page
        .locator("#item-rationale")
        .fill("This control covers a service the organization does not operate");
      await page.getByRole("button", { name: "Record outcome" }).click();
      expect(await visible(page.getByText("Not applicable").first(), 20000)).toBe(
        true,
      );

      // 8. Complete the cycle (all controls now carry a conclusion).
      await page.getByRole("button", { name: "Complete assessment" }).first().click();
      expect(
        await visible(page.locator("#assessment-completion-notes"), 10000),
      ).toBe(true);
      await page
        .locator("#assessment-completion-notes")
        .fill("Assessed both controls over the Q1 period; no limitations recorded");
      await page.getByRole("button", { name: "Complete assessment" }).last().click();
      expect(await visible(page.getByText("Completed").first(), 20000)).toBe(true);

      // 9. Completed cycles are final and await independent review.
      expect(
        await visible(page.getByText(/Independent review required/i).first(), 15000),
      ).toBe(true);
      expect(
        await visible(
          page.getByRole("button", { name: "Assess", exact: true }),
          2500,
        ),
      ).toBe(false);
      // The assessor cannot review their own cycle (server-enforced; the button
      // is disabled in the UI and the dialog states why).
      const reviewButton = page.getByRole("button", {
        name: "Record review",
        exact: true,
      });
      expect(await visible(reviewButton, 5000)).toBe(true);
      expect(await reviewButton.first().isEnabled()).toBe(false);

      // 10. Revoke the grant: the list stays readable, write controls vanish.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByText(assessmentTitle).first(), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "New assessment" }), 2500),
      ).toBe(false);

      // 11. No runtime page errors along the journey.
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    240000,
  );
});
