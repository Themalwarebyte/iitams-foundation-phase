# Cybersecurity Assurance — Phase 4A

| Batch | Status | Checkpoint |
| --- | --- | --- |
| Batch 1 — assessments, vulnerabilities, remediation, evidence | **committed** (2026-10-20) | `ac879fe` — `feat(cyber): implement cybersecurity assessments and vulnerability management` |
| Batch 2A — security testing engagements and test cases | **committed** (2026-10-20) | `4d00f22` — `feat(cyber): add authorized security testing engagements and test cases` |
| Batch 2B — retesting, independent verification and assurance reporting | **implemented, uncommitted for review** | base `4d00f22` |

Batch 1 built the registers. Batch 2A adds authorized security testing work on
top of the SAME assessment register, and Batch 2B adds retesting, independent
verification and assurance reporting on top of Batch 2A (see below).

## What this batch delivers

| Capability | Where |
| --- | --- |
| Cybersecurity assessment register (reference, title, type, scope, asset/service, owner, planned/actual dates, status, objectives, outcome) | `src/convex/cyberAssessments.ts`, `/cyber/assessments` |
| Vulnerability register (reference, title, description, affected asset, discovery method, severity, CVSS, discovery/target dates, owner, lifecycle, linked assessment, evidence, remediation notes) | `src/convex/cyberVulnerabilities.ts`, `/cyber/vulnerabilities` |
| Explicit remediation actions (owner, due date, mandatory flag, progress/completion/verification notes, evidence refs) | `src/convex/cyberActions.ts` |
| Append-only history (`vulnerabilityEvents`) for assessments, vulnerabilities and actions | `src/convex/schema.ts` |
| Cybersecurity evidence with server-side SHA-256 integrity, classification gate and audited downloads | `src/convex/cyberEvidence.ts` |
| Shared vocabulary, transitions, CVSS validation, limits | `src/lib/cyber.ts` |
| UI primitives (pills, metrics, boundary/unauthorized state) | `src/components/iitams/cyber/CyberPrimitives.tsx` |

## Design decisions

1. **The Phase-1 tables were extended, not duplicated.** `vulnerabilities` and
   `securityAssessments` already existed (seeded demo rows feed the executive
   dashboard). Batch 1 adds the real fields, indexes and statuses in place.
   The Phase-1 severity counters on assessments are now **optional and never
   written**: the UI derives every count from linked vulnerability rows, so an
   assessment can never display a fabricated total.

2. **No second risk model.** Severity and CVSS are independent inputs. CVSS is
   optional, validated as a real base score (0–10, at most one decimal) and as a
   v3.0/v3.1 vector shape; it is never derived from severity and no score is
   invented. Linking an ICT risk row (`riskId`) is traceability only — the risk
   row is never patched, and residual risk stays with the Risk Assessment
   workflow.

3. **Lifecycles are explicit.**
   - Assessment: planned (`scheduled`) → in progress → completed · cancelled.
     Completing requires an outcome summary and never happens because
     vulnerabilities exist.
   - Vulnerability: open → confirmed → in remediation → remediated → verified →
     closed, with risk-accepted and false-positive branches and explicit
     reopening.
   - Action: open → in progress → completed → verified → closed (or cancelled).

4. **Completion is not verification.** `remediated` / `completed` are claims.
   `verifyVulnerability` and `verifyRemediationAction` refuse the person who
   recorded the work, with no override. Closing requires a verified (or
   risk-accepted / false-positive) record and **no unresolved actions**.

5. **Reopening preserves history.** Reopening clears the stale remediation and
   verification stamps so the new cycle starts honestly, while the append-only
   event history keeps the earlier claim, rejection and verification.

6. **Findings were not reused, deliberately.** The Phase-2 audit findings are
   engagement-scoped (`audit.manage`) and compliance findings are
   framework/control-scoped; wrapping a vulnerability inside either would
   corrupt those semantics (an engagement finding must stay tied to an
   engagement). Vulnerabilities therefore keep their own remediation-action and
   event tables, following the same patterns rather than the same rows.

