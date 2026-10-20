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

## Phase 3B — module workflows

| Workstream | Status | Evidence |
| --- | --- | --- |
| ICT Risk Register (list, detail, create, edit, filter, KPIs) | ✅ | `src/convex/risks.ts`, `/risk/register` |
| Canonical 5×5 inherent/residual scoring shared by server and UI | ✅ | `src/lib/risk.ts` |
| Permission + tenancy enforcement (`risk.view` / `risk.manage`, org re-check) | ✅ | `src/convex/risks.ts`, `src/convex/access.ts` |
| Immutable per-record audit trail | ✅ | `auditLogs.by_organization_entity`, `risk.created` / `risk.updated` |
| Tests (structural + runtime + two-organization isolation + Chromium journey) | ✅ | `tests/risk.test.ts`, `tests/risk.tenant.test.ts`, `tests/browser.risk-register.test.ts` |
| Risk assessments & review history (insert-only snapshots, register stays current) | ✅ | `src/convex/riskAssessments.ts`, `tests/riskAssessments.test.ts` |
| Risk treatment plans & actions (separate action records, controlled states, overdue/progress summaries; treatment never changes residual scores) | ✅ | `src/convex/riskTreatment.ts`, `src/components/iitams/risk/RiskTreatmentPlans.tsx`, `tests/riskTreatment.test.ts` |
| Risk monitoring & treatment oversight (read-only KPIs, bands, assessment trend, oversight, paginated monitored list) | ✅ | `src/convex/riskMonitoring.ts`, `/risk/monitoring`, `tests/riskMonitoring.test.ts`, `tests/browser.risk-monitoring.test.ts` |
| Access-review cycle pagination (cursor over the organization index, every historical cycle reachable) | ✅ | `src/convex/accessReview.ts`, `/admin/access-reviews`, `tests/accessReview.test.ts` |

## Phase 3C — Batch 1: compliance framework catalogue and control register *(committed — `feat(compliance): add framework and control registers`)*

| Workstream | Status | Evidence |
| --- | --- | --- |
| Adopted framework register (identifier, version, issuing authority, description, scope, effective date, lifecycle status, creation metadata) | ✅ | `src/convex/compliance.ts`, `/compliance/frameworks` |
| Control register linked to a framework (identifier, title, description, domain, objective, source reference, applicability, owner, implementation status) | ✅ | `src/convex/compliance.ts`, `/compliance/controls` |
| Shared vocabulary + identifier rules (framework/control validators, domains, statuses) | ✅ | `src/lib/compliance.ts` |
| Authorization: `compliance.view` / `compliance.manage` + active membership, organization derived server-side, cross-tenant denial | ✅ | `src/convex/compliance.ts`, `src/convex/access.ts` (existing registry) |
| Identifier uniqueness (per organization for frameworks, per framework for controls) | ✅ | `complianceFrameworks.by_organization_code`, `controls.by_organization_framework_code` |
| Append-only audit logging for every write (actor, organization, framework attribution) | ✅ | `compliance.framework_created/updated`, `compliance.control_created/updated` |
| No fabricated compliance percentage or test result (`effectiveness` stays `not_tested`) | ✅ | `src/convex/compliance.ts`, `src/convex/dashboard.ts` (null score until assessed) |
| Tests (structural + runtime + cross-tenant + audit integrity + Chromium journey) | ✅ | `tests/compliance.test.ts`, `tests/browser.compliance.test.ts` |

Not in this batch (by design): control testing, evidence mapping, compliance assessments and automated scoring.

## Phase 3C — Batch 2: control testing and evidence mapping *(committed: b2ae1db)*

| Workstream | Status | Evidence |
| --- | --- | --- |
| Control tests linked to an organization-scoped framework + control (reference, objective, procedure, tester, planned/actual dates, period, sample, status, outcome, observations, exceptions, recommendations, completion notes) | ✅ | `src/convex/complianceTesting.ts`, `src/components/iitams/compliance/ComplianceTestingPanel.tsx` |
| Explicit states (`planned` → `in_progress` → `completed`) with validated transitions; outcomes `effective` / `partially_effective` / `ineffective` / `not_tested` | ✅ | `src/lib/compliance.ts` (`canTransitionControlTest`, `isControlTestVerdict`) |
| Completion requires a verdict, adequate notes, and active evidence or a documented missing-evidence exception; non-effective outcomes need observations/exceptions | ✅ | `completeControlTest` |
| Completed tests immutable; corrections are new superseding records (`supersedesTestId`), history never rewritten | ✅ | `supersedeControlTest`, `presentTest` (derived `supersededByTestId`) |
| Compliance evidence records (own table, not the audit-engagement `evidence` model) with server-side SHA-256 hashing via a scheduled action | ✅ | `complianceEvidence`, `computeEvidenceHash`, `recordEvidenceIntegrity` |
| Evidence mappings as rows (`active`, `unlinkedAt`, `unlinkReason`); unlinking never deletes evidence, its hash or history | ✅ | `complianceEvidenceMappings`, `unlinkEvidenceMapping` |
| Authorization: `compliance.view` reads, `compliance.manage` + active membership writes, server-derived organization, every id re-validated | ✅ | `resolveAccess`, `requireManager` |
| Restricted evidence is not downloadable by read-only roles; every download and integrity check is audited | ✅ | `evidenceDownloadUrl`, `verifyEvidenceIntegrity` |
| Reporting: real counts of planned/in-progress/completed tests, outcomes by latest completed test per control, evidence gaps — no compliance percentage | ✅ | `testingSummary`, `ComplianceTestingSummary` |
| Tests (structural + runtime + cross-tenant + integrity + Chromium journey) | ✅ | `tests/complianceTesting.test.ts`, `tests/browser.compliance-testing.test.ts` |

