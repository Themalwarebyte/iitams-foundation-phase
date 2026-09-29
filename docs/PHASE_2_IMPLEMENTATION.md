# IITAMS — Phase 2 Implementation Overview

> Core IT Audit Management Engine · Built on the accepted Phase 1 foundation ·
> September 2026

Phase 2 transforms IITAMS from a governance foundation into a functioning IT
audit lifecycle platform. It deliberately **extends** the Phase 1 architecture
(React/Vite frontend, Convex backend, existing auth, RBAC, tenancy, design
system, dashboard framework, audit-log and notification frameworks) rather
than replacing any of it.

## What was built, per module

| # | Module | Delivery |
|---|---|---|
| 1 | **Audit Universe Management** | Full CRUD repository (`auditUniverseItems` extended to the spec attribute set) with categories, owner/business unit, criticality, data classification, regulatory importance, security exposure; archive/restore lifecycle; search, filters, sorting; per-item audit history from the immutable log. UI: `/audit/universe`. |
| 2 | **Risk-Based Audit Planning** | `auditPlans` + new `auditPlanItems`; configurable weighted scoring engine (`src/lib/auditScoring.ts`) computing a 0–100 audit priority score from six inputs (criticality, data sensitivity, regulatory impact, security exposure, previous findings, change frequency); Low/Medium/High/Critical bands; **scores are computed server-side at scheduling time**; plan approval workflow; coverage objective. UI: `/audit/plans`. |
| 3 | **Audit Engagement Management** | Formal seven-stage lifecycle `draft → planning → approved → fieldwork → review → report_issued → closed` (+ cancellation) guarded by a server-side state machine **and** per-transition role matrix; engagement numbers `ENG-YYYY-NNN`; objective/scope/criteria; auto-derived stage progress. UI: `/audit/engagements`. |
| 4 | **Audit Team Management** | `auditAssignments` with the five team roles (Audit Director/Manager/Lead Auditor/Auditor/Reviewer). **Only assigned users can perform engagement activities** — enforced by `requireEngagementAccess` on every engagement-scoped read/write; assignment requires a same-organization user; assignment changes notify and are audited. |
| 5 | **Audit Programs & Procedures** | `auditPrograms` + `auditProcedures` with control objective, expected evidence and Pass / Fail / Exception results; failing procedures notify managers. UI: `/audit/programs`. |
| 6 | **Working Papers** | `workingPapers` + `workingPaperComments`; Draft → Submitted → Reviewed/Returned → Approved workflow with preparer/reviewer role separation (preparers cannot review their own work); reviewer comments and approval history; approved papers immutable. UI: `/audit/workpapers`. |
| 7 | **Evidence Management** | `evidence` + Convex file storage; browser-direct upload through a one-time URL; **server-side SHA-256** (scheduled internal action — Convex mutations cannot read blob bytes); four-tier classification with restricted downloads gated to audit-management roles; every download writes an access entry to the immutable log; integrity re-verification on demand. UI: `/audit/evidence`. |
| 8 | **Findings Management** | Six-stage lifecycle `identified → draft → reviewed → management_response → corrective_action → closed`; full attribute set (condition, criteria, root cause, impact, recommendation, risk rating); role-guarded transitions; management-response recording; critical/high findings raise notifications. UI: `/audit/findings`. |
| 9 | **Corrective Action Management** | Extended `correctiveActions` (responsible person, completion evidence, verification, reminders); Open → In Progress → Completed → Verified → Closed (+ computed overdue); overdue reminder pass with 7-day rate limiting; verification by audit-management roles. UI: `/audit/actions`. |
| 10 | **Reporting Foundation** | Server-assembled engagement report, findings report and executive audit summary (coverage, key risks, critical findings, outstanding actions, opinion heuristic); PDF via print pipeline and Word (.doc) export from the rendered document — **no external services**, self-hostable. UI: `/audit/reports`. |
| 11 | **Dashboard Expansion** | New `auditDashboard.overview` reactive query + audit programme strip on the executive dashboard: universe size/coverage %, high-risk unaudited, planned/active/completed/delayed audits, backlog, ageing findings, overdue actions, action completion rate. |
| 12 | **Notifications** | Built on the existing framework: engagement assignment, review required, finding identified (critical/high), management response, corrective action assigned/overdue, plan approval, evidence integrity verdicts. |

## Roles (RBAC extension)

Six audit-workflow roles were added to the Phase 1 registry (platform
admin/user/member unchanged):

| Role | Grants |
|---|---|
| `audit_director` | Full audit oversight: audit.view + audit.manage + reports |
| `audit_manager` | Manage engagements, teams, programmes: audit.view + audit.manage + reports |
| `auditor` | Perform assigned work: audit.view (assignment-gated actions) |
| `audit_reviewer` | Review/approve workpapers & findings: audit.view |
| `management_user` | View audits, respond to findings: audit.view + reports |
| `executive_viewer` | Dashboards & reports only |

Two layers of authorization apply everywhere: the module-level RBAC above
**and** engagement-level team assignment (Module 4). Platform admins remain
tenant-scoped superusers. Everything fails closed.

## Security model (maintained & extended)

- `resolveAccess()` remains the single identity/tenancy resolution point; no
  first-org fallback was reintroduced.
- Every audit mutation obtains authority via `requirePermission` /
  `requireEngagementAccess` (module RBAC + tenant match + team assignment).
- All new tables carry `organizationId` and org-scoped indexes; cross-tenant
  ids read as absent.
- Every mutation writes to the **append-only** `auditLogs` (insert-only
  invariant re-verified by unit tests).
- All inputs validated by Convex validators; `schemaValidation: true`.
- Evidence integrity: server-computed SHA-256, classification-gated access,
  access logging.
- Guest policy unchanged (demo-org only, read-only `member` tier, plus a
  **demo-gated** `requestDemoRoleUpgrade` for development testing that
  refuses every non-guest/non-demo caller).

## Self-hosting posture

No new external services or vendor dependencies were introduced. Evidence
storage uses Convex file storage (part of the self-hostable stack); report
export is client-side (print-to-PDF + Word HTML). The `IITAMS_EMAIL_PROVIDER`
abstraction and Freebuff/Vly dev-tooling isolation from Phase 1 are preserved
untouched.
