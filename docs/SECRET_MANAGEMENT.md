# IITAMS — Secret Management

> Status: Phase-1 final closure reference. Applies to this repository in all
> three operating modes: local development, the current managed development
> deployment, and a future self-hosted production deployment.

## 1. Principles

1. **No secrets in source control.** Ever. Not in the working tree, not in
   commit history, not in generated artefacts.
2. **No hard-coded credentials in code.** Provider keys are read from
   environment variables at runtime.
3. **Fail closed.** Code paths that require a secret must not operate when the
   secret is absent — they must not fall back to a default key or endpoint.
4. **Least exposure.** Each secret is known to the smallest set of components
   that needs it (e.g. the OTP provider key is only read by the Convex email
   action, never shipped to the browser bundle).
5. **Rotation is part of the lifecycle.** Every credential has an owner, a
   storage location, and a documented rotation procedure.

## 2. Where secrets live

| Environment | Storage | Example keys |
| --- | --- | --- |
| Local development | `.env` (git-ignored; created manually from `docs/ENVIRONMENT_VARIABLES.md`) | `VITE_CONVEX_URL`, `RESEND_API_KEY` |
| Convex deployment | `npx convex env set` / Convex dashboard (server-side only) | `JWKS`, `JWT_PRIVATE_KEY`, `RESEND_API_KEY` |
| CI | CI secret store (never `env:` literals in workflow files) | Deploy tokens |
| Production (self-hosted) | Server-side env file outside the repo, or the platform's secret manager | Same as Convex deployment set |

The `.gitignore` excludes `.env`, `.env.*` (with an explicit `!.env.example`
exception), `secrets/`, `*.pem`, `*.key`, private keys and certificate
material, and database dumps. Note: the Freebuff platform blocks writing
`.env*` files from agent tooling, so `.env.example` is published as
`docs/ENVIRONMENT_VARIABLES.md` instead.

## 3. Runtime secret consumers (verified)

| Secret | Read by | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | `src/convex/auth/emailOtp.ts` (Resend provider) | Only when `IITAMS_EMAIL_PROVIDER=resend` |
| `RESEND_FROM` | `src/convex/auth/emailOtp.ts` | From-address for the Resend provider |
| `VLY_OTP_API_KEY` | `src/convex/auth/emailOtp.ts` (dev adapter) | Only when BOTH dev flags are enabled; the dev adapter endpoint constant is public |
| `IITAMS_EMAIL_PROVIDER` | `src/convex/auth/emailOtp.ts` | Provider selector: `resend` \| `freebuff_dev` \| `none` (safe default) |
| `IITAMS_ALLOW_GUEST_AUTH` | `src/convex/access.ts` | Enables anonymous/guest sessions (development only) |
| `IITAMS_ENABLE_FREEBUFF_DEVTOOLS` | `src/convex/auth.config.ts`, `src/dev/DevTools.tsx` | Gates all development-platform tooling; production-safe default is absent/false |
| `JWKS` / `JWT_PRIVATE_KEY` | Convex Auth (platform-managed) | Not readable by application code |
| `VITE_CONVEX_URL` | Frontend build | Public by design (client deployment URL) |

The frontend production bundle must never contain provider keys. The closure
process verifies this by scanning `dist/` for provider markers after every
production build (see §6).

## 4. Incident record — exposed credentials

Two credentials were exposed historically (both have been **removed from the
working tree and from the code**; removal does NOT make them safe — they must
still be rotated/revoked by the owner):

| # | Credential | Where it was exposed | Remediation in repo | Owner action required |
| --- | --- | --- | --- | --- |
| 1 | dotenv private key material (`.env.keys`, 416 bytes) | Committed to the repository main branch (published on GitHub) | File deleted; `.gitignore` hardened; `docs/ENVIRONMENT_VARIABLES.md` is the only published template | **ROTATE/REVOKE REQUIRED** — treat the key material as compromised; if it decrypts any `.env` artefacts, regenerate those environments |
| 2 | OTP delivery API key (`fb_email_…` format) | Hard-coded in `src/convex/auth/emailOtp.ts` (published on GitHub) | Replaced by the `IITAMS_EMAIL_PROVIDER` abstraction; no key material in code; endpoint moved behind the dual dev-flag gate | **REVOKE/ROTATE REQUIRED** — invalidate the key at the provider and, if the dev OTP path is still used, reissue under `VLY_OTP_API_KEY` |

Rotation procedures:

- **dotenv key material**: treat every value it could have encrypted as
  exposed. Recreate affected `.env` files from `docs/ENVIRONMENT_VARIABLES.md`,
  generate new key material, and discard the old.
- **OTP API key**: revoke at the issuing provider console, issue a
  replacement, and set it as an environment variable
  (`npx convex env set VLY_OTP_API_KEY <new value>`) — never in source.

## 5. Handling new secrets

1. Choose the narrowest environment that needs it (Convex env for backend,
   `VITE_`-prefixed only for genuinely public client values).
2. Add the key to `docs/ENVIRONMENT_VARIABLES.md` with a description and an
   empty example value.
3. Never paste real values into documentation, tests, or code comments.
4. Prefer fail-closed reads: `process.env.KEY === "expected"` or explicit
   absence handling (`undefined` disables the feature).
5. For third-party services, wire backend keys through Convex actions and read
   them with `process.env` in `"use node"` files.

## 6. Scanning

Before each closure, run a secret scan (counts only are reported in closure
documents):

```bash
grep -rInE "fb_email_[A-Za-z0-9]|sk_live_|sk_test_|AKIA[0-9A-Z]{16}|BEGIN (RSA |EC )?PRIVATE KEY" \
  --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . || echo "0 matches"
```

And after a production build, verify the bundle is free of provider markers:

```bash
grep -rIlE "freebuff|vly|@vly-ai|auth\.freebuff\.app" dist/ || echo "dist clean"
```

Any non-zero match in either scan is a release blocker.