Not in this batch (by design): compliance scoring/percentages, control assessments against a maturity model, and automated effectiveness derivation.

## Phase 3C — Batch 3: compliance assessments and assessment history *(committed: 397cb02)*

| Workstream | Status | Evidence |
| --- | --- | --- |
| Assessment cycles scoped to one adopted framework (reference, scope, period, start/due dates, assessor, status, creation/completion/review metadata) | ✅ | `src/convex/complianceAssessments.ts`, `/compliance/assessments` |
| Control-level records with a SNAPSHOT of the control (code, title, domain, implementation, effectiveness, owner, framework) | ✅ | `complianceAssessmentItems.controlSnapshot` |
| Outcomes: compliant, partially compliant, non-compliant, not assessed, not applicable; rationale required for every conclusion | ✅ | `assessControl`, `src/lib/compliance.ts` |
| Control-test references and evidence links inform the conclusion; testing never sets the assessment outcome | ✅ | `controlTestIds`, `complianceAssessmentEvidence` |
| Draft → in progress → completed → reviewed with server-side transition checks; completion blocked while any control is not assessed | ✅ | `startAssessment`, `completeAssessment`, `canTransitionAssessment` |
| Finalised cycles immutable; corrections are superseding cycles; earlier results stay readable | ✅ | `supersedeAssessment`, `presentAssessment` |
| Independent review (separation of duties): reviewer ≠ assessor and ≠ completer | ✅ | `reviewAssessment`, `canReview` |
| Evidence links are rows: unlinking is audited and retains the evidence record and its hash | ✅ | `unlinkAssessmentEvidence`, `compliance.assessment_evidence_unlinked` |
| Authorization: `compliance.view` reads, `compliance.manage` + active membership writes, server-derived organization, every id re-validated | ✅ | `resolveAccess`, `requireManager` |
| Reporting: counts of cycles and outcomes, evidence gaps, outstanding remediation — no compliance percentage | ✅ | `assessmentSummary`, `ComplianceAssessmentsPage` |
| Tests (structural + runtime + cross-tenant + review + immutability + Chromium journey) | ✅ | `tests/complianceAssessments.test.ts`, `tests/browser.compliance-assessments.test.ts` |

Not in this batch (by design): weighted compliance percentages, maturity scoring, automated assessment of untested controls, and assessment-to-audit-engagement linkage.

## Phase 3C — Batch 4: compliance findings, gaps and remediation *(committed with this change — `feat(compliance): add findings and remediation workflows`)*

| Workstream | Status | Evidence |
| --- | --- | --- |
| Organization-scoped findings linked to framework, control, assessment cycle/item, control tests and evidence (own tables — the Phase-2 audit findings stay engagement-specific) | ✅ | `src/convex/complianceFindings.ts`, `/compliance/findings` |
| Reference, title, description, gap, requirement, root cause, recommendation, severity, owner, identified/target dates, lifecycle status, recorder | ✅ | `complianceFindings`, `createFinding` |
| No finding is created by an assessment outcome; a partially compliant control creates nothing automatically | ✅ | `tests/complianceFindings.test.ts` («no finding is fabricated…») |
| Remediation actions with owner, due date, status, completion notes, evidence refs, completion and verification timestamps | ✅ | `complianceRemediationActions`, `assignRemediationAction`, `completeRemediationAction` |
| Distinct states: recommendation → assigned action → implementation complete → independently verified → finding closed | ✅ | `canTransitionRemediation`, `isRemediationComplete`, `isRemediationResolved` |
| Closure gates: no unresolved mandatory action; a verified closure needs independent verification or a documented exception | ✅ | `closeFinding`, `gates` on `getFinding` |
| Separation of duties: owner/implementer can never verify their own remediation or close their own work | ✅ | `verifyRemediationAction`, `tests/complianceFindings.test.ts` |
| Reopening and failed verification preserve the full event history (append-only `complianceFindingEvents`) | ✅ | `reopenFinding`, `failRemediationVerification` |
| Authorization: canonical `compliance.view`/`compliance.manage`, active membership, server-derived organization, every id re-validated, audit entry per write | ✅ | `resolveAccess`, `requireManager`, `recordEvent` |
| Frontend: register with severity/status/overdue filters, detail, action assignment, overdue indicators, verification and closure controls, read-only for non-managers | ✅ | `ComplianceFindingsPage.tsx` |
| Reporting: counts of open/awaiting/closed findings, overdue actions and actions outstanding — no remediation or compliance percentage | ✅ | `findingsSummary` |
| Tests (structural + runtime + tenant isolation + independent verification + exception path + reopen + evidence + Chromium journey) | ✅ | `tests/complianceFindings.test.ts` (15), `tests/browser.compliance-findings.test.ts` |

