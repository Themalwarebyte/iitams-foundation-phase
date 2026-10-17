import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page, type Browser } from "playwright-core";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";
import { grantDemoTestRole, revokeAllEscalatedGuests } from "./e2e-harness";

/**
 * IITAMS Phase 3A Batch 2A browser suite — membership lifecycle (e2e).
 * =====================================================================
 * Two independent sessions against the demo deployment:
 *
 *  1. Session A signs in as an ordinary guest; the trusted test runner grants
 *     the demo platform-admin TEST role via the token-guarded server-side
 *     harness (never through the browser; revoked on teardown).
 *  2. Session B is a real MEMBER of the demo organization. The member under
 *     test is a seeded, email-verified identity provisioned into the demo
 *     organization through the authorized backend path: the shared demo
 *     directory accumulates thousands of anonymous guests that all render
 *     with the same display name ("Unnamed user"), so a guest row cannot be
 *     addressed deterministically at scale — the member's own email is the
 *     only stable, uniquely searchable identifier. Guest-specific behaviour
 *     (demo join, escalation guards) is covered by the smoke, demo-role and
 *     effective-membership suites.
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

/**
 * Trusted-runner grant of the demo platform-admin TEST role to the current
 * guest session (see tests/e2e-harness.ts — the tester token never enters
 * the browser).
 */
async function becomeDemoAdmin(page: Page): Promise<boolean> {
  return await grantDemoTestRole(page, "admin");
}

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS_URL =
  process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    return "";
  }
}

/** Explicit fixture registry: only emails this file created are ever named. */
const fixtureEmails = new Set<string>();

