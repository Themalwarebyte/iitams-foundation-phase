# IITAMS — Business Continuity Management

> Phase 4A — Batch 4.1: **Business Impact Analysis and Recovery Objectives**.
> Batch 4.1 is committed as `b85273f`; Batch 4.2 (**continuity plans,
> recovery strategies and recovery gaps**) is committed as `9b1bfb6`.
> Batch 4.3 (**recovery exercises, testing and validation**) is implemented
> and awaits review. DR runbooks, emergency communications and recovery
> automation are later batches.

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

Batch 4.3 adds the exercise register: recorded tabletop exercises,
walkthroughs, communications exercises, recovery-procedure simulations and
controlled technical recovery tests, with activities, independent verification,
measured recovery performance, per-strategy coverage, findings and review.

Deliberately **not** implemented: DR runbooks, emergency communications,
automated failover or restoration, automated backup restoration, external
scanning and any readiness/resilience score. A plan is a documented intent and
an exercise record is evidence about one tested version — neither is presented
as organizational resilience.

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

## Recovery exercises (Batch 4.3)

An exercise is a **record**, never an operation. Creating, scheduling, starting,
completing or reviewing one changes only the register: nothing shuts down a
system, triggers failover, restores a backup, runs a recovery command or sends
an emergency notification. Controlled technical recovery tests are performed by
responsible personnel under separate authorization and documented here.

### Eligibility and snapshots

- Only an **approved** continuity plan version can be tested. Draft, in-review,
  returned, superseded and archived plans are refused.
- The plan reference, version and status, plus the linked analysis reference,
  version, status and RTO/RPO/MTPD, are snapshotted on the exercise. Objectives
  are only carried across when the analysis was approved; a draft's numbers are
  never used as an approved objective.
- Every participant, owner, facilitator, strategy and linked gap must belong to
  the caller's organization and (for strategies/gaps) the tested plan version.

### Lifecycle

```
planned ──schedule──▶ scheduled ──start──▶ in_progress ──complete──▶ completed
   │                     │                     │                        │
   └──────cancel─────────┴──────cancel─────────┘                        └──submit──▶ in_review
                                                                                      │
                                                                      reviewed ◀──accept─┤
                                                                      returned ◀──return─┘
```

- Planning detail (title, objectives, type, scope, exclusions, scenario, owner,
  facilitator, participants, dates, methodology, resources, constraints,
  evidence references) is editable only while `planned` or `scheduled`.
- Observations, measurements, strategy coverage and new findings are only
  recorded while `in_progress`. Completion requires a stated outcome and at
  least one activity **reported as performed**; the completed record is frozen.
- `reviewed`, `returned` and `cancelled` are terminal. A material correction to
  a completed or reviewed record opens a new numbered version
  (`supersedeExercise`), and the earlier record keeps its results, review and
  history.
- Independent review: the reviewer cannot be the exercise owner, facilitator,
  preparer or the person who completed it. This is enforced server-side and the
  UI explains why the action is unavailable.

### Reported versus verified

Each activity tracks `performed` (what the team reported doing) separately from
`verified` (an attributed independent check). The verifier can never be the
person who reported the activity, and verification is only possible before the
review decision.

### Measurements

- RTO and RPO measurements are stored in whole minutes; the approved objective
  is snapshotted on the measurement with its analysis reference.
- The recorded outcome must agree with the arithmetic: `met` only when the
  measurement is within the objective, `missed` only when it exceeds it.
- Without an approved objective the only accepted outcome is `not_assessed` — a
  measurement can be recorded, but nothing is claimed against an objective that
  does not exist.
- A minimum service level is an observation, not a number of minutes.
- A missed objective is reported as a finding; the approved BIA and its
  objectives are never modified from the exercise. A *missed* observation that
  was never raised as a finding or recovery gap blocks the capability claim
  instead of being hidden by a reviewed status.
- Every measurement is attributed to the strategy it measured (inferred when the
  exercise covers exactly one strategy, otherwise chosen explicitly). A strategy
  whose steps were never walked cannot be measured at all.

### Exercise-verified capability

`evaluateStrategyCapability` is a pure function shared by the server and the
plan detail. A strategy is labelled `exercise-verified` only when **all** of the
following hold:

