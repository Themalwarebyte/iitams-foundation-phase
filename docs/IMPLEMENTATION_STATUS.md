# IITAMS — Implementation Status

> Phase 1 complete · Verified September 2026 · See
> `docs/MODULE_IMPLEMENTATION_MATRIX.md` for per-module detail.

## Phase 1 — Foundation (this phase)

| Workstream | Status | Evidence |
| --- | --- | --- |
| Repository baseline & audit | ✅ | `docs/PHASE_1_BASELINE.md` |
| Design system (Ministry-sourced tokens, severity/classification, components) | ✅ | `src/index.css`, `src/lib/severity.ts`, `docs/DESIGN_SYSTEM.md` |
| Interactive visual backgrounds (reduced-motion aware) | ✅ | `src/components/VisualBackground.tsx`, landing hero, auth panel |
| Application shell (permission-aware sidebar, top bar, breadcrumbs) | ✅ | `src/components/iitams/*` |
| Executive dashboard (12 KPIs, 5 charts, deadlines, activity) | ✅ | `src/pages/Dashboard.tsx` + `src/convex/dashboard.ts` |
| Navigation & routes for all 8 module groups (46 items) | ✅ | `src/lib/nav.ts` + route registry in `src/main.tsx` |
| RBAC (roles → permissions, fail-closed) | ✅ | `src/convex/access.ts`, `src/lib/permissions.ts` |
| Domain schema (15 tables, multi-tenant) | ✅ | `src/convex/schema.ts` |
| Demo data seeding (flagged, idempotent) | ✅ | `src/convex/seed.ts` |
| Notifications & audit logging | ✅ | `src/convex/notifications.ts`, top-bar popover, activity feed |
| Auth flow preserved & restyled | ✅ | `src/pages/Auth.tsx` (logic untouched, design updated) |
| Self-hosting assets (Docker, Compose, nginx) | ✅ | `Dockerfile`, `docker-compose.yml`, `deploy/nginx.conf` |
| Documentation set | ✅ | 8 docs in `docs/` + README |
| Tests (unit) | ✅ | 14 tests passing (`tests/phase1.test.ts`) |

## Phase 2 — Recommended next (not started)

1. **Module workflows** — findings, corrective actions, risks, controls and
   vulnerabilities: full CRUD UIs with assignment, transitions and evidence
   links (schema already in place).
2. **Evidence management** — S3/MinIO storage abstraction, upload validation,
   SHA-256 integrity hashing, classification enforcement.
3. **User provisioning** — admin invites, role assignment UI, disable
   anonymous sign-in in production.
4. **Administration UIs** — organizations/MDACs, users, roles, audit-log
   viewer.
5. **Reporting engine** — scheduled PDF/CSV generation and delivery.
6. **CI/CD** — GitHub Actions: typecheck, tests, build, dependency audit.

## Longer-term (Phase 3+)

- REST/OData public API surface with OpenAPI.
- OIDC/LDAP enterprise identity bridge (SSO).
- PostgreSQL analytical mirror + BI exports.
- Mobile-responsive field-audit companion (PWA offline capture).

## Verification snapshot

- `bun convex dev --once` — backend deployed clean.
- `bun tsc -b --noEmit` — zero errors.
- `bun test` — 14/14 passing.
