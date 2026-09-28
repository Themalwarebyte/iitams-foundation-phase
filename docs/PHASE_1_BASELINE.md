# IITAMS — Phase 1 Baseline

> Phase: 1 (Foundation, design system, UX & architecture baseline)
> Date: September 2026 · Environment: Vite + React + Convex

## 1. What was found

The repository was a **fresh scaffold** for the IITAMS initiative (the only
prior artifact referencing the programme was the page title "IITAMS
Foundation Phase"). Discovered state:

| Area | Baseline finding |
| --- | --- |
| Framework | Vite 7 + React 19 + TypeScript 5.9, Tailwind v4, shadcn/ui (new-york) |
| Routing | React Router v7; `/` landing (placeholder), `/auth`, `/dashboard` (starter), 404 |
| Backend | Convex with auth tables only (`users`, auth session/account tables) |
| Auth | Convex Auth — email OTP + anonymous; `/auth` wired with `returnTo` handling |
| UI | Default neutral shadcn theme, no product identity, starter dashboard |
| Tests | None |
| Docs | None |
| Deployment config | None |

No pre-existing IITAMS domain functionality existed to preserve — but the
**working auth flow, providers, error boundaries, routing skeleton and UI
library were preserved untouched** and extended rather than replaced.

## 2. What Phase 1 added (all verified in source)

- **Domain schema** (`src/convex/schema.ts`): **17 domain tables** across
  organization, audit, risk, compliance, cyber/VM, BCM/DR, notifications and
  audit-log domains, with multi-tenant `organizationId` scoping and indexes
  (24 tables total including the 7 Convex-Auth platform tables).
- **RBAC** (`src/convex/access.ts`, mirrored in `src/lib/permissions.ts`):
  admin / user / member roles mapped to typed permissions; session query
  resolves effective role + active organization.
- **Executive dashboard** (`src/convex/dashboard.ts`): server-side aggregate
  computing all 12 Phase-1 KPIs, severity distributions, 5×5 heat-map cells,
  trend series and an audit-log activity feed from stored rows (nothing
  fabricated client-side).
- **Demo seeding** (`src/convex/seed.ts`): idempotent, clearly-flagged demo
  organization (`IITAMS-DEMO`) with representative data so charts are
  meaningful in fresh environments.
- **Design system**: Ministry-sourced tokens (`src/index.css`), severity &
  classification system (`src/lib/severity.ts`), reusable composites
  (`src/components/iitams/`), interactive background
  (`src/components/VisualBackground.tsx`). See `docs/DESIGN_SYSTEM.md`.
- **Application shell**: permission-aware sidebar (all 8 groups / **48 items**
  from the brief), top bar with org context, global search, notifications,
  help, profile/logout; breadcrumbs on every module page.
- **Routes**: every navigation target resolves to a protected page.
- **Self-hosting assets**: `Dockerfile`, `docker-compose.yml`,
  `deploy/nginx.conf`, env-var documentation.
- **Authentication safety**: server-side guest gate (`guestAuthEnabled()`) —
  anonymous users fail all permission checks and receive no session context
  unless the deployment explicitly enables guest auth (development only).
- **Tests**: 15 bun tests covering nav contract (48-item), permissions,
  tokens and formatting (`tests/phase1.test.ts`).
- **Docs**: this file plus the six sibling documents.

## 3. Baseline preserved (verified working)

- Convex Auth email-OTP + guest sign-in flow (`/auth`), including error
  handling and `returnTo` redirect semantics.
- `RequireAuth` protected-route pattern with contextual messaging.
- Template providers, `RouteSyncer`, root/toolbar error boundaries.
- shadcn/ui primitives (used, not restyled beyond theme tokens).
- Template lint/format/build scripts.

## 4. Technical debt noted at baseline (carried forward)

| Debt | Disposition |
| --- | --- |
| No migration mechanism (Convex schema pushes are versioned by deployment) | Documented; PostgreSQL path prepared in compose file |
| Anonymous/guest accounts are indistinguishable from provisioned users at auth level | `userProfiles` table + demo org joining added in Phase 1; full provisioning workflow is Phase 2 |
| No test framework at baseline | bun tests added; E2E harness recommended for Phase 2 |
| No CI | Recommended Phase 2 |

## 5. Security observations at baseline

See `docs/SECURITY_HARDENING_BACKLOG.md` for the live list (rate limiting,
password/OTP policy, CSP, upload validation and evidence hashing are the
headline items).
