# Access reviews & recertification (Phase 3A — Batch A3)

Administration → **Access Reviews** (`/admin/access-reviews`) lets an
organization periodically re-certify who still needs which access. This batch
deliberately delivers the *foundation*: review cycles, immutable membership
snapshots, reviewer decisions and remediation that runs through the existing
authorized role and membership workflows. It adds no new way to change a role
or a membership status.

## What exists

| Concept | Table | Notes |
| --- | --- | --- |
| Review cycle | `accessReviewCycles` | Organization-scoped title, due date, creator, status (`in_progress` / `completed` / `cancelled`) and creation timestamp. |
| Membership snapshot | `accessReviewItems` | Insert-only copy of the reviewed membership: user identity, organization, role, membership status and last activity at capture time. |
| Reviewer decision | `accessReviewDecisions` | Append-only. Records decision, reviewer identity, timestamp and notes; the latest row is the current decision. |
| Remediation | `accessReviewRemediations` | A *recommendation* (`change_role`, `suspend_membership`, `deactivate_membership`) with `proposed` → `applied` / `withdrawn`. |

## Lifecycle

1. **Create a cycle.** An administrator with `admin.manage` gives a title and a
   future due date. The organization's active, non-guest memberships are
   snapshotted **page by page**: each call scans at most
   `ACCESS_REVIEW_CAPTURE_PAGE_SIZE` profiles and stores its continuation
   cursor on the cycle, so organizations of any size are supported without an
   oversized transaction. "Continue capture" resumes from the stored cursor,
   never duplicates an item and never rewrites an existing snapshot. The cycle
   tracks scanned / eligible / captured counts and the outstanding remainder;
   capture completion is recorded explicitly. A cycle created with
   `captureMembers: false` is an explicit empty-scope review (no snapshots) and
   is marked capture-complete at creation.
2. **Record decisions.** `access_confirmed`, `remediation_required` or
   `exception_pending`. Non-confirmation decisions require a reviewer note.
   A new decision supersedes the previous one; the full history remains.
3. **Recommend remediation.** Only available while the latest decision is
   "remediation required". The recommendation is stored separately and changes
   nothing by itself — the UI labels it *"Recommended — not applied"*.
4. **Apply remediation.** Applying calls the existing `admin.changeMemberRole`
   or `admin.setMembershipStatus` mutation (the same permission checks, tenant
   checks, lockout guards and audit entries as the Users page). Only after that
   mutation succeeds is the recommendation marked `applied`, with the observed
   before/after role and membership status. A refusal leaves it `proposed` and
   no "applied" claim is ever recorded.
5. **Complete the cycle.** Completion is refused until the snapshot scan is
   complete, while any eligible membership is missing from the snapshot, and
   while any snapshot has no decision. Completing or cancelling makes the cycle
   read-only; snapshots and decision history are retained.

New members who join after a capture scan completes are reviewed in the next
cycle: a completed scan is a point-in-time evidence set and is not reopened.

## Security rules

- Every read requires `admin.view`; every write requires `admin.manage` and an
  active provisioned membership. All checks are server-side; the UI mirrors
  them only for presentation.
- The organization comes exclusively from the caller's resolved access context,
  and every id-addressed row is re-checked against it. A guessed id from
  another organization resolves to "not found".
- Snapshots are never patched: later role or membership changes cannot rewrite
  historical review evidence.
- A reviewer cannot certify their **own administrator access** — that decision
  requires an independent administrator. (Self-attestation of non-privileged
  access remains allowed.)
- Review operations are not exposed on the HTTP router and add no public
  emergency path.
- Audit entries use the `access_review.*` namespace and separate the acting
  reviewer (`actorId`/`actorLabel`) from the reviewed member (`userId`).

## Due-date handling

Due dates must be in the future at creation. A cycle that is still in progress
after its due date is flagged **overdue** in both the list and the detail view;
decisions remain possible (late reviews are recorded as late) but completion
status is never inferred from the date.

## Tests

`tests/accessReview.test.ts` covers the structural guards (authorization on
every operation, tenant re-checks, insert-only snapshots, self-review refusal,
remediation routed through the existing mutations, no HTTP surface) and a
runtime flow (cycle creation and snapshots, reviewer attribution, snapshot
survival across a later role change, self-review refusal for a promoted
administrator, recommendation → applied-only-after-success, audit integrity,
completion guard, due-date validation and non-admin refusal).
