# IITAMS — Business Continuity Management

> Phase 4A — Batch 4.1: **Business Impact Analysis and Recovery Objectives**
> (uncommitted at the time of writing). Full-continuity planning, DR runbooks,
> exercises and recovery automation are later batches.

## Scope of this batch

Business Continuity Management (BCM) starts with what must not stop: the
organization-scoped register of business services and processes, a documented
business impact analysis (BIA) for each one, and the recovery objectives that
follow from the analysis.

Implemented:

- business service / process register (`BS-001…`);
- business impact analyses (`BIA-001…`) with explicit impact judgements per
  category;
- normalized recovery objectives — RTO, RPO, MTPD, minimum acceptable service
  level and recovery priority;
- BIA lifecycle with independent review and versioned revisions;
- append-only continuity history and audit trail;
- truthful coverage summaries and a recovery-objective summary.

Deliberately **not** implemented in this batch: continuity plan authoring, DR
runbooks, recovery exercises/simulations, emergency communications, automated
failover or restoration, and any readiness/resilience score.

## Authorization model

| Capability | Requirement |
| --- | --- |
| Read any continuity record | `bcm.view` |
| Register/amend a service | `bcm.manage` + active membership |
| Create/edit a draft BIA | `bcm.manage` + active membership |
| Submit a BIA for review | `bcm.manage` + active membership |
| Approve or reject a BIA | `bcm.manage` + active membership **and** a different person from the preparer |
| Open a revision | `bcm.manage` + active membership |

The permissions live in the canonical registry (`src/convex/access.ts`). The
baseline tiers (`member`, `user`, `admin`) carry `bcm.view` through the shared
operational read set, and `bcm.manage` is granted to `admin` only. The Phase-2
audit roles (`audit_director`, `audit_manager`, `auditor`, `audit_reviewer`,
`management_user`, `executive_viewer`) have their own explicit permission lists
and were deliberately **not** widened for this batch, so they see no continuity
entries. No second role system, no client-supplied organization or role.

The organization always comes from the authenticated access context. Every
referenced id (service, BIA, owner) is re-validated against that organization,
so a foreign or guessed id is indistinguishable from a missing one.

## Data model (`src/convex/schema.ts`)

| Table | Purpose |
| --- | --- |
| `businessServices` | Governed register of services/processes: reference, name, description, department, owner, operational status, criticality, descriptive ICT dependencies, key dependencies, single points of failure, timestamps |
| `businessImpactAnalyses` | One analysis of one service: reference, title, version, `revisionOf`/`supersededByBiaId`, owner, assessment/review dates, scenario, scope, impacts, dependencies, assumptions, limitations, criticality rationale, normalized objectives, lifecycle and review stamps |
| `bcmReferenceCounters` | Per-organization, per-prefix reference counter, patched inside the creating mutation so concurrent registrations cannot collide |
| `continuityEvents` | Append-only history. Every transition keeps actor, timestamp, summary and (where relevant) the review reason |

The pre-existing `criticalServices` table is a **seeded demo fixture** carrying
a pre-computed readiness percentage for the executive dashboard. It is not a
governance record and is not written to by this module; no score is copied out
of it.

### ICT dependencies

There is no canonical ICT asset register yet. Rather than invent foreign keys to
records that do not exist, related systems and dependencies are stored as
clearly labelled descriptive text (`ictDependencies`, `keyDependencies`,
`singlePointsOfFailure`). The schema leaves room for a future asset link without
migrating existing rows.

## Impact and recovery-objective validation

- All five impact categories (operational, financial, regulatory/legal,
  reputational, customer/service delivery) need an explicit severity
  (`none`, `low`, `moderate`, `high`, `severe`) **and** a rationale of at least
  10 characters. The system stores the recorded judgement; it never estimates
  monetary loss or downtime.
- Recovery objectives are stored as whole **minutes** (maximum one year) so
  units never drift; the UI collects hours and converts once.
- An RTO is required. RPO and MTPD are optional, but if recorded they are
  validated independently: **no ordering between RTO and RPO is assumed**.
