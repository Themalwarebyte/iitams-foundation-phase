# IITAMS — Business Continuity Management

> Phase 4A — Batch 4.1: **Business Impact Analysis and Recovery Objectives**.
> Batch 4.1 is committed as `b85273f`; Batch 4.2 (**continuity plans,
> recovery strategies and recovery gaps**) is committed with this change.
> Recovery exercises, DR runbooks,
> emergency communications and recovery automation are later batches.

## Scope of these batches

Business Continuity Management (BCM) starts with what must not stop: the
organization-scoped register of business services and processes, a documented
business impact analysis (BIA) for each one, and the recovery objectives that
follow from the analysis. Batch 4.2 then documents **how** each service would
be recovered, which strategies exist, and where the documented capability falls
short of the approved objective.

Implemented:

- business service / process register (`BS-001…`);
- business impact analyses (`BIA-001…`) with explicit impact judgements per
  category;
- normalized recovery objectives — RTO, RPO, MTPD, minimum acceptable service
  level and recovery priority;
- continuity plans (`BCP-001…`) linked to a snapshot of the analysis they rely
  on, with ownership, scope, exclusions, assumptions, disruption scenarios and a
  review date;
- documented recovery strategies (`BRS-001…`) whose capability is an estimate;
- structured recovery gaps (`GAP-001…`) with owner, target date and status;
- independent review, versioned revisions and archival for plans and BIAs;
- append-only continuity history and audit trail;
- truthful coverage summaries and a recovery-objective summary.

Deliberately **not** implemented: DR runbooks, recovery exercises/simulations,
emergency communications, automated failover or restoration, and any
readiness/resilience score. A plan is a documented intent, not evidence that
recovery works.

## Authorization model

| Capability | Requirement |
| --- | --- |
| Read any continuity record | `bcm.view` |
| Register/amend a service | `bcm.manage` + active membership |
| Create/edit a draft BIA | `bcm.manage` + active membership |
| Submit a BIA for review | `bcm.manage` + active membership |
| Approve or reject a BIA | `bcm.manage` + active membership **and** a different person from the preparer |
| Open a BIA revision | `bcm.manage` + active membership |
| Create/edit a draft continuity plan | `bcm.manage` + active membership |
| Submit a plan for review | `bcm.manage` + active membership |
| Approve or return a plan | `bcm.manage` + active membership **and** a different person from the preparer |
| Open a plan revision, archive a plan | `bcm.manage` + active membership |
| Document a strategy, record or update a gap | `bcm.manage` + active membership |

The permissions live in the canonical registry (`src/convex/access.ts`). The
baseline tiers (`member`, `user`, `admin`) carry `bcm.view` through the shared
operational read set, and `bcm.manage` is granted to `admin` only. The Phase-2
audit roles (`audit_director`, `audit_manager`, `auditor`, `audit_reviewer`,
`management_user`, `executive_viewer`) have their own explicit permission lists
and were deliberately **not** widened, so they see no continuity entries. No
second role system, no client-supplied organization or role.

The organization always comes from the authenticated access context. Every
referenced id (service, BIA, plan, strategy, gap, owner) is re-validated against
that organization, so a foreign or guessed id is indistinguishable from a
missing one.

## Data model (`src/convex/schema.ts`)

| Table | Purpose |
| --- | --- |
| `businessServices` | Governed register of services/processes: reference, name, description, department, owner, operational status, criticality, descriptive ICT dependencies, key dependencies, single points of failure, timestamps |
| `businessImpactAnalyses` | One analysis of one service: reference, title, version, `revisionOf`/`supersededByBiaId`, owner, assessment/review dates, scenario, scope, impacts, dependencies, assumptions, limitations, criticality rationale, normalized objectives, lifecycle and review stamps |
| `continuityPlans` | One plan version: reference (`BCP-…`), title, purpose, primary service plus additional services, owner, the BIA snapshot it relied on (`biaId`, reference, version, status at link and at approval), disruption scenarios, recovery priority, scope, exclusions, assumptions, review date, lifecycle and review/archive stamps |
| `recoveryStrategies` | Documented recovery approach per plan: reference (`BRS-…`), objective, scenario, approach, alternative arrangements, manual fallback, people/ICT/vendor/facility requirements, minimum service level, expected recovery effort in minutes, target RTO/RPO/MTPD, `capabilityEvidence` + rationale, owner, status |
| `recoveryGaps` | Structured shortfall: reference (`GAP-…`), description, severity, owner, target resolution date, mitigation recommendation, status, optional link to a strategy |
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
`singlePointsOfFailure`, and the per-strategy requirement fields). The schema
leaves room for a future asset link without migrating existing rows.

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

## Plan content validation

- Title 3–200 characters; purpose, scope, exclusions, assumptions and
  disruption scenarios each need ≥ 20 characters, so an empty plan cannot pass
  review.
- One primary service plus at most 10 additional services; the same service can
  never be listed twice, and every service must belong to the caller's
  organization.
- A linked analysis must belong to one of the plan's own services. Its
  reference, version and status are snapshotted at write time and again at
  approval, so revising the BIA later cannot silently rewrite what the approved
  plan was reviewed against.
- The owner must be an active member of the organization.
- The review date must be in the future and no more than 1,095 days away.

## Strategies and gaps

- A strategy's `capabilityEvidence` is `estimate` in practice: the server
  refuses `exercise_verified` until recovery exercises exist, so a documented
  estimate can never render as a validated capability.
