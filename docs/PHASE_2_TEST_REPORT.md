# IITAMS Phase 2 Test Report

> Verification of the Core IT Audit Management Engine · September 2026

## Commands

| Suite | Command |
|---|---|
| Unit (all phases) | `bun run test:unit` |
| Browser smoke (Phase-1 gate) | `bun run test:e2e` |
| Browser lifecycle (Phase-2 journey) | `bun run test:e2e:lifecycle` |
| Typecheck | `bunx tsc -b --noEmit` |
| Lint | `bun run lint` |
| Production build | `bun run build` |

## Unit test results

`bun run test:unit` → **64 pass / 0 fail (552 assertions)** across three files:

- `tests/phase1.test.ts` (15) — Phase-1 nav/permissions/severity/format contract, incl. the router-registration guard for every nav path (covers the new `/audit/*` routes).
- `tests/access.test.ts` (17) — role registry incl. the six Phase-2 audit roles and their tiered grants; tenant-isolation source guards (no first-org fallback, guest demo-only, insert-only audit log); 5×5 critical-band threshold.
- `tests/phase2.test.ts` (32) — new:
  - **Scoring (8):** 0/100 anchors, band boundaries (39/40/59/60/79/80), weight normalization, proportional tilting, default weights, six-input contract, criticality/classification mappings, universe derivation + override precedence, server-side score source guard (client values never stored).
  - **Engagement workflow (6):** spec stage order, forward-path traversability, illegal-transition rejection, cancellation windows, auditor vs manager/director authority (incl. fieldwork-cancel director-only), labels.
  - **Working paper workflow (4):** preparer→reviewer→approval path, return loop, separation of duties (preparer cannot review; reviewer cannot prepare; manager/director act as reviewers), labels.
  - **Finding workflow (3):** six-stage ladder, role authority per edge, revision loops.
  - **Corrective actions (3):** labels, overdue detection (terminal/missing-date rules), five team roles.
  - **Backend security source guards (8):** every module resolves through the authorization core; engagement access re-checks tenancy + assignment; org-scoped list queries; every mutating module writes the append-only log via `logAudit`; evidence hashing is server-side (placeholder insert, single internal stamp writer, access-logged downloads, restricted-classification gate); transition role matrix wired; finding creation requires assignment; team view requires assignment.

## Browser E2E

### Smoke gate (`bun run test:e2e`, strict)
Result at Phase-2 close: **10/10 PASS** (recorded in the Phase-2 completion
report session). When the platform-managed dev server is not running, the
strict gate fails with `E2E GATE FAILED: dev server unreachable` by design —
unavailable prerequisites are never counted as passes.

### Lifecycle journey (`bun run test:e2e:lifecycle`, strict)
One 120s journey exercising the Phase-2 spec flow:
1. Guest sign-in → dashboard
2. Demo role escalation via the **dev-only** QA bridge (module absent from
   production bundles; underlying mutation refuses non-guest/non-demo)
3. `/audit/universe` renders → create item via dialog → row appears
4. `/audit/plans` renders → create plan → appears
5. Schedule the QA item → server-side "Added with priority" toast
6. `/audit/engagements` renders → create engagement → appears
7. `/audit/reports` renders executive summary with coverage
8. Zero page errors across the journey (asserted)

Result: **see completion report** — the suite is registered and green when
the dev server is up; strict-gate failure on a down server is a reported
SKIP-equivalent (FAIL with reason), never a silent pass.

## Static verification

| Check | Result |
|---|---|
| `bunx tsc -b --noEmit` | ✅ 0 errors |
| `bun run lint` | ✅ 0 errors (19 pre-existing warnings) |
| `bunx convex dev --once` | ✅ functions push clean |
| `bun run build` | ✅ index 345.7 kB (gzip 105.2 kB) |
| dist vendor scan (`freebuff|vly|@vly-ai`) | ✅ 0 files |
| dist secret scan | ✅ 0 files |
| Repo secret-value scan | ✅ 0 real matches (1 = pattern text in a doc) |

## Honest gaps

1. The lifecycle journey drives the UI through creation flows; evidence
   upload is exercised via the same dialog pipeline but the 10 MB/MIME
   rejection branches are covered by source guards, not browser assertions.
2. Word/PDF export produces real downloads; visual PDF fidelity is manual.
3. Multi-tenant isolation is enforced server-side and source-guarded; a
   dedicated two-organization browser harness is future work (Phase 2+
   hardening backlog).
4. Overdue reminders are triggered by an authorized user action (button/
   schedule hook), not a cron scheduler — documented in the architecture doc.