7. **Evidence is cybersecurity-scoped.** The audit evidence table is
   engagement-shaped (`audit.manage`) and the compliance evidence table is
   control-shaped (`compliance.manage`); reusing either would leak documents
   into another module. `cyberEvidence` reuses the same storage/hash pattern
   (server-side SHA-256 in a scheduled action) and the same classification gate.

8. **Authorization.** Reads require `cyber.view`; writes require `cyber.manage`
   **and** an active membership. The organization always comes from the access
   context — no function accepts an organization, role or permission argument —
   and every referenced id (assessment, vulnerability, action, evidence, risk,
   owner) is re-validated against it. Audit entries name the actor and the
   affected entity separately.

## Routes

`/cyber/assessments` and `/cyber/vulnerabilities` are now dedicated,
`RequireAuth`-protected pages; the ModulePage placeholders no longer claim them.
Penetration-test, network, application-security and configuration-review pages
remain placeholders for a later batch.

## Verification (1 vCPU / 2 GB host)

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run build` (`tsc -b && vite build`) | exit 0 — Cyber pages present in `dist/assets` |
| `tests/cyber.security.test.ts` | 18 pass |
| `tests/cyberAssurance.test.ts` (runtime, tenant M) | 6 pass |
| `tests/browser.cyber-assurance.test.ts` | 1 pass (Chromium journey) |
| Full unit set (chunked) | 357 pass, 0 fail, 2 pre-existing skips |

## Deliberately not in Batch 1

Vulnerability scanning integrations, CVSS computation from vectors, security
scoring dashboards, and Business Continuity work. (The testing *workflow* that
was deferred here is Batch 2A below.)

# Batch 2A — security testing engagements and test cases

Status: **committed** in `4d00f22` (2026-10-20).

## What this batch adds

| Capability | Where |
| --- | --- |
| Testing scope & written authorization on the existing `securityAssessments` row (subtype, in-scope systems, explicit exclusions, authorized window, lead tester, methodology, rules of engagement, authorization reference, scope status + authorizer) | `src/convex/cyberTesting.ts` (`authorizeTestingScope`), `src/convex/schema.ts` |
| Organization-scoped test cases (`cyberTestCases`, `CT-001…`) linked to an existing assessment | `src/convex/cyberTesting.ts` |
| Execution workflow: start → observations → evidence → outcome → complete, plus not-applicable / cancelled with a mandatory reason and independent review | `cyberTesting.ts`, `/cyber/assessments` detail |
| Truthful roll-ups (planned / in progress / completed / pass / fail / inconclusive / untested / linked vulnerabilities) | `listTestCases`, `testingSummary`, `getAssessment` |
| Test-case register, creation form, execution form, evidence and vulnerability links, history, search/filters, read-only presentation | `src/components/iitams/cyber/CyberTestingPanel.tsx` |
| Shared vocabulary (categories, statuses, outcomes, transitions, scope rules) | `src/lib/cyber.ts` |

## Design rules

1. **No second assessment table.** A security testing engagement *is* a
   `securityAssessments` row of type `penetration_test`,
   `network_assessment`, `application_security` or `configuration_review`, with
   an optional free-text subtype so organizations are not forced into a fixed
   taxonomy. Existing assessments that are not testing engagements are
   untouched (scope status defaults to `draft`).

2. **Recording is not authorization.** A newly recorded engagement is a
   `draft` scope. `authorizeTestingScope` refuses until in-scope systems,
   explicit exclusions, a valid window, a lead tester (an active member),
   methodology, rules of engagement and a written authorization reference are
   all present, and it can run only once per engagement. Starting a test case
   requires the assessment to be `in_progress`, the scope to be `authorized`,
   the current time to fall **inside** the recorded authorization window, and
   the test's target to be declared in the in-scope systems — planning work
   never permits testing. A target named in the explicit exclusions is always
   refused, even when it also appears in the in-scope list. The same gate is
   used to present the refusal reason, so no screen implies a test may run.
   Written authorization is recorded evidence, never proof of external
   approval: the UI states that distinction and the record keeps the
   authorizer, timestamp and reference.

3. **No scanner, no exploitation.** The application records authorized human
   testing. It never runs scanners, exploit code or penetration-test tools, and
   it contains no network calls to targets.

4. **Status ≠ outcome.** A test is `planned | in_progress | completed |
   not_applicable | cancelled`; its outcome is `not_tested | pass | fail |
   inconclusive`. Completion requires a recorded outcome, actual observations
   and an execution date. `not_applicable` and `cancelled` require a documented
   reason and record `not_tested` — they are decisions, not results.

5. **A failure is not a vulnerability.** A failed test creates, changes and
   verifies nothing. Linking an existing vulnerability is traceability only;
   confirmed vulnerabilities stay confirmed only through the Batch-1 lifecycle,
   and the ICT risk score is never touched.

6. **Completed results are immutable.** Completed test cases cannot be edited,
   re-observed, cancelled or given new evidence. Corrections are new test
   cases; the append-only `vulnerabilityEvents` history (now carrying
   `testCaseId`) keeps every action with actor attribution. Independent review
   of a completed result is recorded once and refuses the tester/executor.

7. **Assessment completion respects test work.** `completeAssessment` refuses
   while any test case of the assessment is `planned` or `in_progress`. The UI
   disables the Complete action and states why.

8. **Authorization & tenancy.** Reads use `cyber.view`, writes use
   `cyber.manage` + active membership. The organization is always the access
   context's; every assessment, tester, evidence and vulnerability id is
   re-validated against it. Listing is bounded and index-backed: each request
   scans at most **250** rows (`PAGE_SCAN_LIMIT`), returns at most **100**
   (`limit` clamped to `PAGE_LIMIT_MAX = 100`, default 50) and pages with a
   `createdAt` keyset cursor; roll-ups read at most **2 000** rows
   (`SUMMARY_SCAN_LIMIT`). The effective page size is therefore the smaller
   limit, never the 250-row scan window.

## Reporting honesty

The register reports recorded counts only. A penetration-test pass rate is
never presented as a measure of organizational security effectiveness or
compliance; the UI states this in the panel and the assessment header.

## Verification (Batch 2A) — at its checkpoint

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run build` | exit 0 |
| `tests/cyberTesting.test.ts` | 23 pass (13 structural/vocabulary, 10 runtime) |