Not in this batch (by design): remediation scoring/percentages, automatic finding creation from control tests, and linkage to audit engagements (the audit findings model is engagement-specific and was deliberately not reused as a table).

**Verification (2026-10-19, 1-vCPU / 2 GB sandbox with a swap file added — see
[`DEVELOPMENT_ENVIRONMENT_NOTES.md`](DEVELOPMENT_ENVIRONMENT_NOTES.md) §5):**

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | ✅ exit 0 (24 s) |
| `bun run lint` | ✅ exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run test:unit` (23 files, chunked) | ✅ 23/23 files exit 0 — **333 pass, 0 fail, 2 skip** |
| `bun run test:e2e:compliance-findings` | ✅ 1/1 pass |
| `bun run build` (`tsc -b && vite build`) | ✅ exit 0 — 70 asset files, Compliance pages present |
| Bundle scan (`dist/`) | ✅ no tester token, no `RESEND` key/provider credential, no dev-auth helper, no Vial/`@vly-ai` code, no review ZIP |

The two `compliance.test.ts`/`phase1.test.ts` expectations that had gone stale
with this batch (the fixture-cleanup table set and the navigation totals, now 52
entries) were corrected, and the appendix formatting of `devTenantFixtures.ts`
was tidied. The 2 skips are the pre-existing conditional
*bootstrap-fixture-not-fresh* cases in `security.adminlifecycle.test.ts`, which
skip themselves when the shared dev deployment already holds that fixture —
they are reported as skipped, not as passing.

## Phase 4A — Cybersecurity Assurance Batch 1 *(implemented, uncommitted for review)*

See [`CYBERSECURITY_ASSURANCE.md`](CYBERSECURITY_ASSURANCE.md) for the full design notes.

| Workstream | Status | Evidence |
| --- | --- | --- |
| Cybersecurity assessment register (reference, title, type, scope, asset/service, owner, planned/actual dates, status, objectives, outcome) | ✅ | `src/convex/cyberAssessments.ts`, `/cyber/assessments` |
| Explicit assessment lifecycle (planned → in progress → completed · cancelled); completion requires an outcome summary and is never inferred from findings | ✅ | `canTransitionAssessment`, `completeAssessment` |
| Vulnerability register extending the Phase-1 table (reference, description, asset, discovery method, severity, CVSS, dates, owner, lifecycle, assessment link, evidence, remediation notes) | ✅ | `src/convex/cyberVulnerabilities.ts`, `/cyber/vulnerabilities` |
| Severity and CVSS validated independently; no invented scores, no severity→score inference; vector shape validated | ✅ | `src/lib/cyber.ts` (`validateCvssScore`, `validateCvssVector`) |
| Explicit remediation actions; completion is a claim and independent verification is required | ✅ | `src/convex/cyberActions.ts` |
| Separation of duties: the implementer can never verify their own vulnerability or action | ✅ | `verifyVulnerability`, `verifyRemediationAction` |
| Closure gates: verified / risk-accepted / false-positive record with no unresolved actions | ✅ | `closeVulnerability` |
| Append-only history; reopening clears stale stamps while history stays readable | ✅ | `vulnerabilityEvents`, `reopenVulnerability` |
| ICT risk linkage is traceability only — no second risk model, no risk row patched | ✅ | `linkVulnerabilityRisk`, `tests/cyberAssurance.test.ts` |
| Cybersecurity evidence with server-side SHA-256, classification gate and audited downloads | ✅ | `src/convex/cyberEvidence.ts` |
| Authorization: `cyber.view` / `cyber.manage` + active membership, server-derived organization, cross-tenant denial, per-write audit entries | ✅ | `src/convex/cyberCore.ts` |
| Frontend: registers with search/filters, detail, lifecycle controls, action tracking, evidence upload, history, loading/empty/unauthorized states | ✅ | `src/components/iitams/cyber/*` |
| Tests (structural + runtime + cross-tenant + read-only role + Chromium journey) | ✅ | `tests/cyber.security.test.ts` (18), `tests/cyberAssurance.test.ts` (5), `tests/browser.cyber-assurance.test.ts` (1) |

Not in this batch (by design): penetration-test / network / application-security / configuration-review workflows, scanner integrations, CVSS computation, security scoring, and Business Continuity work.

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
