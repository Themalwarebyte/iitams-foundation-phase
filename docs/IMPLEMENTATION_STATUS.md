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

## Phase 4A — Cybersecurity Assurance Batch 1 *(committed `ac879fe`)*

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

Not in this batch (by design): scanner integrations, CVSS computation, security scoring, and Business Continuity work. The testing workflow is Batch 2A below.

## Phase 4A — Cybersecurity Assurance Batch 2A *(committed `4d00f22`)*

Security testing engagements and test cases, extending the same assessment
register. Full design notes in [`CYBERSECURITY_ASSURANCE.md`](CYBERSECURITY_ASSURANCE.md).

| Workstream | Status | Evidence |
| --- | --- | --- |
| Testing categories on the existing assessment model (penetration testing, network security review, web/application testing, configuration review) + optional subtype | ✅ | `CYBER_ASSESSMENT_TYPE_LABELS`, `securityAssessments.subtype` |
| Testing scope & authorization (in-scope systems, explicit exclusions, authorized window, lead tester, methodology, rules of engagement, written authorization reference, scope status) | ✅ | `authorizeTestingScope` |
| No intrusive work from a record: execution requires an `in_progress` assessment **and** an `authorized` scope; no scanners/exploit code in the app | ✅ | `mayExecuteTests`, `startTestCase` |
| Organization-scoped test cases (`CT-001…`) with objective, procedure, expected behaviour, tester, dates, evidence, linked vulnerability | ✅ | `src/convex/cyberTesting.ts`, `cyberTestCases` |
| Status ≠ outcome; completion needs outcome + observations + execution date; N/A and cancelled require a documented reason | ✅ | `completeTestCase`, `markTestCaseNotApplicable`, `cancelTestCase` |
| Completed results immutable; append-only history; one independent review that refuses the tester/executor | ✅ | `updateTestCase`, `reviewTestCase`, `vulnerabilityEvents.testCaseId` |
| A failed test never creates/verifies a vulnerability; linking is traceability only | ✅ | `completeTestCase`, `linkTestCaseVulnerability`, runtime tests |
| Assessment completion blocked while tests are planned/in progress | ✅ | `completeAssessment` + `outstandingTestsForAssessment` |
| Truthful roll-ups (planned, in progress, completed, pass, fail, inconclusive, untested, linked vulnerabilities) with no effectiveness claim | ✅ | `summarizeTestCases`, `testingSummary` |
| Frontend: scope/authorization section, test-case register, creation, execution, outcome, evidence, links, history, search/filters, read-only | ✅ | `src/components/iitams/cyber/CyberTestingPanel.tsx` |
| Execution gate: authorized scope + live testing window + in-scope, non-excluded target; shared with the UI reason text | ✅ | `testingExecutionStatus`, `startTestCase` |
| Tests (structural + runtime + cross-tenant + read-only + pagination + Chromium journey) | ✅ | `tests/cyberTesting.test.ts` (23), `tests/browser.cyber-testing.test.ts` (1) |

Not in Batch 2A (by design): automated penetration-testing/scanner integrations, exploit execution, security scoring, and Business Continuity work.

## Phase 4A — Cybersecurity Assurance Batch 2B *(committed with Batch 3)*

Security retesting, independent verification and assurance reporting on top of
Batch 2A. Full design notes in [`CYBERSECURITY_ASSURANCE.md`](CYBERSECURITY_ASSURANCE.md).