The full configured unit set was run in documented chunks on the 1 vCPU / 2 GB
host (`bun run test:unit` exceeds the 180 s command ceiling, so the same
file-sets were run per group). At the Batch 2A checkpoint that was **380 tests —
378 pass, 2 skip, 0 fail**; the current combined figure for Batch 2A + 2B is in
the Batch 2B section below. The 2 skips are the pre-existing conditional
bootstrap-prerequisite tests in `tests/security.adminlifecycle.test.ts`; they are
reported as skipped, never as passing.

Browser suites were then run sequentially, all against the live preview: **33
tests — 33 pass, 0 fail, 0 blocked**

| Suite(s) | Pass |
| --- | --- |
| smoke + audit lifecycle | 11 |
| administration + membership | 5 |
| effective membership | 1 |
| administrator lifecycle | 1 |
| provisioning + demo role | 3 |
| invitations | 1 |
| access reviews | 2 |
| ICT risk register + risk monitoring | 3 |
| compliance frameworks/controls + control testing | 2 |
| compliance assessments + findings | 2 |
| cybersecurity assessments + vulnerabilities (Batch 1) | 1 |
| **security testing (Batch 2A)** | 1 |

No assertion was weakened and no suite was skipped.

## Deliberately not in Batch 2A

Automated penetration-testing or scanner integrations, exploit execution,
security scoring, Business Continuity work, and any change to the Vulnerability
Register, Risk Register or Compliance pages.

# Batch 2B — retesting, independent verification and assurance reporting

Status: **implemented and committed together with Batch 3** (2026-10-20), base
`4d00f22`; the combined checkpoint uses
`feat(cyber): complete retesting and security assurance reporting`.

## What this batch adds

