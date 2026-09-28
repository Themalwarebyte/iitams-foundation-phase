# IITAMS — Integrated Information Technology Audit Management System

> A unified ICT governance and assurance platform for risk-based IT auditing,
> cybersecurity assurance, ICT risk management, compliance monitoring,
> vulnerability management and business continuity oversight across
> ministries, departments, agencies and counties (MDACs).

[![Typecheck](https://img.shields.io/badge/typecheck-passing-brightgreen)](#development)
[![Build](https://img.shields.io/badge/build-passing-brightgreen)](#development)
[![Tests](https://img.shields.io/badge/tests-25%20passing-brightgreen)](#development)

## Overview

IITAMS consolidates eight assurance domains behind one permission-aware,
government-grade interface:

- **Audit Management** — universe, plans, engagements, programs, working
  papers, evidence, findings, management responses, corrective actions,
  follow-ups
- **ICT Risk** — register, assessments, treatments, 5×5 heat map, trends
- **Compliance** — frameworks (ISO 27001, NIST CSF, DPA 2019, …), control
  library, testing, evidence mapping
- **Cybersecurity Assurance** — assessments, vulnerabilities, penetration
  tests, network/application/configuration reviews
- **Business Continuity** — critical services, BIA, RTO/RPO, DR plans, tests,
  lessons learned
- **Reports & Analytics** — executive through domain-specific reporting
- **Administration** — organizations/MDACs, users, roles, integrations,
  configuration, audit logs

Phase 1 establishes the foundation: design system, application shell, RBAC,
domain schema, executive dashboard and self-hosting assets. See
[`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) for exactly
what is live vs scaffolded, and
[`docs/MODULE_IMPLEMENTATION_MATRIX.md`](docs/MODULE_IMPLEMENTATION_MATRIX.md)
for the verified per-module matrix.

## Tech stack

| Layer | Technology |
| --- | --- |
| Web | Vite 7 · React 19 · TypeScript 5.9 |
| Styling | Tailwind CSS v4 · shadcn/ui · lucide-react |
| Animation | Framer Motion (reduced-motion aware) |
| Charts | Recharts (via shadcn chart) |
| Backend | Convex (typed functions + document store, modular monolith) |
| Auth | Convex Auth (email OTP; anonymous for demos) |
| Tests | Bun test |

## Quick start

```bash
# 1. Install
bun install

# 2. Backend (dev deployment + codegen)
bun convex dev --once

# 3. Frontend
bun run dev            # http://localhost:5173
```

Sign in via **email OTP** (codes appear in the Convex dashboard during
development) or **Continue as Guest**. The demo organization with clearly
flagged sample data is seeded on first use so the dashboard is meaningful
immediately.

### Environment variables

Copy [`docs/ENVIRONMENT_VARIABLES.md`](docs/ENVIRONMENT_VARIABLES.md) into a
local `.env` (never committed). Key variable: `VITE_CONVEX_URL`.

## Development

```bash
bun run dev            # Vite dev server
bun run build          # typecheck + production build
bun run lint           # ESLint
bun run format         # Prettier
bun test               # unit tests + browser smoke suite
bun tsc -b --noEmit    # typecheck only
```

### Browser smoke tests

`tests/browser.smoke.test.ts` runs real Chromium (playwright-core) against the
dev server and covers: landing, auth screen, sign-in, protected-route
enforcement, dashboard, sidebar navigation, global search, notifications,
logout and reduced-motion fallback. Configuration:

```bash
IITAMS_E2E_BASE_URL=http://localhost:5173   # target app (default)
IITAMS_E2E_CHROME_PATH=/path/to/chrome      # browser binary
```

## Self-hosting

IITAMS is engineered to run on standard infrastructure with **no runtime
dependency on any development platform**:

```bash
export VITE_CONVEX_URL=https://<your-deployment>.convex.cloud
docker compose up -d --build      # web tier only, on :8080
```

Details — topology (including the optional `reporting` PostgreSQL mirror,
which is **not** started by default), backups, export/import, and the standard
alternatives for every development convenience — in
[`docs/SELF_HOSTING_ARCHITECTURE.md`](docs/SELF_HOSTING_ARCHITECTURE.md).
Web tier assets: [`Dockerfile`](Dockerfile), [`docker-compose.yml`](docker-compose.yml),
[`deploy/nginx.conf`](deploy/nginx.conf).

## Documentation

| Document | Purpose |
| --- | --- |
| [`docs/PHASE_1_BASELINE.md`](docs/PHASE_1_BASELINE.md) | repository baseline & Phase-1 changes |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | topology, domains, data flow |
| [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) | Ministry-sourced design tokens & components |
| [`docs/MODULE_IMPLEMENTATION_MATRIX.md`](docs/MODULE_IMPLEMENTATION_MATRIX.md) | verified module statuses |
| [`docs/SELF_HOSTING_ARCHITECTURE.md`](docs/SELF_HOSTING_ARCHITECTURE.md) | portability & deployment |
| [`docs/SECURITY_HARDENING_BACKLOG.md`](docs/SECURITY_HARDENING_BACKLOG.md) | baseline + open hardening items |
| [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) | phase status & roadmap |
| [`docs/ENVIRONMENT_VARIABLES.md`](docs/ENVIRONMENT_VARIABLES.md) | configuration reference |

## Licence / attribution

Design language inspired by the Ministry of Information, Communications &
the Digital Economy (Kenya) public web identity; IITAMS remains a distinct
application. Product name: **IITAMS**.
