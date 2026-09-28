# IITAMS — Self-Hosting Architecture

> Requirement: IITAMS must ultimately run on infrastructure controlled by the
> project owner, with no runtime dependency on any development platform.

## 1. Portability assessment

| Requirement | Status | Notes |
| --- | --- | --- |
| Docker / Docker Compose | ✅ | `Dockerfile` (multi-stage, nginx runtime) + `docker-compose.yml` |
| Standard Linux host | ✅ | Static SPA; any Linux + nginx/Caddy/Apache |
| Reverse proxy support | ✅ | `deploy/nginx.conf` (SPA fallback, secure headers); TLS terminates at your proxy |
| PostgreSQL for production | ✅ (provisioned) | Service in `docker-compose.yml`; Phase-1 system of record is Convex — documented migration path below |
| Environment-variable configuration | ✅ | See `docs/ENVIRONMENT_VARIABLES.md` |
| Persistent volumes | ✅ | `pgdata`, `web-logs` volumes declared |
| REST APIs | ✅ (extensible) | Convex HTTP router (`src/convex/http.ts`); REST/JSON endpoints can be added via Hono routes |
| Object/file storage abstraction | ⏳ Phase 2 | Evidence module will target an S3-compatible API (MinIO on-prem) |
| SMTP / email integration | ✅ (wire-up) | Env vars reserved (`SMTP_*`); OTP email action lands with production auth hardening |
| Standards-based identity | ✅ (path) | Convex Auth supports OIDC/OAuth providers; SSO/LDAP bridge documented as Phase 2+ |
| Backup & restore | ✅ documented | §4 |
| Export / import | ✅ documented | §5 |

## 2. Target production topology

```
Internet ──► Reverse proxy (TLS) ──► nginx [web tier, this repo]
                                        │
                                        ▼
                            Convex backend (self-hosted or managed)
                            ├─ function nodes  ──► document store
                            └─ auth (JWT sessions, OIDC-ready)
                                        │
                                        ▼
                        PostgreSQL 16 (reporting / integrations)
                        MinIO / S3 (evidence objects, Phase 2)
                        SMTP relay (notifications)
```

## 3. Deployment steps

```bash
# 1. Configure
cp docs/ENVIRONMENT_VARIABLES.md .env   # then edit (do not commit .env)
export VITE_CONVEX_URL=https://<your-deployment>.convex.cloud

# 2. Build & run
docker compose up -d --build

# 3. Verify
curl -f http://localhost:8080/            # SPA served
docker compose ps                          # healthchecks green
```

The web tier is stateless and horizontally scalable; sessions are stateless
JWTs, so no sticky sessions are required.

## 4. Backup & restore

| Asset | Backup | Restore |
| --- | --- | --- |
| Application data (Convex) | `npx convex export --path backup/` (scheduled, e.g. cron nightly) | `npx convex import backup/` into a fresh deployment |
| PostgreSQL | `docker compose exec postgres pg_dump -U iitams iitams > pg.sql` | `psql -U iitams iitams < pg.sql` |
| Evidence objects (Phase 2) | `mc mirror` / S3 sync of the MinIO bucket | reverse sync to a fresh bucket |
| Configuration | `.env` + secrets store snapshot (never in Git) | re-apply before restore |

Test restores quarterly; keep ≥ 30 days of application-data backups.

## 5. Export / import capability

- **Data out (Phase 1):** Convex supports full JSON export (`npx convex
  export`); all domain tables are plain documents, so the export is
  lossless.
- **Reports out:** dashboards/tables are print-to-PDF ready; report modules
  (Phase 2) will add scheduled PDF/CSV generation.
- **Data in:** `npx convex import` for JSONL; module-level CSV importers are
  a Phase-2 deliverable alongside evidence management.

## 6. Development-platform conveniences used (and their standard alternatives)

| Development convenience | Used for | Standard self-hosted alternative |
| --- | --- | --- |
| Managed Convex dev deployment | faster backend iteration in this environment | self-hosted Convex (`npx convex local` / open-source server) or Convex managed under your own account |
| Platform-managed preview/hosting | this Phase-1 working preview | nginx static hosting in `Dockerfile` |
| Platform secrets UI | dev-phase secret handling | your own secret store (Vault, SOPS, Docker secrets) |

None of these is a **runtime** dependency: the built application is a static
SPA plus a Convex endpoint, both fully reproducible on standard
infrastructure (`VITE_CONVEX_URL` decides where the backend lives).