| Capability | Where |
| --- | --- |
| Security retests (`cyberRetests`, `RT-001…`) against a previously recorded **failed or inconclusive** test, with reason, scope, target, tester, planned/actual dates, procedure, observations, evidence, reviewer and review outcome | `src/convex/cyberRetesting.ts`, `src/convex/schema.ts` |
| Authorization-gated execution: authorized scope + live window + non-excluded, in-scope target; cancelled assessment refused | `retestExecutionStatus` (`src/lib/cyber.ts`), `startRetest` |
| Independent review that refuses the tester **and** the executor; approved / rejected is final and a rejected retest requires a new one | `reviewRetest` |
| Remediation traceability: original test → recorded failure → linked vulnerability → remediation actions → retests → verification → closure, with explicit “no vulnerability” / “no test origin” distinctions | `testTrace` |
| Security assurance reports (`cyberTestReports`, `STR-001…`) with draft → in review → finalized → superseded versions and a **frozen snapshot** | `src/convex/cyberReports.ts`, `src/lib/cyberReport.ts` |
| Honest report content: counts, retests, confirmed linked vulnerabilities, severity distribution, outstanding remediation, verification/closure, accessible evidence, limitations and untested scope | `buildAssuranceReportContent` (pure, unit-tested) |
| UI: retest section inside a test case (plan → start → result → review), traceable status, and the assessment-level report section (create, submit, finalize, revise) | `src/components/iitams/cyber/CyberRetestPanel.tsx`, `CyberTestingPanel.tsx`, `CyberAssessmentsPage.tsx` |

## Design rules

1. **A retest is a new record, never a rewrite.** The original test keeps its
   `completed` status and its historical outcome; the retest carries its own
   evidence, observations, reviewer and append-only history
   (`vulnerabilityEvents.retestId`). Only a `fail`/`inconclusive` result is
   eligible, and a planned or passing test cannot be retested.

2. **Execution still needs the written authorization.** A retest may run after
   the assessment completed (remediation happens later), but not outside the
   authorized scope, window or target, not against an excluded host, and not on
   a cancelled assessment. The refusal reason shown in the UI is the exact text
   the server raises.

3. **A pass is a claim until reviewed.** Completion records the tester's
   outcome and requires observations and an actual date. Independent review is a
   separate transition, refuses the tester and the executor, and cannot be
   repeated. A rejected retest is terminal — remediation needs a new retest.

4. **Five different states, never conflated.** A tester's recorded retest
   outcome, an independently reviewed retest, a vulnerability the owner marked
   remediated, a vulnerability independently verified, and a vulnerability
   formally closed are separate records and separate transitions. A passing or
   even reviewed retest patches **no** vulnerability row: closure stays with the
   Batch-1 verification workflow, and the ICT risk register is never touched.

5. **Not every failure is a vulnerability, and not every vulnerability came
   from a test.** The trace reports those absences explicitly instead of
   implying a link.

6. **A finalized report is frozen.** Finalization recomputes the content from
   the records once and stores it as `snapshot`; a later test, retest or
   remediation changes the live preview, never the approved report. A revision
   is a new versioned row (`revisionOf`) and supersedes the earlier report only
   when it is itself finalized — the earlier snapshot stays readable.

7. **No scoring, no second reporting engine.** Reports aggregate recorded rows
   and state that a test-pass count is not a measure of security effectiveness.
   Export reuses the existing Audit Reports infrastructure only if it can be
   adapted without crossing domain boundaries; structured on-screen reporting is
   delivered here and richer export remains a separately scoped follow-up.

8. **Authorization, tenancy and bounds.** Reads use `cyber.view`, writes use
   `cyber.manage` + active membership, the organization always comes from the
   access context, and every referenced id (test, retest, assessment,
   vulnerability, evidence, reviewer) is re-validated against it. Listings scan
   at most 250 rows, return at most 100 with a keyset cursor, and aggregation
   reads at most 2 000 rows per table.

## Verification (Batch 2A + 2B) — final

