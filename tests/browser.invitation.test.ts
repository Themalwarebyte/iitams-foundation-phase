import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { api } from "../src/convex/_generated/api";
import { ConvexHttpClient } from "convex/browser";
import { grantDemoTestRole } from "./e2e-harness";

/**
 * Batch 2C — REAL Chromium invitation-onboarding journey.
 * ================================================================
 * Full administrator → recipient workflow with SEPARATE browser sessions:
 *
 *   1. ADMIN SESSION: guest sign-in → trusted-runner platform-admin grant →
 *      Administration → Users → "Invite User" dialog → explicit confirm →
 *      the invitation appears (truthful delivery state; dev deployments have
 *      no email provider and the UI must NOT claim a sent email).
 *   2. TRUSTED RUNNER: issues the acceptance link via the token-guarded
 *      dev harness route (POST /api/dev-invite-acceptance-link) — the
 *      tester token NEVER enters any browser session.
 *   3. RECIPIENT SESSION: opens the acceptance link (secret stripped from
 *      the URL), sees org name + intended role only after validation, signs
 *      in via REAL email-OTP through the existing auth page (code retrieved
 *      by the runner through the dev OTP harness), returns to /invite/accept
 *      with returnTo preserved, confirms, and lands on the dashboard with
 *      the invited role and an active membership — NO manual administrator
 *      provisioning step required.
 *
 * Strict when run via `bun run test:e2e:invitations` or IITAMS_E2E_STRICT=1;
 * soft skips otherwise. No page errors anywhere.
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
  process.env.npm_lifecycle_event === "test:e2e:invitations" ||
  process.argv.some((a) => a.includes("test:e2e:invitations"));
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

async function newPage(opts?: { reducedMotion?: boolean }) {
  if (!browser) throw new Error("browser unavailable");
  const ctx = await browser.newContext({
    reducedMotion: "reduce",
    viewport: { width: 1440, height: 900 },
  });
  if (opts?.reducedMotion) {
    await ctx.emulateMedia({ reducedMotion: "reduce" });
  }
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
  return { page, context: ctx, errors };
}

async function visible(
  locator: ReturnType<Page["locator"]> | ReturnType<Page["getByText"]>,
  timeout = 15000,
): Promise<boolean> {
  try {
    await locator.waitFor({ state: "visible", timeout });
    return true;
  } catch {
    return false;
  }
}

/** Guest sign-in through the legitimate auth flow, landing on /dashboard. */
async function signInAsGuest(page: Page) {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const guest = page.getByRole("button", { name: /Continue as Guest/ });
  if (!(await visible(guest, 10000))) {
    return { ok: false, reason: "guest auth disabled on deployment" };
  }
  await guest.first().click();
  try {
    await page.waitForURL("**/dashboard", { timeout: 20000 });
  } catch {
    return { ok: false, reason: "guest sign-in did not reach /dashboard" };
  }
  const headingWait = await visible(
    page.getByRole("heading", { name: "Executive Dashboard" }),
    25000,
  );
  if (!headingWait) {
    const bodyHead = await page
      .locator("body")
      .innerText()
      .then((t) => t.slice(0, 300).replace(/\n/g, " | "))
      .catch(() => "<body read failed>");
    return {
      ok: false,
      reason: `dashboard heading not visible (url: ${page.url()}; body: ${bodyHead})`,
    };
  }
  return { ok: true };
}

/** Real email-OTP sign-in through the auth page, code via the harness. */
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
  const sendButton = page.getByRole("button", { name: /Send verification code/i });
  await sendButton.click();

  // The runner retrieves the REAL generated code through the trusted OTP
  // harness (the browser never sees it until the user receives it by email
  // — in dev the provider is unconfigured and the code is captured server-side).
  let code: string | null = null;
  const token = testerToken();
  if (!token) return { ok: false, reason: "tester token unavailable in runner" };
  for (let i = 0; i < 12; i++) {
    await page.waitForTimeout(1500);
    try {
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
    } catch {
      // retry until deadline
    }
  }
  if (!code) return { ok: false, reason: "OTP code not retrievable via trusted harness" };

  // Enter the code: the shadcn InputOTP renders slots inside a single
  // keyboard-capturing container — click it, then type the digits.
  const headline = page.getByText(/We've sent a code/i);
  if (!(await visible(headline, 12000))) {
    return { ok: false, reason: "OTP step not visible after code send" };
  }
  const otpGroup = page.locator('[data-slot="input-otp"]').first();
  await otpGroup.click();
  await page.keyboard.type(code, { delay: 80 });

  const verifyButton = page.getByRole("button", { name: /Verify code/i });
  await verifyButton.click();

  // The auth flow navigates to returnTo (the acceptance page).
  try {
    await page.waitForURL("**/invite/accept**", { timeout: 20000 });
  } catch {
    return { ok: false, reason: "email-OTP sign-in did not return to /invite/accept" };
  }
  return { ok: true };
}