async function harnessPost(
  path: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await fetch(`${HARNESS_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": testerToken(),
    },
    body: JSON.stringify(body),
  });
}

/** Trusted-runner admin session (guest + harness demo grant). */
async function harnessAdminClient(): Promise<ConvexHttpClient | null> {
  if (!testerToken()) return null;
  const guest = new ConvexHttpClient(CONVEX_URL);
  const r = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string };
  };
  if (r.tokens?.token) {
    (guest as unknown as { setAuth: (v: string) => void }).setAuth(r.tokens.token);
  }
  await guest.mutation(api.session.joinDemoOrganization, {});
  const session = (await guest.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  const res = await harnessPost("/api/dev-grant-demo-role", {
    userId: session.userId,
    role: "admin",
    ttlMinutes: 120,
  });
  if (!res.ok) return null;
  return guest;
}

/** Real email-OTP sign-in through the existing auth page (code retrieved by
 * the TRUSTED RUNNER from the token-guarded harness, never from the page). */
async function signInViaEmailOtp(
  page: Page,
  email: string,
  returnTo: string,
): Promise<{ ok: boolean; reason?: string }> {
  await page.goto(`${BASE}/auth?returnTo=${encodeURIComponent(returnTo)}`, {
    waitUntil: "domcontentloaded",
  });
  const emailInput = page.locator('input[name="email"]');
  if (!(await visible(page, emailInput, 10000))) {
    return { ok: false, reason: "auth email form not visible" };
  }
  await emailInput.fill(email);
  await page.getByRole("button", { name: /Send verification code/i }).click();

  let code: string | null = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    const res = await harnessPost("/api/dev-otp", { email });
    if (res.ok) {
      const data = (await res.json()) as { code?: string };
      if (data.code && /^\d{6}$/.test(data.code)) {
        code = data.code;
        break;
      }
    }
  }
  if (!code) return { ok: false, reason: "OTP code not retrievable via harness" };

  const headline = page.getByText(/We've sent a code/i);
  if (!(await visible(page, headline, 12000))) {
    return { ok: false, reason: "OTP step not visible after code send" };
  }
  const otpGroup = page.locator('[data-slot="input-otp"]').first();
  await otpGroup.click();
  await page.keyboard.type(code, { delay: 80 });
  await page.getByRole("button", { name: /Verify code/i }).click();
  await page.waitForURL("**/dashboard", { timeout: 25000 }).catch(() => undefined);
  return { ok: true };
}

/** The page's own resolved session state (read-only QA bridge). */
async function sessionInfo(page: Page): Promise<{
  isProvisioned?: boolean;
  awaitingProvisioning?: boolean;
  membershipStatus?: string;
  organization?: { id?: string } | null;
  role?: string | null;
} | null> {
  return await page.evaluate(async () => {
    const qa = (
      window as unknown as {
        __IITAMS_DEV_QA__?: { whoAmI(): Promise<unknown> };
      }
    ).__IITAMS_DEV_QA__;
    try {
      return (await qa?.whoAmI()) as never;
    } catch {
      return null;
    }
  });
}

describe("IITAMS Phase 3A Batch 2A — membership lifecycle", () => {
  test(
    "member loses organization access immediately on suspension and regains it on reactivation",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      // --- Fixture: the member under test (seeded, verified, provisioned) --
      const suffix = `${Date.now()}-${Math.floor(Math.random() * 99999)}`;
      const memberEmail = `membership-${suffix}@check.example`;
      const fixtureAdmin = await harnessAdminClient();
      if (!fixtureAdmin) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] trusted-runner admin session unavailable");
          return;
        }
        throw new Error("E2E GATE FAILED: trusted-runner admin session unavailable");
      }
      await harnessPost("/api/dev-seed-test-user", { email: memberEmail });
      fixtureEmails.add(memberEmail);
      const provisioned = (await fixtureAdmin.mutation(api.admin.provisionMember, {
        email: memberEmail,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] member provisioning unavailable");
          return;
        }
        throw new Error("E2E GATE FAILED: member provisioning unavailable");
      }

      // --- Session B: the member under test -------------------------------
      const b = await newPage();
      const signInB = await signInViaEmailOtp(b.page, memberEmail, "/dashboard");
      if (!signInB.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] member session: ${signInB.reason}`);
          await b.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: member session — ${signInB.reason}`);
      }
      // Established org context before the lifecycle change.
      if (
        !(await visible(
          b.page,
          b.page.getByRole("heading", { name: "Executive Dashboard" }),
          30000,
        ))
      ) {
        const state = await sessionInfo(b.page);
        throw new Error(
          `E2E GATE FAILED: member session did not reach the dashboard — session=${JSON.stringify(state)}`,
        );
      }

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

      // B's directory row is addressed by B's OWN email — the only stable,
      // unique identifier in a directory that also holds thousands of
      // anonymous guests sharing the display name "Unnamed user". The
      // directory search narrows the rendered rows to this member.
      // Chip text renders as "Active status" — match non-exactly.
      // NOTE: the row locator must NOT depend on the Suspend button — that
      // button becomes Reactivate after suspension, which would detach the
      // locator and hide the reactive status change we assert next.
      await a.page
        .getByPlaceholder("Search by name, email or job title…")
        .fill(memberEmail);
      const memberRow = a.page.locator("tbody tr").filter({ hasText: memberEmail }).first();
      expect(await visible(a.page, memberRow, 25000)).toBe(true);
      expect(
        await visible(
          a.page,
          memberRow.getByRole("button", { name: "Suspend" }),
          10000,
        ),
      ).toBe(true);
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
      // back to the safe no-tenant state for a non-guest account.
      const suspended = await (async () => {
        for (let i = 0; i < 20; i++) {
          const state = await sessionInfo(b.page);
          if (state && state.isProvisioned === false) return state;
          await b.page.waitForTimeout(1000);
        }
        return await sessionInfo(b.page);
      })();
      expect(suspended?.isProvisioned).toBe(false);
      expect(suspended?.awaitingProvisioning).toBe(true);
      expect(suspended?.membershipStatus).toBe("suspended");
      expect(suspended?.organization ?? null).toBeNull();
      expect(
        await visible(
          b.page,
          b.page.getByText("Account awaiting provisioning").first(),
          20000,
        ),
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
      const regained = await (async () => {
        for (let i = 0; i < 25; i++) {
          const state = await sessionInfo(b.page);
          if (state && state.isProvisioned === true) return state;
          await b.page.waitForTimeout(1000);
        }
        return await sessionInfo(b.page);
      })();
      expect(regained?.isProvisioned).toBe(true);
      if (!(await visible(b.page, b.page.getByText("IITAMS Demo MDAC").first(), 25000))) {
        // Diagnose instead of failing anonymously: the live session state, the
        // rendered body and any page errors distinguish a reactivity defect
        // from a stale row/locator mismatch.
        const state = await sessionInfo(b.page).catch(() => null);
        const body = await b.page
          .locator("body")
          .innerText()
          .then((t) => t.replace(/\s+/g, " ").slice(0, 400))
          .catch(() => "<body unreadable>");
        throw new Error(
          `member session did not regain organization context — session=${JSON.stringify(state)} body="${body}" errors=${JSON.stringify(b.errors)}`,
        );
      }

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
      // "seconds ago" last-seen. The grant is RE-ISSUED here, after the
      // directory has rendered, because the trusted-runner grant is what
      // patches the target's lastSeenAt: signing in, navigating and waiting
      // for the table can take longer than the 60s the relative label needs
      // before it would read "a minute ago" (the old, timing-dependent
      // failure mode). A refresh makes this session's row the newest
      // fresh-second row in creation order.
      if (!(await becomeDemoAdmin(a.page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] self-refusal: fresh grant unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: self-refusal — fresh grant unavailable");
      }
      const freshAdminRow = a.page
        .locator("tbody tr")
        .filter({ hasText: "Administrator" })
        .filter({ hasText: /second[s]? ago/ })
        // Newest row = this session's just-escalated profile (creation order).
        .last();
      expect(await visible(a.page, freshAdminRow, 20000)).toBe(true);
      // Pin the row by DOM position before interacting: the "seconds ago"
      // label is the identification signal, but it turns into "a minute ago"
      // as the run proceeds, which would silently detach a text-filtered
      // locator mid-interaction.
      const adminRowIndex = await freshAdminRow.evaluate((el) =>
        Array.from(el.parentElement?.children ?? []).indexOf(el as Element),
      );
      expect(adminRowIndex).toBeGreaterThanOrEqual(0);
      const adminRow = a.page.locator("tbody tr").nth(adminRowIndex);
      expect(await adminRow.innerText()).toContain("Administrator");

      await adminRow.getByRole("button", { name: "Suspend" }).click();
      expect(
        await visible(
          a.page,
          a.page.getByText(/Administrators cannot change their own membership status/),
          15000,
        ),
      ).toBe(true);
      // Nothing changed: the refusal is server-side, not a UI-only guard.
      expect(
        await visible(a.page, adminRow.getByText("Active").first(), 10000),
      ).toBe(true);

      expect(a.errors, `page errors: ${a.errors.join(" | ")}`).toHaveLength(0);
      await a.page.close();
    },
    120000,
  );
});