Run against the final source state on the 1 vCPU / 2 GB host:

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run build` (`tsc -b && vite build`) | exit 0 |
| Full unit set (documented chunks) | **403 tests — 401 pass, 2 skip, 0 fail** |
| Browser suites (sequential, live preview) | **34 tests — 34 pass, 0 fail, 0 blocked** |

`bun run test:unit` still exceeds the 180 s command ceiling on this host, so the
same file list was run in bounded chunks; every configured file was covered. The
2 skips are the pre-existing conditional bootstrap-prerequisite tests in
`tests/security.adminlifecycle.test.ts` — reported as skipped, never as passing.

| Suite(s) | Pass |
| --- | --- |
| smoke | 10 |
| audit lifecycle + administration | 4 |
| membership | 2 |
| effective membership | 1 |
| administrator lifecycle | 1 |
| provisioning + demo role | 3 |
| invitations | 1 |
| access reviews | 2 |
| ICT risk register + risk monitoring | 3 |
| compliance frameworks/controls | 1 |
| control testing + compliance assessments | 2 |
| compliance findings | 1 |
| cybersecurity assessments + vulnerabilities (Batch 1) | 1 |
| security testing (Batch 2A) | 1 |
| **retesting + assurance reporting (Batch 2B)** | 1 |

No assertion was weakened and no suite was skipped.

## Deliberately not in Batch 2B

Automated scanners or offensive tooling, a security-score dashboard, and
Business Continuity. Report export moved to Batch 3 (below), which reuses the
Audit Reports print/Word mechanism rather than adding a second engine.

# Batch 3 — reporting hub, versioned exports and posture summaries

Status: **implemented and committed with Batch 2B** (2026-10-20), base
`4d00f22`.

## What this batch adds

| Capability | Where |
| --- | --- |
| `/reports/cybersecurity` report-discovery hub: organization-scoped list, search over reference/title/people/assessment, filters by assessment, status and creation date, keyset pagination, lifecycle counts, preparer/reviewer attribution, version and supersession links | `reportHub` (`src/convex/cyberReports.ts`), `src/components/iitams/cyber/CyberReportsPage.tsx` |
| Report detail: assessment and scope, testing period and methodology, in-scope systems and exclusions, recorded test counts and outcomes, confirmed linked vulnerabilities, severity distribution, outstanding remediation, retest/verification status, evidence and withheld evidence, limitations, untested scope, preparer, reviewer, review decision and append-only history | `getReport`, `ReportDetailPanel` |
| PDF (print) and Word (`.doc` HTML) export of the report as the requesting viewer may see it, named `STR-nnn-vN-finalized|draft-slug.ext` | `src/lib/cyberReportExport.ts`, `reportExportFilename` |
| Organization-scoped posture summary from recorded rows only (tests completed/outstanding/passed/failed/inconclusive, confirmed vulnerabilities by severity, outstanding remediation, retests awaiting review, vulnerabilities awaiting verification/closure, finalized/superseded reports) | `postureSummary`, hub summary cards |
| Management actions surfaced only to `cyber.manage`; read-only viewers see the same report without controls | `canManage` in every response, `Read-only` badge |
| Separation of duties enforced server-side: preparer cannot review or finalize, approval stores the approved content fingerprint, finalization refuses when records changed after approval | `reviewReport`, `finalizeReport` |
| Tests: structural, runtime, cross-tenant and Chromium journey | `tests/cyberReports.test.ts` (13), `tests/browser.cyber-reports.test.ts` (1) |

## Design rules

1. **One reporting engine.** Reports are still `cyberTestReports` rows produced
   by `buildAssuranceReportContent`; the hub is a discovery layer over them.
   Export renders the same frozen content through the existing self-hosted
   print-to-PDF / Word-HTML mechanism used by Audit Reports — no PDF library and
   no external service.

2. **Frozen means frozen.** The detail view and both exports read
   `snapshot`/`reviewedSnapshot` for a finalized or superseded report. Live data
   is only computed for drafts and in-review reports, and those views say so.
   Superseded versions stay readable and exportable as their original content.

3. **Evidence follows the current viewer.** `getReport` re-applies
   `redactReportContentForViewer` to the stored snapshot, so a restricted
   evidence reference is withheld from a viewer who lacks the clearance even
   though the snapshot captured it. Withheld counts are reported, never dropped
   silently.

4. **Export is a rendering of authorized reads.** The export input is the
   already-redacted `getReport` payload; it contains no tester tokens, auth
   secrets or internal credentials. Draft exports carry a “DRAFT / NOT
   FINALIZED” banner and a `draft` filename so they cannot be mistaken for an
   approved report.

5. **No score.** The posture summary reports recorded counts and states that a
   pass rate of recorded tests is not organizational security effectiveness. It
   invents no composite score and exposes `truncated` flags when a 2 000-row cap
   is reached instead of presenting a partial scan as complete.

6. **Tenancy and bounds.** Every hub, detail, export and summary read starts
   from `resolveCyberAccess` (`cyber.view`, active membership, server-derived
   organization); a referenced report or assessment from another organization
   is refused. Hub scans are capped at 250 rows per page request with a
   `createdAt` keyset cursor and at most 100 rows returned; history reads are
   capped at 200 and evidence at 100.

## Verification (Batch 2A + 2B + 3) — final

Run against the final source state on the 1 vCPU / 2 GB host:

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run build` (`tsc -b && vite build`) | exit 0 |
| Full unit set (documented chunks) | **418 tests — 416 pass, 2 skip, 0 fail** |
| Browser suites (sequential, live preview) | **35 tests — 35 pass, 0 fail, 0 blocked** |

