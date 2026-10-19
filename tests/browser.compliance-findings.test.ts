import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
  revokeDemoTestRole,
} from "./e2e-harness";

/**
 * Phase 3C Batch 4 — compliance findings and remediation (browser).
 * ================================================================
 * Real Chromium journey against /compliance/findings:
 *   guest sign-in → trusted-runner admin grant → a framework with a control is
 *   created through the register → a finding is recorded with a past target date
 *   (overdue) → a mandatory remediation action is assigned, started and its
 *   implementation completed → the implementer cannot verify their own work →
 *   the finding is submitted for verification → a self-served "verified"
 *   closure is refused → revoking the grant leaves the register readable with no
 *   write controls and no "remediation rate" figure anywhere.
 *
 * Strict via `bun run test:e2e:compliance-findings` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:compliance-findings" ||
  process.argv.some((a) => a.includes("test:e2e:compliance-findings"));
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

async function createFrameworkAndControl(
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
  await page.locator("#framework-name").fill(`Findings framework ${RUN_ID}`);
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
  await page.getByRole("button", { name: "Add control" }).click();
  await page.locator("#control-framework").click();
  await page
    .getByRole("option", { name: new RegExp(frameworkIdentifier) })
    .click();
  await page.locator("#control-identifier").fill("C.1");
  await page.locator("#control-title").fill(`Findable control ${RUN_ID}`);
  await page.getByRole("button", { name: "Create control" }).click();
  expect(
    await visible(page.getByText(`Findable control ${RUN_ID}`).first(), 20000),
  ).toBe(true);
}

describe("IITAMS compliance findings (browser)", () => {
  test(
    "records a finding, tracks remediation, blocks self-verification and stays read-only after revocation",
    async () => {
      if (!requireEnv()) return;
      const { page, errors } = await newPage();

      // 1. Guest session + trusted-runner admin grant (never in the browser).
      expect(await signInAsGuest(page)).toBe(true);
      expect(await grantDemoTestRole(page, "admin")).toBe(true);
      await page.waitForTimeout(1500);

      // 2. A framework with one control, created through the register UI.
      const frameworkIdentifier = `E2EF-${RUN_ID}`;
      await createFrameworkAndControl(page, frameworkIdentifier);

      // 3. The register states it publishes no overall figure. The first visit
      // compiles the lazy route chunk on a memory-constrained dev host, so the
      // initial paint is given a generous budget.
      await page.goto(`${BASE}/compliance/findings`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Findings & remediation" }),
          60000,
        ),
      ).toBe(true);
      expect(
        await visible(
          page.getByText(/No overall remediation rate is calculated/i).first(),
          15000,
        ),
      ).toBe(true);

      // 4. Record a finding with a past target date (overdue).
      await page.getByRole("button", { name: "Record finding" }).first().click();
      expect(await visible(page.locator("#finding-framework"), 10000)).toBe(true);
      await page.locator("#finding-framework").click();
      await page
        .getByRole("option", { name: new RegExp(frameworkIdentifier) })
        .click();
      const findingTitle = `Browser finding ${RUN_ID}`;
      await page.locator("#finding-title").fill(findingTitle);
      await page
        .locator("#finding-description")
        .fill(
          "The periodic review was not performed during the sampled period and no evidence was retained",
        );
      await page.locator("#finding-control").click();
      await page.getByRole("option", { name: /C\.1/ }).click();
      await page.locator("#finding-severity").click();
      await page.getByRole("option", { name: "High", exact: true }).click();
      await page
        .locator("#finding-identified")
        .fill(new Date(Date.now() - 60 * 86_400_000).toISOString().slice(0, 10));
      await page
        .locator("#finding-target")
        .fill(new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10));
      await page.locator("#finding-gap").fill("No review evidence for the quarter");
      await page.getByRole("button", { name: "Record finding" }).last().click();
      expect(await visible(page.getByText(findingTitle).first(), 20000)).toBe(true);
      expect(await visible(page.getByText(/^CF-\d{3}$/).first(), 10000)).toBe(true);
      // The past target date surfaces as overdue on a real record.
      expect(await visible(page.getByText("Overdue").first(), 10000)).toBe(true);
      // Summary counts come from real records (never an undefined hint).
      expect(
        await visible(page.getByText(/^\d+ finding\(s\) recorded$/).first(), 10000),
      ).toBe(true);

      // 5. Open the finding: completion is not verification, and closure is gated.
      await page.getByRole("button", { name: findingTitle }).first().click();
      expect(
        await visible(page.getByText(/Completion is not verification/i).first(), 15000),
      ).toBe(true);
      const submitButton = page.getByRole("button", {
        name: "Submit for verification",
      });
      expect(await visible(submitButton, 10000)).toBe(true);
      expect(await submitButton.first().isDisabled()).toBe(true);
      expect(
        await visible(
          page.getByText(/Record at least one remediation action/i).first(),
          10000,
        ),
      ).toBe(true);

      // 6. Assign a mandatory action that is already past due.
      await page
        .locator("#action-description")
        .fill("Schedule the review and retain the signed evidence");
      await page
        .locator("#action-due")
        .fill(new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10));
      await page.getByRole("button", { name: "Assign action" }).click();
      expect(
        await visible(page.getByText(/RA-\d{3}/).first(), 20000),
      ).toBe(true);
      expect(await visible(page.getByText("Assigned").first(), 10000)).toBe(true);

      // 7. Start it, then record the implementation as complete.
      await page.getByRole("button", { name: "Start", exact: true }).first().click();
      expect(
        await visible(page.getByText("In progress").first(), 15000),
      ).toBe(true);
      await page
        .getByRole("button", { name: "Record completion" })
        .first()
        .click();
      await page
        .locator('textarea[id^="complete-"]')
        .fill("Review scheduled and the signed minutes were filed in the register");
      await page.getByRole("button", { name: "Save completion" }).first().click();
      expect(
        await visible(page.getByText("Implementation complete").first(), 20000),
      ).toBe(true);

      // 8. The implementer cannot verify their own work — the UI says who may.
      expect(
        await visible(
          page
            .getByText(/Verification must be recorded by someone other than/i)
            .first(),
          10000,
        ),
      ).toBe(true);

      // 9. Submit for verification (every mandatory action is complete).
      await submitButton.first().click();
      expect(
        await visible(page.getByText("Awaiting verification").first(), 20000),
      ).toBe(true);

      // 10. A self-served "verified" closure is refused: the UI blocks it and
      // states who may verify (the backend rejects the same attempt — covered
      // by the unit suite).
      await page.locator("#close-method").click();
      await page
        .getByRole("option", { name: "Independently verified", exact: true })
        .click();
      await page
        .locator("#close-notes")
        .fill("Closing the finding myself immediately after implementing the work");
      expect(
        await visible(
          page.getByText(/someone other than the owner or the implementer/i).first(),
          10000,
        ),
      ).toBe(true);
      const closeButton = page.getByRole("button", { name: "Close finding" });
      expect(await closeButton.first().isEnabled()).toBe(false);

      // 11. Revoke the grant: the register stays readable, write controls vanish.
      expect(await revokeDemoTestRole(page)).toBe(true);
      await page.reload({ waitUntil: "domcontentloaded" });
      expect(await visible(page.getByText(findingTitle).first(), 20000)).toBe(true);
      expect(
        await visible(page.getByRole("button", { name: "Record finding" }), 2500),
      ).toBe(false);

      // 12. No runtime page errors along the journey.
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    300000,
  );
});
