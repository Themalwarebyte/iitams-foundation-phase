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

## One-time administrator bootstrap (Convex deployment variables)

Set with `npx convex env set KEY value` on a FRESH deployment only — they
drive `claimInitialAdministrator` (see
[`ADMINISTRATOR_BOOTSTRAP.md`](ADMINISTRATOR_BOOTSTRAP.md))

```bash
IITAMS_BOOTSTRAP_ORG_CODE="HQ-MAIN"        # `code` of the target organization
IITAMS_BOOTSTRAP_ADMIN_EMAIL="ict.oair@example.go.ke"  # designated admin
IITAMS_BOOTSTRAP_TOKEN="<openssl rand -hex 24>"        # one-time activation secret
```

- All three variables are required together; if any is missing, bootstrap is
  disabled and the mutation refuses with a generic error.
- The plaintext token is never stored anywhere durable — only its SHA-256
  hash inside the `initialBootstraps` consumption row.
- After the first successful claim the bootstrap is permanently consumed;
  unset the variables as hygiene.

## Variable reference

| Variable | Scope | Required | Purpose |
| --- | --- | --- | --- |
| `VITE_CONVEX_URL` | build (Vite) | Yes | Convex deployment the web client talks to. |
| `CONVEX_SITE_URL` | Convex deployment | Yes | Public URL used as the auth token issuer. |
| `JWKS` / `JWT_PRIVATE_KEY` | Convex deployment | Yes | Auth token signing material. |
| `SITE_URL` | Convex deployment | Yes | Canonical URL for auth redirects. |
| `VITE_SITE_URL` | build (Vite) | No | Canonical public URL for self-hosted runs. |
| `SMTP_*` | Convex deployment | No | Email delivery for OTP codes in production. |
| `IITAMS_BOOTSTRAP_ORG_CODE` | Convex deployment | No (fresh deployments) | One-time administrator bootstrap target organization. |
| `IITAMS_BOOTSTRAP_ADMIN_EMAIL` | Convex deployment | No (fresh deployments) | Designated first administrator's email identity. |
| `IITAMS_BOOTSTRAP_TOKEN` | Convex deployment | No (fresh deployments) | High-entropy one-time activation secret (hash-only persistence). |
| `IITAMS_RECOVERY_ENABLED` | Convex deployment | No | Set to `true` **only** while running the exceptional CLI-only last-administrator recovery, then unset ([`ADMINISTRATOR_RECOVERY.md`](ADMINISTRATOR_RECOVERY.md)). |
| `IITAMS_EMAIL_PROVIDER` | Convex deployment | No | `resend` enables real OTP email delivery; unset means codes are not emailed ([`PREVIEW_OWNER_ACCESS.md`](PREVIEW_OWNER_ACCESS.md)). |
| `RESEND_API_KEY` | Convex deployment | No | Resend API key (secret; deployment environment only). |
| `RESEND_FROM` | Convex deployment | No | Verified Resend sender, e.g. `IITAMS <no-reply@your-domain>`. |
| `SITE_URL` | Convex deployment | No | Public application origin used in invitation/acceptance links. |
| `IITAMS_OWNER_PROVISIONING_ENABLED` | Convex deployment | No | Set to `true` **only** while running the documented non-production preview-owner procedure, then unset. |
| `IITAMS_OWNER_PROVISIONING_TOKEN` | Convex deployment | No | High-entropy one-shot operator token for that procedure (unset afterwards). |

## Precedence & security notes

- `VITE_*` variables are **baked into the static bundle at build time** — they
  are not secrets and must never contain credential values.
- Convex-deployment variables are set via `npx convex env set KEY value` and
  stay server-side; they never reach the browser.
- In Docker builds, pass `VITE_CONVEX_URL` as a build arg (see `Dockerfile`).
