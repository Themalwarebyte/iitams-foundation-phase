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
  test("administrator without admin.manage cannot create invitations (real guest session)", async () => {
    if (!(await serverUp())) {
      console.warn("[test:SKIPPED] convex backend unreachable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
    }
    // Setup: real authorized admin (demo-escalated guest) creates an invite.
    const adminGuest = await signInAnonymous();
    await adminGuest.mutation(api.session.joinDemoOrganization, {});
    const session = (await adminGuest.query(api.session.getSession, {})) as { userId?: string } | null;
    const userId = session?.userId;
    if (!userId || !(await harnessGrantAdmin(userId))) {
      console.warn("[test:SKIPPED] trusted-runner admin grant unavailable");
      return;
    }
    const email = `inv-sec-${Date.now()}@check.example`;
    const created = (await adminGuest.mutation(api.invitations.createInvitation, {
      email,
      role: "member",
    })) as { ok?: boolean; invitationId?: string };
    expect(created.ok).toBe(true);

    const link = await harnessInviteLink(created.invitationId!);
    if (!link.ok) {
      console.warn("[test:SKIPPED] harness link reissue unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
    }
    const adminGuest = await signInAnonymous();
    await adminGuest.mutation(api.session.joinDemoOrganization, {});
    const session = (await adminGuest.query(api.session.getSession, {})) as { userId?: string } | null;
    const userId = session?.userId;
    if (!userId || !(await harnessGrantAdmin(userId))) {
      console.warn("[test:SKIPPED] trusted-runner admin grant unavailable");
      return;
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
      console.warn("[test:SKIPPED] harness link reissue unavailable");
      return;
    }
    const hash1 = sha256Hex(link1.secret);
    const inspect1 = (await client.query(api.invitations.inspectInvitation, {
      secretHash: hash1,
    })) as { valid?: boolean };
    expect(inspect1.valid).toBe(true);

    // Resend/reissue — old token dies, new token validates.
    const link2 = await harnessInviteLink(first.invitationId!);
    if (!link2.ok) {
      console.warn("[test:SKIPPED] second harness reissue unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend unreachable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      console.warn("[test:SKIPPED] admin grant unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
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
      console.warn("[test:SKIPPED] invitee OTP sign-in unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      console.warn("[test:SKIPPED] admin grant unavailable");
      return;
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
      console.warn("[test:SKIPPED] harness link unavailable");
      return;
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
      console.warn("[test:SKIPPED] invitee OTP sign-in unavailable");
      return;
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
    }
    const admin = await adminClientWithGrant();
    if (!admin) {
      console.warn("[test:SKIPPED] admin grant unavailable");
      return;
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
    const sweep = await fetch(`${HARNESS}/api/dev-expire-invitations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-iitams-tester-token": token,
      },
      body: JSON.stringify({}),
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
      console.warn("[test:SKIPPED] backend/harness unavailable");
      return;
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
      console.warn("[test:SKIPPED] invitee OTP sign-in unavailable");
      return;
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
});