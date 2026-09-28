# IITAMS — Self-Hosting Architecture

> Target requirement: **No Freebuff or Convex Cloud dependency after final
> self-hosting.** The complete Convex backend must eventually run on
> infrastructure controlled by the project owner.

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

None is a **runtime** dependency: the built application is a static SPA plus
a Convex endpoint, fully reproducible on standard infrastructure —
`VITE_CONVEX_URL` decides where the backend lives.

## 7. Self-hosting smoke test

After deployment, verify: landing renders, `/auth` loads, sign-in works,
protected routes redirect unauthenticated users, dashboard renders, sidebar
navigation works, logout works. This is the same checklist as the closure
browser smoke suite (§8 of the closure report).