`bun run test:unit` still exceeds the 180 s command ceiling on this host, so the
same configured file list was run in bounded chunks; every file was covered. The
2 skips are the pre-existing conditional bootstrap-prerequisite tests in
`tests/security.adminlifecycle.test.ts` — reported as skipped, never as passing.

| Chunk | Result |
| --- | --- |
| phase1, access, phase2, phase3a, phase3ab2, phase3ab3 | 123 pass |
| security.devotp, demoescalation, rolemanagement, previewOwner, authOtp | 46 pass |
| security.adminlifecycle | 21 pass, 2 skip |
| security.invitations | 23 pass |
| accessReview | 13 pass |
| risk, risk.tenant, riskAssessments, riskTreatment, riskMonitoring | 45 pass |
| compliance, complianceTesting, complianceAssessments, complianceFindings | 62 pass |
| cyber.security, cyberAssurance, cyberTesting, cyberRetesting, cyberReports | 83 pass |

Browser suites were run sequentially against the live preview: smoke + audit
lifecycle 11, administration + membership 5, effective membership 1,
administrator lifecycle 1, provisioning + demo role 3, invitations 1, access
reviews 2, risk register + monitoring 3, compliance 2, compliance assessments +
findings 2, cyber testing + retesting 2, cyber assurance + **reporting hub 2**.
No assertion was weakened and no suite was skipped.

## Deliberately not in Batch 3

Native PDF/DOCX generation. The delivered export is **browser print-to-PDF**
(an HTML document with a print trigger) and **Word-compatible HTML `.doc`** —
not a server-rendered PDF binary and not a native Office Open XML `.docx`.
The self-hosted path is the supported format; native document generation is a
separately scoped follow-up. Also not in this batch: scheduled report delivery,
a composite security score, offensive scanners, Business Continuity and
Cybersecurity Batch 4.

## Reporting completeness and export safety

- `AssuranceReportContent.limitations.truncatedDatasets` records every dataset
  whose aggregation scan reached its 2 000-row cap. Report detail and both
  exports state that those counts are **lower bounds**, that the report does not
  claim comprehensive coverage, and name the affected datasets. The list is part
  of the frozen snapshot, so a finalized report keeps the limitation it was
  approved with.
- Export HTML escapes every user-supplied field (title, narrative text, actor
  labels, evidence filenames/classifications, retest references). A test feeds
  `</td><script>…</script>`, `<img onerror=…>` and a script-bearing name and
  asserts no raw markup survives; the only live script is the print trigger the
  module adds itself. Evidence storage URLs and references are never rendered.
- Re-finalizing a finalized report is refused (tested), and Convex's
  serializable mutations make a concurrent double-finalize or review/finalize
  race resolve to one committed transition with the other re-evaluated against
  the moved state.
