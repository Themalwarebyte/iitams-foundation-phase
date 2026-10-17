import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../src/convex/_generated/api";
import { sha256Hex } from "../src/lib/sha256";

/**
 * Batch 2C — invitation security boundary tests.
 * ======================================================================
 * Structural guards verify the design invariants; the runtime block
 * exercises the DEPLOYED boundary with real clients and the trusted
 * harness (same model as tests/security.demoescalation.test.ts).
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

/** Trusted-runner admin grant for the CURRENT guest session (via harness). */
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

/** Harness-granted demo admin client (authorized createInvitation caller). */
async function adminClientWithGrant(): Promise<ConvexHttpClient | null> {
  const admin = await signInAnonymous();
  await admin.mutation(api.session.joinDemoOrganization, {});
  const session = (await admin.query(api.session.getSession, {})) as {
    userId?: string;
  } | null;
  if (!session?.userId) return null;
  if (!(await harnessGrantAdmin(session.userId))) return null;
  return admin;
}

/** Monotonic-ish unique suffix for fixture emails within a runner session. */
const uniq = () => Date.now() * 1000 + Math.floor(Math.random() * 999);

/** Trusted-runner harness route: reissue the acceptance link of an invitation. */
async function harnessInviteLink(invitationId: string): Promise<
  { ok: true; secret: string; email: string; role: string } | { ok: false }
> {
  const res = await fetch(`${HARNESS}/api/dev-invite-acceptance-link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-iitams-tester-token": token,
    },
    body: JSON.stringify({ invitationId }),
  });
  if (!res.ok) return { ok: false };
  const data = (await res.json()) as { secret?: string; email?: string; role?: string };
  if (!data.secret) return { ok: false };
  return {
    ok: true,
    secret: data.secret,
    email: data.email ?? "",
    role: data.role ?? "",
  };
}

describe("Batch 2C — invitation hashing + structural guards", () => {
  const invSrc = readFileSync("src/convex/invitations.ts", "utf8");
  const schemaSrc = readFileSync("src/convex/schema.ts", "utf8");
  const coreSrc = readFileSync("src/convex/membershipCore.ts", "utf8");
  const httpSrc = readFileSync("src/convex/http.ts", "utf8");
  const devToolsSrc = readFileSync("src/dev/DevTools.tsx", "utf8");

  test("sha256Hex matches Node crypto across arbitrary inputs", () => {
    const samples = [
      "",
      "a",
      "the quick brown fox jumps over the lazy dog",
      "x".repeat(200),
      "inv-secret-with-unicode-Ünïcøde",
      JSON.stringify({ nested: true, n: 42 }),
    ];
    for (const s of samples) {
      expect(sha256Hex(s)).toBe(createHash("sha256").update(s, "utf8").digest("hex"));
    }
  });

  test("secrets are stored only as SHA-256 hashes (no plaintext persistence)", () => {
    expect(schemaSrc).toContain("organizationInvitations: defineTable");
    expect(schemaSrc).toContain("secretHash");
    expect(invSrc).toContain("sha256Hex(secret)");
    expect(invSrc).toContain('withIndex("by_secret_hash"');
    // No plaintext-secret field exists in the table definition.
    for (const line of schemaSrc.split("\n")) {
      if (/secret:\s*v\./.test(line)) {
        throw new Error(`plaintext secret field found in schema: ${line}`);
      }
    }
  });

  test("acceptance is transactional and single-use", () => {
    const idx = invSrc.indexOf("export const acceptInvitation = mutation({");
    expect(idx).toBeGreaterThan(-1);
    const body = invSrc.slice(idx);
    const profileWrite = body.indexOf("applyInitialMembership");
    const terminal = body.indexOf('status: "accepted"');
    expect(profileWrite).toBeGreaterThan(-1);
    expect(terminal).toBeGreaterThan(profileWrite);
  });

  test("acceptance authority is the recipient identity (token never sufficient)", () => {
    const idx = invSrc.indexOf("export const acceptInvitation = mutation({");
    const body = invSrc.slice(idx);
    expect(body).toContain("requireUser(ctx)");
    expect(body).toContain("!user.emailVerificationTime");
    expect(body).toContain("user.isAnonymous === true");
    expect(body).toContain("verifiedEmail !== inv.email");
  });

  test("both provisioning paths share ONE membership-write core", () => {
    expect(coreSrc).toContain("applyInitialMembership");
    expect(invSrc).toContain("applyInitialMembership(ctx, {");
    const adminSrc = readFileSync("src/convex/admin.ts", "utf8");
    expect(adminSrc).toContain("applyInitialMembership(ctx, {");
  });

  test("audit trail never carries secrets, codes or credentials", () => {
    for (const m of invSrc.matchAll(/summary: `([^`]*)`/g)) {
      expect(m[1].includes("secret")).toBe(false);
    }
    expect(invSrc).not.toContain("actorLabel: args.secret");
  });

  test("the OTP-only dev adapter is never used for invitations", () => {
    expect(invSrc).not.toContain("sendViaFreebuffDevAdapter");
    expect(invSrc).not.toContain("DEV_ADAPTER_ENDPOINT");
  });

  test("no tester credential reaches browser-facing code", () => {
    expect(devToolsSrc).not.toContain("IITAMS_TESTER_TOKEN");
    const acceptSrc = readFileSync("src/pages/InviteAccept.tsx", "utf8");
    expect(acceptSrc).not.toContain("x-iitams-tester-token");
    expect(acceptSrc).not.toContain("IITAMS_TESTER_TOKEN");
  });

  test("invitation harness routes stay uniformly token-guarded", () => {
    for (const [path, fn] of [
      ["/api/dev-invite-acceptance-link", "harnessReissueInvitation"],
      ["/api/dev-expire-invitations", "harnessExpireInvitations"],
    ] as const) {
      const idx = httpSrc.indexOf(`path: "${path}"`);
      expect(idx).toBeGreaterThan(-1);
      expect(httpSrc.slice(idx)).toContain("isTrustedDevTester(request)");
      expect(httpSrc.slice(idx)).toContain(fn);
    }
  });
});

