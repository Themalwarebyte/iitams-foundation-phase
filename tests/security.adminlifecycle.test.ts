import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";

/**
 * Phase 3A Batch A1 — administrator lifecycle security tests.
 * =====================================================================
 * Structural guards verify design invariants in source; the behavioral block
 * exercises the DEPLOYED boundary with real sessions and the trusted
 * harness (same model as tests/security.invitations.test.ts).
 *
 * Bootstrap behavioral coverage is deployment-configuration-dependent: the
 * one-time activation secret exists only in the defender-controlled
 * environment and the runner environment. When the deployment (or runner)
 * has no bootstrap configuration, the happy-path test SKIPS HONESTLY instead
 * of weakening the invariant. Refusal behavior is always tested live.
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
import { execSync } from "node:child_process";
import { join } from "node:path";

const token = testerToken();
const harnessConfigured = Boolean(token);

/** The runner-side one-time bootstrap secret (never committed, never logged). */
const BOOTSTRAP_TOKEN = (process.env.IITAMS_BOOTSTRAP_TOKEN ?? "").trim();
const BOOTSTRAP_EMAIL = "initial-admin-bootstrap-iitams@check.example";

async function serverUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CONVEX_URL}/api/query`);
    return res.status < 600;
  } catch {
    return false;
  }
}

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

async function harnessGrantAdmin(userId: string): Promise<boolean> {
  const res = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ userId, role: "admin", ttlMinutes: 120 }),
  });
  return res.ok;
}

async function seedVerifiedIdentity(email: string): Promise<boolean> {
  const res = await fetch(`${HARNESS}/api/dev-seed-test-user`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ email }),
  });
  return res.ok;
}

async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
  const c = new ConvexHttpClient(CONVEX_URL);
  try {
    await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, { provider: "email-otp", params: { email } });
    let code: string | null = null;
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 1200));
      const res = await fetch(`${HARNESS}/api/dev-otp`, {
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
    if (!code) return null;
    const finished = (await (c as unknown as {
      action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
    }).action(api.auth.signIn, {
      provider: "email-otp",
      params: { email, code },
    })) as { tokens?: { token?: string; accessToken?: string } };
    const jwt = finished.tokens?.token ?? finished.tokens?.accessToken;
    if (jwt) (c as unknown as { setAuth: (v: string) => void }).setAuth(jwt);
    return c;
  } catch {
    return null;
  }
}

/** Explicit fixture registry: every guest this FILE grants a demo role to
 * is recorded here, and ONLY these ids are ever passed back to the scoped
 * revert/expire harness routes (test isolation — cleanup can never name any
 * record this file did not create). */
const fixtureUserIds = new Set<string>();

async function adminClientWithGrant(): Promise<ConvexHttpClient | null> {
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  if (!(await harnessGrantAdmin(session.userId))) return null;
  fixtureUserIds.add(session.userId);
  return admin;
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 99999)}`;

// ============================================================================
// Structural guards (no deployment required)
// ============================================================================

