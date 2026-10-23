import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeAllEscalatedGuests,
} from "./e2e-harness";

/**
 * Phase 4A Batch 4.1 — Business Continuity: Business Impact Analysis (browser).
 * ===========================================================================
 * Real Chromium journey with two independent guest identities of the demo
 * organization:
 *
 *   preparer: register a business service → create a BIA with impact
 *             judgements and recovery objectives → submit for review. The
 *             preparer is never offered the review action.
 *   reviewer: separate guest session → open the same BIA by search → record an
 *             independent approval.
 *   preparer: reopen the approved BIA, confirm it is frozen and offers a
 *             revision instead of an edit.
 *   viewer:   an un-elevated guest sees the register read-only, with no create
 *             or review controls.
 *
 * Strict via `bun run test:e2e:bcm` or IITAMS_E2E_STRICT=1; soft-skips
 * otherwise, matching the other browser suites.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:bcm" ||
  process.argv.some((a) => a.includes("test:e2e:bcm"));
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

async function elevatedPage(): Promise<{ page: Page; errors: string[] }> {
  const { page, errors } = await newPage();
  expect(await signInAsGuest(page)).toBe(true);
  expect(await grantDemoTestRole(page, "admin")).toBe(true);
  await page.waitForTimeout(1500);
  return { page, errors };
}

const IMPACT_NOTES: Record<string, string> = {
  operational: "Payment intake stops and manual receipting cannot cover volume",
  financial: "Revenue collection is deferred and settlement penalties accrue",
  regulatory: "Statutory settlement reporting deadlines would be missed",
  reputational: "Public payment failures attract media and oversight attention",
  customer: "Citizens cannot complete payments through any digital channel",
};

describe("IITAMS business continuity BIA (browser)", () => {
  test(
    "registers a service, records a BIA, separates review duties and freezes approval",
    async () => {
      if (!requireEnv()) return;
      const preparer = await elevatedPage();
      const page = preparer.page;
      const serviceName = `Browser continuity service ${RUN_ID}`;
      const biaTitle = `Browser BIA ${RUN_ID}`;

      // 1. Register the business service.
      await page.goto(`${BASE}/bcm/critical-services`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page.getByRole("heading", {
            name: "Critical services and processes",
          }),
          60000,
        ),
      ).toBe(true);
      await page.getByTestId("bcm-service-new").click();
      await visible(page.locator("#svc-name"), 10000);
      await page.locator("#svc-name").fill(serviceName);
      await page
        .locator("#svc-description")
        .fill(
          "Citizen payment intake and nightly reconciliation for the revenue service.",
        );
      await page.locator("#svc-dept").fill("Revenue operations");
      await page.locator("#svc-owner").click();
      await page.getByRole("option").first().click();
      await page.locator("#svc-criticality").click();
      await page.getByRole("option", { name: "Critical", exact: true }).click();
      await page
        .locator("#svc-dependencies")
        .fill(
          "Revenue operations staff, the payment switch supplier and the banking interface.",
        );
      await page
        .locator("#svc-ict")
        .fill("Payment switch (vendor-hosted), core banking API");
      await page.getByRole("button", { name: "Register service" }).last().click();
      expect(
        await visible(page.getByText(serviceName).first(), 20000),
      ).toBe(true);

      // 2. Record the business impact analysis.
      await page.goto(`${BASE}/bcm/bia`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page.getByRole("heading", { name: "Business impact analysis" }),
          60000,
        ),
      ).toBe(true);
      await page.getByTestId("bia-new").click();
      await visible(page.locator("#bia-title"), 10000);
      await page.locator("#bia-service").click();
      await page
        .getByRole("option")
        .filter({ hasText: serviceName })
        .first()
        .click();
      await page.locator("#bia-owner").click();
      await page.getByRole("option").first().click();
      await page.locator("#bia-title").fill(biaTitle);
      await page
        .locator("#bia-scenario")
        .fill(
          "Loss of the primary payment switch for an extended period, including the nightly reconciliation batch.",
        );
      await page
        .locator("#bia-scope")
        .fill("Citizen payment intake and nightly reconciliation");
      for (const [category, notes] of Object.entries(IMPACT_NOTES)) {
        await page.locator(`#impact-notes-${category}`).fill(notes);
      }
      await page.locator("#impact-operational").click();
      await page.getByRole("option", { name: "High", exact: true }).click();
      await page
        .locator("#bia-dependencies")
        .fill("Payment switch supplier and the core banking interface");
      await page
        .locator("#bia-spof")
        .fill("The vendor-hosted switch has no active-active pair");
      await page
        .locator("#bia-existing")
        .fill("Nightly database backups and a manual receipting workaround");
      await page
        .locator("#bia-assumptions")
        .fill(
          "Staff can reach the alternate site and the supplier honours its support window.",
        );
      await page
        .locator("#bia-limitations")
        .fill(
          "No recovery exercise has been performed, so these objectives are untested.",
        );
      await page
        .locator("#bia-criticality-rationale")
        .fill(
          "Revenue collection stops and statutory settlement deadlines are missed.",
        );
      await page.locator("#bia-rto").fill("4");
      await page.locator("#bia-rpo").fill("1");
      await page.locator("#bia-mtpd").fill("8");
      await page
        .locator("#bia-minimum")
        .fill(
          "Manual receipting continues for critical payments with daily reconciliation.",
        );
      await page
        .locator("#bia-objective-rationale")
        .fill(
          "The statutory settlement cut-off requires restoration within the same business day.",
        );
      await page.getByTestId("bia-save").click();
      // The register lists one row per analysis; the newly created draft is the
      // only BIA for this run's unique service.
      const savedRow = page.getByRole("row").filter({ hasText: serviceName });
      expect(await visible(savedRow.first(), 20000)).toBe(true);

      // 3. Submit the draft; the preparer is offered no review action.
      await savedRow.first().click();
      expect(
        await visible(page.getByRole("dialog").filter({ hasText: biaTitle }), 15000),
      ).toBe(true);
      const submit = page.getByTestId("bia-submit");
      expect(await visible(submit, 20000)).toBe(true);
      await submit.click();
      expect(
        await visible(page.getByText(/Submitted by/i).first(), 20000),
      ).toBe(true);
      expect(await page.getByTestId("bia-review").count()).toBe(0);

      // 4. A second identity records the independent review.
      const reviewer = await elevatedPage();
      const reviewerPage = reviewer.page;
      await reviewerPage.goto(`${BASE}/bcm/bia`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          reviewerPage.getByRole("heading", { name: "Business impact analysis" }),
          60000,
        ),
      ).toBe(true);
      await reviewerPage
        .getByPlaceholder("Search reference, title, service or reviewer…")
        .fill(serviceName);
      const reviewerRow = reviewerPage
        .getByRole("row")
        .filter({ hasText: serviceName });
      expect(await visible(reviewerRow.first(), 20000)).toBe(true);
      await reviewerRow.first().click();
      const review = reviewerPage.getByTestId("bia-review");
      expect(await visible(review, 20000)).toBe(true);
      await review.click();
      await reviewerPage
        .locator("#review-notes")
        .fill(
          "Impacts, dependencies and objectives are consistent with the recorded scope and assumptions.",
        );
      await reviewerPage.getByRole("button", { name: "Record decision" }).click();
      expect(
        await visible(
          reviewerPage.getByText(/Last review: Approved/i).first(),
          20000,
        ),
      ).toBe(true);

      // 5. The approved analysis is frozen and offers a revision, not an edit.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page
        .getByPlaceholder("Search reference, title, service or reviewer…")
        .fill(serviceName);
      const approvedRow = page.getByRole("row").filter({ hasText: serviceName });
      expect(await visible(approvedRow.first(), 30000)).toBe(true);
      await approvedRow.first().click();
      expect(
        await visible(
          page.getByText(/approved and cannot be edited/i).first(),
          20000,
        ),
      ).toBe(true);
      expect(
        await page.getByRole("button", { name: "Open revision" }).count(),
      ).toBe(1);
      expect(
        await page.getByRole("button", { name: "Edit draft" }).count(),
      ).toBe(0);

      // 6. Recovery objectives summary renders the recorded RTO/RPO.
      await page.goto(`${BASE}/bcm/rto-rpo`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page.getByRole("heading", { name: "Recovery objectives" }),
          60000,
        ),
      ).toBe(true);
      expect(
        await visible(page.getByText("4 hour(s)").first(), 20000),
      ).toBe(true);

      // 7. A viewer without bcm.manage gets a read-only register.
      const viewer = await newPage();
      expect(await signInAsGuest(viewer.page)).toBe(true);
      await viewer.page.goto(`${BASE}/bcm/critical-services`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          viewer.page.getByRole("heading", {
            name: "Critical services and processes",
          }),
          60000,
        ),
      ).toBe(true);
      expect(
        await viewer.page.getByTestId("bcm-service-new").count(),
      ).toBe(0);
      await viewer.page.goto(`${BASE}/bcm/bia`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          viewer.page.getByRole("heading", { name: "Business impact analysis" }),
          60000,
        ),
      ).toBe(true);
      expect(await viewer.page.getByTestId("bia-new").count()).toBe(0);

      const blocking = (list: string[]) =>
        list.filter((e) => !/ResizeObserver|convex.*WebSocket/i.test(e));
      expect(blocking(preparer.errors)).toEqual([]);
      expect(blocking(reviewer.errors)).toEqual([]);
      expect(blocking(viewer.errors)).toEqual([]);

      await viewer.page.context().close();
      await reviewerPage.context().close();
      await page.context().close();
    },
    240000,
  );
});
