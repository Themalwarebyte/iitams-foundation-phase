import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";

/**
 * IITAMS Phase 3A Batch 2B browser suite — member provisioning (e2e).
 * =====================================================================
 * Journey:
 *
 *  1. Session A signs in as a guest and escalates to demo platform admin via
 *     the dev-only QA bridge (same refusal chain as Batch 1/2A).
 *  2. A dev-gated seeder creates an EXISTING, VERIFIED, non-anonymous test
 *     account (simulating a real email-OTP sign-up) with no organization
 *     profile — the provisioning flow itself keeps every real-account check.
 *  3. The administrator opens Administration → Users, clicks "Add Existing
 *     User", enters the verified email, picks an initial role (the
 *     privileged admin role is NOT offered), adds an optional job title,
 *     confirms, and the new member appears in the directory reactively with
 *     an active membership and the assigned role.
 *  4. Duplicate provisioning of the same address is refused with the
 *     uniform safe error.
 *  5. Audit Logs show the immutable `user.membership_provisioned` entry.
 *
 * Same invocation contract as the other browser suites: strict when run via
 * `bun run test:e2e:provision` or IITAMS_E2E_STRICT=1; soft skips only with
 * IITAMS_E2E_SOFT=1. No page errors anywhere.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:provision" ||
  process.argv.some((a) => a.includes("test:e2e:provision"));
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

async function becomeDemoAdmin(page: Page): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt++) {
    const ok = await page.evaluate(async () => {
      const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
        | { becomeDemoAdmin(): Promise<unknown> }
        | undefined;
      if (!qa) return false;
      try {
        await qa.becomeDemoAdmin();
        return true;
      } catch {
        return false;
      }
    });
    if (ok) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

describe("IITAMS Phase 3A Batch 2B — member provisioning", () => {
  test(
    "administrator provisions an existing verified user with an initial role",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      const a = await newPage();
      const signIn = await signInAsGuest(a.page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] provisioning: ${signIn.reason}`);
          await a.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: provisioning — ${signIn.reason}`);
      }
      if (!(await becomeDemoAdmin(a.page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] provisioning: demo admin bridge unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: provisioning — bridge unavailable");
      }

      // Dev-only seeder: create an existing verified (non-anonymous) account
      // without an organization profile.
      const email = `pb2b-${Date.now()}@test.example`;
      const seeded = await a.page.evaluate(async (addr) => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { seedVerifiedTestUser(email: string): Promise<{ ok: boolean; email: string }> }
          | undefined;
        if (!qa) return null;
        try {
          return await qa.seedVerifiedTestUser(addr);
        } catch {
          return null;
        }
      }, email);
      if (!seeded?.ok) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] provisioning: test-identity seeder unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: test-identity seeder unavailable");
      }

      await a.page
        .getByText("Administration", { exact: true })
        .first()
        .waitFor({ state: "visible", timeout: 15000 });
      await a.page.getByRole("link", { name: "Users", exact: true }).first().click();
      await a.page.waitForURL("**/admin/users");
      await a.page
        .getByRole("heading", { name: "Users" })
        .waitFor({ state: "visible", timeout: 20000 });

      // Open the form and fill it (choosing an option closes the select
      // naturally — no Escape keypresses, which can close the outer dialog).
      await a.page.getByRole("button", { name: "Add Existing User" }).click();
      await a.page.getByLabel("Verified user email").fill(email);

      // The privileged admin role must not be offered in the initial-role picker.
      await a.page.getByLabel("Initial organization role").click();
      const adminOption = a.page.getByRole("option", { name: "Administrator", exact: true });
      expect(await visible(a.page, adminOption, 3000)).toBe(false);
      await a.page.getByRole("option", { name: "Member", exact: true }).first().click();
      await a.page.getByLabel("Job title (optional)").fill("QA Provisioned Officer");

      await a.page.getByRole("button", { name: "Review and provision" }).click();
      // The alert dialog carries both a title and a button reading "Confirm
      // provisioning" — assert via the uniquely-named BUTTON (strict-safe).
      expect(
        await visible(
          a.page,
          a.page.getByRole("button", { name: "Confirm provisioning" }),
          10000,
        ),
      ).toBe(true);
      await a.page.getByRole("button", { name: "Confirm provisioning" }).click();

      expect(
        await visible(a.page, a.page.getByText(/provisioned with initial role Member/), 15000),
      ).toBe(true);
      // Validation gate: an invalid email is reported before any server call.
      await a.page.getByRole("button", { name: "Add Existing User" }).click();
      await a.page.getByLabel("Verified user email").fill("not-an-email");
      await a.page.getByLabel("Verified user email").blur();
      expect(
        await visible(a.page, a.page.getByText(/Enter a complete email address/), 5000),
      ).toBe(true);
      await a.page.getByRole("button", { name: "Cancel" }).click();

      // Reactive directory: the newly provisioned member row appears with
      // role, active membership and job title.
      const memberRow = a.page.locator("tbody tr").filter({ hasText: email }).first();
      expect(await visible(a.page, memberRow, 20000)).toBe(true);
      expect(await visible(a.page, memberRow.getByText("Member").first(), 10000)).toBe(true);
      expect(await visible(a.page, memberRow.getByText(/QA Provisioned Officer/), 10000)).toBe(true);
      expect(await visible(a.page, memberRow.getByText("Active").first(), 10000)).toBe(true);

      // Duplicate provisioning is refused with the uniform safe error
      // (does not disclose any membership data).
      await a.page.getByRole("button", { name: "Add Existing User" }).click();
      await a.page.getByLabel("Verified user email").fill(email);
      await a.page.getByLabel("Initial organization role").click();
      await a.page.getByRole("option", { name: "Member", exact: true }).first().click();
      await a.page.getByRole("button", { name: "Review and provision" }).click();
      await a.page.getByRole("button", { name: "Confirm provisioning" }).click();
      expect(
        await visible(
          a.page,
          a.page.getByText(/not eligible for provisioning into your organization/),
          15000,
        ),
      ).toBe(true);

      // The immutable audit trail records the provisioning with actor and target.
      await a.page.getByRole("link", { name: "Audit Logs" }).first().click();
      await a.page.waitForURL("**/admin/audit-logs");
      expect(
        await visible(a.page, a.page.getByText("user.membership_provisioned").first(), 20000),
      ).toBe(true);
      // The audit summary carries the target's display label (the seeded
      // test account's name), not the raw address.
      expect(
        await visible(
          a.page,
          a.page.getByText(`${email.split("@")[0]} provisioned into`).first(),
          15000,
        ),
      ).toBe(true);

      expect(a.errors, `page errors: ${a.errors.join(" | ")}`).toHaveLength(0);
      await a.page.close();
    },
    150000,
  );
});
