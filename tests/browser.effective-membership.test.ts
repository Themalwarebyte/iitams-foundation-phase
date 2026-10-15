import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { chromium, type Page, type Browser } from "playwright-core";

/**
 * IITAMS Phase 3A Batch 2B — effective membership acceptance (e2e).
 * ==================================================================
 * Verifies effective access with TWO SEPARATE authenticated identities:
 *
 *  Identity A (administrator): guest session escalated to demo platform
 *   admin via the dev-only QA bridge, then provisions an existing verified
 *   user through the "Add Existing User" UI flow.
 *  Identity B (provisioned member): signs in INDEPENDENTLY through the real
 *   email-OTP flow on its own page/session, using the dev-only pending-OTP
 *   reader (backend-gated `api.devOtp.pending`) to retrieve the code that
 *   the no-delivery development branch captured. No admin session is ever
 *   reused for B's assertions.
 *
 * Assertions:
 *  - B receives the intended organization + role and sees authorized
 *    functionality (dashboard + permitted module navigation).
 *  - Administration UI is absent for B and an admin.view–guarded backend
 *    query is DENIED for B's session (probe returns { denied: true } only).
 *  - B's organization context is exactly the provisioning organization
 *    (single-tenant session; no cross-organization surface).
 *  - After the administrator SUSPENDS the membership, B's live session
 *    degrades to the unprovisioned shape (no organization, no permissions),
 *    and re-provisioning the same address is refused by the uniform
 *    duplicate-membership refusal.
 *  - Same for DEACTIVATED (reactivate → deactivate).
 *  - The audit trail records the suspension as
 *    `user.membership_suspended` with the ADMINISTRATOR as the acting
 *    identity and the MEMBER as the target — actor ≠ target.
 *
 * Same invocation contract as the other browser suites: strict when run via
 * `bun run test:e2e:effective-membership` or IITAMS_E2E_STRICT=1; soft skips
 * only with IITAMS_E2E_SOFT=1. No page errors anywhere.
 */

const BASE = process.env.IITAMS_E2E_BASE_URL ?? "http://localhost:5173";
const CHROME =
  process.env.IITAMS_E2E_CHROME_PATH ??
  "/home/daytona/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

const invokedAsE2E =
  process.env.npm_lifecycle_event === "test:e2e:effective-membership" ||
  process.argv.some((a) => a.includes("test:e2e:effective-membership"));
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

type SessionInfo = {
  role: string | null;
  isProvisioned: boolean;
  awaitingProvisioning: boolean;
  membershipStatus?: string;
  organization: { id: string; name: string; code: string } | null;
  email: string | null;
  name: string | null;
  permissions: Record<string, boolean>;
};

async function sessionInfo(page: Page): Promise<SessionInfo | null> {
  return await page.evaluate(async () => {
    const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
      | { whoAmI(): Promise<unknown> }
      | undefined;
    if (!qa) return null;
    try {
      return (await qa.whoAmI()) as SessionInfo;
    } catch {
      return null;
    }
  });
}

/** Read the pending dev OTP for `email` (backend-gated query). */
async function pendingOtp(
  page: Page,
  email: string,
  timeoutMs = 20000,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await page.evaluate(async (addr) => {
      const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
        | { pendingOtp(email: string): Promise<{ code: string } | null> }
        | undefined;
      if (!qa?.pendingOtp) return null;
      try {
        return (await qa.pendingOtp(addr))?.code ?? null;
      } catch {
        return null;
      }
    }, email);
    if (code) return code;
    await page.waitForTimeout(500);
  }
  return null;
}

