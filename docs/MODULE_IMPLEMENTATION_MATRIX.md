# IITAMS — Module Implementation Matrix

> Statuses verified against source code and the deployed Convex schema.
> Closure verification: September 2026. Legend: ✅ Implemented · 🟡 Partial ·
> 🟠 Placeholder · ❌ Missing

## 1. Exact schema inventory (verified programmatically)

**Total tables: 24** — 7 platform + 17 domain.

### Platform / global (7) — provided by Convex Auth

| Table | Purpose | Indexes |
| --- | --- | --- |
| `authAccounts` | One account per auth provider per user; provider secrets | `userIdAndProvider`, `providerAndAccountId` |
| `authRateLimits` | Auth rate-limit buckets (convex-auth internal) | `identifier` |
| `authRefreshTokens` | Refresh-token rotation chain per session | `sessionId`, `sessionIdAndParentRefreshTokenId` |
| `authSessions` | Active sessions (userId + expiry) | `userId` |
| `authVerificationCodes` | OTP/verification codes per account | `accountId`, `code` |
| `authVerifiers` | Verifier challenge records (convex-auth internal) | `signature` |
| `users` | Identity records (name, email, isAnonymous, role) | `email` |

### Domain (17) — tenant-scoped by `organizationId` unless noted

| Table | Purpose | Indexes |
| --- | --- | --- |
| `organizations` | **Global** tenancy root / MDAC registry (no `organizationId` of its own) | `code` |
| `userProfiles` | Per-user extension (active org, job title, permissions) — **user-scoped** | `userId` |
| `auditUniverseItems` | Audit universe entries (domain, inherent risk, cadence) | `by_organization` |
| `auditPlans` | Risk-based audit plans (fiscal year, status, counters) | `by_organization` |
| `auditEngagements` | Engagements with lifecycle status, lead auditor, progress | `by_organization`, `by_status` |
| `findings` | Audit findings with severity/status/due dates | `by_organization`, `by_status`, `by_severity` |
| `correctiveActions` | Remediation tracking per finding (owner, due, status) | `by_organization`, `by_status` |
| `risks` | ICT risk register: 5×5 inherent/residual likelihood × impact | `by_organization`, `by_status` |
| `riskTrendSnapshots` | Quarterly pre-aggregated risk trend series | `by_organization` |
| `complianceFrameworks` | Frameworks with implemented/total controls and scores | `by_organization` |
| `controls` | Control library with effectiveness states | `by_organization`, `by_effectiveness` |
| `vulnerabilities` | CVE/CVSS records with severity, status, ageing input | `by_organization`, `by_severity`, `by_status` |
| `securityAssessments` | Pentest/network/appsec/config reviews with finding counts | `by_organization`, `by_type` |
| `criticalServices` | BCM services with RTO/RPO target vs current, readiness | `by_organization` |
| `drTests` | DR tests/exercises with status and lessons field | `by_organization`, `by_status` |
| `notifications` | **Mixed scope:** user-scoped or org-wide | `by_user`, `by_organization` |
| `auditLogs` | Append-only activity/audit trail — **mixed scope** | `by_organization` |

**Tenant-scoped:** 13 tables (those with a `by_organization` index).
**User-scoped:** `userProfiles`; the user-facing slice of `notifications`.
**Platform/global:** the 7 platform tables, plus `organizations` (tenancy
root) and the org-wide slice of `notifications`/`auditLogs`.

## 2. Navigation reconciliation — 48/48 (verified programmatically)

Programmatic count over `src/lib/nav.ts`: Overview 3 · Audit Management 10 ·
ICT Risk 5 · Compliance 6 · Cybersecurity Assurance 6 · Business Continuity 6 ·
Reports & Analytics 6 · Administration 6 = **48 unique paths**, each with a
protected route in `src/main.tsx`. **Nothing merged, nothing omitted.** The
Phase-1 report's "46" was a report error (not a code defect); corrected here
and in `docs/PHASE_1_BASELINE.md`.

## 3. Module statuses

