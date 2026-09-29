# IITAMS Audit Module Architecture (Phase 2)

> How the Core IT Audit Management Engine is structured — data, domain logic,
> authorization and UI — extending the Phase 1 architecture without replacing
> any of it.

## 1. Layered architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ UI layer — src/components/iitams/audit/*.tsx                    │
│   UniversePage · PlansPage · EngagementsPage · ProgramsPage     │
│   WorkpapersPage · EvidencePage · FindingsPage · ActionsPage    │
│   ReportsPage   (+ shared ListPageShell)                        │
│   Mirrors state machines from src/lib/auditWorkflow.ts for UX;  │
│   never trusted for authorization.                              │
├─────────────────────────────────────────────────────────────────┤
│ Route layer — src/main.tsx                                      │
│   /audit/{universe,plans,engagements,programs,workpapers,       │
│           evidence,findings,actions,reports}                    │
│   RequireAuth wrapper; legacy Phase-1 paths redirect.           │
├─────────────────────────────────────────────────────────────────┤
│ Domain logic — src/lib/auditScoring.ts, auditWorkflow.ts        │
│   Pure, dependency-free, shared by Convex functions and React.  │
├─────────────────────────────────────────────────────────────────┤
│ Backend — src/convex/                                           │
│   auditAccess.ts  ← authorization core (single choke point)     │
│   auditUniverse.ts · auditPlans.ts · auditEngagements.ts        │
│   auditWorkpapers.ts · auditEvidence.ts · auditFindings.ts      │
│   auditReports.ts · auditDashboard.ts                           │
│   session.ts (guest provisioning + demo-gated QA escalation)    │
├─────────────────────────────────────────────────────────────────┤
│ Data — src/convex/schema.ts (schemaValidation: true)            │
│   organizationId on every tenant table + org-scoped indexes     │
└─────────────────────────────────────────────────────────────────┘
```

## 2. Authorization core (`src/convex/auditAccess.ts`)

Every audit mutation resolves authority through one of:

- `requirePermission(ctx, permission)` — module RBAC via `resolveAccess`
  (fail-closed role registry from Phase 1, now with the six audit roles).
- `requireEngagementAccess(ctx, engagementId, permission)` — module RBAC +
  **tenant match** (cross-org engagement ids read as "not found") + **team
  assignment**. Produces an `EngagementAccess` view:
  - `canWork` — any assignment (or platform admin)
  - `isManagerLike` — audit_manager / audit_director / admin
  - `canManageStructure` — manager-like authority (team, programs, findings)

`requireTeamRole(ea, roles, action)` gates fine-grained edges (review/
approve) on the caller's `auditAssignments.teamRole`.

**Two-layer rule (Module 4):** platform RBAC grants module capability;
engagement assignment grants the right to touch a specific engagement. An
`auditor` with no assignment can open the module but sees no engagement
artefacts.

## 3. State machines (`src/lib/auditWorkflow.ts`)

Four lifecycles with explicit transition tables and role matrices:

| Artefact | States | Authority highlights |
|---|---|---|
| Engagement | draft → planning → approved → fieldwork → review → report_issued → closed (+ cancelled) | lead_auditor may start planning; approval/closure manager+; cancellation: director-only at fieldwork |
| Working paper | draft → submitted → reviewed → approved (+ returned loop) | preparer submits; reviewer-tier dispositions; approved immutable |
| Finding | identified → draft → reviewed → management_response → corrective_action → closed | auditors draft; lead/manager review; manager+ advance; management records response |
| Corrective action | open → in_progress → completed → verified → closed (+ overdue) | responsible updates; verification manager+ |

The UI renders only transitions the caller's role permits; the server
rejects everything else (UI is never authoritative).

## 4. Evidence integrity pipeline (Module 7)

```
Browser file picker
  → validate type/size client-side (10 MB, MIME allow-list)
  → mutation generateUploadUrl      (audit.manage required)
  → PUT bytes to one-time Convex storage URL
  → mutation confirmUpload          (validates MIME + size + same-org parents)
      insert evidence row (sha256 = "", storageId)
      schedule internal action
  → internal action computeEvidenceHash
      fetch blob via storage URL → SHA-256 (WebCrypto)
      → internal mutation stampEvidenceHash (sha256)
Downloads:
  → mutation getDownloadUrl         (audit.view + tenant check +
                                     classification gate + ACCESS LOGGED)
Verification:
  → mutation verifyIntegrity        (schedules recompute; verdict → audit log)
```

Why an action: Convex mutation contexts expose `StorageWriter` (write-only)
— blob bytes are readable only in action/query contexts, so hashing runs in
a scheduled internal action and stamps the record. Client-claimed hashes are
never trusted (`sha256: ""` placeholder; internal stamp is the sole writer).

## 5. Risk-based planning (Module 2)

`computePriorityScore(inputs, weights)` maps six 0–5 inputs through
configurable weights (default: criticality .25, data sensitivity .20,
regulatory impact .20, security exposure .15, previous findings .10, change
frequency .10) to a 0–100 score, banded Low < 40 ≤ Medium < 60 ≤ High < 80 ≤
Critical. `auditPlans.addPlanItem` recomputes the score **server-side** from
the universe item's attributes (client hints only for previous findings /
change frequency) — the stored `priorityScore`/`priorityBand` can never be
dictated by the client.

## 6. Multi-tenancy

- Every new table carries `organizationId` and org-scoped indexes.
- All list queries filter by `resolveAccess().organizationId`; engagement-
  scoped modules resolve the parent engagement's tenancy first.
- Assignment of team members verifies the target user's profile belongs to
  the same organization.
- Guest sessions remain demo-org-only (Phase 1 policy); the dev-QA role
  escalation mutation refuses every non-anonymous or non-demo caller.

## 7. Observability

- Every mutation writes `auditLogs` (append-only) — create/update/transition/
  assign/verify/upload/download/reminder/integrity events.
- Notifications (Module 12) reuse the existing framework: assignment,
  review-required, finding identified, action assigned/overdue, plan
  approved, integrity verdicts.
- `auditDashboard.overview` aggregates the audit programme reactively for
  the executive dashboard strip.

## 8. Testability

Pure domain logic (scoring, state machines) is unit-tested directly
(`tests/phase2.test.ts`); server-side invariants (tenant scoping, insert-only
logging, server-side hashing, role-matrix guarding) are enforced by
source-guard tests that fail if the structure is removed; the browser
lifecycle suite (`tests/browser.audit-lifecycle.test.ts`) drives the real UI
through the create→plan→engage→report journey.