- An RTO greater than the MTPD is refused unless a documented exception
  justification (≥ 20 characters) is recorded, and that exception is preserved
  on the record and shown in the detail view.
- The assessment date cannot be in the future and the review interval must be
  between 1 and 1,095 days.

## Lifecycle

```
draft ──submit──▶ in_review ──approve──▶ approved ──revise──▶ (new draft version)
  ▲                  │                        │
  └──return──────────┘                        └── when the revision is approved,
                                                  the earlier version becomes superseded
```

- Only a `draft` can be edited. `reviewBia` refuses the preparer, so approval is
  always by a different active member with `bcm.manage`.
- Approval and rejection both write the decision, notes, reviewer and timestamp
  server-side, and append a `continuityEvents` row.
- An approved BIA is immutable. `reviseBia` opens the next numbered version
  (`revisionOf`); the earlier version is only marked `superseded` when the
  revision is approved, and its content and review history stay readable.
- A rejected BIA returns to `draft` with the decision recorded — it is never
  approved and cannot be described as reviewed.
- Re-submission clears the previous decision stamps so a stale decision cannot
  be mistaken for a current one.

## Summaries

`continuitySummary` reports recorded counts only: services total/active/
critical/high/retired, coverage split into approved BIA / open BIA only /
missing BIA, and review counts (awaiting review, overdue reassessment,
approved total). `recoveryObjectives` lists the latest non-superseded analysis
per service with normalized durations, priority and overdue flag.

Both read at most 2,000 rows per table and expose `truncated` flags. When
truncation occurs the UI states that counts are partial and are not exact
totals. Nothing in the module derives a readiness, maturity or resilience score,
and a completed BIA is explicitly **not** presented as a tested continuity plan.

## Frontend

| Route | Page |
| --- | --- |
| `/bcm/critical-services` | `BcmServicesPage` — register, search/filters, keyset pagination, create/amend, service detail with BIA versions and history; read-only without `bcm.manage` |
| `/bcm/bia` | `BcmBiaPage` — BIA register, filters, create/edit draft, impact matrix, recovery objectives, submit, independent review, revision, versions and history |
| `/bcm/rto-rpo` | `BcmRecoveryPage` — recovery objectives per service, priority, overdue reviews, truncation notice |

Both register pages show loading, empty, error (crash boundary) and
unauthorized states. The module-wide disclaimer explains that a BIA is an
analysis, not a plan or a resilience claim.

## Tests

- `tests/bcm.test.ts` — structural checks (closed transition table, no scoring,
  canonical permissions, real routes), pure objective validation, and a runtime
  lifecycle: service registration, concurrent reference uniqueness, read-only
  refusal, cross-tenant denial, impact/objective validation, self-approval
  refusal, immutable approval, revision/supersession, rejection, summaries,
  pagination and foreign-id refusal.
- `tests/browser.bcm.test.ts` — Chromium journey: register a service, record a
  BIA, submit, independent approval by a second identity, frozen approval with
  revision offered, recovery-objective summary, and read-only viewer state.

Run them with `bun test tests/bcm.test.ts` and `bun run test:e2e:bcm`
(strict) or `IITAMS_E2E_STRICT=1 bun test tests/browser.bcm.test.ts`.

## Known limitations

- No continuity plan, runbook, exercise or recovery-automation record exists
  yet; a BIA never claims otherwise.
- No ICT asset register, so asset links are descriptive text.
- Summaries scan at most 2,000 records per table and disclose truncation.
- The export/report surface for continuity data (`/reports/bcm`) is still a
  placeholder.
- A BIA records objectives; it does not evidence that recovery has been tested.

## Next batch (recommended)

Business Continuity Batch 2 — continuity and disaster-recovery **plan**
authoring linked to approved BIAs, with plan ownership, versioning, review
dates and explicit "untested" status, followed by recovery exercises and
lessons learned. Nothing in Batch 2 should infer resilience from the presence
of a plan.