| Module / capability | Backend | Frontend | Evidence & notes |
| --- | --- | --- | --- |
| **Authentication** | ✅ | ✅ | Convex Auth email-OTP (+ anonymous, gated — see §4); `/auth`; `RequireAuth`; JWT sessions |
| **Guest-mode control** | ✅ | ✅ | Server-side `guestAuthEnabled()` gate; production refuses anonymous; guest button renders only when deployment enables it |
| **Users** | 🟡 | 🟡 | `users` + `userProfiles` exist; management UI Phase 2 |
| **Roles / RBAC** | ✅ | ✅ | `access.ts` role→permission map; session query; permission-filtered sidebar; enforced server-side |
| **Organizations (MDACs)** | 🟡 | 🟠 | `organizations` table; session exposes active org; admin UI Phase 2 |
| **Audit universe** | 🟡 | 🟠 | Table + demo seed; CRUD UI Phase 2 |
| **Audit plans** | 🟡 | 🟠 | Table (fiscal year, status, counters) |
| **Audit engagements** | 🟡 | ✅ (view) | Table + dashboard KPIs; workspace Phase 2 |
| **Audit programs** | ❌ | 🟠 | Route + nav only |
| **Working papers** | ❌ | 🟠 | Route + nav only |
| **Evidence** | ❌ | 🟠 | Route + nav only; storage abstraction Phase 2 |
| **Findings** | 🟡 (read) | ✅ (view) | Table; open/critical counts + severity distribution server-side; writes Phase 2 |
| **Management responses** | ❌ | 🟠 | Route + nav only |
| **Corrective actions** | 🟡 (read) | ✅ (view) | Table; overdue computation; workflow UI Phase 2 |
| **Follow-up audits** | ❌ | 🟠 | Route + nav only |
| **Risk register** | 🟡 (read) | ✅ (view) | Table with 5×5 inherent/residual scores |
| **Risk assessments** | ❌ | 🟠 | Route + nav only |
| **Risk treatments** | ❌ | 🟠 | Route + nav only |
| **Risk heat map** | ✅ | ✅ | 5×5 residual cells computed server-side; rendered chart |
| **Risk trends** | ✅ | ✅ | `riskTrendSnapshots` + trend chart |
| **Compliance frameworks** | 🟡 (read) | ✅ (view) | Table with scores; framework bar chart |
| **Control library** | 🟡 (read) | ✅ (view) | Table with effectiveness; effectiveness gauge |
| **Compliance assessments** | ❌ | 🟠 | Route + nav only |
| **Control testing** | ❌ | 🟠 | Route + nav only |
| **Evidence mapping** | ❌ | 🟠 | Route + nav only |
| **Compliance dashboard** | ✅ | ✅ | Score % + per-framework breakdown |
| **Security assessments** | 🟡 (read) | ✅ (view) | Table with finding counts by severity |
| **Vulnerabilities** | 🟡 (read) | ✅ (view) | Table (CVE, CVSS, ageing); KPI + distributions |
| **Penetration tests** | 🟡 (read) | 🟠 | Modelled as `securityAssessments.type="penetration_test"`; workflow Phase 2 |
| **Network assessments** | 🟡 (read) | 🟠 | `type="network_assessment"`; dedicated UI Phase 2 |
| **Application security** | 🟡 (read) | 🟠 | `type="application_security"`; dedicated UI Phase 2 |
| **Configuration reviews** | 🟡 (read) | 🟠 | `type="configuration_review"`; dedicated UI Phase 2 |
| **Critical services (BCM)** | 🟡 (read) | ✅ (view) | Table with RTO/RPO target vs current; readiness KPI |
| **Business impact analysis** | ❌ | 🟠 | Route + nav only |
| **RTO / RPO** | 🟡 (read) | 🟠 | Fields on critical services; dedicated view Phase 2 |
| **DR plans** | ❌ | 🟠 | Route + nav only |
| **DR tests & exercises** | 🟡 (read) | ✅ (view) | Table with status; pass-rate KPI + upcoming count |
| **Lessons learned** | 🟡 | 🟠 | `lessonsLearned` field exists on `drTests`; module Phase 2 |
| **Executive dashboard** | ✅ | ✅ | 12 KPIs, 5 charts, deadlines, activity feed — server-computed |
| **Executive reports** | ❌ | 🟠 | Route + nav only |
| **Audit/Risk/Compliance/Cyber/BCM reports** | ❌ | 🟠 | Routes + nav only |
| **Activity / audit logging** | ✅ | ✅ | Append-only `auditLogs`, `logAction`, activity feed; log-viewer UI Phase 2 |
| **Notifications** | ✅ | ✅ | Table + list/mark-read mutations; top-bar popover |
| **Integrations** | ❌ | 🟠 | Route + nav only |
| **API endpoints (REST)** | 🟡 | — | Convex HTTP router with auth routes; public REST surface Phase 2 |

## 4. Summary counts

| Status | Count |
| --- | --- |
| ✅ Implemented | 13 |
| 🟡 Partial | 16 |
| 🟠 Placeholder | 19 |