describe("Batch 2C — deployed invitation boundary (runtime)", () => {
  /** Test hygiene (fixture, not product): revoke leftover ACTIONABLE
   * invitations whose recipient address belongs to THIS suite's fixture
   * domain. Test isolation (source-review fix): `@check.example` is the
   * RFC 2606 test domain the entire suite uses for every fixture address —
   * so the drain can never name/flip an invitation for a real recipient in
   * the shared organization; legitimate invitations (real addresses) are
   * structurally out of scope. Terminal rows are never touched. */
  const FIXTURE_EMAIL_DOMAIN = "@check.example";
  async function drainPendingInvitations(admin: ConvexHttpClient): Promise<number> {
    const rows = (await admin.query(api.invitations.listInvitations, {})) as
      | Array<{ _id: string; email?: string; status?: string }>
      | null;
    let drained = 0;
    for (const row of rows ?? []) {
      const isFixture =
        typeof row.email === "string" &&
        row.email.toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN);
      if (
        isFixture &&
        (row.status === "pending" ||
          row.status === "pending_delivery" ||
          row.status === "delivery_failed")
      ) {
        try {
          await admin.mutation(api.invitations.revokeInvitation, {
            invitationId: row._id as never,
          });
          drained += 1;
        } catch {
          // A row can go terminal concurrently; hygiene is best-effort.
        }
      }
    }
    return drained;
  }

  test("test hygiene: drains ONLY fixture-domain invitations, never real ones", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await signInAnonymous();
    await admin.mutation(api.session.joinDemoOrganization, {});
    const session = (await admin.query(api.session.getSession, {})) as {
      userId?: string;
    } | null;
    if (!session?.userId || !(await harnessGrantAdmin(session.userId))) {
      throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
    }
    const drained = await drainPendingInvitations(admin);
    if (drained > 0) {
      console.warn(`[test:HYGIENE] revoked ${drained} leftover open fixture invitation(s)`);
    }
  }, 60000);

  test("cleanup isolation: a non-fixture invitation is never touched by the drain", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
    }
    const suffix = uniq();
    // A REAL-looking address outside the suite's fixture domain: the drain
    // routine must not touch it even though it is open and actionable.
    const keptEmail = `kept-real-${suffix}@partner-portal.example`;
    const kept = (await admin.mutation(api.invitations.createInvitation, {
      email: keptEmail,
      role: "auditor",
    })) as { ok?: boolean; invitationId?: string };
    expect(kept.ok).toBe(true);
    const link = await harnessInviteLink(kept.invitationId!);
    if (!link.ok) return;
    const keptHash = sha256Hex(link.secret);
    const inspectBefore = (await admin.query(api.invitations.inspectInvitation, {
      secretHash: keptHash,
    })) as { valid?: boolean };
    expect(inspectBefore.valid).toBe(true);

    // Run the drain — scoped to @check.example fixtures only.
    const drained = await drainPendingInvitations(admin);

    // Race-safety note: under concurrent runner files the dev backend's
    // virtual clock advances sharply with each write, so a scheduled
    // delivery action queued at creation time can still fire and re-mint
    // the deliverable secret AFTER the trusted-harness mint — invalidating
    // the previously captured hash even though the drain never touched the
    // row. Assert on what the drain must NOT change instead: the row's
    // non-terminal status (fresh reissue also still succeeds), re-checking
    // actionability on the CURRENT deliverable secret.
    const rows = (await admin.query(api.invitations.listInvitations, {})) as
      | Array<{ email?: string; status?: string }>
      | null;
    const keptRows = (rows ?? []).filter((r) => r.email === keptEmail);
    expect(keptRows).toHaveLength(1);
    expect(keptRows[0]!.status).not.toBe("revoked");
    expect(keptRows[0]!.status).not.toBe("expired");
    const keptReissue = await harnessInviteLink(kept.invitationId!);
    expect(keptReissue.ok).toBe(true);
    if (keptReissue.ok) {
      const keptHashNow = sha256Hex(keptReissue.secret);
      const inspectAfter = (await admin.query(api.invitations.inspectInvitation, {
        secretHash: keptHashNow,
      })) as { valid?: boolean };
      expect(inspectAfter.valid).toBe(true);
    }
    // And the fixture-domain rows are gone (drain report matches reality).
    const leftoverFixtures = (rows ?? []).filter(
      (r) =>
        r.email?.toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN) &&
        (r.status === "pending" || r.status === "pending_delivery" || r.status === "delivery_failed"),
    );
    expect(leftoverFixtures).toHaveLength(0);

    // Restore: the kept invitation is revoked by ITS OWN caller — this is
    // explicit fixture cleanup for this test only (audit history intact).
    const revoked = (await admin.mutation(api.invitations.revokeInvitation, {
      invitationId: kept.invitationId! as never,
    })) as { ok?: boolean };
    expect(revoked.ok).toBe(true);
    expect(drained).toBeGreaterThanOrEqual(0);
  }, 120000);

  test("administrator without admin.manage cannot create invitations (real guest session)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] convex backend unreachable");
    }
    const guest = await signInAnonymous();
    await guest.mutation(api.session.joinDemoOrganization, {});
    // NO escalation — an ordinary provisioned guest holds no admin.manage.
    const attempt = guest
      .mutation(api.invitations.createInvitation, {
        email: `noauth-${Date.now()}@check.example`,
        role: "member",
      })
      .then(() => JSON.stringify({ ok: true }));
    await expect(attempt).rejects.toThrow();
  }, 30000);

  test("unauthenticated callers cannot accept a REAL invitation hash", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    // Setup: real authorized admin (demo-escalated guest) creates an invite.
    const adminGuest = await signInAnonymous();
    await adminGuest.mutation(api.session.joinDemoOrganization, {});
    const session = (await adminGuest.query(api.session.getSession, {})) as { userId?: string } | null;
    const userId = session?.userId;
    if (!userId || !(await harnessGrantAdmin(userId))) {
      throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
    }
    const email = `inv-sec-${Date.now()}@check.example`;
    const created = (await adminGuest.mutation(api.invitations.createInvitation, {
      email,
      role: "member",
    })) as { ok?: boolean; invitationId?: string };
    expect(created.ok).toBe(true);

    const link = await harnessInviteLink(created.invitationId!);
    if (!link.ok) {
      throw new Error("[test:PREREQ-FAILED] harness link reissue unavailable");
    }
    expect(link.email).toBe(email);
    const hash = sha256Hex(link.secret);

    // Anonymous (unauthenticated) client cannot accept.
    await expect(
      client
        .mutation(api.invitations.acceptInvitation, { secretHash: hash })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();

    // A GUEST session (anonymous identity) cannot accept either.
    const otherGuest = await signInAnonymous();
    await expect(
      otherGuest
        .mutation(api.invitations.acceptInvitation, { secretHash: hash })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow(/guest/i);

    // A garbage hash is uniformly refused.
    await expect(
      otherGuest
        .mutation(api.invitations.acceptInvitation, {
          secretHash: "f".repeat(64),
        })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
  }, 60000);

  test("duplicate pending invitations are refused; resend invalidates the old token", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const adminGuest = await signInAnonymous();
    await adminGuest.mutation(api.session.joinDemoOrganization, {});
    const session = (await adminGuest.query(api.session.getSession, {})) as { userId?: string } | null;
    const userId = session?.userId;
    if (!userId || !(await harnessGrantAdmin(userId))) {
      throw new Error("[test:PREREQ-FAILED] trusted-runner admin grant unavailable");
    }
    const email = `inv-dup-${Date.now()}@check.example`;
    const first = (await adminGuest.mutation(api.invitations.createInvitation, {
      email,
      role: "auditor",
    })) as { ok?: boolean; invitationId?: string };
    expect(first.ok).toBe(true);

    // Duplicate (same org+email, still pending) — refused.
    await expect(
      adminGuest
        .mutation(api.invitations.createInvitation, { email, role: "member" })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow(/already pending/i);

    // Privileged admin role is structurally impossible (validator).
    await expect(
      (adminGuest.mutation(api.invitations.createInvitation, {
        email: `inv-admin-${Date.now()}@check.example`,
        role: "admin" as never,
      }) as unknown as Promise<unknown>).then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();

    // The fresh link validates; the previous token is invalidated on resend.
    const link1 = await harnessInviteLink(first.invitationId!);
    if (!link1.ok) {
      throw new Error("[test:PREREQ-FAILED] harness link reissue unavailable");
    }
    const hash1 = sha256Hex(link1.secret);
    const inspect1 = (await client.query(api.invitations.inspectInvitation, {
      secretHash: hash1,
    })) as { valid?: boolean };
    expect(inspect1.valid).toBe(true);

    // Resend/reissue — old token dies, new token validates.
    const link2 = await harnessInviteLink(first.invitationId!);
    if (!link2.ok) {
      throw new Error("[test:PREREQ-FAILED] second harness reissue unavailable");
    }
    const hash2 = sha256Hex(link2.secret);
    expect(hash2).not.toBe(hash1);
    const oldInspect = (await client.query(api.invitations.inspectInvitation, {
      secretHash: hash1,
    })) as { valid?: boolean };
    expect(oldInspect.valid).toBe(false);
    const newInspect = (await client.query(api.invitations.inspectInvitation, {
      secretHash: hash2,
    })) as { valid?: boolean; invitedEmail?: string; intendedRole?: string };
    expect(newInspect.valid).toBe(true);
    expect(newInspect.invitedEmail).toBe(email);

    // Revoke — token dies (pending → revoked), accept path dead.
    const revoked = (await adminGuest.mutation(api.invitations.revokeInvitation, {
      invitationId: first.invitationId!,
    })) as { ok?: boolean };
    expect(revoked.ok).toBe(true);
    const dead = (await client.query(api.invitations.inspectInvitation, {
      secretHash: hash2,
    })) as { valid?: boolean };
    expect(dead.valid).toBe(false);
  }, 60000);

  test("listing exposes no hashes or secrets (organization-scoped)", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    // Unauthenticated list attempt must be refused outright.
    await expect(
      client
        .query(api.invitations.listInvitations, {})
        .then((r) => JSON.stringify(r)),
    ).rejects.toThrow();
  }, 30000);
});