/** REAL email-OTP sign-in for the member's OWN session (independent auth). */
async function signInWithOtp(
  page: Page,
  email: string,
): Promise<{ ok: boolean; reason?: string }> {
  await page.goto(`${BASE}/auth`, { waitUntil: "domcontentloaded" });
  const emailInput = page.locator('input[name="email"]');
  if (!(await visible(page, emailInput, 10000))) {
    return { ok: false, reason: "email sign-in form not reachable" };
  }
  await emailInput.fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();  if (!(await visible(page, page.getByText("Check your email"), 15000))) {
    const alert = await page
      .locator('[role="alert"]')
      .first()
      .textContent()
      .catch(() => null);
    return {
      ok: false,
      reason: `code entry step did not appear${alert ? ` (alert: ${alert.trim().slice(0, 200)})` : ""}`,
    };
  }
  const code = await pendingOtp(page, email);
  if (!code) {
    return { ok: false, reason: "pending OTP not captured (dev gate off?)" };
  }
  await page.locator('input[data-slot="input-otp"]').first().fill(code);
  await page.getByRole("button", { name: "Verify code" }).click();
  try {
    await page.waitForURL("**/dashboard", { timeout: 25000 });
  } catch {
    return { ok: false, reason: "OTP sign-in did not reach /dashboard" };
  }
  // The member's provisioning must be resolved by their own session.
  if (
    !(await visible(
      page,
      page.getByRole("heading", { name: "Executive Dashboard" }),
      25000,
    ))
  ) {
    return { ok: false, reason: "dashboard heading not visible after OTP sign-in" };
  }
  return { ok: true };
}

/** Provision `email` through the Administration UI as the current admin. */
async function provisionViaUi(
  page: Page,
  email: string,
  jobTitle: string,
): Promise<{ provisioned: boolean; refused: boolean; diag?: string[] }> {
  await page
    .getByText("Administration", { exact: true })
    .first()
    .waitFor({ state: "visible", timeout: 15000 });
  await page.getByRole("link", { name: "Users", exact: true }).first().click();
  await page.waitForURL("**/admin/users");
  await page
    .getByRole("heading", { name: "Users" })
    .waitFor({ state: "visible", timeout: 20000 });

  await page.getByRole("button", { name: "Add Existing User" }).click();
  await page.getByLabel("Verified user email").fill(email);
  await page.getByLabel("Initial organization role").click();
  await page.getByRole("option", { name: "Member", exact: true }).first().click();
  await page.getByLabel("Job title (optional)").fill(jobTitle);
  await page.getByRole("button", { name: "Review and provision" }).click();
  const confirmed = await visible(
    page,
    page.getByRole("button", { name: "Confirm provisioning" }),
    10000,
  );
  if (!confirmed) {
    const t = await page.locator("[data-sonner-toast]").allTextContents().catch(() => []);
    return { provisioned: false, refused: false, diag: t };
  }
  await page.getByRole("button", { name: "Confirm provisioning" }).click();

  const prost = await visible(
    page,
    page.getByText(/provisioned with initial role Member/),
    15000,
  );
  if (prost) return { provisioned: true, refused: false };
  const refst = await visible(
    page,
    page.getByText(/not eligible for provisioning into your organization/),
    10000,
  );
  if (refst) return { provisioned: false, refused: true };
  const toasts = await page.locator("[data-sonner-toast]").allTextContents().catch(() => []);
  return { provisioned: false, refused: false, diag: toasts } as never;
}

