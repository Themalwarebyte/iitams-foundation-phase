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

export default http;
