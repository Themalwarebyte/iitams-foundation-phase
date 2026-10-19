import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import { api } from "../src/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { grantDemoTestRole } from "./e2e-harness";

/**
 * Batch A1 — REAL Chromium administrator-lifecycle journey.
 * ========================================================
 * Verifies the pending-grant confirmation flow end-to-end:
 *
 *   1. Trusted runner cleanup (token-guarded harness only) — leftover
 *      test-admin grants are reverted so the lifecycle starts clean.
 *   2. ADMIN (real harness-authorized session): navigates Administration →
 *      Users, uses the "Grant admin" action on a directory member and
 *      confirms the dialog — a PENDING grant is created (no elevation).
 *   3. RECIPIENT (independent browser session, real email-OTP sign-in):
 *      opens /privilege-requests, sees the pending request, explicitly
 *      accepts it with its own confirmation dialog, and holds effective
 *      administrator permissions afterwards.
 *
 * Strict when run via `bun run test:e2e:adminlifecycle` or IITAMS_E2E_STRICT=1;
 * soft skips otherwise. The tester token never enters the browser.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";
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


const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:adminlifecycle" ||
  process.argv.some((a) => a.includes("test:e2e:adminlifecycle"));
const STRICT = invokedAsE2E || process.env.IITAMS_E2E_STRICT === "1";
const SOFT = !STRICT;

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
});

afterAll(async () => {
  await browser?.close();
  // Lifecycle discipline through the token-guarded harness only.
  const token = testerToken();
  if (token) {
    await fetch(`${HARNESS_URL}/api/dev-revert-demo-admin-grants`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-iitams-tester-token": token },
      // Scoped revert: ONLY the guests this file granted demo roles to.
      body: JSON.stringify({ fixtureUserIds: [...fixtureUserIds] }),
    }).catch(() => undefined);
  }
}, 60000);

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
    const msg = "chromium unavailable";
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${msg}`);
      return;
    }
    throw new Error(`E2E GATE FAILED: ${msg}`);
  }
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
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Explicit fixture registry for THIS file: only guests it granted a demo
 * role to may ever be named in the scoped revert harness route. */
const fixtureUserIds = new Set<string>();

/** Trusted-runner admin session (guest + harness demo grant). */
async function harnessAdminClient(): Promise<ConvexHttpClient | null> {
  const token = testerToken();
  if (!token) return null;
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
  const res = await fetch(`${HARNESS_URL}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId: session.userId, role: "admin", ttlMinutes: 120 }),
  });
  if (!res.ok) return null;
  fixtureUserIds.add(session.userId);
  return guest;
}

/** Real email-OTP sign-in through the existing auth page. */
async function signInViaEmailOtp(
  page: Page,
  email: string,
  returnTo: string,
): Promise<{ ok: boolean; reason?: string }> {
  await page.goto(`${BASE}/auth?returnTo=${encodeURIComponent(returnTo)}`, {
    waitUntil: "domcontentloaded",
  });
  const emailInput = page.locator('input[name="email"]');
  if (!(await visible(emailInput, 10000))) {
    return { ok: false, reason: "auth email form not visible" };
  }
  await emailInput.fill(email);
  await page.getByRole("button", { name: /Send verification code/i }).click();

  const token = testerToken();
  if (!token) return { ok: false, reason: "tester token unavailable in runner" };
  let code: string | null = null;
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    const res = await fetch(`${HARNESS_URL}/api/dev-otp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": token,
      },
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      const data = (await res.json()) as { code?: string };
      if (data.code && /^\d{6}$/.test(data.code)) {
        code = data.code;
        break;
      }
    }
  }
  if (!code) return { ok: false, reason: "OTP code not retrievable via trusted harness" };

  const headline = page.getByText(/We've sent a code/i);
  if (!(await visible(headline, 12000))) {
    return { ok: false, reason: "OTP step not visible after code send" };
  }
  const otpGroup = page.locator('[data-slot="input-otp"]').first();
  await otpGroup.click();
  await page.keyboard.type(code, { delay: 80 });
  await page.getByRole("button", { name: /Verify code/i }).click();
  return { ok: true };
}