1. a reviewed exercise exists on the exact plan version that contains it;
2. that exercise recorded the strategy's recovery steps as performed;
3. it produced at least one measurement **attributed to that strategy** and
   actually assessed against an approved objective — `not_assessed` is never
   treated as achievement, and an exercise that covered several strategies
   cannot lend one strategy's measurement to another;
4. no high or critical finding for that strategy is open, in progress or
   awaiting verification (an explicitly accepted finding is disclosed, and a
   verified one is closed);
5. no objective was measured as missed without a finding or recovery gap
   recording the deviation;
6. the exercise tested the same analysis baseline version as the plan.

Anything less stays a documented estimate, with the unmet conditions listed in
the UI. The label is **derived evidence**: the approved plan and its strategies
are never mutated, and a plan is never presented as exercise-verified as a
whole — only the strategies an exercise actually covered are counted.

### Findings and remediation

- Findings are raised from the moment an exercise is running, may reference a
  strategy, an objective and an existing recovery gap, and carry an owner,
  target date and corrective action.
- `open → in_progress → resolved → verified` (or `accepted` with a rationale).
  Resolution requires notes and an evidence reference; verification requires a
  different authorized user from the resolver.
- A finding never closes itself by being assigned, and verifying a finding never
  closes a recovery gap — gaps keep their own evidence and closure workflow.

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
| `/bcm/dr-tests` | `BcmExercisesPage` — exercise register with status/type filters, search, keyset pagination, open-finding counts and truncation disclosure |
| `/bcm/dr-tests/:exerciseId` | `BcmExerciseDetailPage` — plan and baseline tested, participants, activities (planned / reported / verified), measurements with objective comparison, strategy coverage and derived capability, findings and remediation, review, versions and history, plus schedule/start/complete/cancel/submit/review/supersede actions |

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
- `tests/bcmExercises.test.ts` — structural checks (closed exercise/finding
  tables, planning vs results windows, no operational execution, no resilience
  score, schema snapshots/indexes, real routes, derived capability) and a
  runtime lifecycle: approved-plan-only, cross-tenant refusal, participant
  membership, schedule/start, frozen planning, reported vs verified activity,
  outcome consistency, results-window enforcement, single coverage per
  strategy, finding resolution and independent verification, completion,
  self-review refusal, reviewed capability derivation, supersession, read-only
  refusal, pagination and no mutation of the approved strategies.
- `tests/browser.bcm-exercises.test.ts` — Chromium journey: plan a tabletop
  exercise, schedule and start it, report an activity, record a missed RTO
  measurement, record strategy coverage, raise a finding, complete, submit, and
  have a second identity independently accept it; then confirm the reviewed
  status and the exercise-verified capability label.

Run them with `bun test tests/bcm.test.ts tests/bcmPlans.test.ts
tests/bcmExercises.test.ts` and `bun run test:e2e:bcm` /
`bun run test:e2e:bcm-plans` / `bun run test:e2e:bcm-exercises` (strict), or
`IITAMS_E2E_STRICT=1 bun test tests/browser.bcm-exercises.test.ts`.

## Known limitations

- No DR runbook or automated recovery procedure is stored; exercises reference
  external documentation instead.
- No automated failover, infrastructure shutdown, backup restoration, external
  scanning or emergency notification exists anywhere in the module.
- Strategy `capabilityEvidence` is still stored as `estimate`. Verification is
  derived from reviewed exercises and shown alongside it; it never edits the
  approved plan record.
- Findings have no notification/escalation integration; overdue findings are
  surfaced in the UI only.
- No ICT asset register, so asset links are descriptive text.
- Summaries are bounded and disclose truncation instead of extrapolating.
- The export/report surface for continuity data (`/reports/bcm`) is still a
  placeholder.
- A plan records intended recovery, and an exercise records what was observed
  once; neither evidences that recovery would succeed in a real event.

## Next batch (recommended)

Business Continuity Batch 4.4 — continuity **reporting and lessons-learned
consolidation**: exercise and finding summaries for management, continuity
report export, and overdue-exercise/review tracking. Automated failover,
infrastructure recovery and live operational tooling remain explicitly out of
scope and require a separate authorized milestone.