| Workstream | Status | Evidence |
| --- | --- | --- |
| Retests (`RT-001…`) against a recorded failed/inconclusive test with reason, scope, target, tester, dates, procedure, observations, evidence, reviewer and decision | ✅ | `src/convex/cyberRetesting.ts`, `cyberRetests` |
| Original result never rewritten; only fail/inconclusive is eligible; retest history is append-only (`vulnerabilityEvents.retestId`) | ✅ | `createRetest`, `getRetest` |
| Authorization-gated retest execution (scope, window, exclusions, in-scope target, cancelled assessment) | ✅ | `retestExecutionStatus`, `startRetest` |
| Independent review that refuses tester and executor; approved/rejected final; rejected requires a new retest | ✅ | `reviewRetest` |
| Remediation traceability chain with explicit “failure without vulnerability” distinction | ✅ | `testTrace` |
| Assurance reports (`STR-001…`): draft → in review → finalized → superseded, frozen snapshot, revisions as new versions | ✅ | `src/convex/cyberReports.ts`, `src/lib/cyberReport.ts` |
| Report content: counts, retests, confirmed vulnerabilities, severity distribution, outstanding remediation, verification/closure, accessible evidence, limitations | ✅ | `buildAssuranceReportContent` |
| A recorded or reviewed retest pass closes no vulnerability and changes no ICT risk score | ✅ | `completeRetest`, `reviewRetest`, runtime tests |
| Frontend: retest section in the test detail (plan, start, result, review), traceable status, assessment report section (create, submit, finalize, revise) | ✅ | `src/components/iitams/cyber/CyberRetestPanel.tsx` |
| Tests (structural + runtime + cross-tenant + read-only + foreign-tester + concurrency + snapshot immutability + Chromium journey) | ✅ | `tests/cyberRetesting.test.ts` (21), `tests/browser.cyber-retesting.test.ts` (1) |

Verified on the final state: `tsc` exit 0, `lint` exit 0 (21 pre-existing
warnings), `build` exit 0, units **403 (401 pass, 2 skip, 0 fail)**, browser
**34 (34 pass, 0 fail)**.

Not in Batch 2B (by design): scanners/offensive tooling, security scoring and
Business Continuity. Report export and the discovery hub are Batch 3.

## Phase 4A — Cybersecurity Assurance Batch 3 *(committed with Batch 2B)*

Cybersecurity reporting hub, versioned exports and security posture summaries.
Full design notes in [`CYBERSECURITY_ASSURANCE.md`](CYBERSECURITY_ASSURANCE.md).

| Workstream | Status | Evidence |
| --- | --- | --- |
| `/reports/cybersecurity` discovery hub replacing the placeholder: search, assessment/status/date filters, lifecycle counts, preparer and reviewer attribution, version/supersession links, keyset pagination | ✅ | `reportHub`, `src/components/iitams/cyber/CyberReportsPage.tsx` |
| Dedicated report detail: scope, methodology, counts, confirmed vulnerabilities, severity distribution, remediation, verification, evidence (accessible vs withheld), reviewer decision and version history | ✅ | `getReport`, `ReportDetailPanel` |
| Finalized content read from the frozen snapshot; drafts and in-review reports labelled as live/unapproved | ✅ | `getReport` snapshot branch, detail banners, runtime tests |
| PDF (print) and Word export of the authorized, redacted report; version and state in the filename; drafts carry a DRAFT banner; superseded versions remain exportable | ✅ | `src/lib/cyberReportExport.ts` |
| Organization-scoped posture summary of recorded counts only — no composite score, explicit truncation flags | ✅ | `postureSummary` |
| Separation of duties: preparer cannot review or finalize; approval fingerprint invalidates on data change; finalized snapshots immutable | ✅ | `reviewReport`, `finalizeReport`, `tests/cyberReports.test.ts` |
| Authorization `cyber.view` / `cyber.manage` + active membership, server-derived organization, cross-tenant refusal, bounded indexed reads, append-only event and audit entries | ✅ | `resolveCyberAccess`, `appendCyberEvent`, `logCyberAudit` |
| Tests (unit + cross-tenant + redaction + Chromium journey) | ✅ | `tests/cyberReports.test.ts` (13), `tests/browser.cyber-reports.test.ts` (1) |

Verified on the final state: `tsc` exit 0, `lint` exit 0 (21 pre-existing
warnings), `build` exit 0, units **418 (416 pass, 2 skip, 0 fail)**, browser
**35 (35 pass, 0 fail, 0 blocked)**. Truncated aggregations are disclosed in
the report and its exports as lower bounds, never as exact totals.

Not in Batch 3 (by design): a server-rendered PDF binary, scheduled delivery,
security scoring, scanners and Business Continuity.

## Phase 3B — Risk register pagination correction *(committed, `686880d`)*

