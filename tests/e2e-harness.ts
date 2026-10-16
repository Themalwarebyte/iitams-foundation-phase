import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";

/**
 * Trusted server-side test-harness helpers (demo-escalation hardening).
 * ======================================================================
 * Browser suites NEVER escalate roles through the browser: the QA bridge
 * exposes no escalation helpers. The runner instead
 *
 *   1. reads the guest's own userId through the existing authorized session
 *      query (window.__IITAMS_DEV_QA__.whoAmI — no secret involved), then
 *   2. calls the token-guarded HTTP harness routes directly from the runner
 *      (POST /api/dev-grant-demo-role, POST /api/dev-revoke-demo-role).
 *
 * The tester token lives only in the runner environment / gitignored runner
 * file; it is never sent through page.evaluate, headers, localStorage,
 * cookies or any client-side code.
 */

// Convex httpAction routes live on the deployment's HTTP (site) URL.
export const HARNESS_URL =
  process.env.VITE_CONVEX_SITE_URL ?? "http://127.0.0.1:3211";

export function testerToken(): string {
  const fromEnv = process.env.IITAMS_TESTER_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    return readFileSync(join(process.cwd(), ".iitams-tester-token"), "utf8").trim();
  } catch {
    throw new Error(
      "E2E BLOCKED: trusted test-runner token not configured (expected IITAMS_TESTER_TOKEN in the runner environment or the gitignored .iitams-tester-token file) — role setup must go through the trusted server-side harness, not the browser",
    );
  }
}

export async function harnessPost(
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

export type DemoTestRole = "audit_manager" | "admin";

type QaBridge = {
  whoAmI(): Promise<{ userId: string } | null> | { userId: string } | null;
};

/** The signed-in guest's own userId, obtained through the session query. */
async function guestUserId(page: Page): Promise<string | null> {
  return await page.evaluate(async () => {
    const qa = (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ as
      | QaBridge
      | undefined;
    if (!qa?.whoAmI) return null;
    try {
      const session = await qa.whoAmI();
      const userId = (session as { userId?: string } | null)?.userId;
      return typeof userId === "string" ? userId : null;
    } catch {
      return null;
    }
  });
}

/** Every guest userId this runner has escalated (for teardown revocation). */
const escalatedGuests: string[] = [];

/**
 * Trusted-runner role grant: escalates the CURRENT browser guest session to
 * the approved demo test role. Retries briefly — AppLayout's provisioning
 * effect (joinDemoOrganization) must have established the explicit demo
 * membership before the backend honors the grant.
 */
export async function grantDemoTestRole(
  page: Page,
  role: DemoTestRole,
  ttlMinutes?: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const userId = await guestUserId(page);
    if (userId) {
      try {
        const res = await harnessPost("/api/dev-grant-demo-role", {
          userId,
          role,
          ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
        });
        if (res.ok) {
          if (!escalatedGuests.includes(userId)) escalatedGuests.push(userId);
          return true;
        }
      } catch {
        // token/network failures fall through to the retry-until-deadline loop
      }
    }
    await page.waitForTimeout(1000);
  }
  return false;
}

/**
 * Trusted-runner revocation: restores the CURRENT browser guest session to
 * the read-only member tier (used both for explicit lifecycle tests and for
 * hygiene between phase steps).
 */
export async function revokeDemoTestRole(page: Page): Promise<boolean> {
  const userId = await guestUserId(page);
  if (!userId) return false;
  try {
    const res = await harnessPost("/api/dev-revoke-demo-role", { userId });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Runner-side sweep: persist every expired demo test grant (the trusted
 * harness route also runs this on grant/revoke). Returns the backend's
 * expired-per-profile count.
 */
export async function sweepExpiredDemoGrants(): Promise<number | null> {
  try {
    const res = await harnessPost("/api/dev-expire-demo-grants", {});
    if (!res.ok) return null;
    const data = (await res.json()) as { expired?: number };
    return data.expired ?? null;
  } catch {
    return null;
  }
}

/**
 * Teardown: revoke every privilege this runner granted (best-effort, so a
 * crashed test run can never leave an elevated demo guest behind).
 */
export async function revokeAllEscalatedGuests(): Promise<void> {
  const targets = escalatedGuests.splice(0, escalatedGuests.length);
  for (const userId of targets) {
    try {
      const res = await harnessPost("/api/dev-revoke-demo-role", { userId });
      if (!res.ok) {
        console.warn(`[teardown:WARN] revoke refused for the escalated guest (HTTP ${res.status})`);
      }
    } catch (err) {
      console.warn(`[teardown:WARN] revoke failed: ${String(err).slice(0, 200)}`);
    }
  }
}
