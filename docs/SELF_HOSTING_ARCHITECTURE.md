# IITAMS — Self-Hosting Architecture

> Target requirement: **No Freebuff or Convex Cloud dependency after final
> self-hosting.** The complete Convex backend must eventually run on
> infrastructure controlled by the project owner.

## A. Two operating modes (development vs final production)

IITAMS runs in two clearly separated modes. Conflating them is a defect; this
section is the authoritative distinction.

### A.1 Current development mode (this environment)

| Aspect | State |
| --- | --- |
| Web tier | Vite dev server (managed by the development platform) |
| Backend | Managed Convex dev deployment (`VITE_CONVEX_URL` points at it) |
| Dev tooling | Vly toolbar / instrumentation / route bridge — loaded **only** when `import.meta.env.DEV` is true (`src/dev/DevTools.tsx`); the `vlyPlugin()` Vite plugin is **excluded from production builds** (`vite.config.ts`) |
| Dev conveniences | Platform preview hosting, platform secrets UI, guest sign-in (`IITAMS_ALLOW_GUEST_AUTH=true`), dev OTP adapter (`IITAMS_EMAIL_PROVIDER=freebuff_dev`, additionally gated by `IITAMS_ENABLE_FREEBUFF_DEVTOOLS=true`) |
| Auth | Own Convex Auth email-OTP provider; the platform JWT provider is only pushed when `IITAMS_ENABLE_FREEBUFF_DEVTOOLS=true` (production default: absent/false) |

### A.2 Final production mode (self-hosted target)

| Aspect | State |
| --- | --- |
| Web tier | Static SPA from `dist/` served by nginx (`Dockerfile`) — no dev tooling, no platform code |
| Backend | Self-hosted Convex (owner infrastructure) targeted purely via `VITE_CONVEX_URL` |
| Dev tooling | None present in the bundle (verified: production `dist/` scans clean for platform markers) |
| Dev conveniences | None: guest auth disabled (`IITAMS_ALLOW_GUEST_AUTH` unset), OTP via Resend (`IITAMS_EMAIL_PROVIDER=resend` + `RESEND_API_KEY`) or `none`, platform JWT provider absent |
| Runtime coupling | **None verified** — the production bundle is a static SPA plus a Convex endpoint URL; see §6 for evidence |

### A.3 Mode checklist

Before declaring production readiness, confirm:

- [ ] `bun run build` output (`dist/`) contains no platform markers
      (`freebuff`, `vly`, `auth.freebuff.app`, `@vly-ai`) — scan command in
      `docs/SECRET_MANAGEMENT.md` §6
- [ ] `IITAMS_ALLOW_GUEST_AUTH` unset/false on the deployment
- [ ] `IITAMS_ENABLE_FREEBUFF_DEVTOOLS` unset/false
- [ ] `IITAMS_EMAIL_PROVIDER=resend` (or `none`) with `RESEND_API_KEY` set
      server-side only
- [ ] `IITAMS-DEMO` organization absent or clearly flagged; demo seed not run
      against production data

## 0. Datastore strategy (authoritative)

| Concern | Strategy |
| --- | --- |
| **Transactional application datastore** | **Convex document store** — the single system of record. No parallel source of truth exists or is planned. |
| **Authentication datastore** | **Convex** (same deployment): `authAccounts`, `authSessions`, `authRefreshTokens`, `authVerificationCodes` + `users`. Credentials/session material never leaves the deployment. |
| **File / evidence storage** | Phase 1 stores no files. Phase 2 evidence will use an **S3-compatible object store (MinIO on-prem)** behind a storage abstraction; only object metadata lives in Convex. SHA-256 integrity hashing at ingest is part of the Phase-2 security backlog. |
| **Self-hosted Convex** | Convex is open-source and self-hostable; the client targets it purely via `VITE_CONVEX_URL`. Final topology: Convex backend nodes + its storage on owner infrastructure behind the owner's reverse proxy. Any managed service today is a development-phase convenience only. |
| **Backup / export strategy** | `npx convex export` (JSON) for the full datastore, scheduled (e.g. cron nightly) with ≥30-day retention; object storage mirrored with `mc mirror`/S3 sync in Phase 2; configuration from your secret store. Restores via `npx convex import`. Quarterly restore drills. |
| **Production migration strategy** | 1) Stand up self-hosted Convex; 2) `npx convex import` of exported data; 3) rebuild web tier with the new `VITE_CONVEX_URL`; 4) smoke-test (§7 of closure report); 5) decommission the managed deployment. The app is rebuildable from Git at any commit; data moves as data. |

**PostgreSQL is NOT a datastore of IITAMS.** The `postgres` service in
`docker-compose.yml` is **reserved/optional** under the opt-in `reporting`
profile for a possible Phase-3+ analytics mirror. It is not started by
default, holds no application data, and must never become a second source of
truth. Remove the service block entirely if it will never be used.

## 1. Portability assessment