describe("IITAMS Phase 3A Batch 2B — effective membership with independent sessions", () => {
  test(
    "provisioned member authenticates and holds exactly the granted access",
    async () => {
      requireEnv();
      if (!serverUp || !browser) return;

      // ------------------------------------------------------------------
      // Identity A — administrator (guest session escalated via dev bridge)
      // ------------------------------------------------------------------
      const a = await newPage();
      const signIn = await signInAsGuest(a.page);
      if (!signIn.ok) {
        if (SOFT) {
          console.warn(`[e2e:SKIPPED] effective-membership: ${signIn.reason}`);
          await a.page.close();
          return;
        }
        throw new Error(`E2E GATE FAILED: administrator — ${signIn.reason}`);
      }
      if (!(await becomeDemoAdmin(a.page))) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] effective-membership: admin bridge unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: admin bridge unavailable");
      }

      // ------------------------------------------------------------------
      // A provisions an existing verified user via the UI
      // ------------------------------------------------------------------
      const email = `eff2b-${Date.now()}@test.example`;
      const seeded = await a.page.evaluate(async (addr) => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { seedVerifiedTestUser(email: string): Promise<{ ok: boolean }> | undefined }
          | undefined;
        if (!qa) return false;
        try {
          return (await qa.seedVerifiedTestUser(addr))?.ok ?? false;
        } catch {
          return false;
        }
      }, email);
      if (!seeded) {
        if (SOFT) {
          console.warn("[e2e:SKIPPED] effective-membership: test-identity seeder unavailable");
          await a.page.close();
          return;
        }
        throw new Error("E2E GATE FAILED: test-identity seeder unavailable");
      }

      const result = await provisionViaUi(a.page, email, "Effective Membership Officer");
      expect(result.provisioned).toBe(true);

      const adminSession = await sessionInfo(a.page);
      const adminOrgId = adminSession?.organization?.id ?? null;
      const adminLabel = adminSession?.name ?? "";
      expect(adminOrgId).not.toBeNull();

      // ------------------------------------------------------------------
      // Identity B — the member's OWN session (real email-OTP sign-in)
      // ------------------------------------------------------------------
      const b = await newPage();
      const memberSignIn = await signInWithOtp(b.page, email);
      if (!memberSignIn.ok) {
        if (SOFT) {
          console.warn(
            `[e2e:SKIPPED] effective-membership (member session): ${memberSignIn.reason}`,
          );
          await a.page.close();
          await b.page.close();
          return;
        }
        throw new Error(
          `E2E GATE FAILED: member's own session — ${memberSignIn.reason}`,
        );
      }

      // Exactly the intended organization and role, resolved from B's session.
      const member = await sessionInfo(b.page);
      expect(member).not.toBeNull();
      expect(member!.isProvisioned).toBe(true);
      expect(member!.awaitingProvisioning).toBe(false);
      expect(member!.email).toBe(email);
      expect(member!.role).toBe("member");
      expect(member!.organization?.id).toBe(adminOrgId);
      expect(member!.membershipStatus).toBe("active");

      // Authorized functionality is accessible with the member's own session:
      // the dashboard resolved a permitted module link is offered.
      expect(member!.permissions.dashboard).toBe(true);
      expect(member!.permissions.audit).toBe(true);
      expect(
        await visible(
          b.page,
          b.page.getByRole("link", { name: "Audit Universe", exact: true }).first(),
          10000,
        ),
      ).toBe(true);

      // Unauthorized functionality: no Administration surface in the UI and
      // the admin.view–guarded backend query is DENIED for B's session.
      expect(member!.permissions.admin).toBe(false);
      expect(member!.permissions.adminManage).toBe(false);
      expect(
        await visible(
          b.page,
          b.page.getByText("Administration", { exact: true }).first(),
          5000,
        ),
      ).toBe(false);
      const denial = await b.page.evaluate(async () => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { probeAdminApi?(): Promise<{ denied: boolean }> }
          | undefined;
        if (!qa?.probeAdminApi) return null;
        try {
          return await qa.probeAdminApi();
        } catch {
          return { denied: true };
        }
      });
      expect(denial).not.toBeNull();
      expect(denial!.denied).toBe(true);

      // Cross-organization data remains inaccessible: B's session carries
      // exactly ONE organization (the provisioning one) — the backend has no
      // client-supplied-tenant surface, and admin cross-org listings are
      // denied by the probe above.
      expect(member!.organization?.id).toBe(adminOrgId);

      // ------------------------------------------------------------------
      // Administration: suspend the membership — B's OWN session degrades
      // ------------------------------------------------------------------
      const row = a.page.locator("tbody tr").filter({ hasText: email }).first();
      expect(await visible(a.page, row, 10000)).toBe(true);
      await row.getByRole("button", { name: "Suspend" }).click();
      // Directory reacts to the server-enforced lifecycle change.
      // StatusChip renders "Suspended" + a sr-only " status" suffix.
      const chipVisible = await visible(a.page, row.getByText(/^Suspended/), 12000);
      if (!chipVisible) {
        const toasts = await a.page
          .locator('[data-sonner-toast]')
          .allTextContents()
          .catch(() => []);
        const rowText = await row.textContent().catch(() => null);
        throw new Error(
          `Suspend did not reflect in the directory: toasts=${JSON.stringify(toasts)} row=${(rowText ?? "").slice(0, 300)}`,
        );
      }
      await row.getByText(/^Suspended/).waitFor({
        state: "visible",
        timeout: 1000,
      });

      // B's live (still signed-in) session is refused organization context:
      const suspended = await sessionInfo(b.page);
      expect(suspended!.isProvisioned).toBe(false);
      expect(suspended!.awaitingProvisioning).toBe(true);
      expect(suspended!.membershipStatus).toBe("suspended");
      expect(suspended!.organization).toBeNull();
      expect(suspended!.role).toBeNull();
      expect(suspended!.permissions.dashboard).toBe(false);

      // Re-provisioning the suspended member is refused at the backend
      // authorization boundary (probe reports ONLY the refusal decision).
      const dup1 = await a.page.evaluate(async (addr) => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { probeProvision?(_email: string): Promise<{ refused: boolean }> }
          | undefined;
        if (!qa?.probeProvision) return null;
        try {
          return await qa.probeProvision(addr);
        } catch {
          return { refused: true };
        }
      }, email);
      expect(dup1).not.toBeNull();
      expect(dup1!.refused).toBe(true);
      const rowNow = a.page.locator("tbody tr").filter({ hasText: email }).first();
      await rowNow.getByRole("button", { name: "Reactivate" }).click();
      await rowNow.getByText(/^Active/).first().waitFor({
        state: "visible",
        timeout: 15000,
      });
      await rowNow.getByRole("button", { name: "Deactivate" }).click();
      await rowNow.getByText(/^Deactivated/).waitFor({
        state: "visible",
        timeout: 15000,
      });
      const deactivated = await sessionInfo(b.page);
      expect(deactivated!.membershipStatus).toBe("deactivated");
      expect(deactivated!.organization).toBeNull();

      const dup2 = await a.page.evaluate(async (addr) => {
        const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
          | { probeProvision?(_email: string): Promise<{ refused: boolean }> }
          | undefined;
        if (!qa?.probeProvision) return null;
        try {
          return await qa.probeProvision(addr);
        } catch {
          return { refused: true };
        }
      }, email);
      expect(dup2).not.toBeNull();
      expect(dup2!.refused).toBe(true);

      // ------------------------------------------------------------------
      // Audit integrity: the suspension entry separates actor from target.
      // ------------------------------------------------------------------
      await a.page.getByRole("link", { name: "Audit Logs" }).first().click();
      await a.page.waitForURL("**/admin/audit-logs");
      const suspendedEntry = a.page
        .locator("tbody tr")
        .filter({ hasText: "user.membership_suspended" })
        .first();
      expect(await visible(a.page, suspendedEntry, 20000)).toBe(true);
      // Audit integrity: the entry separates ACTOR from TARGET. The summary
      // now carries the TARGET's display label (the dev-seeded identity's
      // name is the email's local part), the action is attributed to the
      // administrator (actor), and the two identities are distinct.
      const entryText = await suspendedEntry.textContent().catch(() => "");
      expect(entryText).toContain(email.split("@")[0]); // TARGET label in summary
      expect(entryText).toContain("by administrator"); // actor attribution
      expect(entryText).toContain("Administrator"); // ACTOR label column
      // Actor (administrator) and target (provisioned member) are distinct.
      expect(adminLabel).not.toContain(email.split("@")[0]);

      // No page errors on either identity's session.
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);

      await a.page.close();
      await b.page.close();
    },
    300000,
  );
});
