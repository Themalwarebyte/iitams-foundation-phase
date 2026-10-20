# Cybersecurity Assurance — Phase 4A

| Batch | Status | Checkpoint |
| --- | --- | --- |
| Batch 1 — assessments, vulnerabilities, remediation, evidence | **committed** (2026-10-20) | `ac879fe` — `feat(cyber): implement cybersecurity assessments and vulnerability management` |
| Batch 2A — security testing engagements and test cases | **implemented, uncommitted for review** | base `ac879fe` |

Batch 1 built the registers. Batch 2A adds authorized security testing work
on top of the SAME assessment register (see “Batch 2A” below).

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

Status: **implemented, uncommitted for review** (2026-10-20).

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

## Verification (Batch 2A) — final

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings |
| `bun run build` | exit 0 |
| `tests/cyberTesting.test.ts` | 21 pass (12 structural/vocabulary, 9 runtime) |

The full configured unit set was run in documented chunks on the 1 vCPU / 2 GB
host (`bun run test:unit` exceeds the 180 s command ceiling, so the same
file-sets were run per group): **380 tests — 378 pass, 2 skip, 0 fail.** The 2
skips are the pre-existing conditional bootstrap-prerequisite tests in
`tests/security.adminlifecycle.test.ts`; they are reported as skipped, never as
passing. Adding the 21 new `cyberTesting` tests to the previously confirmed 357
accounts for the difference.

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
