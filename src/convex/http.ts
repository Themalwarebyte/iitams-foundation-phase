import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { auth } from "./auth";
import { guestAuthEnabled } from "./access";

const http = httpRouter();

auth.addHttpRoutes(http);

// ---------------------------------------------------------------------------
// TRUSTED SERVER-SIDE TEST HARNESS (development-only) — Batch 2B hardening
// ---------------------------------------------------------------------------
// These routes are the ONLY access path to the development OTP retrieval and
// the development test-identity seeding. They replace the previously PUBLIC
// queries/mutations (devOtp.pending / session.seedVerifiedTestUser), whose
// dev-environment flag was NOT authorization.
//
// Authorization model (ALL conditions required):
//   1. The deployment must be a development deployment
//      (IITAMS_ALLOW_GUEST_AUTH === "true"). Production deployments refuse
//      every request regardless of any other condition.
//   2. The request must present the trusted test-runner secret in the
//      `x-iitams-tester-token` header, compared in constant time. The secret
//      lives ONLY on the deployment (IITAMS_TESTER_TOKEN env var) and in the
//      gitignored local runner file; it is NEVER stored in source code,
//      browser bundles or committed configuration, and is NEVER exposed to a
//      browser: the routes are called directly by the trusted test runner,
//      not through the application's client bundle.
//
// With an unconfigured or wrong token every route answers a uniform 403, so
// there is no oracle about deployment configuration. No caller — unauthen-
// ticated, guest or ordinary user — can read OTP codes or mint verified
// identities through these routes.
// ---------------------------------------------------------------------------

