# IITAMS — Implementation Status

> Phase 1 (foundation) + Phase 2 (Core IT Audit Management Engine) complete ·
> Verified September 2026 · See `docs/MODULE_IMPLEMENTATION_MATRIX.md` for
> per-module detail and `docs/PHASE_2_IMPLEMENTATION.md` for the Phase-2
> delivery breakdown.

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
| Tests (unit + browser smoke) | ✅ | 15 unit tests + 10 Chromium smoke tests passing (`tests/`) |

## Phase 2 — Core IT Audit Management Engine (complete)

| Workstream | Status | Evidence |
| --- | --- | --- |
| Recovery validation after sandbox incidents | ✅ | `docs/PHASE_2_RECOVERY_CHECK.md` |
| Audit universe management (CRUD, archive, search, history) | ✅ | `src/convex/auditUniverse.ts`, `/audit/universe` |
| Risk-based planning + server-side priority scoring | ✅ | `src/lib/auditScoring.ts`, `src/convex/auditPlans.ts`, `/audit/plans` |
| Engagement lifecycle (7 stages, role-guarded) | ✅ | `src/lib/auditWorkflow.ts`, `src/convex/auditEngagements.ts`, `/audit/engagements` |
| Team assignment (assignment-gated authority) | ✅ | `src/convex/auditAccess.ts`, `auditAssignments` |
| Programs & procedures (Pass/Fail/Exception) | ✅ | `src/convex/auditWorkpapers.ts`, `/audit/programs` |
| Working papers (preparer/reviewer workflow) | ✅ | `/audit/workpapers` |
| Evidence (server-side SHA-256, classification, access logs) | ✅ | `src/convex/auditEvidence.ts`, `/audit/evidence` |
| Findings lifecycle + management response | ✅ | `src/convex/auditFindings.ts`, `/audit/findings` |
| Corrective actions (overdue, reminders, verification) | ✅ | `/audit/actions` |
| Reporting foundation (engagement/findings/executive; PDF+Word) | ✅ | `src/convex/auditReports.ts`, `/audit/reports` |
| Dashboard expansion (audit programme strip) | ✅ | `src/convex/auditDashboard.ts` |
| Notifications (assignment/review/finding/action/overdue) | ✅ | existing framework, extended |
| RBAC extension (6 audit roles) | ✅ | `src/convex/access.ts`, `src/lib/permissions.ts` |
| Tests (unit 64/64; smoke 10/10; lifecycle journey pending — dev server unreachable at closure, see test report) | ✅ / ⏳ | `tests/phase2.test.ts`, `tests/browser.audit-lifecycle.test.ts`, `docs/PHASE_2_TEST_REPORT.md` |
| Documentation set | ✅ | `docs/PHASE_2_IMPLEMENTATION.md`, `docs/AUDIT_MODULE_ARCHITECTURE.md`, `docs/AUDIT_WORKFLOW.md`, `docs/PHASE_2_DATA_MODEL.md` |

## Phase 3 — Recommended next (not started)

1. **User provisioning UI** — admin invites, role assignment, disable
   anonymous sign-in in production deployments.
2. **Administration UIs** — organizations/MDACs, users, roles, audit-log
   viewer.
3. **Remaining module workflows** — risk/compliance/cyber/BCM record CRUD UIs
   on the Phase-1 schema (foundation already in place).
4. **Reporting engine** — scheduled report generation and delivery.
5. **CI/CD** — GitHub Actions: typecheck, tests, build, dependency audit.

## Longer-term (Phase 3+)

- REST/OData public API surface with OpenAPI.
- OIDC/LDAP enterprise identity bridge (SSO).
- PostgreSQL analytical mirror + BI exports.
- Mobile-responsive field-audit companion (PWA offline capture).

## Verification snapshot (closure)

- `bun convex dev --once` — backend deployed clean.
- `bun tsc -b --noEmit` — zero errors.
- `bun run build` — production build succeeds.
- `bun test` — 25/25 passing (15 unit + 10 browser smoke).
