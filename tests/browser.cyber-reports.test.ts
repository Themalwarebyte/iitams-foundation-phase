import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
} from "./e2e-harness";

/**
 * Phase 4A Batch 3 — Cybersecurity Reporting Hub (browser).
 * =========================================================
 * Real Chromium journey with TWO independent identities (both guests of the
 * demo organization, each elevated by the trusted runner):
 *
 *   preparer: guest → admin grant → assessment with an authorized scope → one
 *             recorded test → draft report → submit for independent review.
 *             The preparer is never offered approval or finalization.
 *   reviewer: separate guest session → admin grant → reports hub → open the
 *             report by its reference → record an independent approval.
 *   preparer: finalize the independently approved report, verify the frozen
 *             snapshot, and download the Word export.
 *
 * Strict via `bun run test:e2e:cyber-reports` or IITAMS_E2E_STRICT=1;
 * soft-skips otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:cyber-reports" ||
  process.argv.some((a) => a.includes("test:e2e:cyber-reports"));
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
    acceptDownloads: true,
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

/** Guest + trusted-runner admin grant, ready for cybersecurity writes. */
async function elevatedPage(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors } = await newPage();
  expect(await signInAsGuest(page)).toBe(true);
  expect(await grantDemoTestRole(page, "admin")).toBe(true);
  await page.waitForTimeout(1500);
  return { page, errors };
}

