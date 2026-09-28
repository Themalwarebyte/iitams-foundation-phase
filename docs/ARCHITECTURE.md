# IITAMS Architecture

> Status: Phase 1 · Modular monolith on Convex + React SPA

## 1. High-level topology

```
┌─────────────────────────────┐        ┌──────────────────────────────┐
│  Web tier (this repo)       │  WSS/  │  Backend tier (Convex)       │
│  Vite + React 19 SPA        │◄─HTTP─►│  Functions + document store  │
│  Tailwind v4 + shadcn/ui    │        │  Auth (JWT sessions)         │
│  Static hosting / nginx     │        │  Reactive subscriptions      │
└─────────────────────────────┘        └──────────────────────────────┘
```

The web tier is a **static SPA** served by any web server (nginx config in
`deploy/nginx.conf`). The backend tier is **Convex** — a modular monolith of
typed server functions over its document store — reached over WebSocket/HTTP
from the client. This satisfies the Phase-1 constraint of a modular monolith
while remaining portable: Convex is open-source and self-hostable, and the
documented production target adds PostgreSQL alongside for relational
reporting/integration needs (see `docs/SELF_HOSTING_ARCHITECTURE.md`).

## 2. Repository layout

```
src/
  convex/            # Backend domain modules (schema + queries + mutations)
    schema.ts        #   All domain tables, indexes, shared validators
    access.ts        #   RBAC permission model + session resolution
    session.ts       #   Shell session query, join-org mutation
    dashboard.ts     #   Executive aggregate query (KPIs, distributions)
    notifications.ts #   Notifications + append-only audit log
    seed.ts          #   Idempotent demo-data seeder (flagged isDemo)
  pages/             # Route-level views (Landing, Auth, Dashboard, Module…)
  components/
    ui/              # shadcn/radix primitives (do not restyle ad hoc)
    iitams/          # IITAMS composites (shell, KPI, charts, badges…)
    VisualBackground.tsx
  lib/
    nav.ts           # Single source of truth for navigation/routes
    permissions.ts   # Client mirror of the RBAC permission set
    severity.ts      # Severity + classification token maps
    format.ts        # Date/number formatting
    utils.ts         # cn() etc.
  hooks/use-auth.ts  # Auth state + actions
tests/               # bun test suites
docs/                # Phase documentation (this folder)
deploy/nginx.conf    # Self-hosted static serving config
Dockerfile           # Multi-stage build for the web tier
docker-compose.yml   # Self-hosting composition
```

## 3. Domain boundaries

The backend is organised as bounded modules over one schema — a modular
monolith with clean seams for later extraction:

| Domain | Convex module(s) | Tables |
| --- | --- | --- |
| Identity & Access | `auth` (Convex Auth), `access.ts` | `users`, `authSessions`, `authAccounts`, `userProfiles` |
| Organization Management | `access.ts`, `session.ts` | `organizations` |
| Audit Management | `dashboard.ts` | `auditUniverseItems`, `auditPlans`, `auditEngagements`, `findings`, `correctiveActions` |
| ICT Risk Management | `dashboard.ts` | `risks`, `riskTrendSnapshots` |
| Compliance Management | `dashboard.ts` | `complianceFrameworks`, `controls` |
| Cybersecurity Assurance / Vulnerability Management | `dashboard.ts` | `vulnerabilities`, `securityAssessments` |
| BCM / DR | `dashboard.ts` | `criticalServices`, `drTests` |
| Reporting & Analytics | `dashboard.ts` | pre-aggregated `riskTrendSnapshots`, executive aggregate |
| Notifications | `notifications.ts` | `notifications` |
| Audit Logging | `notifications.ts` | `auditLogs` (append-only) |
| Administration | `session.ts` | org/user provisioning (Phase 2 UI) |
| Integrations | reserved | — (Phase 2+) |

## 4. Data flow

1. **Reads** are reactive Convex queries; the shell (`session.getSession`)
   and dashboard (`dashboard.executive`) aggregate server-side so the client
   never duplicates state.
2. **Writes** go through typed mutations; significant actions append to
   `auditLogs` (actor, action, entity, timestamp).
3. **Auth** uses Convex Auth (email OTP + anonymous for demos) issuing JWT
   sessions; `getAuthUserId` guards every server function; effective role
   resolves from the user profile.
4. **Tenancy** — every domain row carries `organizationId`; queries filter by
   the acting user's active organization.

## 5. Frontend composition

- `main.tsx` — providers (Convex Auth, router, Toaster) + error boundaries;
  module registry mirrors `lib/nav.ts` so every sidebar route exists.
- `AppLayout` = `SidebarProvider` + `AppSidebar` + `TopBar` + content.
- Route protection via `RequireAuth` (preserves `returnTo`).
- State: Convex subscriptions only; no duplicated server state in the client.

## 6. Extension pattern (Phase 2+)

To activate a module:
1. Extend `src/convex/schema.ts` only if new fields/tables are needed.
2. Add queries/mutations in a **new domain module** (e.g. `src/convex/audit.ts`)
   using `getEffectiveRole`/`roleHasPermission` guards and `organizationId`
   scoping; log significant actions via the audit-log mutation.
3. Add the page under `src/pages/`, wire it in `main.tsx` (or reuse
   `ModulePage`), and flip the `phase2` flag in `lib/nav.ts`.
