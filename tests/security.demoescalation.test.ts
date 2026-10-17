import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api, internal } from "../src/convex/_generated/api";

/**
 * IITAMS demo-escalation hardening — REAL backend authorization boundary.
 * =====================================================================
 * Tests the actually deployed boundary of trusted demo-role granting (not
 * just source text):
 *
 *  1. the old public self-escalation mutations no longer exist — the
 *     deployment refuses every client-initiated escalation attempt;
 *  2. the ONLY entry point is the token-guarded HTTP harness route
 *     POST /api/dev-grant-demo-role (+ /api/dev-revoke-demo-role), which
 *     refuses without a token / with a wrong token (uniform 403, no oracle);
 *  3. ordinary demo guests cannot self-escalate (the QA bridge exposes no
 *     escalation helper and no public escalation mutation remains);
 *  4. unknown / unsupported roles are rejected outright;
 *  5. a legitimate trusted-runner grant operates on a real anonymous guest
 *     with an explicit demo membership and is visible in the target's own
 *     session resolution (api.session.getSession);
 *  6. revocation restores the read-only member tier;
 *  7. audit-log immutability and actor/target attribution;
 *  8. no tester credential reaches the browser runtime or bundle surface.
 */

const CONVEX_URL = process.env.VITE_CONVEX_URL ?? "http://127.0.0.1:3210";
const HARNESS =
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

const client = new ConvexHttpClient(CONVEX_URL);

const token = testerToken();
const harnessConfigured = Boolean(token);

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