/** Constant-time equality for the test-runner secret (no node:crypto). */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  let diff = ab.length ^ bb.length;
  const max = Math.max(ab.length, bb.length);
  for (let i = 0; i < max; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Development test-harness authorization: dev-only deployment AND the trusted
 * test-runner secret. Returns false in every non-authorized case (no
 * distinction between "not a dev deployment" and "wrong token" toward the
 * caller).
 */
function isTrustedDevTester(request: Request): boolean {
  if (!guestAuthEnabled()) return false;
  const expected = process.env.IITAMS_TESTER_TOKEN;
  if (expected === undefined) return false;
  const presented = request.headers.get("x-iitams-tester-token");
  if (presented === null) return false;
  return constantTimeEqual(presented, expected);
}

function jsonError(status: number): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /api/dev-otp { email } — trusted test harness: return the pending
 * DEVELOPMENT OTP code for one address so a trusted runner can complete a
 * REAL email-OTP authentication for a test identity. Only the internal
 * reference api.devOtp.pending (see src/convex/devOtp.ts) is queried; there
 * is no publicly callable endpoint returning OTP values.
 */
http.route({
  path: "/api/dev-otp",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let email: string;
    try {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email !== "string" || !body.email.includes("@")) {
        return new Response(JSON.stringify({ error: "invalid email" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      email = body.email;
    } catch {
      return new Response(JSON.stringify({ error: "invalid body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const pending = await ctx.runQuery(internal.devOtp.pending, { email });
    if (!pending) return new Response(JSON.stringify({ code: null }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
    return new Response(JSON.stringify({ code: pending.code, expiresAt: pending.expiresAt }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * POST /api/dev-seed-test-user { email } — trusted test harness: create a
 * NON-anonymous VERIFIED test identity (no organization profile) through the
 * INTERNAL reference api.session.seedVerifiedTestUser. No publicly callable
 * endpoint can create verified identities.
 */
http.route({
  path: "/api/dev-seed-test-user",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let email: string;
    try {
      const body = (await request.json()) as { email?: unknown };
      if (typeof body.email !== "string" || !body.email.includes("@")) {
        return new Response(JSON.stringify({ error: "invalid email" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        });
      }
      email = body.email;
    } catch {
      return new Response(JSON.stringify({ error: "invalid body" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await ctx.runMutation(internal.session.seedVerifiedTestUser, { email });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
});

/**
 * POST /api/dev-grant-demo-role { userId | email, role?, ttlMinutes? } —
 * trusted test harness: grant an approved TEST demo role (audit_manager or
 * admin) to a specific, already-provisioned anonymous demo guest. The actual
 * role change runs through the INTERNAL mutation session.grantDemoTestRole
 * (see src/convex/session.ts for the full authorization model). The guest's
 * userId MUST come from the guest's own authorized session query — the
 * runner reads it from the browser over the normal session channel and then
 * calls this route directly; the tester token never enters the browser.
 */
http.route({
  path: "/api/dev-grant-demo-role",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let args: { userId?: unknown; email?: unknown; role?: unknown; ttlMinutes?: unknown };
    try {
      args = (await request.json()) as typeof args;
    } catch {
      return jsonError(403); // malformed body from an unauthorized caller: uniform refusal
    }
    if (typeof args.userId !== "string" || args.userId.length === 0) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (
      args.role !== undefined &&
      (typeof args.role !== "string" ||
        (args.role !== "audit_manager" && args.role !== "admin"))
    ) {
      // Unknown or unsupported roles are rejected outright — never defaulted.
      return new Response(
        JSON.stringify({ error: "unknown or unsupported demo test role" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }
    // Hygiene sweep first: persist expired grants (and thereby propagate the
    // expiry to cached session reads, which only freshen on server writes).
    await ctx.runMutation(internal.session.expireDemoTestGrants).catch(() => undefined);
    const run = await ctx
      .runMutation(internal.session.grantDemoTestRole, {
        userId: args.userId as never,
        role: typeof args.role === "string"
          ? args.role
          : undefined,
        ttlMinutes: typeof args.ttlMinutes === "number" && Number.isFinite(args.ttlMinutes)
          ? args.ttlMinutes
          : undefined,
      })
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-revoke-demo-role { userId } — trusted test harness: revoke a
 * demo guest's test role (restores the read-only member tier). Same trusted-
 * runner-only authorization; teardown-revocation of every grant the runner
 * made is the primary lifecycle control (the server-enforced deadline is
 * the backstop when no teardown runs).
 */
http.route({
  path: "/api/dev-revoke-demo-role",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let args: { userId?: unknown };
    try {
      args = (await request.json()) as typeof args;
    } catch {
      return jsonError(403);
    }
    if (typeof args.userId !== "string" || args.userId.length === 0) {
      return jsonError(403);
    }
    // Hygiene sweep first (see grant route).
    await ctx.runMutation(internal.session.expireDemoTestGrants).catch(() => undefined);
    const run = await ctx
      .runMutation(internal.session.revokeDemoTestRole, { userId: args.userId as never })
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-expire-demo-grants — trusted test harness: persist every
 * expired demo test grant (resetting those guests to the read-only tier and
 * clearing the expiry state). This is the runner-side hook for asserting
 * server-enforced expiry; revocation and grant routes run it automatically.
 */
http.route({
  path: "/api/dev-expire-demo-grants",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    try {
      const result = await ctx.runMutation(internal.session.expireDemoTestGrants);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    } catch (err: unknown) {
      return new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
  }),
});

/**
 * POST /api/dev-invite-acceptance-link { invitationId } — trusted test
 * harness (Batch 2C): re-issue the acceptance secret of a pending test
 * invitation and return the full browser acceptance link. This is the ONLY
 * non-production path that exposes an invitation secret: it is dev-gated
 * AND token-guarded (same isTrustedDevTester model), and the secret is
 * never handed to ordinary browser sessions or the app bundle. Re-issuing
 * invalidates the previous token exactly like an administrative resend.
 */
http.route({
  path: "/api/dev-invite-acceptance-link",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let args: { invitationId?: unknown };
    try {
      args = (await request.json()) as typeof args;
    } catch {
      return jsonError(403); // malformed body from an unauthorized caller: uniform refusal
    }
    if (typeof args.invitationId !== "string" || args.invitationId.length === 0) {
      return jsonError(403);
    }
    const run = await ctx
      .runMutation(internal.invitations.harnessReissueInvitation, {
        invitationId: args.invitationId as never,
      })
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-invite-redeliver { invitationId, expectedSecretHash? } —
 * trusted test harness (Batch A1 stabilization): replay the delivery
 * pipeline SYNCHRONOUSLY (ctx.runAction) so a test can deterministically
 * reproduce scheduler/reissue orderings without waiting for wall-clock
 * scheduling latency.
 *
 *  - body WITHOUT `expectedSecretHash`: the route snapshots the
 *    invitation's CURRENT hash via an internal query and passes it as the
 *    generation anchor — i.e. "deliver normally, as of now".
 *  - body WITH `expectedSecretHash`: the caller pins an EXPLICIT anchor —
 *    the exact shape of a queued scheduled action whose generation was
 *    captured before a newer reissue — enabling the stale-action regression.
 *
 * The anchor is a one-way hash only; no plaintext secret is ever accepted
 * or returned here beyond the normal delivery outcome. Dev-gated AND
 * token-guarded like every other harness route.
 */
http.route({
  path: "/api/dev-invite-redeliver",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let args: { invitationId?: unknown; expectedSecretHash?: unknown };
    try {
      args = (await request.json()) as typeof args;
    } catch {
      return jsonError(403); // malformed body from an unauthorized caller: uniform refusal
    }
    if (typeof args.invitationId !== "string" || args.invitationId.length === 0) {
      return jsonError(403);
    }
    // Explicit anchors must look like a SHA-256 hex digest; the guard can
    // only be exercised with a generation the caller actually pinned.
    if (
      args.expectedSecretHash !== undefined &&
      (typeof args.expectedSecretHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(args.expectedSecretHash))
    ) {
      return jsonError(403);
    }
    const pinnedAnchor =
      args.expectedSecretHash !== undefined
        ? (args.expectedSecretHash as string)
        : undefined;
    const run = (async () => {
      if (pinnedAnchor !== undefined) {
        return await ctx.runAction(internal.invitations.deliverInvitationEmail, {
          invitationId: args.invitationId as never,
          expectedSecretHash: pinnedAnchor,
        });
      }
      // Snapshot the CURRENT hash right now: this becomes the anchor, so a
      // concurrent newer issuance between snapshot and action execution is
      // correctly refused by the mint guard.
      const inv = (await ctx.runQuery(internal.invitations.getForDeliverySnapshot, {
        invitationId: args.invitationId as never,
      })) as { currentSecretHash: string | null } | null;
      const anchor =
        inv === null ? undefined : inv.currentSecretHash === null ? undefined : inv.currentSecretHash;
      return await ctx.runAction(internal.invitations.deliverInvitationEmail, {
        invitationId: args.invitationId as never,
        expectedSecretHash: anchor,
      });
    })()
      .then(
        (result) => new Response(JSON.stringify(result ?? { ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-expire-invitations { organizationId? } — trusted test
 * harness: persist due invitation expiry (pending → expired) for the whole
 * deployment or one organization, mirroring the production lifecycle sweep.
 */
http.route({
  path: "/api/dev-expire-invitations",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let body: unknown = {};
    try {
      body = await request.json();
    } catch {
      body = {}; // treat like an empty sweep request
    }
    const organizationId =
      (body as { organizationId?: unknown }).organizationId;
    const run = await ctx
      .runMutation(
        internal.invitations.harnessExpireInvitations,
        organizationId === undefined || typeof organizationId !== "string"
          ? {}
          : { organizationId: organizationId as never },
      )
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-expire-admin-grants { grantIds: string[] } — trusted test
 * harness: expire therunner's OWN pending administrator grants (pending →
 * expired with the same immutable audit event as lazy expiry). Test
 * isolation (source-review fix): the route exists ONLY for records the
 * runner explicitly names; a blanket organization-wide or global expiry
 * (the former force:true behaviour) is refused — test artifacts must never
 * surface as production lifecycle changes outside the test's fixtures.
 */
http.route({
  path: "/api/dev-expire-admin-grants",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let args: { grantIds?: unknown; force?: unknown };
    try {
      args = (await request.json()) as typeof args;
    } catch {
      return jsonError(403); // malformed body from an unauthorized caller: uniform refusal
    }
    const grantIds = Array.isArray(args.grantIds)
      ? (args.grantIds as unknown[]).filter(
          (g): g is string => typeof g === "string" && g.length > 0,
        )
      : [];
    if (grantIds.length === 0) {
      // No explicit fixture list — refuse (never a global/bulk sweep).
      return jsonError(403);
    }
    const run = await ctx
      .runMutation(internal.adminLifecycle.expireDueGrants, {
        grantIds: grantIds as never,
      })
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

/**
 * POST /api/dev-revert-demo-admin-grants { fixtureUserIds: string[] } —
 * trusted test harness: revert ONLY the demo-role artifacts of the explicit
 * fixture users the runner names (its own granted guests). Test isolation
 * (source-review fix): refusing when no explicit fixture list is supplied
 * guarantees the old organization-wide sweep cannot silently revert
 * administrators outside the test's own fixtures.
 */
http.route({
  path: "/api/dev-revert-demo-admin-grants",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    if (!isTrustedDevTester(request)) return jsonError(403);
    let fixtureUserIds: string[] = [];
    try {
      const body = (await request.json()) as { fixtureUserIds?: unknown };
      fixtureUserIds = Array.isArray(body?.fixtureUserIds)
        ? (body.fixtureUserIds as unknown[]).filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          )
        : [];
    } catch {
      return jsonError(403);
    }
    if (fixtureUserIds.length === 0) {
      return jsonError(403);
    }
    const run = await ctx
      .runMutation(internal.devOtp.revertDemoAdminGrants, {
        fixtureUserIds: fixtureUserIds as never,
      })
      .then(
        (result) => new Response(JSON.stringify(result), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .catch((err: unknown) =>
        new Response(JSON.stringify({ error: (err as Error).message.slice(0, 200) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    return run;
  }),
});

export default http;