The register previously read a fixed 500-row window, so risks created after
that point were unreachable and the KPI strip reported the window as a
total. It now traverses the unique organization/code index with a validated
keyset cursor, applies search and filters server-side while walking, discloses
when a scan did not cover the whole register, and labels the summary total as
exact or a lower bound. Full contract and evidence in
[`RISK_REGISTER.md`](RISK_REGISTER.md).

## Phase 4A — Business Continuity Batch 4.1 *(committed: `b85273f`)*

Business impact analysis and recovery objectives. Full design notes in
[`BUSINESS_CONTINUITY.md`](BUSINESS_CONTINUITY.md).

| Workstream | Status | Evidence |
| --- | --- | --- |
| Business service / process register (`BS-001…`): name, description, department, owner, operational status, criticality, ICT/key dependencies, single points of failure | ✅ | `src/convex/businessServices.ts`, `/bcm/critical-services` |
| Business impact analyses (`BIA-001…`) with explicit per-category impact judgement (operational, financial, regulatory, reputational, customer) and a rationale for every category | ✅ | `src/convex/businessImpactAnalyses.ts`, `src/lib/bcm.ts` |
| Normalized recovery objectives stored in whole minutes — RTO required, RPO/MTPD optional and validated independently; an RTO beyond the MTPD needs a documented exception | ✅ | `validateRecoveryObjectives`, `tests/bcm.test.ts` |
| BIA lifecycle draft → in review → approved, with rejection returning to draft; only drafts are editable | ✅ | `submitBia`, `reviewBia`, `canTransitionBia` |
| Independent review — the preparer can never approve their own analysis | ✅ | `reviewBia`, runtime test |
| Approved analyses are immutable; corrections are numbered revisions that supersede only on approval, and earlier versions stay readable | ✅ | `reviseBia`, `revisionOf` / `supersededByBiaId` |
| Append-only continuity history (`continuityEvents`) and per-write audit entries | ✅ | `appendBiaEvent`, `bcm.*` audit actions |
| Authorization: `bcm.view` reads, `bcm.manage` + active membership writes, server-derived organization, every id re-validated, cross-tenant refusal | ✅ | `resolveBcmAccess` |
| Truthful summaries: service/BIA counts, coverage (approved / open / missing), overdue reassessment — no readiness, maturity or resilience score | ✅ | `continuitySummary`, `recoveryObjectives` |
| Frontend: service register and detail, BIA register with impact matrix and objectives, submit/review/revision controls, recovery-objective page, read-only without `bcm.manage` | ✅ | `src/components/iitams/bcm/*` |
| Tests (structural + runtime + concurrency + cross-tenant + read-only + attribution + Chromium journey) | ✅ | `tests/bcm.test.ts` (24), `tests/browser.bcm.test.ts` (1) |

Not in Batch 4.1 (by design): continuity/DR plan authoring, runbooks,
recovery exercises, emergency communications, failover automation, continuity
report export and any resilience score. A recorded BIA is never presented as a
tested plan.

Verified on the final state: `tsc -b --noEmit` exit 0, `lint` exit 0 (21
pre-existing warnings), `tests/bcm.test.ts` 24/24 pass (including concurrent
approval and reviewer-attribution runtime cases), `phase1` 15/15 pass,
`tests/browser.bcm.test.ts` 1/1 pass (strict, real Chromium, two independent
identities).

## Phase 4A — Business Continuity Batch 4.2 *(committed with this change — `feat(bcm): add continuity plans and recovery strategies`)*

Continuity plans, recovery strategies and recovery gaps. Full design notes in
[`BUSINESS_CONTINUITY.md`](BUSINESS_CONTINUITY.md).