async function harness(
  path: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<Response> {
  return await fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

/** A real guest session exactly as the anonymous provider creates it. */
async function signInAnonymous(): Promise<ConvexHttpClient> {
  const guest = new ConvexHttpClient(CONVEX_URL);
  const result = (await (guest as unknown as {
    action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
  }).action(api.auth.signIn, { provider: "anonymous", params: {} })) as {
    tokens?: { token?: string; accessToken?: string };
  };
  const jwt = result.tokens?.token ?? result.tokens?.accessToken;
  if (jwt) (guest as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
  return guest;
}

describe("demo escalation — backend authorization boundary", () => {
  test("the old public self-escalation mutations no longer exist client-side", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    // The public API surface must expose no escalation mutation at all.
    const publicNames = Object.keys(
      api.session as unknown as Record<string, unknown>,
    ).sort();
    expect(publicNames).not.toContain("requestDemoRoleUpgrade");
    expect(publicNames).not.toContain("requestDemoAdminUpgrade");
  }, 30000);

  test("unauthenticated callers cannot elevate roles (internal reference refused)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    // The replacement is internal: a client-initiated call through the
    // internal reference is refused by the deployment itself.
    const attempt = client
      .mutation(internal.session.grantDemoTestRole, {
        userId: "jdemo0000000000000000000000000",
      } as never)
      .then((r) => JSON.stringify(r));
    await expect(attempt).rejects.toThrow();
  }, 30000);

  test("ordinary demo guests cannot self-escalate (guest session, no escalation path)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    const guest = await signInAnonymous();
    const session = (await guest.query(api.session.getSession, {})) as {
      isAnonymous?: boolean;
      role?: string | null;
    } | null;
    expect(session).not.toBeNull();
    expect(session!.isAnonymous).toBe(true);
    // The guest resolves a role only through the demo-org bootstrap (member),
    // never an escalated tier — there is no callable path for escalation.
    expect(session!.role === "member" || session!.role === null).toBe(true);
  }, 30000);

  test("harness grant route refuses missing tester token (uniform 403)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    const missing = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "jx" }),
    });
    expect(missing.status).toBe(403);
    expect(await missing.text()).toBe("{\"error\":\"unauthorized\"}");
  }, 30000);

  test("harness grant route refuses wrong tester token (identical 403, no oracle)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    const wrong = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": "definitely-wrong-token",
      },
      body: JSON.stringify({ userId: "jx" }),
    });
    const missing = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "jx" }),
    });
    expect(wrong.status).toBe(403);
    expect(await wrong.text()).toBe(await missing.text());
    // The revoke route refuses equally.
    const wrongRevoke = await fetch(`${HARNESS}/api/dev-revoke-demo-role`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": "bad",
      },
      body: JSON.stringify({ userId: "jx" }),
    });
    expect(wrongRevoke.status).toBe(403);
  }, 30000);

  test("harness grant route rejects unknown or unsupported roles", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness token unavailable");
    }
    const res = await harness("/api/dev-grant-demo-role", {
      userId: "jsynth000000000000000000000000",
      role: "super_admin",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("unknown or unsupported");
  }, 30000);

  test("non-anonymous targets are refused (real identity via the trusted seeder)", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness token unavailable");
    }
    // A REAL non-anonymous identity (verified email, isAnonymous=false),
    // created through the trusted seeder — never a fabricated id.
    const email = `demoesc-nonanon-${Date.now()}@test.example`;
    const seedRes = await fetch(`${HARNESS}/api/dev-seed-test-user`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": token,
      },
      body: JSON.stringify({ email }),
    });
    expect(seedRes.status).toBe(200);
    const seeded = (await seedRes.json()) as { ok?: boolean; userId?: string };
    expect(seeded.ok).toBe(true);
    expect(seeded.userId).toBeTruthy();

    // The grant route must refuse this real, non-anonymous target.
    const res = await harness("/api/dev-grant-demo-role", {
      userId: seeded.userId,
      role: "audit_manager",
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(
      "only to anonymous guest identities",
    );
  }, 60000);

  test("legitimate trusted-runner grant works and is visible in the guest's own session", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness token unavailable");
    }
    // Real guest sign-in via the anonymous provider + the app's own audited
    // provisioning path (joinDemoOrganization), then a trusted-runner grant.
    const guest = await signInAnonymous();
    await guest.mutation(api.session.joinDemoOrganization, {});
    const session = (await guest.query(api.session.getSession, {})) as
      | { userId?: string }
      | null;
    const userId = session?.userId;
    expect(userId).toBeTruthy();

    const res = await harness("/api/dev-grant-demo-role", {
      userId,
      role: "audit_manager",
      ttlMinutes: 5,
    });
    expect(res.status).toBe(200);
    const grant = (await res.json()) as {
      ok?: boolean;
      role?: string;
      expiresAt?: number;
    };
    expect(grant.ok).toBe(true);
    expect(grant.role).toBe("audit_manager");
    expect(grant.expiresAt).toBeGreaterThan(Date.now());

    // #11: the granted role is visible in the target's authenticated session.
    const elevated = (await guest.query(api.session.getSession, {})) as
      | { role?: string | null }
      | null;
    expect(elevated?.role).toBe("audit_manager");
  }, 60000);

  test("server-enforced expiry: a lapsed grant no longer authorizes the elevated tier", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness token unavailable");
    }
    const guest = await signInAnonymous();
    await guest.mutation(api.session.joinDemoOrganization, {});
    const userId = (
      (await guest.query(api.session.getSession, {})) as { userId?: string }
    )!.userId;

    // ~1.8s TTL.
    const res = await harness("/api/dev-grant-demo-role", { userId, ttlMinutes: 0.03 });
    expect((await res.json() as { ok?: boolean }).ok).toBe(true);

    // Let the measured deadline lapse, then persist the expiry through the
    // trusted harness sweep (a server-side write; the resolver also refuses
    // expired grants at every fresh read — source-guarded in phase3a).
    await new Promise((r) => setTimeout(r, 3000));
    const sweep = await harness("/api/dev-expire-demo-grants", {});
    expect(sweep.status).toBe(200);
    const expiredCount = ((await sweep.json()) as { expired?: number }).expired ?? 0;
    expect(expiredCount).toBeGreaterThan(0);

    // The target's session resolves the expired grant to the read-only tier.
    const after = (await guest.query(api.session.getSession, {})) as {
      role?: string | null;
    } | null;
    expect(after?.role ?? "member").toBe("member");
  }, 60000);

  test("trusted-runner revocation restores the read-only tier", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness token unavailable");
    }
    const guest = await signInAnonymous();
    await guest.mutation(api.session.joinDemoOrganization, {});
    const userId = ((await guest.query(api.session.getSession, {})) as { userId?: string })!.userId;

    const grantRes = await harness("/api/dev-grant-demo-role", { userId, role: "admin", ttlMinutes: 5 });
    expect((await grantRes.json() as { ok?: boolean }).ok).toBe(true);
    expect(((await guest.query(api.session.getSession, {})) as { role?: string | null }).role).toBe("admin");

    const rev = await harness("/api/dev-revoke-demo-role", { userId });
    expect(rev.status).toBe(200);
    expect(((await rev.json()) as { ok?: boolean }).ok).toBe(true);
    expect(((await guest.query(api.session.getSession, {})) as { role?: string | null }).role).toBe("member");
  }, 60000);

  test("audit logs identify the harness as ACTOR and stay append-only", async () => {
    // Append-only: no backend module patches, replaces or deletes auditLogs.
    for (const file of ["src/convex/session.ts", "src/convex/admin.ts"]) {
      const src = await Bun.file(file).text();
      expect(src).not.toMatch(/ctx\.db\.(patch|replace|delete)\("auditLogs"/);
    }
    const sessionSrc = await Bun.file("src/convex/session.ts").text();
    // Actor = trusted harness (never the guest), action names are explicit.
    expect(sessionSrc).toContain('actorLabel: "trusted test harness (server-side)"');
    expect(sessionSrc).toContain("user.demo_role_granted");
    expect(sessionSrc).toContain("user.demo_role_revoked");
    // Target = the guest profile row the grant concerns.
    expect(sessionSrc).toContain("userId: args.userId");
  }, 30000);

  test("no tester credential reaches the browser runtime or bundle surface", async () => {
    // The QA bridge exposes no escalation helpers and carries no secret.
    const devToolsSrc = await Bun.file("src/dev/DevTools.tsx").text();
    expect(devToolsSrc).not.toContain("upgradeDemoRole");
    expect(devToolsSrc).not.toContain("becomeDemoAdmin");
    expect(devToolsSrc).not.toContain("IITAMS_TESTER_TOKEN");
    expect(devToolsSrc).not.toContain("x-iitams-tester-token");
    // Browser-facing bundle surfaces have no token references either.
    for (const file of ["vite.config.ts", "index.html", "src/main.tsx"]) {
      const src = await Bun.file(file).text();
      expect(src).not.toContain("IITAMS_TESTER_TOKEN");
    }
    // The token is read ONLY by the backend http harness (process.env).
    const httpSrc = await Bun.file("src/convex/http.ts").text();
    expect(httpSrc).toContain("process.env.IITAMS_TESTER_TOKEN");
  }, 30000);
});
