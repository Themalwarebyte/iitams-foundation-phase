# IITAMS Audit Workflow Reference (Phase 2)

> Operational reference for the four lifecycles: who may move what, in which
> order, and what happens automatically at each step.

## 1. Engagement lifecycle (Module 3)

```
Draft → Planning → Approved → Fieldwork → Review → Report Issued → Closed
  ↘ cancelled (from Draft/Planning/Approved/Fieldwork)
```

| Transition | Authorized team roles |
|---|---|
| Draft → Planning | Lead Auditor, Audit Manager, Audit Director |
| Planning → Approved | Audit Manager, Audit Director |
| Approved → Fieldwork | Lead Auditor, Audit Manager, Audit Director |
| Fieldwork → Review | Lead Auditor, Audit Manager, Audit Director |
| Review → Report Issued | Audit Manager, Audit Director |
| Report Issued → Closed | Audit Manager, Audit Director |
| Backward (Planning→Draft, Approved→Planning, Fieldwork→Approved) | Audit Manager, Audit Director |
| → Cancelled | Audit Manager (Draft/Planning/Approved), **Director only** at Fieldwork |

Automatic effects: `progressPct` derives from stage (5/15/25/55/80/95/100);
`endDate` stamps on closure; entering Review raises an org notification;
platform `admin` acts as manager-like within its own organization.

## 2. Working paper lifecycle (Module 6)

```
Draft → Submitted → Reviewed → Approved
              ↘ Returned → Submitted (rework loop)
```

| Transition | Authorized roles |
|---|---|
| Draft → Submitted | Auditor, Lead Auditor, Audit Manager (preparer side) |
| Submitted → Reviewed | Reviewer, Audit Manager, Audit Director |
| Submitted → Returned | Reviewer, Audit Manager, Audit Director |
| Reviewed → Approved | Audit Manager, Audit Director |
| Returned → Submitted | Auditor, Lead Auditor, Audit Manager |

Automatic effects: `submittedAt`/`reviewedAt`/`approvedAt` stamp; submitting
with a nominated reviewer notifies them; returning notifies the preparer;
reviewer comments accumulate in the approval history; **approved papers are
immutable** (updates rejected server-side). Separation of duties: a paper's
preparer cannot review/approve it (reviewer-tier roles only).

## 3. Finding lifecycle (Module 8)

```
Identified → Draft → Reviewed → Management Response → Corrective Action → Closed
```

| Transition | Authorized roles |
|---|---|
| Identified → Draft | Auditor, Lead Auditor, Audit Manager |
| Draft → Reviewed | Lead Auditor, Audit Manager, Reviewer |
| Reviewed → Management Response | Audit Manager, Audit Director (+ management_user/admin via response recording) |
| Management Response → Corrective Action | Audit Manager, Audit Director |
| Corrective Action → Closed | Audit Manager, Audit Director |
| Revisions (Reviewed→Draft, Mgmt→Reviewed, CA→Mgmt) | Manager-tier roles |

Automatic effects: critical/high findings raise org-wide notifications at
identification; the management response text is recorded on the finding by
`recordManagementResponse` (management_user, audit manager/director, admin,
platform user); closure requires the full ladder — no skipping.

## 4. Corrective actions (Module 9)

```
Open → In Progress → Completed → Verified → Closed
  ↘ Overdue (computed) → In Progress / Completed
```

- Creation: audit-management roles, against an open finding; the responsible
  person is notified with the due date.
- Verification: **completed → verified** requires audit-management authority;
  verifier identity is stamped (`verifiedByName`/`verifiedAt`).
- Overdue detection is computed (`dueDate < now` and not terminal) for
  dashboards and list highlighting.
- Reminders: `sendOverdueReminders` (audit.manage) walks open/in-progress
  actions past due, marks them overdue, notifies the responsible person and
  rate-limits to one reminder per 7 days (`lastReminderAt`).

## 5. Planning → engagement flow (Modules 1–3)

1. Universe items are maintained (Module 1) with criticality,
   classification, regulatory importance and security exposure.
2. A plan is drafted; items are scheduled with `previousFindings` /
   `changeFrequency` hints — the **server** computes the 0–100 priority
   score and band (Module 2).
3. The plan is approved (draft → approved; audited; org notified).
4. Engagements are created from the plan (optionally linked to the plan item
   and universe item) and follow §1.
5. Coverage metrics (universe items with any engagement) and the backlog
   (plan items still planned/deferred) feed the dashboard strip (Module 11).

## 6. Evidence → workpaper → finding linkage (Modules 5–8)

- Procedures record Pass / Fail / Exception with expected-evidence
  descriptions; a **Fail** notifies the organization.
- Evidence uploads can attach to an engagement and/or working paper; all
  downloads are access-logged; restricted classification requires
  audit-management roles.
- Findings reference the engagement; their full attribute set
  (condition/criteria/root cause/impact/recommendation) feeds the engagement
  report (Module 10).

## 7. Notification matrix (Module 12)

| Event | Audience |
|---|---|
| Engagement assignment / role change | Assigned user |
| Engagement enters Review | Organization |
| Working paper submitted (with reviewer) | Nominated reviewer |
| Working paper returned | Preparer |
| Finding identified (critical/high) | Organization |
| Management response recorded | Organization participants |
| Corrective action assigned / overdue reminder | Responsible person |
| Plan approved | Organization |
| Evidence integrity verdict | Audit log (org-visible event stream) |