| Requirement | Status | Notes |
| --- | --- | --- |
| Docker / Docker Compose | ✅ | `Dockerfile` (multi-stage, nginx runtime) + `docker-compose.yml` |
| Standard Linux host | ✅ | Static SPA; any Linux + nginx/Caddy/Apache |
| Reverse proxy support | ✅ | `deploy/nginx.conf` (SPA fallback, secure headers); TLS terminates at your proxy |
| PostgreSQL for production | ℹ️ reserved only | Opt-in `reporting` profile; **not** a datastore of IITAMS |
| Environment-variable configuration | ✅ | See `docs/ENVIRONMENT_VARIABLES.md` |
| Persistent volumes | ✅ | `pgdata` (optional profile), `web-logs` |
| REST APIs | ✅ (extensible) | Convex HTTP router (`src/convex/http.ts`); REST/JSON endpoints can be added via Hono routes |
| Object/file storage abstraction | ⏳ Phase 2 | Evidence module will target S3-compatible API (MinIO on-prem) |
| SMTP / email integration | ✅ (wire-up) | Env vars reserved (`SMTP_*`); OTP email action lands with production auth hardening |
| Standards-based identity | ✅ (path) | Convex Auth supports OIDC/OAuth providers; SSO/LDAP bridge Phase 2+ |
| Backup & restore | ✅ documented | §0 and §4 |
| Export / import | ✅ documented | §5 |

## 2. Target production topology

```
Internet ──► Reverse proxy (TLS) ──► nginx [web tier, this repo]
                                        │
                                        ▼
                       Self-hosted Convex backend (owner infra)
                        ├─ function nodes  ──► document store  ◄── system of record
                        └─ auth (JWT sessions, OIDC-ready)          (incl. auth tables)
                                        │
                    (optional, opt-in)  ▼
             PostgreSQL "reporting" profile — analytics mirror only
                        MinIO / S3 (evidence objects, Phase 2)
                        SMTP relay (notifications)
```

## 3. Deployment steps

```bash
# 1. Configure
cp docs/ENVIRONMENT_VARIABLES.md .env   # then edit (do not commit .env)
export VITE_CONVEX_URL=https://<your-convex-endpoint>

# 2. Build & run
docker compose up -d --build

# 3. Verify
curl -f http://localhost:8080/            # SPA served
docker compose ps                          # healthchecks green
```

The web tier is stateless and horizontally scalable; sessions are stateless
JWTs — no sticky sessions required.

## 4. Backup & restore

| Asset | Backup | Restore |
| --- | --- | --- |
| Application data (Convex, incl. auth) | `npx convex export --path backup/` — nightly, ≥30-day retention | `npx convex import backup/` into a fresh deployment |
| Evidence objects (Phase 2) | `mc mirror` / S3 sync | reverse sync to a fresh bucket |
| Configuration | `.env` + secrets store snapshot (never in Git) | re-apply before restore |

Test restores quarterly.

## 5. Export / import capability

- **Data out (Phase 1):** `npx convex export` — lossless JSON of all tables.
- **Reports out:** dashboards/tables are print-to-PDF ready; scheduled
  report generation is a Phase-2 deliverable.
- **Data in:** `npx convex import` (JSONL); module-level CSV importers are
  Phase 2.

## 6. Development-platform conveniences used (and their standard alternatives)

| Development convenience | Used for | Standard self-hosted alternative |
| --- | --- | --- |
| Managed Convex dev deployment | backend iteration in this environment | self-hosted Convex or Convex managed under your own account |
| Platform-managed preview/hosting | this Phase-1 working preview | nginx static hosting in `Dockerfile` |
| Platform secrets UI | dev-phase secret handling | your own secret store (Vault, SOPS, Docker secrets) |
| Guest sign-in + dev OTP adapter | friction-free evaluation of the preview | real email-OTP sign-in via Resend; guest path refuses to run without both dev flags |

**Runtime coupling: none (verified at Phase-1 closure).** Evidence:

1. `vite.config.ts` excludes `vlyPlugin()` from build invocations
   (`process.argv` contains `build`); it runs in dev only.
2. `src/main.tsx` imports `src/dev/DevTools.tsx` lazily and only under
   `import.meta.env.DEV`; the module is unreachable in the production bundle.
3. `src/lib/vly-integrations.ts` was removed; `@vly-ai/integrations` and
   `@zumer/snapdom` are devDependencies only.
4. `src/convex/auth.config.ts` adds the platform JWT provider only when
   `IITAMS_ENABLE_FREEBUFF_DEVTOOLS === "true"`.
5. `src/convex/auth/emailOtp.ts` selects the delivery provider explicitly
   (`resend` / `freebuff_dev` / `none`); the dev adapter requires BOTH dev
   flags and reads its key from `VLY_OTP_API_KEY` — no hard-coded endpoints
   or keys in the delivery path.
6. Production-build scan of `dist/` returns **0 files** matching
   `freebuff`, `vly`, `auth.freebuff.app`, `@vly-ai`.

The built application is a static SPA plus a Convex endpoint —
`VITE_CONVEX_URL` decides where the backend lives.

## 7. Self-hosting smoke test

After deployment, verify: landing renders, `/auth` loads, sign-in works,
protected routes redirect unauthenticated users, dashboard renders, sidebar
navigation works, logout works. This is the same checklist as the closure
browser smoke suite (§8 of the closure report).