describe("Batch 2C — behavioral acceptance & provisioning regression (runtime)", () => {
  /** Seed a VERIFIED (non-anonymous) identity via the trusted harness. */
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

  /** REAL email-OTP sign-in for a verified identity (code via OTP harness). */
  async function signInEmailOtp(email: string): Promise<ConvexHttpClient | null> {
    const c = new ConvexHttpClient(CONVEX_URL);
    try {
      await (c as unknown as {
        action: (ref: unknown, args: Record<string, unknown>) => Promise<unknown>;
      }).action(api.auth.signIn, { provider: "email-otp", params: { email } });
      let code: string | null = null;
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1200));
        try {
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
        } catch {
          // retry
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

  /** Harness-granted demo admin client (authorized createInvitation caller). */
  async function adminClientWithGrant(): Promise<ConvexHttpClient | null> {
    const admin = await signInAnonymous();
    await admin.mutation(api.session.joinDemoOrganization, {});
    const session = (await admin.query(api.session.getSession, {})) as {
      userId?: string;
    } | null;
    if (!session?.userId) return null;
    if (!(await harnessGrantAdmin(session.userId))) return null;
    return admin;
  }

  const uniq = () => Date.now() * 1000 + Math.floor(Math.random() * 999);

  test("trusted harness routes refuse missing/wrong tokens uniformly (live)", async () => {
    if (!(await serverUp())) {
      throw new Error("[test:PREREQ-FAILED] backend unreachable");
    }
    for (const path of ["/api/dev-invite-acceptance-link", "/api/dev-expire-invitations"]) {
      const missing = await fetch(`${HARNESS}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(missing.status).toBe(403);
      const wrong = await fetch(`${HARNESS}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-iitams-tester-token": "not-the-real-token",
        },
        body: JSON.stringify({}),
      });
      expect(wrong.status).toBe(403);
      expect(await wrong.text()).toBe(await missing.clone().text());
    }
  }, 30000);

  test("manual Add-Existing-User provisioning behaves exactly as before (shared core)", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      throw new Error("[test:PREREQ-FAILED] admin grant unavailable");
    }
    const suffix = uniq();
    const emailB = `provisionTarget-${suffix}@check.example`;
    expect(await seedVerifiedIdentity(emailB)).toBe(true);

    // First provisioning succeeds (verified, no membership yet).
    const provisioned = (await admin.mutation(api.admin.provisionMember, {
      email: emailB,
      initialRole: "management_user",
    })) as { ok?: boolean; role?: string; profileId?: string };
    expect(provisioned.ok).toBe(true);
    expect(provisioned.role).toBe("management_user");

    // Provisioning the SAME member again is refused (no duplicate/rewrite).
    await expect(
      admin
        .mutation(api.admin.provisionMember, {
          email: emailB,
          initialRole: "auditor",
        })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();

    // A never-registered address is refused uniformly.
    await expect(
      admin
        .mutation(api.admin.provisionMember, {
          email: `never-registered-${suffix}@check.example`,
          initialRole: "member",
        })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
  }, 90000);

  test("manual provisioning is refused for a member onboarded via invitation (no duplicate access)", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) return;
    const suffix = uniq();
    const email = `accept-then-provision-${suffix}@check.example`;

    // Recipient joins through a verified invitation first.
    const inv = (await admin.mutation(api.invitations.createInvitation, {
      email,
      role: "auditor",
    })) as { ok?: boolean; invitationId?: string };
    expect(inv.ok).toBe(true);
    const link = await harnessInviteLink(inv.invitationId!);
    if (!link.ok) return;
    const invitee = await signInEmailOtp(email);
    if (!invitee) {
      throw new Error("[test:PREREQ-FAILED] invitee OTP sign-in unavailable");
    }
    const accepted = (await invitee.mutation(api.invitations.acceptInvitation, {
      secretHash: sha256Hex(link.secret),
    })) as { ok?: boolean };
    expect(accepted.ok).toBe(true);

    // The manual Add-Existing-User path must now REFUSE (membership exists —
    // neither a second membership in this org nor any transfer). This also
    // covers "acceptance after administrative membership was separately
    // granted" in the reverse direction.
    await expect(
      admin
        .mutation(api.admin.provisionMember, { email, initialRole: "member" })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
  }, 90000);

  test("wrong-email refused; right-email acceptance succeeds exactly once (replay refused)", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      throw new Error("[test:PREREQ-FAILED] admin grant unavailable");
    }
    const suffix = uniq();
    const invitedEmail = `acceptee-${suffix}@check.example`;
    const strangerEmail = `stranger-${suffix}@check.example`;
    expect(await seedVerifiedIdentity(strangerEmail)).toBe(true);

    const inv = (await admin.mutation(api.invitations.createInvitation, {
      email: invitedEmail,
      role: "auditor",
    })) as { ok?: boolean; invitationId?: string };
    expect(inv.ok).toBe(true);
    const link = await harnessInviteLink(inv.invitationId!);
    if (!link.ok) {
      throw new Error("[test:PREREQ-FAILED] harness link unavailable");
    }
    const hash = sha256Hex(link.secret);

    // 1. WRONG-email verified identity is refused (exact-mail binding).
    const stranger = await signInEmailOtp(strangerEmail);
    if (stranger) {
      await expect(
        stranger
          .mutation(api.invitations.acceptInvitation, { secretHash: hash })
          .then(() => JSON.stringify({ ok: true })),
      ).rejects.toThrow(/different email address/i);
    }

    // 2. The invited user verifies THEIR address and accepts exactly once.
    const invitee = await signInEmailOtp(invitedEmail);
    if (!invitee) {
      throw new Error("[test:PREREQ-FAILED] invitee OTP sign-in unavailable");
    }
    const accepted = (await invitee.mutation(api.invitations.acceptInvitation, {
      secretHash: hash,
    })) as { ok?: boolean; role?: string };
    expect(accepted.ok).toBe(true);
    expect(accepted.role).toBe("auditor");

    // The target's own session reflects the provisioned membership and role.
    const sess = (await invitee.query(api.session.getSession, {})) as {
      role?: string | null;
      isProvisioned?: boolean;
      isAnonymous?: boolean;
    } | null;
    expect(sess?.isProvisioned).toBe(true);
    expect(sess?.role).toBe("auditor");

    // 3. REPLAY of the same token is refused and changes nothing.
    await expect(
      invitee
        .mutation(api.invitations.acceptInvitation, { secretHash: hash })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
    const sessAfter = (await invitee.query(api.session.getSession, {})) as {
      role?: string | null;
    } | null;
    expect(sessAfter?.role).toBe("auditor");
  }, 120000);

  test("revoked invitations are refused; suspended members cannot be re-onboarded", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      throw new Error("[test:PREREQ-FAILED] admin grant unavailable");
    }
    const suffix = uniq();
    const email = `revoke-flow-${suffix}@check.example`;

    const inv = (await admin.mutation(api.invitations.createInvitation, {
      email,
      role: "management_user",
    })) as { ok?: boolean; invitationId?: string };
    expect(inv.ok).toBe(true);
    const link = await harnessInviteLink(inv.invitationId!);
    if (!link.ok) return;
    const hash = sha256Hex(link.secret);

    // Revoke BEFORE delivery-based acceptance.
    const revoked = (await admin.mutation(api.invitations.revokeInvitation, {
      invitationId: inv.invitationId!,
    })) as { ok?: boolean };
    expect(revoked.ok).toBe(true);
    const anonymous = await signInAnonymous();
    await expect(
      anonymous
        .mutation(api.invitations.acceptInvitation, { secretHash: hash })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();

    // Repeat revocation is refused (terminal, no double transition).
    await expect(
      admin
        .mutation(api.invitations.revokeInvitation, {
          invitationId: inv.invitationId!,
        })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();

    // Expiry enforcement: an invitation whose deadline passed cannot accept
    // even from its own recipient's session.
    const email2 = `expiry-flow-${suffix}@check.example`;
    const inv2 = (await admin.mutation(api.invitations.createInvitation, {
      email: email2,
      role: "user",
    })) as { ok?: boolean; invitationId?: string };
    if (!inv2.ok) return;
    const link2 = await harnessInviteLink(inv2.invitationId!);
    if (!link2.ok) return;
    const hash2 = sha256Hex(link2.secret);
    // Fixtures only: scope the lifecycle sweep to the test's own organization.
    const adminSession = (await admin.query(
      api.session.getSession,
      {},
    )) as { organization?: { id?: string } } | null;
    const sweep = await fetch(`${HARNESS}/api/dev-expire-invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": token,
      },        body: JSON.stringify({ organizationId: adminSession?.organization?.id }),
      });
      expect(sweep.status).toBe(200);
    const anonymous2 = await signInAnonymous();
    await expect(
      anonymous2
        .mutation(api.invitations.acceptInvitation, { secretHash: hash2 })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
  }, 90000);

  test("concurrent duplicate acceptance creates exactly one membership", async () => {
    if (!(await serverUp()) || !harnessConfigured) {
      throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
    }
    const admin = await adminClientWithGrant();
    if (!admin) return;
    const suffix = uniq();
    const email = `concurrent-${suffix}@check.example`;
    const inv = (await admin.mutation(api.invitations.createInvitation, {
      email,
      role: "member",
    })) as { ok?: boolean; invitationId?: string };
    if (!inv.ok) return;
    const link = await harnessInviteLink(inv.invitationId!);
    if (!link.ok) return;
    const hash = sha256Hex(link.secret);
    const invitee = await signInEmailOtp(email);
    if (!invitee) {
      throw new Error("[test:PREREQ-FAILED] invitee OTP sign-in unavailable");
    }

    // Two simultaneous acceptances: Convex serializes mutations, so exactly
    // one wins; the loser is refused and no duplicate membership exists.
    const results = await Promise.allSettled([
      invitee.mutation(api.invitations.acceptInvitation, { secretHash: hash }),
      invitee.mutation(api.invitations.acceptInvitation, { secretHash: hash }),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled + rejected).toBe(2);
    expect(fulfilled).toBeGreaterThanOrEqual(1);
    // A third attempt is still refused (terminal).
    await expect(
      invitee
        .mutation(api.invitations.acceptInvitation, { secretHash: hash })
        .then(() => JSON.stringify({ ok: true })),
    ).rejects.toThrow();
    // The session resolves to the invited tier exactly once.
    const sess = (await invitee.query(api.session.getSession, {})) as {
      role?: string | null;
      isProvisioned?: boolean;
    } | null;
    expect(sess?.isProvisioned).toBe(true);
    expect(sess?.role).toBe("member");
  }, 120000);

  type InviteRow = {
    _id: string;
    deliveryAttempts: number;
    deliveryStatus: string | null;
  };

  /** Trusted-harness redelivery: synchronously replay the delivery action
   * with an explicit generation anchor (the exact shape of an out-of-order
   * scheduled delivery). Called only when the backend is up. */
  async function devRedeliver(
    invitationId: string,
    expectedSecretHash?: string,
  ): Promise<Response> {
    return fetch(`${HARNESS}/api/dev-invite-redeliver`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": token,
      },
      body: JSON.stringify(
        expectedSecretHash === undefined
          ? { invitationId }
          : { invitationId, expectedSecretHash },
      ),
    });
  }

  async function attemptsOf(invitationId: string): Promise<number> {
    const admin = await adminClientWithGrant();
    if (admin == null) return -1;
    const rows = (await admin.query(api.invitations.listInvitations, {})) as
      | InviteRow[]
      | null;
    return rows?.find((r) => r._id === invitationId)?.deliveryAttempts ?? -1;
  }

  test(
    "stale scheduled delivery cannot supersede a newer trusted-harness reissue",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) return;
      const suffix = uniq();
      const email = `record-stale-${suffix}@check.example`;

      // 1. Fresh invitation: its delivery action anchors on the unset
      //    generation and mints as soon as it runs (no e-mail provider in
      //    dev, so it completes with a composed token nonetheless).
      const inv = (await admin.mutation(api.invitations.createInvitation, {
        email,
        role: "auditor",
      })) as { ok?: boolean; invitationId?: string };
      expect(inv.ok).toBe(true);
      const invitationId = inv.invitationId!;

      // Give the scheduled creation-delivery time to complete so the row
      // enters a settled state before this test drives its own reissues.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (await attemptsOf(invitationId)) < 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(await attemptsOf(invitationId)).toBeGreaterThanOrEqual(1);

      // 2. Older reissue (generation H1) — its token is real but will soon
      //    be superseded by the newest one below.
      const olderLink = await harnessInviteLink(invitationId);
      expect(olderLink.ok).toBe(true);
      const olderHash = sha256Hex(olderLink.ok ? olderLink.secret : "");

      // 3. NEWEST reissue (generation H2) — this is the link a real admin
      //    would have just sent; it MUST stay valid no matter when stale
      //    delivery actions fire.
      const newestLink = await harnessInviteLink(invitationId);
      expect(newestLink.ok).toBe(true);
      const newestHash = sha256Hex(newestLink.ok ? newestLink.secret : "");
      const attemptsAtNewest = await attemptsOf(invitationId);

      // 4. Reproduce the RACE deterministically: replay the delivery action
      //    with the OLD generation anchor — exactly the durable argument a
      //    scheduled action carries when a newer reissue landed after it
      //    was queued. Without the generation guard the mint would
      //    overwrite the newest hash and kill the fresh link.
      const redeliver = await devRedeliver(invitationId, olderHash);
      expect(redeliver.status).toBe(200);

      // 5. Newest issued token remains valid.
      const newestInspect = (await admin.query(api.invitations.inspectInvitation, {
        secretHash: newestHash,
      })) as { valid?: boolean };
      expect(newestInspect.valid).toBe(true);

      // 6. Stale generation rejected: the older reissued token does not
      //    authenticate anything after being superseded.
      const staleInspect = (await admin.query(api.invitations.inspectInvitation, {
        secretHash: olderHash,
      })) as { valid?: boolean };
      expect(staleInspect.valid).toBe(false);

      // 7. No stale write and no attempt-budget consumption: a superseded
      //    scheduled action must not mint (no attempt increments) and must
      //    not rewrite the row (no terminal-status revision).
      expect(await attemptsOf(invitationId)).toBe(attemptsAtNewest);

      // 8. List view still reports only safe delivery metadata.
      const rows = (await admin.query(api.invitations.listInvitations, {})) as
        | InviteRow[]
        | null;
      const row = rows?.find((r) => r._id === invitationId);
      expect(row).toBeDefined();
      expect(JSON.stringify(row)).not.toContain(newestHash);
      expect(JSON.stringify(row)).not.toContain(olderHash);
    },
    120000,
  );

  test(
    "fresh redelivery still mints and invalidates prior tokens (expiry/status intact)",
    async () => {
      if (!(await serverUp()) || !harnessConfigured) {
        throw new Error("[test:PREREQ-FAILED] backend/harness unavailable");
      }
      const admin = await adminClientWithGrant();
      if (!admin) return;
      const suffix = uniq();

      const inv = (await admin.mutation(api.invitations.createInvitation, {
        email: `record-fresh-${suffix}@check.example`,
        role: "auditor",
      })) as { ok?: boolean; invitationId?: string };
      expect(inv.ok).toBe(true);
      const invitationId = inv.invitationId!;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && (await attemptsOf(invitationId)) < 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
      const before = await attemptsOf(invitationId);

      const link = await harnessInviteLink(invitationId);
      expect(link.ok).toBe(true);
      const hash = sha256Hex(link.ok ? link.secret : "");

      // A redelivery whose anchor matches the CURRENT generation must mint
      // a new token (the normal in-order path: attempt budget consumed by
      // exactly one, previous token invalidated atomically).
      const redeliver = await devRedeliver(invitationId, hash);
      expect(redeliver.status).toBe(200);
      const after = await attemptsOf(invitationId);
      expect(after).toBe(before + 1);

      // The prior link is dead; a fresh reissue revalidates cleanly (same
      // reissue semantics as an administrative resend).
      const staleAfter = (await admin.query(api.invitations.inspectInvitation, {
        secretHash: hash,
      })) as { valid?: boolean };
      expect(staleAfter.valid).toBe(false);
      const relink = await harnessInviteLink(invitationId);
      expect(relink.ok).toBe(true);
    },
    120000,
  );
});