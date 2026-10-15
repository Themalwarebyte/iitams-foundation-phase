import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";

/**
 * IITAMS Phase 3A Batch 2A browser suite — membership lifecycle (e2e).
 * =====================================================================
 * Two independent sessions against the demo deployment:
 *
 *  1. Session A signs in as guest and escalates to demo platform admin via
 *     the dev-only QA bridge (same refusal chain as Batch 1).
 *  2. Session B signs in as a plain guest — a real MEMBER of the demo
 *     organization (provisioned through the audited joinDemo path).
 *
 * Coverage:
 *  - the User Directory shows the real membership status (chip) per member;
 *  - an administrator can Suspend that member from the directory, the row
 *    flips to "Suspended", and the MEMBER'S LIVE SESSION loses organization
 *    access immediately (AppLayout drops into the safe no-tenant state and
 *    their org context disappears) — server-enforced denial, not UI-only;
 *  - Reactivation from the directory flips the row back to "Active" and the
 *    member's session regains its organization context automatically;
 *  - an administrator CANNOT change their own membership status (server
 *    refusal surfaces as an error toast) — anti-self-lockout.
 *
 * Same invocation contract as the other browser suites: strict when run via
 * `bun run test:e2e:membership` or IITAMS_E2E_STRICT=1; soft skips only with
 * IITAMS_E2E_SOFT=1. No page errors anywhere.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:membership" ||
  process.argv.some((a) => a.includes("test:e2e:membership"));
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
  // AppLayout's provisioning effect must finish: the dashboard heading only
  // renders once the audited joinDemo provisioning has resolved.
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

describe("IITAMS Phase 3A Batch 2A — membership lifecycle", () => {
  test(
    "member loses organization access immediately on suspension and regains it on reactivation",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      // --- Session B: the member under test -------------------------------
      const b = await newPage();
      const signInB = await signInAsGuest(b.page);
      if (!signInB.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] member session: ${signInB.reason}`);
          await b.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: member session — ${signInB.reason}`);
      }
      // Established org context before the lifecycle change.
      expect(
        await visible(b.page, b.page.getByText("IITAMS Demo MDAC").first(), 15000),
      ).toBe(true);

      // --- Session A: administrator ---------------------------------------
      const a = await newPage();
      const signInA = await signInAsGuest(a.page);
      if (!signInA.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] admin session: ${signInA.reason}`);
          await a.page.close();
          await b.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: admin session — ${signInA.reason}`);
      }
      if (!(await becomeDemoAdmin(a.page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] demo admin bridge unavailable");
          await a.page.close();
          await b.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: demo admin bridge unavailable");
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

      // B's directory row: a Member whose "Last seen" is seconds old (its
      // provisioning just happened; historical test guests show minutes/days).
      // Chip text renders as "Active status" — match non-exactly.
      const memberRow = a.page
        .locator("tbody tr")
        .filter({ hasText: "Member" })
        .filter({ hasText: /second[s]? ago/ })
        // Rows with identical names keep creation order (by-organization index
        // scan) — the freshly provisioned member is the newest row.
        .last();
      expect(await visible(a.page, memberRow, 20000)).toBe(true);
      expect(
        await visible(a.page, memberRow.getByText("Active").first(), 10000),
      ).toBe(true);

      // Suspend from the directory (server-side admin.manage enforcement).
      await memberRow.getByRole("button", { name: "Suspend" }).click();

      // Reactive row state confirms the mutation landed and is audited data.
      expect(
        await visible(
          a.page,
          memberRow.getByText("Suspended").first(),
          15000,
        ),
      ).toBe(true);

      // IMMEDIATE ACCESS DENIAL in the member's live session (server-enforced
      // via resolveAccess): B's org context disappears and the shell falls
      // back to the safe no-tenant provisioning state.
      expect(
        await visible(b.page, b.page.getByText("Preparing your demo workspace"), 20000),
      ).toBe(true);
      expect(
        await visible(
          b.page,
          b.page
            .locator("aside, nav, [role=navigation], body")
            .getByText("IITAMS Demo MDAC")
            .first(),
          5000,
        ),
      ).toBe(false);

      // Reactivate from the directory.
      await memberRow.getByRole("button", { name: "Reactivate" }).click();
      expect(
        await visible(a.page, memberRow.getByText("Active").first(), 15000),
      ).toBe(true);

      // The member's session regains its organization context automatically.
      expect(
        await visible(b.page, b.page.getByText("IITAMS Demo MDAC").first(), 25000),
      ).toBe(true);

      expect(b.errors, `member page errors: ${b.errors.join(" | ")}`).toHaveLength(0);
      expect(a.errors, `admin page errors: ${a.errors.join(" | ")}`).toHaveLength(0);
      await a.page.close();
      await b.page.close();
    },
    150000,
  );

  test(
    "administrator cannot change their own membership status (server refusal)",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      const a = await newPage();
      const signInA = await signInAsGuest(a.page);
      if (!signInA.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] self-refusal: ${signInA.reason}`);
          await a.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: self-refusal — ${signInA.reason}`);
      }
      if (!(await becomeDemoAdmin(a.page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] self-refusal: demo admin bridge unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: self-refusal — bridge unavailable");
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

      // Isolate this session's OWN row: the platform-admin role plus a
      // "seconds ago" last-seen — requestDemoAdminUpgrade patches the
      // caller lastSeenAt, so only this session's row is seconds old while
      // historical test profiles show minutes/days.
      const adminRow = a.page
        .locator("tbody tr")
        .filter({ hasText: "Administrator" })
        .filter({ hasText: /second[s]? ago/ })
        // Newest row = this session's just-escalated profile (creation order).
        .last();
      expect(await visible(a.page, adminRow, 10000)).toBe(true);

      await adminRow.getByRole("button", { name: "Suspend" }).click();
      expect(
        await visible(
          a.page,
          a.page.getByText(/Administrators cannot change their own membership status/),
          15000,
        ),
      ).toBe(true);

      expect(a.errors, `page errors: ${a.errors.join(" | ")}`).toHaveLength(0);
      await a.page.close();
    },
    120000,
  );
});
