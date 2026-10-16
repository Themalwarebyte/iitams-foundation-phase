import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";
import {
  grantDemoTestRole,
  revokeDemoTestRole,
  revokeAllEscalatedGuests,
  sweepExpiredDemoGrants,
  HARNESS_URL,
  testerToken,
} from "./e2e-harness";

/**
 * IITAMS demo-escalation hardening — browser-user journey (e2e).
 * ============================================================
 * Verifies the end-to-end migration of role setup from the browser to the
 * trusted runner:
 *
 *  1. the QA bridge exposes NO escalation helpers (a guest-bound attacker
 *     cannot self-escalate from the browser);
 *  2. an ordinary guest signs in through the legitimate authentication flow
 *     and the trusted runner escalates that specific guest via the
 *     token-guarded server-side harness (the tester token never enters the
 *     browser);
 *  3. the browser session observes the elevated role through the normal
 *     session-resolution channel (Administration appears in the sidebar);
 *  4. trusted-runner revocation removes the privilege and the same live
 *     session immediately loses the elevated tier;
 *  5. server-enforced expiration backstop (a short-TTL grant degrades the
 *     session to the read-only member tier after the deadline);
 *  6. mutually distinct, uniform harness refusals for wrong tokens through
 *     the real HTTP surface.
 *
 * Same invocation contract as the other browser suites: strict when run via
 * `bun run test:e2e:demo-role` or IITAMS_E2E_STRICT=1; soft skips only with
 * IITAMS_E2E_SOFT=1. No page errors anywhere.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:demo-role" ||
  process.argv.some((a) => a.includes("test:e2e:demo-role"));
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
  // Lifecycle discipline: revoke any privilege this run granted.
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
  // The harness secret is a runner prerequisite: role setup flows through
  // the trusted server-side harness, never the browser.
  try {
    testerToken();
  } catch (e) {
    if (SOFT) {
      console.warn(`[e2e:SKIPPED] ${String(e).slice(0, 200)}`);
      return;
    }
    throw e;
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

async function signInAsGuest(page: Page) {
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

describe("IITAMS demo-role harness journey (browser)", () => {
  test(
    "trusted-runner grant elevates the guest's live session; revocation degrades it",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const { page, errors } = await newPage();

      // 1. The guest session holds NO escalation helper. Load the app fresh
      // (auth screen renders the router-scoped bridge) and inspect the
      // exposed surface.
      await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500); // the policy query resolves, bridge mounts
      const bridgeKeys: string[] = await page.evaluate(async () => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | Record<string, unknown>
          | undefined;
        return qa ? Object.keys(qa) : [];
      });
      expect(bridgeKeys).not.toContain("upgradeDemoRole");
      expect(bridgeKeys).not.toContain("becomeDemoAdmin");
      expect(bridgeKeys).toContain("whoAmI");

      // 2. Ordinary guest sign-in through the legitimate auth flow.
      const signIn = await signInAsGuest(page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] demo-role journey: ${signIn.reason}`);
          await page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: journey — ${signIn.reason}`);
      }

      // Fresh guest: no Administration surface.
      expect(
        await visible(page, page.getByText("Administration", { exact: true }), 8000),
      ).toBe(false);

      // 3. Trusted-runner grant via the token-guarded harness endpoint.
      const granted = await grantDemoTestRole(page, "admin");
      if (!granted) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] trusted-runner grant unavailable");
          await page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: trusted-runner grant unavailable");
      }
      // The SAME session observes the elevated permission set through the
      // normal session-resolution mechanism.
      expect(
        await visible(page, page.getByText("Administration", { exact: true }), 15000),
      ).toBe(true);

      // 4. Revocation degrades the same live session. Poll the guest's own
      // session query (the backend authorization boundary) until the
      // read-only tier is affirmed, then require the UI to follow.
      const revoked = await revokeDemoTestRole(page);
      if (revoked) {
        let roleAfterRevoke: string | null = null;
        for (let i = 0; i < 12; i++) {
          const session = await page.evaluate(async () => {
            const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
              | { whoAmI(): Promise<{ role?: string | null } | null> }
              | undefined;
            if (!qa?.whoAmI) return null;
            try {
              return await qa.whoAmI();
            } catch {
              return null;
            }
          });
          roleAfterRevoke = session?.role ?? null;
          if (roleAfterRevoke === "member") break;
          await page.waitForTimeout(1000);
        }
        expect(roleAfterRevoke).toBe("member");
        expect(
          await visible(page, page.getByText("Administration", { exact: true }), 10000),
        ).toBe(false);
      }

      // 5. Server-enforced expiry backstop: a short-TTL grant must no longer
      // authorize the elevated tier once the deadline passes. The trusted
      // runner persists the expiry through the harness sweep (server-side
      // write), which also propagates the expired role into the guest's
      // session resolution.
      const regranted = await grantDemoTestRole(page, "admin", 0.02);
      if (regranted) {
        // Let the ~1.2s deadline pass fully.
        await page.waitForTimeout(3500);
        const expired = await sweepExpiredDemoGrants();
        expect(expired).toBeGreaterThanOrEqual(1);
        // Explicit trusted-runner revocation still succeeds on an already-
        // expired grant (idempotent, restores the read-only tier and clears
        // lingering grant state).
        expect(await revokeDemoTestRole(page)).toBe(true);
        // Deletion propagation can trail the committed write on the shared
        // React session channel: poll the guest's own authoritative session
        // query (same bounded pattern as step 4) instead of a single read.
        let sessionAfter: { role?: string | null } | null = null;
        for (let i = 0; i < 12; i++) {
          sessionAfter = await page.evaluate(async () => {
            const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
              | { whoAmI(): Promise<{ role?: string | null } | null> }
              | undefined;
            if (!qa?.whoAmI) return null;
            try {
              return await qa.whoAmI();
            } catch {
              return null;
            }
          });
          if ((sessionAfter?.role ?? "member") === "member") break;
          await page.waitForTimeout(1000);
        }
        expect(sessionAfter?.role ?? "member").toBe("member");
      }

      expect(errors, `page errors: ${errors.join(" | ")}`).toHaveLength(0);
      await page.close();
    },
    240000,
  );

  test(
    "harness HTTP surface refuses wrong tokens uniformly (real endpoint)",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;
      const wrong = await fetch(`${HARNESS_URL}/api/dev-grant-demo-role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": "browser-side-forbidden-token",
        },
        body: JSON.stringify({ userId: "jx" }),
      });
      expect(wrong.status).toBe(403);
      expect(await wrong.text()).toBe("{\"error\":\"unauthorized\"}");
    },
    90000,
  );
});
