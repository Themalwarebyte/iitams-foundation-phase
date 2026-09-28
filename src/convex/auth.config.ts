import type { AuthConfig } from "convex/server";

/**
 * IITAMS authentication providers
 * ================================
 * Primary and default: this deployment's own Convex Auth (email OTP via
 * src/convex/auth/emailOtp.ts, plus the gated anonymous provider). A
 * self-hosted IITAMS functions fully with this entry alone — no request is
 * ever made to any external identity provider, and there is no implicit
 * Freebuff default.
 *
 * The Freebuff federated JWT provider is a DEVELOPMENT-ONLY adapter. It is
 * added ONLY when IITAMS_ENABLE_FREEBUFF_DEVTOOLS=true is explicitly set on
 * the deployment. Self-hosted production never evaluates that branch.
 */

const devtoolsEnabled =
  process.env.IITAMS_ENABLE_FREEBUFF_DEVTOOLS === "true";

const providers: AuthConfig["providers"] = [
  // Standard Convex Auth provider for this project's own sign-in ("Get
  // Started" email/guest, see src/convex/auth.ts). The deployment self-issues
  // JWTs (iss = CONVEX_SITE_URL, no `kid` header) validated via OIDC discovery
  // at `${domain}/.well-known/openid-configuration`, served by
  // auth.addHttpRoutes() in convex/http.ts. Do NOT convert this entry to
  // `type: "customJwt"` — that path rejects tokens without a `kid` header,
  // which would break normal IITAMS email authentication.
  {
    domain: process.env.CONVEX_SITE_URL!,
    applicationID: "convex",
  },
];

if (devtoolsEnabled) {
  // Development adapter: Freebuff-signed federated tokens let a signed-in
  // Freebuff user carry their identity into this dev project without local
  // sign-in. Requires a `kid`-bearing token + JWKS endpoint (why customJwt is
  // correct here). Never active unless explicitly enabled.
  const freebuffIssuer =
    process.env.VLY_CONVEX_AUTH_ISSUER ?? "https://freebuff.com";
  providers.push({
    type: "customJwt",
    issuer: freebuffIssuer,
    jwks: `${freebuffIssuer}/api/web/.well-known/jwks.json`,
    applicationID: "vly-convex",
    algorithm: "RS256",
  });
}

export default { providers } satisfies AuthConfig;
