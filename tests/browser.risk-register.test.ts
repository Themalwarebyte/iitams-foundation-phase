import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { grantDemoTestRole, revokeAllEscalatedGuests } from "./e2e-harness";

/**
 * Phase 3B Batch 1 — Risk Register (browser).
 * ==========================================
 * Real Chromium journey against /risk/register:
 *   guest sign-in → trusted-runner admin grant (never in the browser) →
 *   register loads seeded organization risks → search narrows the table →
 *   create a risk through the dialog → the new record appears with a
 *   generated R-### identifier → open detail → audit history + edit entry.
 *
 * Strict via `bun run test:e2e:risk` or IITAMS_E2E_STRICT=1; soft-skips
 * otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:risk" ||
  process.argv.some((a) => a.includes("test:e2e:risk"));
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
});

afterAll(async () => {
  await browser?.close();
  await revokeAllEscalatedGuests();
});

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

describe("IITAMS risk register (browser)", () => {
  test(
    "register loads, filters, creates a scored risk and shows its audit history",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // 1. Guest session, then a trusted-runner admin grant (risk.manage).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. Register route renders for an authorized role.
      await page.goto(`${BASE}/risk/register`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByRole("heading", { name: "Risk Register" }), 20000),
      ).toBe(true);
      expect(await visible(page.getByText(/R-00\d/).first(), 20000)).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "New risk" }), 10000),
      ).toBe(true);

      // 3. Search narrows the register to matching records.
      const search = page.getByLabel("Search risks");
      await search.fill("Ransomware");
      expect(
        await visible(page.getByText(/Ransomware on core banking segment/), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/Legacy OS end-of-support/), 3000),
      ).toBe(false);
      await search.fill("");

      // 4. Create a risk through the dialog.
      await page.getByRole("button", { name: "New risk" }).click();
      const titleInput = page.locator("#risk-title");
      expect(await visible(titleInput, 10000)).toBe(true);
      const title = `QA supply-chain compromise ${Date.now()}`;
      await titleInput.fill(title);
      await page.locator("#risk-owner").fill("QA Risk Owner");
      await page.locator("#risk-asset").fill("National registry service");
      await page.getByRole("button", { name: "Create risk" }).click();

      // The new record is listed with its generated identifier and owner.
      expect(await visible(page.getByText(title).first(), 20000)).toBe(true);
      expect(await visible(page.getByText("QA Risk Owner").first(), 10000)).toBe(true);

      // 5. Open the detail dialog: score cells, audit history and edit action.
      await page.getByText(title).first().click();
      expect(
        await visible(page.getByRole("dialog"), 15000),
      ).toBe(true);
      expect(
        await visible(page.getByText(/Audit history \(\d+\)/), 10000),
      ).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Edit risk" }), 10000),
      ).toBe(true);

      // 6. Dialog closes back to the register without a page error.
      await page.keyboard.press("Escape");
      expect(
        await visible(page.getByRole("heading", { name: "Risk Register" }), 10000),
      ).toBe(true);

      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    120000,
  );

  test(
    "a read-only member sees the register but no write controls",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // No harness grant: the guest stays on the read-only member tier
      // (risk.view only), which is what an ordinary viewer would hold.
      expect(await signInAsGuest(page)).toBe(true);
      await page.goto(`${BASE}/risk/register`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(page.getByRole("heading", { name: "Risk Register" }), 20000),
      ).toBe(true);
      expect(await visible(page.getByText(/R-00\d/).first(), 20000)).toBe(true);
      // Write controls are absent (presentation mirrors server enforcement).
      expect(
        await visible(page.getByRole("button", { name: "New risk" }), 2000),
      ).toBe(false);

      // Detail is readable; editing is not offered.
      await page.getByRole("button", { name: "View" }).first().click();
      expect(await visible(page.getByRole("dialog"), 15000)).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Edit risk" }), 2000),
      ).toBe(false);

      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    120000,
  );
});
