# Cybersecurity Assurance — Phase 4A Batch 1

Status: **implemented and uncommitted for review** (2026-10-19).
Base commit: `cb015d5` — `feat(compliance): add findings and remediation workflows`.

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

Penetration-test / network / application-security / configuration-review
workflows, vulnerability scanning integrations, CVSS computation from vectors,
security scoring dashboards, and Business Continuity work.