describe("IITAMS cybersecurity reporting hub (browser)", () => {
  test(
    "lists reports, separates review duties, freezes finalization and exports",
    async () => {
      if (!requireEnv()) return;
      const preparer = await elevatedPage();
      const page = preparer.page;

      // 1. Assessment → authorized scope → one recorded test.
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
      const assessmentTitle = `Browser report engagement ${RUN_ID}`;
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

      await page.getByRole("button", { name: "Add test case" }).click();
      await visible(page.locator("#ct-title"), 10000);
      await page.locator("#ct-title").fill(`Browser TLS check ${RUN_ID}`);
      await page.locator("#ct-system").fill("api.gov.example");
      await page
        .locator("#ct-objective")
        .fill("Confirm the API gateway refuses obsolete TLS versions");
      await page
        .locator("#ct-procedure")
        .fill(
          "Attempt a connection with TLS 1.0 and TLS 1.1 and inspect the negotiated protocol",
        );
      await page
        .locator("#ct-expected")
        .fill("Only TLS 1.2 and above are accepted");
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
      await page.getByRole("option", { name: "Pass", exact: true }).click();
      await page
        .locator("#ct-observations")
        .fill("Only TLS 1.2 and above were accepted during the check");
      await page.getByRole("button", { name: "Record result" }).click();
      expect(
        await visible(page.getByText(/^CT-\d{3,}$/).first(), 20000),
      ).toBe(true);

      // 2. Draft the assurance report from the assessment. Re-open the stored
      //    engagement from the register so the report section is unambiguous.
      await page.goto(`${BASE}/cyber/assessments`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Security assessments" }),
          30000,
        ),
      ).toBe(true);
      const assessmentRow = page
        .getByRole("row")
        .filter({ hasText: assessmentTitle });
      expect(await visible(assessmentRow.first(), 20000)).toBe(true);
      await assessmentRow.getByRole("button", { name: "Open" }).first().click();
      const newReport = page.getByRole("button", { name: "New report" });
      expect(await visible(newReport, 20000)).toBe(true);
      await newReport.click();
      await visible(page.locator("#str-conclusions"), 10000);
      const reportTitle = `Browser assurance report ${RUN_ID}`;
      await page.locator("#str-title").fill(reportTitle);
      await page
        .locator("#str-conclusions")
        .fill(
          "The recorded TLS check passed; no other conclusion is supported by the records",
        );
      await page
        .locator("#str-recommendations")
        .fill("Re-run the configuration check after the next gateway change");
      await page
        .locator("#str-limitations")
        .fill("Testing was limited to the authorized scope");
      await page
        .locator("#str-untested")
        .fill("Denial-of-service behaviour was not tested");
      await page.getByRole("button", { name: "Create draft" }).click();
      expect(
        await visible(page.getByText(/^STR-\d{3,}$/).first(), 20000),
      ).toBe(true);
      const reference = (
        await page.getByText(/^STR-\d{3,}$/).first().innerText()
      ).trim();

      // 3. Reporting hub: search, open the draft, submit for independent review.
      await page.goto(`${BASE}/reports/cybersecurity`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", { name: "Cybersecurity Reports" }),
          60000,
        ),
      ).toBe(true);
      const search = page.getByPlaceholder(
        "Search reference, title or assessment",
      );
      await search.fill(RUN_ID);
      expect(
        await visible(page.getByText(reference).first(), 20000),
      ).toBe(true);
      // Status filter keeps the matching draft visible.
      await page.getByRole("combobox", { name: "Report status" }).click();
      await page.getByRole("option", { name: "Draft" }).click();
      expect(
        await visible(page.getByText(reference).first(), 20000),
      ).toBe(true);
      await page.getByRole("button", { name: "Open" }).first().click();
      const submit = page.getByRole("button", { name: "Submit for review" });
      expect(await visible(submit, 15000)).toBe(true);
      await submit.click();
      expect(
        await visible(page.getByText(/Awaiting independent review/i).first(), 20000),
      ).toBe(true);
      // Separation of duties in the UI: the preparer is offered neither action.
      expect(
        await page.getByRole("button", { name: "Approve review" }).count(),
      ).toBe(0);
      expect(
        await page.getByRole("button", { name: "Finalize" }).count(),
      ).toBe(0);
      expect(
        await visible(
          page.getByText(/You prepared this report, so you cannot review or approve it/i).first(),
          10000,
        ),
      ).toBe(true);

      // 4. A second, independent identity approves the same report.
      const reviewer = await elevatedPage();
      const reviewerPage = reviewer.page;
      await reviewerPage.goto(`${BASE}/reports/cybersecurity`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          reviewerPage.getByRole("heading", { name: "Cybersecurity Reports" }),
          60000,
        ),
      ).toBe(true);
      await reviewerPage
        .getByPlaceholder("Search reference, title or assessment")
        .fill(reference);
      expect(
        await visible(reviewerPage.getByText(reference).first(), 20000),
      ).toBe(true);
      await reviewerPage.getByRole("button", { name: "Open" }).first().click();
      await reviewerPage
        .locator("#report-notes")
        .fill(
          "Checked the recorded test counts and scope against the assessment independently",
        );
      await reviewerPage.getByRole("button", { name: "Approve review" }).click();
      expect(
        await visible(
          reviewerPage.getByText(/Independently approved/i).first(),
          20000,
        ),
      ).toBe(true);

      // 5. The preparer finalizes the approved version; content is frozen.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByPlaceholder("Search reference, title or assessment")
        .fill(reference);
      expect(await visible(page.getByText(reference).first(), 30000)).toBe(true);
      await page.getByRole("button", { name: "Open" }).first().click();
      const finalize = page.getByRole("button", { name: "Finalize" });
      expect(await visible(finalize, 30000)).toBe(true);
      await page
        .locator("#report-notes")
        .fill("Finalizing the independently approved version");
      await finalize.click();
      expect(
        await visible(page.getByText(/frozen snapshot/i).first(), 30000),
      ).toBe(true);

      // 6. Word export uses the frozen snapshot and names the version/state.
      const downloadPromise = page.waitForEvent("download", { timeout: 20000 });
      await page.getByRole("button", { name: "Export Word" }).click();
      const download = await downloadPromise;
      const filename = download.suggestedFilename();
      expect(filename.toUpperCase()).toContain(reference);
      expect(filename.toLowerCase()).toContain("finalized");
      expect(filename).toEndWith(".doc");

      // 7. The report detail links to its assessment, and the deep link opens
      // that assessment rather than a blank register.
      const assessmentLink = page
        .locator('a[href*="/cyber/assessments?assessment="]')
        .first();
      expect(await assessmentLink.count()).toBeGreaterThan(0);
      await assessmentLink.click();
      await page.waitForURL(/\/cyber\/assessments\?assessment=/, {
        timeout: 20000,
      });
      expect(
        await visible(page.getByRole("dialog").filter({ hasText: RUN_ID }), 30000),
      ).toBe(true);

      // 8. No runtime crashes for either identity.
      const blocking = (list: string[]) =>
        list.filter((e) => !/ResizeObserver|convex.*WebSocket/i.test(e));
      expect(blocking(preparer.errors)).toEqual([]);
      expect(blocking(reviewer.errors)).toEqual([]);

      await reviewerPage.context().close();
      await page.context().close();
    },
    240000,
  );
});
