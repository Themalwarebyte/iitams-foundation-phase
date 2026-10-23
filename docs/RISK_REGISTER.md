# ICT Risk Register — pagination, ordering and summary contract

Phase 3B — Batch 1 foundation, with the pagination correction described below.
Implementation: `src/convex/risks.ts`, `src/components/iitams/risk/RiskRegisterPage.tsx`,
shared model `src/lib/risk.ts`.

## 1. What was wrong

`listRisks` read the first `RISK_LIST_LIMIT = 500` rows of the organization's
register (`by_organization`, insertion order) and then filtered and sorted them
in memory. Consequences:

- a record created after the organization passed 500 rows was **not reachable**
  at all — the register silently ended, with no "there is more" signal;
- `riskSummary` counted the same truncated window and reported `sampled` only
  when it hit exactly 500, so `total: 500` looked like an organization total;
- filters and search only ever covered the truncated window while the UI
  presented them as register-wide;
- the identifier allocator scanned the same capped window, so it leaned on
  collision probing for every new code.

The failing risk-register runtime assertions were therefore a genuine defect,
not test flakiness: the shared demo organization holds more than 500 risks
(codes `R-011…R-522` at the time of the fix).

## 2. What replaced it

### 2.1 Orientation and ordering

The register is ordered by its per-organization identifier (`R-001`, `R-002`, …)
ascending over the **unique** `by_organization_code` index. Because the index is
unique per organization the order is total and deterministic: two rows can never
claim the same position, and an unchanged register always traverses in exactly
the same sequence.

### 2.2 Traversal

`listRisks({ cursor, numItems, search, category, status, band })`:

- `numItems` is validated server-side (`1…100`, default 25);
- `cursor` is the last identifier the previous request examined. It is validated
  against `^R-\d{3,}$`; a malformed value is refused rather than restarting or
  skipping the register. A cursor is **only** a position inside the caller's own
  register — organization context always comes from the access context, so a
  cursor carries no authority;
- the handler scans forward with a bounded keyset read (`RISK_SCAN_BUDGET = 400`
  documents per request, batched at 100), returning at most `numItems` matches;
- the response states `nextCursor`, `isDone`, `complete` (the whole register was
  walked for this filter set), `scanned` (documents examined) and `filtered`.

Therefore:

- every record belonging to the organization is reachable, including records
  created long after the first page;
- no record is duplicated or omitted when pages are traversed over an unchanged
  dataset (the cursor is exclusive — `code > last examined`);
- each request stays bounded and indexed; the register is never materialised in
  memory;
- page cost is independent of how large the register grows.

### 2.3 Filters and search are honest

Search (code, title, owner, asset/service, category), category, status and
residual band are applied **server-side** to the records scanned by the request,
so filtering searches the register as it is traversed rather than re-sorting a
browser-side copy.

When the scan budget is exhausted before the register ends, `complete` is false.
The UI then says exactly that ("filters applied to the N records scanned for this
page; the rest of the register has not been searched yet") and offers the next
page. It never implies that a partial scan covered the register, and an empty
filtered page is described as "no matching risks in this part of the register"
rather than "no risks match".

### 2.4 Identifier allocation

`nextRiskCode` no longer depends on a listing window. It takes the numeric
maximum of (a) the greatest code in the code index and (b) the codes of the
newest 50 records, then probes the unique index until the code is free. Codes are
never reused, and allocation stays correct past 999 records (where zero-padded
codes stop sorting numerically).

### 2.5 Summary accuracy

`riskSummary` reads a bounded window of up to `RISK_SUMMARY_SCAN_LIMIT = 1000`
records and returns `exact: rows < scanLimit` alongside `total`, `sampled`,
`scanLimit`, banding, status counts and review figures.

- Below the window: `exact: true`, and `total` is the organization's true count.
- At the window: `exact: false`, and the register page renders `≥ 1 000` with an
  explicit lower-bound explanation instead of a fabricated total.

Banding still uses the single shared 5×5 model in `src/lib/risk.ts`; residual
scoring semantics are unchanged.

## 3. Frontend behaviour

- Cursor stack pagination (`Previous` / `Next`) with a live "Page N · X records ·
  register order by identifier" line.
- Changing any filter or search term restarts the traversal from the first page.
- Creating a risk opens that record's detail dialog immediately and returns the
  register to page 1, so a new record is never "missing" from a later page.
- Loading, empty, filtered-empty, partial-scan and access-denied states are all
  explicit; roles without `risk.manage` get the read-only view.

## 4. Verification

| Check | Evidence |
| --- | --- |
| >500 records reachable, no ceiling | `tests/risk.pagination.test.ts` — 1020 seeded rows in isolated tenant `IITAMS-TEST-P`, full traversal, `pages > 5` |
| No duplication/omission, deterministic | same suite: identifier and id sets compared, double traversal compared, ordering asserted ascending |
| New record after the limit | same suite: created risk found exactly once through traversal, unique code |
| Server-side search beyond one scan window | same suite: last identifier not found in the first window, found by continuing, `complete` disclosed |
| Filter correctness vs independent count | same suite: category/band/status counts equal a full traversal's counts |
| Summary exactness and disclosure | same suite: `exact: true` on the small tenant, `exact: false` + `total === scanLimit` on the large one |
| Cursor/page-size/band validation, unauthenticated refusal | same suite |
| Tenant isolation | `tests/risk.tenant.test.ts` (two real organizations) and the pagination suite (foreign id read/write refused) |
| Assessments/treatment/monitoring compatibility | pagination suite compatibility case + `tests/riskAssessments.test.ts`, `tests/riskTreatment.test.ts`, `tests/riskMonitoring.test.ts` |
| Browser journey | `tests/browser.risk-register.test.ts` (2 journeys), `browser.risk-monitoring.test.ts` |

## 5. Test-fixture retention strategy (separately reviewable)

The scale test must not touch the shared demo organization and must not delete
legitimate records. It therefore uses a dedicated, explicitly demo-flagged
tenant and tagged rows:

- `IITAMS-TEST-P` is created (idempotently) by the internal, dev-gated
  `devTenantFixtures.ensureTenantFixtures`; the suite refuses to run against any
  organization that is not demo-flagged and not a known fixture code.
- `devTenantFixtures.seedFixtureRisks` inserts at most 250 rows per call, only
  into a fixture organization, only with a `[iitams-…]` title tag, continuing the
  organization's real identifier sequence and re-checking the unique index.
- `devTenantFixtures.resetFixtureRecords` removes rows **by that tag only**, in
  batches of 25, and never touches `auditLogs`.
- The suite clears its tag before seeding and again in teardown, so repeat runs
  return the fixture to its baseline. No general data-deletion API was added, no
  demo-organization risk was deleted and no audit entry was modified.

Any future cleanup of accumulated demo-organization test risks should follow the
same shape: a narrow internal mutation, dev-gated, tag- or pattern-scoped,
batched, documented here, and reviewed independently of feature work.