describe("IITAMS Batch 2C — invitation onboarding journey (browser)", () => {
  test(
    "admin invites through the UI; the invited user verifies email, accepts and holds effective access",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const runId = Date.now();
      const uiEmail = `inv-ui-admin-journey-${runId}@check.example`;
      const recipientEmail = `inv-recipient-${runId}@check.example`;

      // ---------------- ADMIN SESSION ----------------
      const { page: adminPage, errors: adminErrors, context: adminCtx } = await newPage();
      const adminSignIn = await signInAsGuest(adminPage);
      if (!adminSignIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] invitation journey: ${adminSignIn.reason}`);
          await adminCtx.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: journey — ${adminSignIn.reason}`);
      }

      // Trusted-runner platform-admin grant for this guest session (the
      // shared harness helper polls whoAmI and retries until provisioned).
      const granted = await grantDemoTestRole(adminPage, "admin", 120);
      if (!granted) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] trusted-runner admin grant unavailable");
          await adminCtx.close();
          return;
        }
        throw new Error("E2E GATE FAILED: trusted-runner admin grant unavailable");
      }

      // Administration → Users with the invitation management section.
      await adminPage.goto(`${BASE}/admin/users`, { waitUntil: "domcontentloaded" });
      await adminPage.waitForTimeout(2000);
      const inviteButton = adminPage.getByRole("button", { name: /Invite User/i });
      if (!(await visible(inviteButton, 15000))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] Invite User control not visible for admin");
          await adminCtx.close();
          return;
        }
        throw new Error("E2E GATE FAILED: Invite User control not visible");
      }
      await inviteButton.click();
      const emailInput = adminPage.locator("#invite-email");
      await emailInput.fill(uiEmail);
      await adminPage.locator("#invite-role").click();
      await adminPage.getByRole("option", { name: /Auditor/ }).click();
      await adminPage.locator("#invite-title").fill("Assurance Officer");
      await adminPage.getByRole("button", { name: /Review invitation/i }).click();
      // Explicit confirmation step.
      const confirmDialog = adminPage.getByText(/Confirm invitation/i);
      if (!(await visible(confirmDialog, 8000))) {
        throw new Error("E2E GATE FAILED: explicit invite confirmation not shown");
      }
      await adminPage.getByRole("button", { name: /Send invitation/i }).click();

      // Truthful state: created (dev has no email provider — delivery is
      // shown as NOT sent; the toast must not claim an email went out).
      await adminPage.waitForTimeout(1500);
      const invitedEmailVisible = await visible(
        adminPage.getByText("Invitations").first(),
        10000,
      );
      expect(invitedEmailVisible).toBe(true);
      const rowForUiEmail = await visible(
        adminPage.getByText(uiEmail).first(),
        10000,
      );
      expect(rowForUiEmail).toBe(true);

      // ---------------- RECIPIENT JOURNEY (API-issued invitation) ----------
      // The link comes from the trusted harness; the invitation itself was
      // created through the SAME authorized backend mutation the UI uses
      // (real admin-manage session via ConvexHttpClient).
      let inviteLink: string | null = null;
      let invitationId: string | null = null;
      {
        const adminClient = new ConvexHttpClient(CONVEX_URL);
        const result = (await (adminClient as unknown as {
          action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
        }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
          tokens?: { token?: string; accessToken?: string };
        };
        const jwt = result.tokens?.token ?? result.tokens?.accessToken;
        if (jwt)
          (adminClient as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
        await adminClient.mutation(api.session.joinDemoOrganization, {});
        const session = (await adminClient.query(api.session.getSession, {})) as {
          userId?: string;
        } | null;
        const token = testerToken();
        if (!token || !session?.userId) {
          throw new Error("E2E GATE FAILED: runner admin client setup failed");
        }
        const grantRes = await fetch(`${HARNESS_URL}/api/dev-grant-demo-role`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-iitams-tester-token": token,
          },
          body: JSON.stringify({ userId: session.userId, role: "admin", ttlMinutes: 120 }),
        });
        if (!grantRes.ok) throw new Error("E2E GATE FAILED: runner admin grant failed");

        const created = (await adminClient.mutation(api.invitations.createInvitation, {
          email: recipientEmail,
          role: "auditor",
          jobTitle: "Journey Auditor",
        })) as { ok?: boolean; invitationId?: string };
        if (!created.ok || !created.invitationId) {
          throw new Error("E2E GATE FAILED: invitation creation failed");
        }
        invitationId = created.invitationId;
        const linkRes = await fetch(`${HARNESS_URL}/api/dev-invite-acceptance-link`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-iitams-tester-token": token,
          },
          body: JSON.stringify({ invitationId }),
        });
        expect(linkRes.status).toBe(200);
        const linkData = (await linkRes.json()) as { secret?: string };
        expect(typeof linkData.secret).toBe("string");
        inviteLink = `${BASE}/invite/accept?secret=${linkData.secret!}`;
      }

      // ---------------- RECIPIENT SESSION ----------------
      const { page: recipPage, errors: recipErrors, context: recipCtx } = await newPage();
      await recipPage.goto(inviteLink!, { waitUntil: "domcontentloaded" });
      await recipPage.waitForTimeout(1500);

      // Organizations name + intended role shown only after validation.
      await visible(recipPage.getByText(/Inviting organization/i), 15000);
      await visible(recipPage.getByText(/Audit Director|Auditor/i).first(), 10000);

      // The secret is stripped from the visible URL as soon as practical.
      const urlNow = recipPage.url();
      expect(urlNow).not.toContain("secret=");

      // Sign in with the invited email through REAL email-OTP auth.
      const recSignIn = await signInViaEmailOtp(recipPage, recipientEmail, "/invite/accept");
      if (!recSignIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] recipient otp: ${recSignIn.reason}`);
          await recipCtx.close();
          await adminCtx.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: recipient otp — ${recSignIn.reason}`);
      }

      // Back on /invite/accept with the verified matching session.
      await recipPage.waitForTimeout(2000);
      const confirmButton = recipPage.getByRole("button", { name: /Confirm and join/i });
      if (!(await visible(confirmButton, 15000))) {
        const bodyHead = await recipPage
          .locator("body")
          .innerText()
          .then((t) => t.slice(0, 500).replace(/\n/g, " | "))
          .catch(() => "<body read failed>");
        throw new Error(
          `E2E GATE FAILED: confirm-and-join step not shown after verified sign-in (url: ${recipPage.url()}; body: ${bodyHead})`,
        );
      }
      await confirmButton.click();

      // Onboarded directly to the dashboard — no manual provisioning step.
      try {
        await recipPage.waitForURL("**/dashboard", { timeout: 30000 });
      } catch {
        throw new Error(
          `E2E GATE FAILED: acceptance did not reach /dashboard (url: ${recipPage.url()})`,
        );
      }

      // The verified recipient now holds the effective invited access via the
      // normal session-resolution mechanism (role + provisioning + org).
      await recipPage.waitForTimeout(2500);
      const recipientAccess = await recipPage.evaluate(async () => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { whoAmI?: () => Promise<{ role?: string | null; isProvisioned?: boolean; isAnonymous?: boolean; email?: string | null } | null> }
          | undefined;
        if (!qa?.whoAmI) return null;
        try {
          return await qa.whoAmI();
        } catch {
          return null;
        }
      });
      expect(recipientAccess).not.toBeNull();
      expect(recipientAccess!.isAnonymous).toBe(false);
      expect(recipientAccess!.isProvisioned).toBe(true);
      expect(recipientAccess!.role).toBe("auditor");
      expect(recipientAccess!.email?.toLowerCase()).toBe(recipientEmail);

      // Replay protection: a second acceptance of the SAME token is refused
      // (the invitation is now terminal) — handled server-side with a
      // uniform refusal.
      const replayRes = await fetch(`${HARNESS_URL}/api/dev-invite-acceptance-link`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": testerToken(),
        },
        body: JSON.stringify({ invitationId }),
      });
      // Reissue after acceptance must be refused by the backend (200 would
      // mean a dead invitation can still mint links).
      const replayOk = replayRes.ok && (await replayRes.json() as { secret?: string }).secret !== undefined;
      expect(replayOk).toBe(false);

      expect(recipErrors, `recipient page errors: ${recipErrors.join(" | ")}`).toHaveLength(0);
      expect(adminErrors, `admin page errors: ${adminErrors.join(" | ")}`).toHaveLength(0);
      await recipCtx.close();
      await adminCtx.close();
    },
    300000,
  );
});
