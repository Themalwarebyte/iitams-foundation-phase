import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 3C Batch 1 — Compliance framework catalogue and control register
 * (browser).
 * =====================================================================
 * Real Chromium journey against /compliance/frameworks and
 * /compliance/controls:
 *   guest sign-in → trusted-runner admin grant (never in the browser) →
 *   add an adopted framework → it appears in the directory with its identifier
 *   → open its record → add a linked control from the control register → the
 *   control appears (with implementation status, never a compliance score) →
 *   the framework/domain filters narrow the register → revoking the grant
 *   turns the same pages read-only (no create/edit controls).
 *
 * Strict via `bun run test:e2e:compliance` or IITAMS_E2E_STRICT=1; soft-skips
 * otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:compliance" ||
  process.argv.some((a) => a.includes("test:e2e:compliance"));
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

describe("IITAMS compliance register (browser)", () => {
  test(
    "administrator records a framework and a linked control; a revoked role sees the same pages read-only",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Framework directory renders with its honest framing.
      await page.goto(`${BASE}/compliance/frameworks`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Framework directory" }), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/does not assert a compliance score/i), 15000),
      ).toBe(true);

      // 3. Add an adopted framework through the dialog.
      const frameworkIdentifier = `E2E-${RUN_ID}`;
      const frameworkName = `Browser framework ${RUN_ID}`;
      await page.getByRole("button", { name: "Add framework" }).click();
      const nameField = page.locator("#framework-name");
      expect(await visible(nameField, 10000)).toBe(true);
      await nameField.fill(frameworkName);
      await page.locator("#framework-identifier").fill(frameworkIdentifier);
      await page.locator("#framework-version").fill("2026.1");
      await page.locator("#framework-authority").fill("Browser test authority");
      await page.getByRole("button", { name: "Create framework" }).click();
      expect(
        await visible(page.getByText(frameworkIdentifier).first(), 20000),
      ).toBe(true);
      expect(await visible(page.getByText(frameworkName).first(), 10000)).toBe(true);

      // 4. Open the framework record: metadata plus the control register.
      await page.getByRole("button", { name: frameworkName }).first().click();
      expect(
        await visible(page.getByText(/Controls in this framework/i), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/Browser test authority/i).first(), 10000),
      ).toBe(true);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);

      // 5. Add a control linked to that framework from the control register.
      await page.goto(`${BASE}/compliance/controls`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Control register" }), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "Add control" }).click();
      expect(await visible(page.locator("#control-identifier"), 10000)).toBe(true);
      await page.locator("#control-framework").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      await page.locator("#control-identifier").fill("A.5.1");
      await page
        .locator("#control-title")
        .fill(`Browser control ${RUN_ID}`);
      await page.locator("#control-domain").click();
      await page.getByRole("option", { name: "Governance" }).click();
      await page.locator("#control-implementation").click();
      await page.getByRole("option", { name: "In progress" }).click();
      await page.getByRole("button", { name: "Create control" }).click();
      expect(
        await visible(page.getByText(`Browser control ${RUN_ID}`).first(), 20000),
      ).toBe(true);
      expect(await visible(page.getByText("In progress").first(), 10000)).toBe(true);
      // The register states implementation, never a fabricated score.
      expect(await visible(page.getByText(/not a test result/i).first(), 10000)).toBe(
        true,
      );

      // 6. The framework filter narrows the register to the linked control.
      await page.locator("#control-framework-filter").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      await page.waitForTimeout(1200);
      expect(
        await visible(page.getByText(`Browser control ${RUN_ID}`).first(), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(`Controls linked to ${frameworkIdentifier}`).first(), 15000),
      ).toBe(true);

      // 7. Revoke the grant: the same pages become read-only for the session.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByRole("heading", { name: "Control register" }), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Add control" }), 2500),
      ).toBe(false);
      expect(
        await visible(page.getByText(`Browser control ${RUN_ID}`).first(), 15000),
      ).toBe(true);

      await page.goto(`${BASE}/compliance/frameworks`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(page.getByRole("heading", { name: "Framework directory" }), 20000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Add framework" }), 2500),
      ).toBe(false);

      // 8. No runtime page errors along the journey.
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    180000,
  );
});
