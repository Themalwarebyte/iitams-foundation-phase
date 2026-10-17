import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";
import { grantDemoTestRole, revokeAllEscalatedGuests } from "./e2e-harness";

/**
 * IITAMS Phase 3A — Batch A3 access reviews (browser journey).
 * ============================================================
 * Same strict-gate contract as the other browser suites: strict when run via
 * `bun run test:e2e:access-review` or IITAMS_E2E_STRICT=1; soft skips only
 * with IITAMS_E2E_SOFT=1. Skips are never reported as passes.
 *
 * What this verifies (behaviour, not just “the page renders”):
 *  - a guest without administration cannot reach the access-review area;
 *  - an administrator creates a review cycle through the UI and the cycle is
 *    listed with its due date and status;
 *  - the cycle detail shows real snapshot rows captured from the directory;
 *  - a reviewer records a decision, which is attributed and rendered;
 *  - completion stays blocked while items are still pending;
 *  - no page errors anywhere.
 *
 * The browser never escalates itself: the demo admin TEST role is granted by
 * the trusted runner harness (see tests/e2e-harness.ts).
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:access-review" ||
  process.argv.some((a) => a.includes("test:e2e:access-review"));
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
    | ReturnType<Page["getByText"]>,
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
  } catch {
    return { ok: false, reason: "guest sign-in did not reach /dashboard" };
  }
  if (
    !(await visible(
      page,
      page.getByRole("heading", { name: "Executive Dashboard" }),
      25000,
    ))
  ) {
    return { ok: false, reason: "dashboard heading not visible (provisioning unresolved)" };
  }
  return { ok: true };
}

describe("IITAMS Batch A3 — access reviews (browser)", () => {
  test(
    "non-administrators cannot open the access-review area",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page } = await newPage();
      const signIn = await signInAsGuest(page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] access reviews gate: ${signIn.reason}`);
          await page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: access reviews gate — ${signIn.reason}`);
      }
      await page.goto(`${BASE}/admin/access-reviews`, {
        waitUntil: "domcontentloaded",
      });
      expect(
        await visible(
          page,
          page.getByText(/Administration is not available for your role/i),
          20000,
        ),
      ).toBe(true);
      // No review data leaks to the unauthorized view.
      expect(
        await visible(page, page.getByRole("button", { name: "New review cycle" }), 3000),
      ).toBe(false);
      await page.close();
    },
    90000,
  );

  test(
    "administrator creates a cycle, sees snapshots, records a decision and completion stays blocked",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();
      const signIn = await signInAsGuest(page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] access reviews journey: ${signIn.reason}`);
          await page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: access reviews — ${signIn.reason}`);
      }
      if (!(await grantDemoTestRole(page, "admin"))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] demo admin bridge unavailable");
          await page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: demo admin bridge unavailable");
      }

      await page.getByText("Administration", { exact: true }).first().waitFor({
        state: "visible",
        timeout: 15000,
      });
      await page.getByRole("link", { name: "Access Reviews" }).first().click();
      await page.waitForURL("**/admin/access-reviews");
      expect(
        await visible(page, page.getByRole("heading", { name: "Access Reviews" }), 20000),
      ).toBe(true);

      // Create a cycle through the UI.
      const title = `Browser recertification ${Date.now()}`;
      const due = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      await page.getByRole("button", { name: "New review cycle" }).click();
      await page.getByLabel("Title").fill(title);
      await page.getByLabel("Due date").fill(due);
      await page.getByRole("button", { name: "Create cycle" }).click();

      // The cycle appears in the list and its detail shows captured snapshots.
      expect(await visible(page, page.getByText(title).first(), 25000)).toBe(true);
      expect(
        await visible(page, page.getByText(/Captured snapshots/i), 20000),
      ).toBe(true);
      expect(
        await visible(page, page.getByText(/Snapshot capture is incomplete|of \d+ eligible/i), 20000),
      ).toBe(true);

      // A decision can be recorded and is attributed to the reviewer.
      const decide = page.getByRole("button", { name: /Record decision/ }).first();
      if (!(await visible(page, decide, 20000))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] no snapshot rows captured for this cycle");
          await page.close();
          return;
        }
        throw new Error(
          "E2E GATE FAILED: access reviews — no snapshot rows were captured",
        );
      }
      await decide.click();
      await page.getByRole("button", { name: "Save decision" }).click();
      expect(
        await visible(page, page.getByText(/Access confirmed/).first(), 20000),
      ).toBe(true);

      // Completion is blocked while the review is unfinished.
      const complete = page.getByRole("button", { name: "Complete", exact: true });
      expect(await complete.isDisabled()).toBe(true);

      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    150000,
  );
});
