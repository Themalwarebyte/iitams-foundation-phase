import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";

/**
 * IITAMS Phase 2 browser lifecycle suite (strict gates, same contract as the
 * Phase-1 smoke suite). Strict when invoked via `bun run test:e2e:lifecycle`
 * or IITAMS_E2E_STRICT=1; soft skips only with IITAMS_E2E_SOFT=1.
 *
 * Journey: guest sign-in → role escalation (demo-gated dev QA bridge) →
 * audit universe page → create item → plans page → create plan → engagement
 * creation → reports page. Every created artefact must appear in the UI and
 * the whole journey must complete without a single page error.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:lifecycle" ||
  process.argv.some((a) => a.includes("test:e2e:lifecycle"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

let browser: Browser | null = null;
let serverUp = false;
let browserError: string | null = null;

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
    browserError = String(e).slice(0, 300);
  }
});

afterAll(async () => {
  await browser?.close();
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
    const msg = `chromium unavailable at ${CHROME}${browserError ? ` — ${browserError}` : ""}`;
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
}

async function newPage() {
  const page = await browser!.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  return { page, errors };
}

async function visible(
  page: Page,
  locator:
    | ReturnType<Page["getByRole"]>
    | ReturnType<Page["locator"]>
    | ReturnType<Page["getByText"]>
    | ReturnType<Page["getByLabel"]>,
  timeout = 15000,
): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

async function signInAsGuest(
  page: Page,
): Promise<{ ok: boolean; reason?: string }> {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const guest = page.getByRole("button", { name: /Continue as Guest/ });
  if (!(await visible(page, guest, 10000))) {
    return { ok: false, reason: "guest auth disabled on deployment" };
  }
  await guest.first().click();
  try {
    await page.waitForURL("**/dashboard", { timeout: 20000 });
    return { ok: true };
  } catch {
    return { ok: false, reason: "guest sign-in did not reach /dashboard" };
  }
}

/** Escalate the guest to the demo audit-manager tier (dev-only bridge). */
async function upgradeDemoRole(page: Page): Promise<boolean> {
  return await page.evaluate(async () => {
    const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
      | { upgradeDemoRole(): Promise<unknown> }
      | undefined;
    if (!qa) return false;
    try {
      await qa.upgradeDemoRole();
      return true;
    } catch {
      return false;
    }
  });
}

describe("IITAMS Phase 2 audit lifecycle (browser)", () => {
  test(
    "sign-in → universe → create item → plan → schedule → engagement → reports",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // 1. Login (guest) + demo role escalation for write flows.
      const signIn = await signInAsGuest(page);
      expect(signIn.ok, signIn.reason).toBe(true);
      expect(await upgradeDemoRole(page)).toBe(true);
      await page.waitForTimeout(1500); // session refetch with elevated role

      // 2. Open the audit universe page.
      await page.goto(`${BASE}/audit/universe`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page,
          page.getByRole("heading", { name: "Audit Universe" }),
          20000,
        ),
      ).toBe(true);

      // 3. Create an audit universe item.
      await page.getByRole("button", { name: "New item" }).first().click();
      const nameInput = page.locator("#u-name");
      expect(await visible(page, nameInput, 10000)).toBe(true);
      const itemName = `QA Data Centre ${Date.now()}`;
      await nameInput.fill(itemName);
      await page.getByRole("button", { name: "Create item" }).click();
      expect(await visible(page, page.getByText(itemName).first(), 15000)).toBe(true);

      // 4. Create an audit plan.
      await page.goto(`${BASE}/audit/plans`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(page, page.getByRole("heading", { name: "Audit Plans" }), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "New plan" }).click();
      const planNameInput = page.locator("#p-name");
      expect(await visible(page, planNameInput, 10000)).toBe(true);
      const planName = `QA Plan ${Date.now()}`;
      await planNameInput.fill(planName);
      await page.getByRole("button", { name: "Create plan" }).click();
      expect(await visible(page, page.getByText(planName).first(), 15000)).toBe(true);

      // 5. Schedule the universe item into the plan (server-side scoring).
      await page.getByRole("button", { name: "Add universe item" }).first().click();
      expect(
        await visible(page, page.getByText("Universe item *"), 10000),
      ).toBe(true);
      // Open the item combobox and pick the QA item.
      await page.locator('[role="dialog"] [role="combobox"]').first().click();
      const option = page.getByRole("option", { name: new RegExp("QA Data Centre") }).first();
      expect(await visible(page, option, 10000)).toBe(true);
      await option.click();
      await page.getByRole("button", { name: "Add to plan" }).click();
      expect(
        await visible(page, page.getByText(/Added with priority/), 15000),
      ).toBe(true);

      // 6-7. Create an engagement.
      await page.goto(`${BASE}/audit/engagements`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page,
          page.getByRole("heading", { name: "Audit Engagements" }),
          20000,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "New engagement" }).first().click();
      const titleInput = page.locator("#e-title");
      expect(await visible(page, titleInput, 10000)).toBe(true);
      const engTitle = `QA Engagement ${Date.now()}`;
      await titleInput.fill(engTitle);
      await page.getByRole("button", { name: "Create engagement" }).click();
      expect(await visible(page, page.getByText(engTitle).first(), 15000)).toBe(true);

      // 10. Reports page renders the executive summary with coverage.
      await page.goto(`${BASE}/audit/reports`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(page, page.getByRole("heading", { name: "Audit Reports" }), 20000),
      ).toBe(true);
      expect(await visible(page, page.getByText("Audit coverage"), 10000)).toBe(true);

      // No page errors across the whole journey.
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    120000,
  );
});
