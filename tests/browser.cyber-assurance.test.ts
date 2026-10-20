import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 4A Batch 1 — cybersecurity assurance (browser).
 * ====================================================
 * Real Chromium journey against the two new registers:
 *   guest sign-in → trusted-runner admin grant → plan an assessment and start
 *   it → record a vulnerability with a CVSS score and a linked assessment →
 *   confirm it, start remediation and record the fix claim → the same user is
 *   not offered self-verification → revoking the grant leaves both registers
 *   readable with no write controls.
 *
 * Strict via `bun run test:e2e:cyber` or IITAMS_E2E_STRICT=1; soft-skips
 * otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:cyber" ||
  process.argv.some((a) => a.includes("test:e2e:cyber"));
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

describe("IITAMS cybersecurity assurance (browser)", () => {
  test(
    "plans an assessment, records a vulnerability and refuses self-verification",
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
      const assessmentTitle = `Browser assessment ${RUN_ID}`;
      await page.locator("#cyber-assessment-title").fill(assessmentTitle);
      await page
        .locator("#cyber-assessment-asset")
        .fill("Public payment gateway");
      await page.getByRole("button", { name: "Plan assessment" }).last().click();
      expect(await visible(page.getByText(assessmentTitle).first(), 20000)).toBe(
        true,
      );
      expect(await visible(page.getByText(/^CSA-\d{3,}$/).first(), 10000)).toBe(
        true,
      );

      // 3. Start it: the lifecycle is explicit, never inferred.
      await page.getByRole("button", { name: "Open" }).first().click();
      const start = page.getByRole("button", { name: "Start assessment" });
      expect(await visible(start, 15000)).toBe(true);
      await start.click();
      expect(
        await visible(page.getByText("In progress").first(), 15000),
      ).toBe(true);
      await page.keyboard.press("Escape");

      // 4. Record a vulnerability with a real CVSS score.
      await page.goto(`${BASE}/cyber/vulnerabilities`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Vulnerabilities", exact: true }),
          60000,
        ),
      ).toBe(true);
      await page.getByRole("button", { name: "Record vulnerability" }).click();
      const vulnTitle = `Browser vulnerability ${RUN_ID}`;
      await page.locator("#vuln-title").fill(vulnTitle);
      await page.locator("#vuln-asset").fill("api-gateway-01");
      await page.locator("#vuln-cvss").fill("7.5");
      await page.locator("#vuln-cve").fill("CVE-2026-424242");
      await page
        .getByRole("button", { name: "Record vulnerability" })
        .last()
        .click();
      expect(await visible(page.getByText(vulnTitle).first(), 20000)).toBe(true);
      expect(await visible(page.getByText(/^VUL-\d{3,}$/).first(), 10000)).toBe(
        true,
      );
      expect(await visible(page.getByText(/CVSS 7\.5/).first(), 10000)).toBe(
        true,
      );

      // 5. Confirm → start remediation → record the fix claim. Filter to this
      // run's record first: the register is ordered by severity, so a seeded
      // critical row would otherwise be the first one opened.
      await page.getByLabel("Search vulnerabilities").fill(vulnTitle);
      await page.waitForTimeout(800);
      await page.getByRole("button", { name: "Open" }).first().click();
      const confirm = page.getByRole("button", { name: "Confirm" });
      expect(await visible(confirm, 15000)).toBe(true);
      await confirm.click();
      expect(
        await visible(page.getByRole("button", { name: "Start remediation" }), 15000),
      ).toBe(true);
      await page.getByRole("button", { name: "Start remediation" }).click();
      expect(
        await visible(page.getByRole("button", { name: "Record remediation" }), 15000),
      ).toBe(true);
      await page.getByRole("button", { name: "Record remediation" }).click();
      await page
        .locator("#note-dialog-field")
        .fill("Patch applied to the gateway cluster and change record attached");
      await page.getByRole("button", { name: "Record remediation" }).last().click();
      expect(
        await visible(page.getByText(/awaiting verification/i).first(), 15000),
      ).toBe(true);
      // The recorder is told plainly that self-verification is not allowed.
      const verify = page.getByRole("button", { name: "Verify" });
      expect(await visible(verify, 10000)).toBe(true);
      expect(await verify.first().isDisabled()).toBe(true);

      // 6. Revoke the grant: both registers stay readable, writes disappear.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.waitForTimeout(1200);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page.getByRole("heading", { name: "Vulnerabilities", exact: true }),
          60000,
        ),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Record vulnerability" }).count(),
      ).toBe(0);
      expect(await visible(page.getByText(vulnTitle).first(), 15000)).toBe(true);

      // 7. No runtime crashes during the journey.
      expect(errors.filter((e) => !/ResizeObserver|convex.*WebSocket/i.test(e))).toEqual(
        [],
      );
    },
    180000,
  );
});