- `recoveryCapabilityDelta` (expected minus objective minutes) is exposed as
  arithmetic only. A positive delta is a fact worth recording as a gap, never a
  verdict that the objective would be missed.
- Gaps start `open` or `in_progress`; `resolved` and `accepted` are terminal.
  Transitions are a closed table; resolving or accepting a gap demands a stated
  rationale, and recording a strategy never resolves a gap.
- Strategies are frozen once the plan is approved (a change needs a revision),
  while gaps stay actionable on an approved plan — remediation continues after
  approval even though the plan text itself cannot change. Archived plans accept
  no new gaps.

## Lifecycle

```
draft ──submit──▶ in_review ──approve──▶ approved ──revise──▶ (new draft version)
  ▲                  │                        │
  └──return──────────┘                        └── when the revision is approved,
                                                  the earlier version becomes superseded
                                                                     │
                                              approved ──archive──▶ archived (terminal)
```

- Only a `draft` (or a `returned` plan) can be edited. `reviewPlan` refuses the
  preparer, so approval is always by a different active member with
  `bcm.manage`.
- Approval and rejection both write the decision, notes, reviewer and timestamp
  server-side, and append a `continuityEvents` row.
- An approved version is immutable. `revisePlan` opens the next numbered
  version (`revisionOf`); the earlier version is only marked `superseded` when
  the revision is approved, and its content and review history stay readable.
- Archiving requires a reason and is terminal; archived and superseded rows are
  history, never editable.
- Re-submission clears the previous decision stamps so a stale decision cannot
  be mistaken for a current one.

## Summaries

`continuitySummary` reports recorded counts only: services total/active/
critical/high/retired, coverage split into approved BIA / open BIA only /
missing BIA, and review counts (awaiting review, overdue reassessment,
approved total). `recoveryObjectives` lists the latest non-superseded analysis
per service with normalized durations, priority and overdue flag. `listPlans`
reports plan counts by status and the number of open gaps, with keyset
pagination over the organization/created index.

These reads are bounded (≤ 1,000 plan rows for counts, ≤ 250 for a page, ≤ 2,000
per table for the BIA summaries) and expose `truncated` flags. When truncation
occurs the UI states that counts are partial and are not exact totals. Nothing
in the module derives a readiness, maturity or resilience score, and a
completed BIA or approved plan is explicitly **not** presented as a tested
continuity capability.

## Frontend

| Route | Page |
| --- | --- |
| `/bcm/critical-services` | `BcmServicesPage` — register, search/filters, keyset pagination, create/amend, service detail with BIA versions and history; read-only without `bcm.manage` |
| `/bcm/bia` | `BcmBiaPage` — BIA register, filters, create/edit draft, impact matrix, recovery objectives, submit, independent review, revision, versions and history |
| `/bcm/rto-rpo` | `BcmRecoveryPage` — recovery objectives per service, priority, overdue reviews, truncation notice |
| `/bcm/plans` | `BcmPlansPage` — continuity plan register with status/priority filters, search by reference, title, owner or service, keyset pagination, gap counts and truncation disclosure |
| `/bcm/plans/:planId` | `BcmPlanDetailPage` — plan content, services covered, baseline warning, recovery strategies with capability comparison, recovery gaps, version history and append-only history, plus submit/review/revision/archive and strategy/gap actions |

Register and detail pages show loading, empty, error (crash boundary) and
unauthorized states. The module-wide disclaimer explains that a BIA is an
analysis and a plan is a documented intent — neither is a resilience claim.

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
- `tests/bcmPlans.test.ts` — structural checks (closed plan/strategy/gap tables,
  estimate-only capability, no resilience score, schema indexes, real routes),
  capability arithmetic, and a runtime lifecycle: draft against an approved
  baseline, server-side validation, self-approval refusal, approval and freeze,
  concurrent approvals, revision preserving the approved version, unapproved
  baseline flagged, rejection returning for revision, estimated strategies,
  a strategy never resolving a gap, read-only refusal, cross-tenant denial,
  concurrent reference allocation and register pagination.
- `tests/browser.bcm-plans.test.ts` — Chromium journey: register a service,
  create a plan without a baseline (disclosure asserted), submit, independent
  approval by a second identity, frozen version with revision offered, and a
  read-only viewer.

Run them with `bun test tests/bcm.test.ts tests/bcmPlans.test.ts` and
`bun run test:e2e:bcm` / `bun run test:e2e:bcm-plans` (strict), or
`IITAMS_E2E_STRICT=1 bun test tests/browser.bcm-plans.test.ts`.

## Known limitations

- No runbook, exercise, simulation or recovery-automation record exists yet; a
  plan never claims recovery has been tested.
- Strategy capability cannot be marked `exercise_verified` because exercises do
  not exist; everything is a documented estimate.
- No ICT asset register, so asset links are descriptive text.
- Summaries are bounded and disclose truncation instead of extrapolating.
- The export/report surface for continuity data (`/reports/bcm`) is still a
  placeholder.
- A plan records intended recovery; it does not evidence that recovery works.

## Next batch (recommended)

Business Continuity Batch 4.3 — recovery **exercises** and lessons learned:
exercise records scoped to a plan version, participants, success criteria and
outcomes, which are the only thing allowed to move a strategy from `estimate` to
`exercise_verified`. Nothing in that batch should infer resilience from the
presence of a plan or an exercise schedule.