| Workstream | Status | Evidence |
| --- | --- | --- |
| Continuity plans (`BCP-001…`) covering one primary service plus explicit additional services, with purpose, disruption scenarios, recovery priority, scope, exclusions, assumptions and owner | ✅ | `src/convex/continuityPlans.ts`, `/bcm/plans` |
| The analysis a plan relies on is snapshotted (reference, version, status at link and at approval) so a later BIA revision cannot rewrite an approved baseline | ✅ | `biaSnapshot`, `biaStatusAtApproval` |
| "No approved baseline" is disclosed, never implied away: a missing or unapproved linked analysis is flagged in the API and the plan header | ✅ | `getPlan.baselineWarning`, browser test |
| Closed plan lifecycle draft → in review → approved/returned, with revision and terminal archive; only drafts and returned plans are editable | ✅ | `canTransitionPlan`, `submitPlan`, `reviewPlan`, `revisePlan`, `archivePlan` |
| Independent review — the preparer can never approve their own plan; concurrent approvals cannot both succeed | ✅ | `reviewPlan`, runtime tests |
| Approved versions are immutable; a revision supersedes the earlier version only on approval, and prior versions stay readable | ✅ | `revisionOf` / `supersededByPlanId`, version history |
| Recovery strategies (`BRS-001…`) with documented approach, arrangements, manual fallback, requirements, expected effort and target RTO/RPO/MTPD | ✅ | `createStrategy`, `presentStrategy` |
| Capability evidence is an estimate only — `exercise_verified` is refused until recovery exercises exist | ✅ | `bcmCapabilityEvidenceValidator`, runtime test |
| Objective-vs-estimate comparison is arithmetic (expected − objective minutes), never a compliance verdict | ✅ | `recoveryCapabilityDelta` |
| Recovery gaps (`GAP-001…`) with severity, owner, target date, mitigation and a closed status table; resolving or accepting needs a rationale; a strategy never resolves a gap | ✅ | `createGap`, `updateGapStatus`, runtime test |
| Plan register with server-side search/filters, keyset pagination, status counts and open-gap totals that disclose truncation | ✅ | `listPlans` |
| Append-only history and per-write audit entries for every plan, strategy and gap transition | ✅ | `appendContinuityEvent`, `bcm.*` audit actions |
| Frontend: plan register, create/edit form, plan detail with baseline, strategies, gaps, versions and history, submit/review/revision/archive and strategy/gap actions, read-only without `bcm.manage` | ✅ | `src/components/iitams/bcm/BcmPlansPage.tsx`, `BcmPlanForm.tsx`, `BcmPlanDetailPage.tsx` |
| Tests (structural + runtime + concurrency + cross-tenant + read-only + Chromium journey) | ✅ | `tests/bcmPlans.test.ts` (22), `tests/browser.bcm-plans.test.ts` (1) |

Not in Batch 4.2 (by design): recovery exercises and lessons learned, DR
runbooks, emergency communications, failover automation, continuity report
export and any resilience score. A plan is a documented intent; nothing in the
module presents it as a tested capability.

Verified on the final state (full regression after acceptance):
`tsc -b --noEmit` exit 0; `eslint` 0 errors (23 pre-existing warnings);
`bun run build` succeeds and emits the `BcmPlanDetailPage` chunk; the complete
unit battery passes **479 / 479** across 19 bounded chunks with **2 skipped**
(explicit skips in `tests/security.adminlifecycle.test.ts`) and **0 failed** —
`tests/bcm.test.ts` + `tests/bcmPlans.test.ts` are **46/46**, including
concurrent approval, concurrent reference allocation, cross-tenant and
read-only runtime cases. All **22 configured Chromium suites pass 37/37**,
including `tests/browser.bcm-plans.test.ts` (strict, real Chromium, two
independent identities plus a read-only viewer).

Two pre-existing regression-battery defects were corrected during acceptance
and committed separately: `tests/risk.test.ts` assumed a fresh risk appears on
the first register page, but the documented contract after `686880d` orders the
register by identifier (it now walks the cursor traversal), and the access-review
pagination walk was bounded at 40 pages of the shared demo organization's
accumulated history (it now stops once its own fixture cycles are reached).

## Phase 3 — Recommended next (not started)

1. **User provisioning UI** — admin invites, role assignment, disable
   anonymous sign-in in production deployments.
2. **Administration UIs** — organizations/MDACs, users, roles, audit-log
   viewer.
3. **Remaining module workflows** — BCM recovery exercises and lessons learned,
   DR runbooks and recovery automation (the register, BIA, recovery objectives
   and continuity plans are done); the continuity and audit report surfaces are
   still placeholders.
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
