# IITAMS Environment Variables

> A literal `.env.example` is intentionally not committed: deployment secret
> surfaces (including `.env*` paths) are blocked in this repository by policy.
> Copy the template below into `.env` locally and fill in real values — and
> never commit that file.

## Template

```bash
# IITAMS environment configuration (template — copy to .env and fill in)
# Never commit real values. Secrets belong in your deployment secret store.

# --- Convex backend ---------------------------------------------------------
# Convex deployment URL used by the web client (from the Convex dashboard or
# `npx convex dev` output).
VITE_CONVEX_URL=https://<your-deployment>.convex.cloud

# Convex-deployment-side variables (set with `npx convex env set`, not here):
#   CONVEX_SITE_URL   — public site URL used as the auth JWT issuer
#   JWKS              — auth signing keys (generated during auth setup)
#   JWT_PRIVATE_KEY   — auth signing key (generated)
#   SITE_URL          — canonical site URL for auth redirects

# --- Frontend build ---------------------------------------------------------
VITE_SITE_URL=http://localhost:5173

# --- Optional: SMTP for OTP delivery in self-hosted deployments -------------
# When unset, dev OTP codes surface in the Convex dashboard instead of email.
# SMTP_HOST=
# SMTP_PORT=587
# SMTP_USER=
# SMTP_PASSWORD=
# SMTP_FROM="IITAMS <no-reply@example.go.ke>"
```

## Variable reference

| Variable | Scope | Required | Purpose |
| --- | --- | --- | --- |
| `VITE_CONVEX_URL` | build (Vite) | Yes | Convex deployment the web client talks to. |
| `CONVEX_SITE_URL` | Convex deployment | Yes | Public URL used as the auth token issuer. |
| `JWKS` / `JWT_PRIVATE_KEY` | Convex deployment | Yes | Auth token signing material. |
| `SITE_URL` | Convex deployment | Yes | Canonical URL for auth redirects. |
| `VITE_SITE_URL` | build (Vite) | No | Canonical public URL for self-hosted runs. |
| `SMTP_*` | Convex deployment | No | Email delivery for OTP codes in production. |

## Precedence & security notes

- `VITE_*` variables are **baked into the static bundle at build time** — they
  are not secrets and must never contain credential values.
- Convex-deployment variables are set via `npx convex env set KEY value` and
  stay server-side; they never reach the browser.
- In Docker builds, pass `VITE_CONVEX_URL` as a build arg (see `Dockerfile`).
