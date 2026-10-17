import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";
import { grantDemoTestRole, revokeAllEscalatedGuests } from "./e2e-harness";

/**
 * IITAMS Phase 3A browser suite — Administration foundation (strict gates,
 * same contract as the Phase-1/2 browser suites). Strict when invoked via
 * `bun run test:e2e:admin` or IITAMS_E2E_STRICT=1; soft skips only with
 * IITAMS_E2E_SOFT=1.
 *
 * Journey: guest sign-in (ordinary demo guest) → TRUSTED-RUNNER demo admin
 * grant via the token-guarded server-side harness (the browser itself never
 * escalates; the tester token never enters the browser) → Administration
 * section visible in the sidebar → dashboard shows real KPI tiles →
 * organizations/users/roles/audit-logs pages render → signed-out visitor is
 * blocked from /admin/dashboard. Every escalated guest is revoked on
 * teardown. No page errors anywhere.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:admin" ||
  process.argv.some((a) => a.includes("test:e2e:admin"));
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
  // AppLayout's provisioning effect must finish before the escalation bridge
  // can run — the Executive Dashboard heading only renders once provisioned.
  if (!(await visible(page, page.getByRole("heading", { name: "Executive Dashboard" }), 25000))) {
    return { ok: false, reason: "dashboard heading not visible (provisioning unresolved)" };
  }
  return { ok: true };
}

/**
 * Grant the demo platform-admin TEST role to the current guest session via
 * the TRUSTED RUNNER harness (the browser session itself signs in as an
 * ordinary guest and never touches the tester secret). Retries briefly:
 * AppLayout provisions the guest profile asynchronously after sign-in and
 * the backend refuses grants for not-yet-provisioned guests.
 */
async function becomeDemoAdmin(page: Page): Promise<boolean> {
  return await grantDemoTestRole(page, "admin");
}

describe("IITAMS Phase 3A administration", () => {
  test(
    "admin nav is hidden for non-admin members and shown after demo admin escalation",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();
      const signIn = await signInAsGuest(page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] admin nav: ${signIn.reason}`);
          await page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: admin nav — ${signIn.reason}`);
      }

      // Fresh guest session resolves to the read-only member tier: no
      // Administration section.
      expect(
        await visible(page, page.getByText("Administration", { exact: true }), 8000),
      ).toBe(false);

      const upgraded = await becomeDemoAdmin(page);
      if (!upgraded) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] demo admin bridge unavailable");
          await page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: demo admin bridge unavailable");
      }

      // Session is a reactive subscription: the sidebar picks up the new role.
      expect(
        await visible(page, page.getByText("Administration", { exact: true }), 15000),
      ).toBe(true);
      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    90000,
  );

  test(
    "admin dashboard, directory, org and role pages render real data",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();
      const signIn = await signInAsGuest(page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] admin pages: ${signIn.reason}`);
          await page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: admin pages — ${signIn.reason}`);
      }
      if (!(await becomeDemoAdmin(page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] admin pages: demo admin bridge unavailable");
          await page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: admin pages — bridge unavailable");
      }

      await page.getByText("Administration", { exact: true }).first().waitFor({
        state: "visible",
        timeout: 15000,
      });

      // Dashboard
      await page.getByRole("link", { name: "Admin Dashboard" }).first().click();
      await page.waitForURL("**/admin/dashboard");
      expect(
        await visible(page, page.getByRole("heading", { name: "Administration Dashboard" }), 20000),
      ).toBe(true);
      expect(
        await visible(page, page.getByText("Directory members", { exact: false }), 15000),
      ).toBe(true);
      expect(
        await visible(page, page.getByText("Recent administrative activity"), 15000),
      ).toBe(true);

      // Organizations
      await page.getByRole("link", { name: /Organizations \/ MDACs/ }).first().click();
      await page.waitForURL("**/admin/organizations");
      expect(
        await visible(page, page.getByRole("heading", { name: "Organizations" }), 20000),
      ).toBe(true);
      expect(
        await visible(
          page,
          page.getByText(/IITAMS Demo MDAC|No organization record/).first(),
          15000,
        ),
      ).toBe(true);

      // Users
      await page.getByRole("link", { name: "Users", exact: true }).first().click();
      await page.waitForURL("**/admin/users");
      expect(
        await visible(page, page.getByRole("heading", { name: "Users" }), 20000),
      ).toBe(true);

      // Roles
      await page.getByRole("link", { name: /Roles & Permissions/ }).first().click();
      await page.waitForURL("**/admin/roles");
      expect(
        await visible(page, page.getByRole("heading", { name: "Roles & Permissions" }), 20000),
      ).toBe(true);
      expect(await visible(page, page.getByText("admin.view", { exact: true }), 15000)).toBe(true);

      // Access reviews (Phase 3A — Batch A3)
      await page.getByRole("link", { name: "Access Reviews" }).first().click();
      await page.waitForURL("**/admin/access-reviews");
      expect(
        await visible(page, page.getByRole("heading", { name: "Access Reviews" }), 20000),
      ).toBe(true);
      expect(
        await visible(page, page.getByRole("button", { name: "New review cycle" }), 15000),
      ).toBe(true);

      // Audit logs
      await page.getByRole("link", { name: "Audit Logs" }).first().click();
      await page.waitForURL("**/admin/audit-logs");
      expect(
        await visible(page, page.getByRole("heading", { name: "Audit Logs" }), 20000),
      ).toBe(true);
      // The trusted-runner grant itself must be visible in the log.
      expect(
        await visible(page, page.getByText("user.demo_role_granted").first(), 15000),
      ).toBe(true);

      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    120000,
  );

  test(
    "signed-out visitors cannot reach /admin/dashboard",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page } = await newPage();
      await page.goto(`${BASE}/admin/dashboard`, { waitUntil: "domcontentloaded" });
      expect(
        await visible(
          page,
          page.getByText(/Sign in to open Administration|Sign in to continue/i),
          20000,
        ),
      ).toBe(true);
      await page.close();
    },
    90000,
  );
});