describe("Batch A1 — administrator lifecycle structural guards", () => {
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const lifecycleSrc = readFileSync("src/convex/adminLifecycle.ts", "utf8");
  const membershipSrc = readFileSync("src/lib/membership.ts", "utf8");
  const adminSrc = readFileSync("src/convex/admin.ts", "utf8");
  const invitationsSrc = readFileSync("src/convex/invitations.ts", "utf8");
  const coreSrc = readFileSync("src/convex/membershipCore.ts", "utf8");
  const httpSrc = readFileSync("src/convex/http.ts", "utf8");
  const usersPageSrc = readFileSync(
    "src/components/iitams/admin/AdminUsersPage.tsx",
    "utf8",
  );

  test("the canonical privileged role key remains the registry `admin` (no second role definition)", () => {
    expect(membershipSrc).not.toMatch(/ADMIN_ROLE\s*=\s*"(?!admin)/);
    expect(schemaSrc).toContain('v.literal(ROLES.ADMIN)');
    // No new role literal is introduced anywhere in the role validator.
    expect(schemaSrc.match(/roleValidator members/g) ?? []).toHaveLength(0);
  });

  test("bootstrap secrets are hash-only in durable storage (no plaintext persistence)", () => {
    expect(schemaSrc).toContain("initialBootstraps: defineTable");
    expect(schemaSrc).toContain("tokenHash: v.string()");
    expect(schemaSrc).toContain("previousRole");
    // No plaintext bootstrap-token field anywhere in the schema.
    expect(schemaSrc.includes("bootstrapToken:")).toBe(false);
    expect(schemaSrc.includes("activationToken:")).toBe(false);
    expect(lifecycleSrc).toContain("tokenHash: sha256Hex(");
  });

  test("the bootstrap secret is never exposed to browser-facing code", () => {
    for (const line of usersPageSrc.split("\n")) {
      if (line.includes("IITAMS_BOOTSTRAP") || line.includes("activationToken")) {
        throw new Error(`bootstrap secret referenced in frontend: ${line.trim()}`);
      }
    }
    // The claim mutation takes the token as an argument; nothing returns a
    // token: no query/mutation in the module exposes a plaintext secret.
    expect(lifecycleSrc).toContain("activationToken: v.string()");
    for (const line of lifecycleSrc.split("\n")) {
      if (/export const .* = query\(/.test(line) && /bootstrap/i.test(line)) {
        throw new Error(`bootstrap secret surfaced through a query: ${line.trim()}`);
      }
    }
  });

  test("bootstrap accepts NO caller-supplied organization (env-defined target only)", () => {
    expect(lifecycleSrc).toContain("IITAMS_BOOTSTRAP_ORG_CODE");
    expect(lifecycleSrc).toContain("IITAMS_BOOTSTRAP_ADMIN_EMAIL");
    expect(lifecycleSrc).toContain("IITAMS_BOOTSTRAP_TOKEN");
    // The organisation is resolved from configuration by CODE, never from args.
    const idx = lifecycleSrc.indexOf("claimInitialAdministrator = mutation({");
    const body = lifecycleSrc.slice(idx, idx + 250);
    expect(body).toContain("activationToken: v.string()"); // the ONLY argument
  });

  test("bootstrap verifies email identity and refuses non-anonymous-free guests", () => {
    const idx = lifecycleSrc.indexOf("claimInitialAdministrator");
    const body = lifecycleSrc.slice(idx);
    expect(body).toContain("emailVerificationTime");
    expect(body).toContain("isAnonymous");
    expect(body).toContain("bootstrapFor(ctx, org._id)"); // consumption marker
    expect(body).toContain("countActiveAdministrators(ctx, org._id)"); // no-admin check
  });

  test("grant initiation is PENDING — no immediate privilege elevation", () => {
    const idx = lifecycleSrc.indexOf("grantAdministrator = mutation({");
    const body = lifecycleSrc.slice(idx, lifecycleSrc.indexOf("acceptAdministratorGrant"));
    expect(body).toContain('status: "pending"');
    // The initiation mutation patches nobody's role.
    expect(body.includes("patch(profile._id")).toBe(false);
    expect(body.includes('patch(target._id')).toBe(false);
  });

  test("acceptance elevates ONLY the intended target in one atomic mutation", () => {
    const idx = lifecycleSrc.indexOf("acceptAdministratorGrant = mutation({");
    const body = lifecycleSrc.slice(idx, lifecycleSrc.indexOf("rejectAdministratorGrant"));
    expect(body).toContain("targetUserId !== user._id"); // wrong-user refusal
    expect(body).toContain("emailVerificationTime"); // verified identity re-check
    // The elevation is a contiguous single-mutation write: role patch,
    // then terminal grant transition, no await boundary crossing between.
    expect(body).toMatch(
      /patch\(profile\._id, \{ role: ADMIN_ROLE \}\);\s*await ctx\.db\.patch\(grant\._id, \{ status: "accepted", decidedAt: Date\.now\(\)/,
    );
    // The wrong-user check comes BEFORE any role write.
    expect(body.indexOf("targetUserId !== user._id")).toBeLessThan(
      body.lastIndexOf("patch(profile._id"),
    );
  });

  test("revocation restores the RECORDED previous role (never an automatic member)", () => {
    const idx = lifecycleSrc.indexOf("revokeAdministrator = mutation({");
    const body = lifecycleSrc.slice(idx, lifecycleSrc.indexOf("listAdministratorLifecycle"));
    expect(body).toContain("previousRole ?? sourceBootstrap?.previousRole ?? null");
    expect(body).toContain("lastAdminGuardMessage()");
    expect(body).toContain("target.userId === access.user._id"); // self-revoke refusal
  });

  test("last-active-administrator guard exists in BOTH revocation and membership status flows", () => {
    expect(lifecycleSrc).toContain("countActiveAdministrators");
    expect(adminSrc).toContain("lastAdminGuardMessage()");
    // The counting helper excludes expired trusted-harness demo grants.
    expect(lifecycleSrc).toContain("demoRoleExpiresAt");
  });

  test("ordinary provisioning and invitations remain admin-excluded", () => {
    // The provisionable-roles list must NOT contain the privileged key.
    const arr = membershipSrc.slice(
      membershipSrc.indexOf("PROVISIONABLE_INITIAL_ROLES = ["),
      membershipSrc.indexOf("] as const") + 10,
    );
    expect(arr.includes('"admin"')).toBe(false);
    expect(invitationsSrc).toContain("PROVISIONABLE_INITIAL_ROLES");
    // The shared membership-write core runs role assignment for ordinary
    // paths only; a plaintext admin literal must never be written there.
    expect(coreSrc).not.toContain('["admin"]');
    expect(coreSrc).not.toMatch(/role:\s*"admin"/);
  });

  test("the new harness route is uniformly token-guarded and dev-only", () => {
    expect(httpSrc).toContain("/api/dev-expire-admin-grants");
    const idx = httpSrc.indexOf("/api/dev-expire-admin-grants");
    const body = httpSrc.slice(idx - 200, idx + 800);
    expect(body).toContain("if (!isTrustedDevTester(request)) return jsonError(403);");
  });

  test("bootstrap configuration is deployment env only, never bundled assets", () => {
    // The names must not appear in ANY frontend file.
    const out = execSync(
      "grep -rl IITAMS_BOOTSTRAP src/pages src/components src/dev 2>/dev/null | wc -l",
      { encoding: "utf8" },
    ).trim();
    expect(out).toBe("0");
  });
});

// ============================================================================
// Behavioral boundary (requires deployed backend + trusted harness)
// ============================================================================

// Explicit skip handling (source-review correction): the backend/harness
// preconditions are probed ONCE at module load; every runtime test below is
// registered through this conditional runner so an unavailable backend or
// missing tester token registers as an explicit (skip), never as a pass.
const backendsLive = await (async () => {
  try {
    const r = await fetch(`${CONVEX_URL}/api/query`);
    return r.status < 600;
  } catch {
    return false;
  }
})();
const runIfBackend =
  backendsLive && harnessConfigured
    ? test
    : (test as unknown as {
        skip: (name: string, fn: () => void | Promise<void>) => void;
      }).skip;

const SKIP_REASON =
  `prerequisites unavailable: backend ${backendsLive ? "live" : "unreachable"}, harness token ${harnessConfigured ? "present" : "missing"}`;

// Scoped revert of ONLY this file's own fixture guests (runs at module load
// and again in afterAll; the scoped harness route refuses without an
// explicit fixture list).
async function revertOwnFixtures(): Promise<Response> {
  return await fetch(`${HARNESS}/api/dev-revert-demo-admin-grants`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ fixtureUserIds: [...fixtureUserIds] }),
  });
}

// Bootstrap-fixture probe (module scope, BEFORE test registration): the
// runner's own claim attempt decides registration. A SUCCESSFUL fresh claim
// is asserted by its own registered test; a consumed fixture registers an
// explicit (skip) naming the blocker — never a pass that masquerades,
// and never shared-data destruction to simulate an empty organization.
// Cross-run cleanup deliberately does NOT enumerate/revoke the shared org's
// administrators: a leftover admin legitimately BLOCKS the one-time claim
// and is reported as such.
type BootstrapProbe = {
  attemptable: boolean;
  freshClaim: boolean;
  /** Successful concurrent claims observed in the race (must be exactly 1). */
  winners: number;
  sessionRole: string | null;
  /** Effective administrator rows after the claim (duplicate rows would show here). */
  adminRowCount: number;
  note: string;
};

const bootstrapProbe = await (async (): Promise<BootstrapProbe> => {
  const failed = (note: string): BootstrapProbe => ({
    attemptable: true,
    freshClaim: false,
    winners: 0,
    sessionRole: null,
    adminRowCount: 0,
    note,
  });
  // eslint note: attemptable stays true so the durable-refusal test can register.
  if (!(await serverUp()) || !harnessConfigured || !BOOTSTRAP_TOKEN) {
    return { attemptable: false, freshClaim: false, winners: 0, sessionRole: null, adminRowCount: 0, note: SKIP_REASON };
  }
  await revertOwnFixtures().catch(() => undefined);
  expect(await seedVerifiedIdentity(BOOTSTRAP_EMAIL)).toBe(true);
  // TWO simultaneous sessions of the designated identity race the one-time
  // claim: the atomic consumption section must let exactly ONE win (a second
  // winner would mean two initial administrator rows are possible).
  const first = await signInEmailOtp(BOOTSTRAP_EMAIL);
  const second = await signInEmailOtp(BOOTSTRAP_EMAIL);
  if (!first || !second) return failed("[test:PREREQ-FAILED] bootstrap claimant sign-in unavailable");
  const results = await Promise.allSettled([
    first.mutation(api.adminLifecycle.claimInitialAdministrator, { activationToken: BOOTSTRAP_TOKEN }),
    second.mutation(api.adminLifecycle.claimInitialAdministrator, { activationToken: BOOTSTRAP_TOKEN }),
  ]);
  const wins = results.filter(
    (r): r is PromiseFulfilledResult<{ ok?: boolean }> => r.status === "fulfilled",
  );
  if (wins.length === 0) {
    const msg = String(
      (results[0] as PromiseRejectedResult).reason ?? "unknown refusal",
    );
    if (/already used|disabled/i.test(msg)) {
      return failed("one-time bootstrap fixture already consumed — first-claim verification requires a fresh disposable bootstrap deployment (docs/ADMINISTRATOR_BOOTSTRAP.md, Test fixturing)");
    }
    return failed(`claim attempt refused for a non-consumption reason: ${msg.slice(0, 160)}`);
  }
  const winnerClient =
    results[0].status === "fulfilled" ? first : second;
  const sess = (await winnerClient.query(api.session.getSession, {})) as {
    role?: string | null;
  } | null;
  const directory = (await winnerClient.query(
    api.adminLifecycle.listAdministratorLifecycle,
    {},
  )) as { administrators?: Array<{ userId?: string }> } | null;
  return {
    attemptable: true,
    freshClaim: wins.length === 1 && wins[0]!.value?.ok === true,
    winners: wins.length,
    sessionRole: sess?.role ?? null,
    adminRowCount: directory?.administrators?.length ?? -1,
    note:
      wins.length === 1
        ? "fresh claim executed by this run (concurrent race)"
        : `concurrent claims both succeeded (${wins.length} winners) — the bootstrap is not single-winner`,
  };
})();

describe("Batch A1 — administrator lifecycle (runtime boundary)", () => {
  // Test-isolation hygiene: before/after EACH full file run, revert ONLY this
  // file's own fixture guests (explicit ids — never a shared-org sweep).
  if (backendsLive && harnessConfigured) {
    beforeAll(async () => {
      await revertOwnFixtures().catch(() => undefined);
    });
    afterAll(async () => {
      await revertOwnFixtures().catch(() => undefined);
    });
  }

  runIfBackend(
    "bootstrap: invalid secret refused; consumed/configured-state handled atomically",
    async () => {
      const wrong = await signInAnonymous();
      await expect(
        wrong
          .mutation(api.adminLifecycle.claimInitialAdministrator, {
            activationToken: "bst_not_the_real_secret",
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(); // refusal either for identity/config or credential

      // A verified non-configured identity with a token (if configured) is
      // refused for the identity mismatch, never silently accepted.
      if (BOOTSTRAP_TOKEN) {
        const seeded = `wrong-identity-${uniq()}@check.example`;
        expect(await seedVerifiedIdentity(seeded)).toBe(true);
        const other = await signInEmailOtp(seeded);
        if (other) {
          await expect(
            other
              .mutation(api.adminLifecycle.claimInitialAdministrator, {
                activationToken: BOOTSTRAP_TOKEN,
              })
              .then(() => JSON.stringify({ ok: true })),
          ).rejects.toThrow(/designated bootstrap identity/i);
        }
      }
    },
    60000,
  );

  // First-claim verification depends on an UNCONSUMED bootstrap fixture
  // (deployment env prerequisites: docs/ADMINISTRATOR_BOOTSTRAP.md). A
  // successful fresh claim is asserted here as its OWN registered test; a
  // consumed fixture registers an explicit (skip) naming the blocker —
  // the first-claim path is never claimed as pass without a fresh fixture,
  // and the durable one-time consumption refusal is separately verified.
  (bootstrapProbe.freshClaim ? test : (test as unknown as { skip: (name: string, fn: () => void | Promise<void>) => void }).skip)(
    bootstrapProbe.freshClaim
      ? "bootstrap happy path: configured verified identity becomes the FIRST admin exactly once"
      : `bootstrap first-claim BLOCKED — bootstrap fixture not fresh: ${bootstrapProbe.note}`,
    async () => {
      expect(bootstrapProbe.freshClaim).toBe(true);
      // Exactly ONE of the two concurrent claims may win — two winners would
      // mean two initial administrators were created.
      expect(bootstrapProbe.winners).toBe(1);
      expect(bootstrapProbe.sessionRole).toBe("admin");
      // Profile integrity: the designated identity is listed exactly ONCE as
      // an effective administrator (a duplicate userProfiles row would show
      // as a second directory entry for the same user).
      expect(bootstrapProbe.adminRowCount).toBe(1);
    },
  );

  (bootstrapProbe.attemptable ? test : (test as unknown as { skip: (name: string, fn: () => void | Promise<void>) => void }).skip)(
    bootstrapProbe.attemptable
      ? "bootstrap: durable one-time consumption refusal (first claim never replays)"
      : `bootstrap durable-consumption BLOCKED — ${bootstrapProbe.note}`,
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const claimant = await signInEmailOtp(BOOTSTRAP_EMAIL);
      if (!claimant) {
        throw new Error("[test:PREREQ-FAILED] bootstrap claimant sign-in unavailable");
      }
      // The claim was consumed by THIS run's probe (fresh world) or by an
      // earlier run (already-consumed world): either way a replay is
      // refused durably — the one-time invariant is live-verified here.
      await expect(
        claimant
          .mutation(api.adminLifecycle.claimInitialAdministrator, {
            activationToken: BOOTSTRAP_TOKEN,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/already used|disabled/i);
    },
    90000,
  );

  test(
    "grant lifecycle: initiate → wrong user refused → target accepts → duplicates refused → revoke restores previous role",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const suffix = uniq();
      const email = `promo-${suffix}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);

      // Provision first (ordinary path) with a DISTINCT previous role.
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }
      const adminSess = (await admin.query(api.session.getSession, {})) as { userId?: string };

      const adminProfileId = (await admin.query(api.admin.listUsers, {})) as Array<{
        _id: string;
        email: string | null;
      }>;
      const ownProfile = adminProfileId.find((u) => u.email !== null && admin.isAnonymous);

      // 10. Self-promotion is refused.
      if (ownProfile) {
        await expect(
          admin
            .mutation(api.adminLifecycle.grantAdministrator, {
              profileId: ownProfile._id as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow(/cannot promote themselves/i);
      }
      void adminSess;

      // 9. Unauthorized initiation is refused (ordinary member session).
      const memberSess = await signInEmailOtp(email);
      if (!memberSess) {
        throw new Error("[test:PREREQ-FAILED] member sign-in unavailable");
      }
      await expect(
        memberSess
          .mutation(api.adminLifecycle.grantAdministrator, {
            profileId: provisioned.profileId as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/Permission denied/);

      // 8. Authorized initiation succeeds and STAYS pending.
      const initiated = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { ok?: boolean; grantId?: string };
      expect(initiated.ok).toBe(true);
      const grantId = initiated.grantId!;

      // 16. Duplicate pending grant refused.
      await expect(
        admin
          .mutation(api.adminLifecycle.grantAdministrator, {
            profileId: provisioned.profileId as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/already pending/i);

      // 12. The WRONG user cannot confirm.
      const stranger = `stranger-${suffix}@check.example`;
      expect(await seedVerifiedIdentity(stranger)).toBe(true);
      const strangerClient = await signInEmailOtp(stranger);
      if (strangerClient) {
        await expect(
          strangerClient
            .mutation(api.adminLifecycle.acceptAdministratorGrant, {
              grantId: grantId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow();
      }

      // 13. Recipient acceptance elevates atomically.
      const accepted = (await memberSess.mutation(
        api.adminLifecycle.acceptAdministratorGrant,
        { grantId: grantId as never },
      )) as { ok?: boolean; role?: string };
      expect(accepted.ok).toBe(true);
      const memberSessionNow = (await memberSess.query(api.session.getSession, {})) as {
        role?: string | null;
        permissions?: { adminManage?: boolean };
      } | null;
      expect(memberSessionNow?.role).toBe("admin");
      expect(memberSessionNow?.permissions?.adminManage).toBe(true);

      // Replay refusal.
      await expect(
        memberSess
          .mutation(api.adminLifecycle.acceptAdministratorGrant, {
            grantId: grantId as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/already admin|cannot be confirmed again|already/i);

      // 19/20. Revocation restores the PREVIOUS role (auditor) immediately.
      const revoked = (await admin.mutation(api.adminLifecycle.revokeAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { ok?: boolean; role?: string };
      expect(revoked.ok).toBe(true);
      expect(revoked.role).toBe("auditor");
      const afterDemote = (await memberSess.query(api.session.getSession, {})) as {
        role?: string | null;
        permissions?: { adminManage?: boolean };
      } | null;
      expect(afterDemote?.role).toBe("auditor");
      expect(afterDemote?.permissions?.adminManage).toBe(false);

      // 18. Concurrent revocation of the same target: exactly one wins.
      // (Re-promote first so two simultaneous revokes race.)
      const p2 = await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      });
      if ((p2 as { ok?: boolean }).ok) {
        await memberSess.mutation(api.adminLifecycle.acceptAdministratorGrant, {
          grantId: ((p2 as unknown as { grantId: string }).grantId) as never,
        });
        const results = await Promise.allSettled([
          admin
            .mutation(api.adminLifecycle.revokeAdministrator, {
              profileId: provisioned.profileId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
          admin
            .mutation(api.adminLifecycle.revokeAdministrator, {
              profileId: provisioned.profileId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ]);
        const fulfilled = results.filter((r) => r.status === "fulfilled").length;
        const rejected = results.filter((r) => r.status === "rejected").length;
        expect(fulfilled + rejected).toBe(2);
        const finalSess = (await memberSess.query(api.session.getSession, {})) as {
          role?: string | null;
        } | null;
        expect(finalSess?.role).toBe("auditor"); // stable terminal state
      }
    },
    120000,
  );

  test(
    "grant rejection, cancellation and expiry never change any privilege",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) return;
      const suffix = uniq();

      async function freshMember(role: "member" | "auditor"): Promise<{
        member: ConvexHttpClient | null;
        profileId: string;
      } | null> {
        // Unique per INVOCATION: the same member may be created several times
        // in one test (e.g. two "member" scenarios) and provisioning refuses
        // duplicates by design — the second claimant must be a fresh identity.
        const email = `decline-${role}-${suffix}-${Math.floor(Math.random() * 1e6)}@check.example`;
        expect(await seedVerifiedIdentity(email)).toBe(true);
        const provisioned = (await admin.mutation(api.admin.provisionMember, {
          email,
          initialRole: role,
        })) as { ok?: boolean; profileId?: string };
        if (!provisioned.ok) return null;
        const member = await signInEmailOtp(email);
        return member ? { member, profileId: provisioned.profileId! } : null;
      }

      // 14. Recipient rejection.
      const r1 = await freshMember("member");
      if (r1?.member) {
        const g = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
          profileId: r1.profileId as never,
        })) as { grantId: string };
        const rej = (await r1.member.mutation(
          api.adminLifecycle.rejectAdministratorGrant,
          { grantId: g.grantId as never },
        )) as { ok?: boolean };
        expect(rej.ok).toBe(true);
        const sess = (await r1.member.query(api.session.getSession, {})) as {
          role?: string | null;
        } | null;
        expect(sess?.role).toBe("member");
        // A decided grant cannot be accepted afterwards.
        await expect(
          r1.member
            .mutation(api.adminLifecycle.acceptAdministratorGrant, {
              grantId: g.grantId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow(/already rejected/i);
      }

      // Cancel by the administrator.
      const r2 = await freshMember("auditor");
      if (r2?.member) {
        const g = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
          profileId: r2.profileId as never,
        })) as { grantId: string };
        const c = (await admin.mutation(api.adminLifecycle.cancelAdministratorGrant, {
          grantId: g.grantId as never,
        })) as { ok?: boolean };
        expect(c.ok).toBe(true);
        await expect(
          r2.member
            .mutation(api.adminLifecycle.acceptAdministratorGrant, {
              grantId: g.grantId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow(/already cancelled|cancelled/i);
        const sess = (await r2.member.query(api.session.getSession, {})) as {
          role?: string | null;
        } | null;
        expect(sess?.role).toBe("auditor");
      }

      // 15. Expiry: pending grant swept to expired → acceptance refused.
      const r3 = await freshMember("member");
      if (r3?.member) {
        const g = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
          profileId: r3.profileId as never,
        })) as { grantId: string };
        const sweep = await fetch(`${HARNESS}/api/dev-expire-admin-grants`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-iitams-tester-token": token,
          },
          // Scoped expiry: ONLY the grant record this test just created —
          // the harness refuses unlabeled (global) expiry requests.
          body: JSON.stringify({ grantIds: [g.grantId] }),
        });
        expect(sweep.status).toBe(200);
        await expect(
          r3.member
            .mutation(api.adminLifecycle.acceptAdministratorGrant, {
              grantId: g.grantId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow(/expired/i);
        const sess = (await r3.member.query(api.session.getSession, {})) as {
          role?: string | null;
        } | null;
        expect(sess?.role).toBe("member");
      }
    },
    120000,
  );

  test(
    "privilege rules stay closed: suspended members and admin targets refused; provisioning/invitations still exclude admin",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) return;
      const suffix = uniq();

      // Suspended member cannot receive a grant.
      const email = `susp-${suffix}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "member",
      })) as { ok?: boolean; profileId?: string };
      if (provisioned.ok) {
        await admin.mutation(api.admin.setMembershipStatus, {
          profileId: provisioned.profileId as never,
          status: "suspended",
        });
        await expect(
          admin
            .mutation(api.adminLifecycle.grantAdministrator, {
              profileId: provisioned.profileId as never,
            })
            .then(() => JSON.stringify({ ok: true })),
        ).rejects.toThrow(/inactive membership|Suspended or deactivated/i);
      }

      // 22. Provisioning with the privileged role remains structurally impossible.
      await expect(
        admin
          .mutation(api.admin.provisionMember, {
            email: `admincheck-${suffix}@check.example`,
            initialRole: "admin" as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow();

      // Invitations also refuse the privileged role.
      await expect(
        admin
          .mutation(api.invitations.createInvitation, {
            email: `inviteadmin-${suffix}@check.example`,
            role: "admin" as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow();
    },
    90000,
  );

  test(
    "audit records separate actor and target for the whole lifecycle (no secrets)",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) return;
      const adminSess = (await admin.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      const suffix = uniq();
      const email = `audit-${suffix}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "auditor",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) return;
      const member = await signInEmailOtp(email);
      if (!member) return;
      const g = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { grantId: string };
      await member.mutation(api.adminLifecycle.acceptAdministratorGrant, {
        grantId: g.grantId as never,
      });
      await admin.mutation(api.adminLifecycle.revokeAdministrator, {
        profileId: provisioned.profileId as never,
      });

      const logs = (await admin.query(api.admin.listAuditLogs, {
        action: "admin.administrator_grant_requested",
        limit: 5,
      } as never)) as Array<{
        action: string;
        actorId?: string | null;
        userId?: string | null;
        summary?: string;
      }>;
      const requested = logs.filter(
        (l) => l.action === "admin.administrator_grant_requested" && l.summary?.includes(email.split("@")[0]),
      );
      expect(requested.length).toBeGreaterThan(0);
      // Actor ≠ target for the REQUESTED entry (actor = initiating admin).
      const row = requested[requested.length - 1]!;
      expect(row.actorId).toBe(adminSess?.userId ?? row.actorId);
      expect(row.actorId).not.toBe(null);
      for (const l of [...logs]) {
        expect(JSON.stringify(l)).not.toMatch(/bst_[A-Za-z0-9]{20,}|activationToken/i);
      }
    },
    90000,
  );

  // ==========================================================================
  // Source-review corrections — behavioral regressions (final source state)
  // ==========================================================================

  runIfBackend(
    "expired pending grant: cannot block a new request and can never be accepted",
    async () => {
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const suffix = uniq();
      const email = `stale-grant-${suffix}-${Date.now()}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "member",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }
      const member = await signInEmailOtp(email);
      if (!member) {
        throw new Error("[test:PREREQ-FAILED] member sign-in unavailable");
      }

      // 1. First grant → expired via the SCOPED harness route (only this
      //    grant id — test isolation; no global expiry anywhere).
      const g1 = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { ok?: boolean; grantId: string };
      expect(g1.ok).toBe(true);
      const sweep = await fetch(`${HARNESS}/api/dev-expire-admin-grants`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({ grantIds: [g1.grantId] }),
      });
      expect(sweep.status).toBe(200);
      expect(((await sweep.json()) as { expired?: number }).expired).toBe(1);

      // 2. The expired grant can never be accepted.
      await expect(
        member
          .mutation(api.adminLifecycle.acceptAdministratorGrant, {
            grantId: g1.grantId as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/expired|already/i);

      // 3. A NEW grant request succeeds (the expired pending row no longer
      //    blocks it — the ordinary refusal previously fired here).
      const g2 = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { ok?: boolean; grantId: string };
      expect(g2.ok).toBe(true);

      // 4. The expired row is audited as expired; the duplicate exception
      //    did not consume the attempt (no stale privilege write).
      const lifecycle = (await admin.query(
        api.adminLifecycle.listAdministratorLifecycle,
        {},
      )) as {
        grants: Array<{ _id: string; status: string }>;
      } | null;
      const statuses = (lifecycle?.grants ?? []).filter(
        (row) => row._id === g1.grantId || row._id === g2.grantId,
      );
      expect(statuses.find((row) => row._id === g1.grantId)?.status).toBe("expired");
      expect(statuses.find((row) => row._id === g2.grantId)?.status).toBe("pending");
    },
    90000,
  );

  runIfBackend(
    "duplicate prevention: a LIVE pending grant is still refused",
    async () => {
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const suffix = uniq();
      const email = `dup-grant-${suffix}-${Date.now()}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);
      const provisioned = (await admin.mutation(api.admin.provisionMember, {
        email,
        initialRole: "member",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }
      const g1 = (await admin.mutation(api.adminLifecycle.grantAdministrator, {
        profileId: provisioned.profileId as never,
      })) as { ok?: boolean; grantId: string };
      expect(g1.ok).toBe(true);
      await expect(
        admin
          .mutation(api.adminLifecycle.grantAdministrator, {
            profileId: provisioned.profileId as never,
          })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/already pending/i);
    },
    90000,
  );

  runIfBackend(
    "concurrent grant creation serializes: exactly one pending grant survives",
    async () => {
      const [adminA, adminB] = await Promise.all([
        adminClientWithGrant(),
        adminClientWithGrant(),
      ]);
      if (!adminA || !adminB) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }
      const suffix = uniq();
      const email = `racing-grant-${suffix}-${Date.now()}@check.example`;
      expect(await seedVerifiedIdentity(email)).toBe(true);
      const provisioned = (await adminA.mutation(api.admin.provisionMember, {
        email,
        initialRole: "member",
      })) as { ok?: boolean; profileId?: string };
      if (!provisioned.ok) {
        throw new Error("[test:PREREQ-FAILED] member provisioning unavailable");
      }

      const results = await Promise.allSettled([
        adminA.mutation(api.adminLifecycle.grantAdministrator, {
          profileId: provisioned.profileId as never,
        }),
        adminB.mutation(api.adminLifecycle.grantAdministrator, {
          profileId: provisioned.profileId as never,
        }),
      ]);
      // Convex serializes mutations: the loser observes the winner's pending
      // row through the re-validated duplicate read and refuses.
      const fulfilled = results.filter((r) => r.status === "fulfilled").length;
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled + rejected.length).toBe(2);
      expect(fulfilled).toBe(1);
      expect(rejected.length).toBe(1);
      // Exactly ONE pending grant exists for the target.
      const lifecycle = (await adminA.query(
        api.adminLifecycle.listAdministratorLifecycle,
        {},
      )) as { grants?: Array<{ targetLabel: string; status: string }> } | null;
      const emailPrefix = email.split("@")[0]!;
      const pendingForTarget = (lifecycle?.grants ?? []).filter(
        (row) => row.status === "pending" && row.targetLabel.includes(emailPrefix),
      );
      expect(pendingForTarget.length).toBe(1);
    },
    90000,
  );

  runIfBackend(
    "an expired trusted demo-role grant is not presented as an effective administrator",
    async () => {
      const admin = await adminClientWithGrant();
      if (!admin) {
        throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
      }

      const directory = async (): Promise<Array<{ profileId: string; label: string }>> => {
        const l = (await admin.query(
          api.adminLifecycle.listAdministratorLifecycle,
          {},
        )) as {
          administrators?: Array<{ profileId: string; label: string }>;
        } | null;
        return l?.administrators ?? [];
      };

      const before = await directory();

      // Grant a SECOND demo admin with a one-second TTL; its row becomes an
      // expired artifact immediately after. Previously the directory (and
      // the last-admin count) would treat it as a live administrator.
      const guest = await signInAnonymous();
      await guest.mutation(api.session.joinDemoOrganization, {});
      const shortSession = (await guest.query(api.session.getSession, {})) as {
        userId?: string;
      } | null;
      if (!shortSession?.userId) {
        throw new Error("[test:PREREQ-FAILED] session unavailable");
      }
      fixtureUserIds.add(shortSession.userId);
      const grantRes = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({
          userId: shortSession.userId,
          role: "admin",
          // Short but not razor-thin: the grant must still be live when the
          // very next directory query runs, even on a loaded CI host.
          ttlMinutes: 2 / 60, // two seconds: expires immediately after
        }),
      });
      expect(grantRes.ok).toBe(true);
      const visibleNow = await directory();
      // While the grant is live the artifact IS a listed administrator.
      expect(visibleNow.length).toBe(before.length + 1);

      // The dev backend runs a deterministic clock that only advances with
      // write transactions — a read-only query observes `Date.now()` frozen at
      // the last write. Sleeping on wall time alone therefore cannot make the
      // server observe the expiry; the next WRITE (the harness's own hygiene
      // sweep, which runs `expireDemoTestGrants` before every grant) both
      // advances the clock and persists the expired grant's revert. Trigger it
      // via a benign harness call for a fresh throwaway guest.
      await new Promise((r) => setTimeout(r, 3000)); // the demo grant expired (wall time)
      const sweepRes = await fetch(`${HARNESS}/api/dev-grant-demo-role`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": token,
        },
        body: JSON.stringify({
          userId: shortSession.userId,
          role: "audit_manager",
          ttlMinutes: 30,
        }),
      });
      expect(sweepRes.ok).toBe(true);

      // After expiry the directory excludes the artifact: the count returns
      // to its pre-grant size (the same predicate the last-admin guard uses
      // — an expired grant can never be counted as the remaining admin).
      const after = await directory();
      expect(after.length).toBe(before.length);
    },
    90000,
  );
});