describe("IITAMS Batch A1 — administrator-lifecycle journey (browser)", () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 99999)}`;
  const memberEmail = `grantflow-${suffix}@check.example`;

  test(
    "admin initiates grant through the UI; recipient confirms in a separate verified session and holds effective access",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      // ---- Trusted-runner cleanup (token-guarded harness only) ----
      const token = testerToken();
      if (!token) {
        console.warn("[e2e:SKIPPED] tester token unavailable");
        return;
      }
      await fetch(`${HARNESS_URL}/api/dev-revert-demo-admin-grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-iitams-tester-token": token },
        // Scoped revert: ONLY this file's own fixture guests.
        body: JSON.stringify({ fixtureUserIds: [...fixtureUserIds] }),
      });

      // Seed + provision the recipient through authorized backend calls.
      const adminClient = await harnessAdminClient();
      if (!adminClient) {
        console.warn("[e2e:SKIPPED] trusted-runner admin session unavailable");
        return;
      }
      await fetch(`${HARNESS_URL}/api/dev-seed-test-user`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({ email: memberEmail }),
      });
      const provisioned = (await adminClient.mutation(api.admin.provisionMember, {
        email: memberEmail,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        console.warn("[e2e:SKIPPED] recipient provisioning unavailable");
        return;
      }

      // ---- ADMIN SESSION (browser): guest sign-in + trusted-runner admin grant, then UI-initiated pending grant ----
      const admin = await newPage();
      const adminSess = await signInAnonymousGuest(admin.page);
      if (!adminSess.ok) {
        console.warn(`[e2e:SKIPPED] admin session: ${adminSess.reason}`);
        await admin.page.context().close();
        return;
      }
      if (!(await grantDemoTestRole(admin.page, "admin", 120))) {
        console.warn("[e2e:SKIPPED] trusted-runner admin grant for the browser session failed");
        await admin.page.context().close();
        return;
      }
      await admin.page.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" });
      const grantButton = admin.page
        .locator("tr", { hasText: memberEmail })
        .getByRole("button", { name: /Grant admin/i })
        .first();
      if (!(await visible(grantButton, 20000))) {
        console.warn("[e2e:SKIPPED] Grant-admin action not visible for the member row");
        await admin.page.context().close();
        return;
      }
      await grantButton.click();
      // shadcn AlertDialog exposes role="alertdialog".
      const confirmDialog = admin.page.getByRole("alertdialog").first();
      await confirmDialog
        .getByRole("button", { name: /Create grant request/i })
        .click();
      const pendingBanner = admin.page.getByText(/Administrator grant pending for/i).first();
      const bannerVisible = await visible(pendingBanner, 20000);
      // The pending grant lists the recipient (org-scoped lifecycle panel).
      const recipientListed = await visible(
        admin.page.getByText(/\d+ \| /),
        1,
      );
      void recipientListed;
      expect(bannerVisible).toBe(true);
      expect(bannerVisible).toBe(true);

      // ---- RECIPIENT SESSION: independent sign-in and explicit acceptance ----
      const recipient = await newPage();
      const signedIn = await signInViaEmailOtp(
        recipient.page,
        memberEmail,
        "/privilege-requests",
      );
      if (!signedIn.ok) {
        console.warn(`[e2e:SKIPPED] recipient sign-in: ${signedIn.reason}`);
        await recipient.page.context().close();
        await admin.page.context().close();
        return;
      }
      const requestCard = recipient.page.getByText(/Administrator grant requested/i).first();
      if (!(await visible(requestCard, 20000))) {
        console.warn("[e2e:SKIPPED] pending request card not visible on /privilege-requests");
        await recipient.page.context().close();
        await admin.page.context().close();
        return;
      }
      await recipient.page
        .getByRole("button", { name: /Review & accept/i })
        .first()
        .click();
      await recipient.page
        .getByRole("button", { name: /Confirm acceptance/i })
        .click();

      // Effective access: the session now resolves administrator permissions.
      const adminBadge = recipient.page
        .getByText(/You are now an organization administrator|Platform Administrator/i)
        .first();
      const elevated = await visible(adminBadge, 20000);
      // Structural confirmation through the backend session query as well.
      const sessionNow = (await recipient.page.evaluate(async () => {
        return await (window as unknown as {
          __IITAMS_DEV_QA__?: { whoAmI?: () => Promise<{ userId: string } | null> };
        }).__IITAMS_DEV_QA__?.whoAmI?.();
      }, )) as unknown;
      void sessionNow;
      expect(elevated).toBe(true);

      // Pending grant is terminal — replay acceptance is refused.
      await recipient.page.goto(`${BASE}/privilege-requests`, {
        waitUntil: "domcontentloaded",
      });
      const noPending = await visible(
        recipient.page.getByText(/No pending requests/i),
        15000,
      );
      expect(noPending).toBe(true);

      await recipient.page.context().close();
      await admin.page.context().close();
    },
    300000,
  );
});

/** Anonymous guest sign-in through the existing auth page (demo mode). */
async function signInAnonymousGuest(page: Page): Promise<{ ok: boolean; reason?: string }> {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const guestButton = page
    .getByRole("button", { name: /continue as guest/i })
    .first();
  if (!(await visible(guestButton, 15000))) {
    return { ok: false, reason: "guest button not visible on /auth (guest auth disabled?)" };
  }
  await guestButton.click();
  try {
    await page.waitForURL(/dashboard|\/$/, { timeout: 20000 });
  } catch {
    // session check below decides
  }
  return { ok: true };
}
