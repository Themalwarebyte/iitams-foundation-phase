# Administrator recovery runbook

> What to do when an organization has lost its last administrator, and how
> that exceptional path differs from ordinary in-app administrator management.

## Three distinct paths (do not confuse them)

| Situation | Path | Who can run it |
| --- | --- | --- |
| Routine role management | `admin.changeMemberRole` (Administration → Users → **Change role**) | An administrator holding `admin.manage` |
| Routine administrator grant | `adminLifecycle.grantAdministrator` → target accepts at `/privilege-requests` | An administrator holding `admin.manage` |
| First administrator on a fresh deployment | `adminLifecycle.claimInitialAdministrator` (one-time bootstrap, [`ADMINISTRATOR_BOOTSTRAP.md`](ADMINISTRATOR_BOOTSTRAP.md)) | The designated, email-verified identity |
| **Lost every administrator** | `adminLifecycle.recoverOrganizationAdministrator` (internal, CLI only) | Deployment operator with Convex deployment credentials |

Routine management never requires database or CLI access, and it is audited as
an in-app decision with a named actor. Recovery is out-of-band by definition:
no administrator remains who could approve an in-app grant, so the operator
acts directly on the deployment.

Routine role editing and the administrator lifecycle stay independent: a
member with an unexpired **pending** administrator grant cannot have their
ordinary role changed until that grant is accepted, declined or cancelled
(the grant records the role to restore on a later revocation, and the role
editor never modifies grant rows). Revoking an administrator restores the role
recorded on their accepted grant, so ordinary role changes should be made
after the lifecycle action, not underneath it.

## Why this is safe

`recoverOrganizationAdministrator` is an **internalMutation**:

- it is **not callable from the browser**, not exposed on the HTTP router, and
  not part of any authenticated client surface — there is no public emergency
  role-grant endpoint, and no token can be presented by a user to invoke it;
- it only runs with deployment credentials (`npx convex run …`), i.e. access
  that already implies full control of the backend;
- it is **disabled unless the operator explicitly enables it** with the
  deployment variable `IITAMS_RECOVERY_ENABLED=true`;
- it refuses unless the target organization has **zero effective
  administrators** (the same shared count used by suspend, deactivate and
  revoke, which ignores expired demo grants) — so it can never quietly add an
  extra administrator while governance is intact;
- the target must be an existing, non-anonymous account with a **verified
  email** and an **active membership** in that exact organization. Nothing is
  created: no user, no profile, no invitation, and the one-time bootstrap is
  not reset or bypassed;
- the promotion and its immutable audit entry are written in one transaction.
  The audit actor is recorded as **“Deployment operator (CLI recovery)”** with
  action `admin.administrator_recovered`, so the out-of-band action is never
  attributed to an in-app administrator.

The one-time bootstrap remains the normal first-administrator path. Recovery
exists only for the case where that path was already consumed and every
administrator was later lost (suspensions, revocations, staff departures).

## Runbook

1. Confirm the organization genuinely has no effective administrator — in the
   Convex dashboard, check `userProfiles` for that organization: no row with
   `role === "admin"` and `membershipStatus` active (or unset, which resolves
   active). If an administrator exists, use the in-app lifecycle instead; the
   recovery mutation will refuse.

2. Ensure the recovery target has signed in at least once (email OTP), so a
   verified account and an active profile already exist. Recovery cannot
   create accounts and does not verify emails.

3. Enable recovery on the deployment **temporarily**:

   ```bash
   npx convex env set IITAMS_RECOVERY_ENABLED true
   ```

4. Run the recovery mutation with the organization's stable `code` and the
   target's email:

   ```bash
   npx convex run adminLifecycle:recoverOrganizationAdministrator \
     '{"organizationCode":"HQ-MAIN","email":"ict.oair@example.go.ke"}'
   ```

   A successful call returns `{ ok: true, profileId, previousRole }`. Any
   refusal message states the failing prerequisite (feature disabled, admins
   still present, unknown organization, unverified account, inactive
   membership, already administrator).

5. **Disable recovery again immediately** — it is one-shot operational tooling,
   not standing configuration:

   ```bash
   npx convex env unset IITAMS_RECOVERY_ENABLED
   ```

6. From the recovered account, restore normal governance: grant or provision
   the remaining administrators through **Administration → Users** and the
   two-step grant flow, then review the audit trail entry
   `admin.administrator_recovered`.

## Verification & tests

`tests/security.rolemanagement.test.ts` covers the routine role editor and the
recovery prerequisites:

- runtime: authorized role change, immediate permission recalculation, audit
  actor/target separation, refusals for non-administrators, self-change,
  administrator targets, no-op changes, invalid roles, and the recovery
  refusal while an organization still has an effective administrator;
- structural: the recovery function is an internal mutation (never a public
  mutation/query and never wired into `http.ts`), is gated on
  `IITAMS_RECOVERY_ENABLED`, requires zero effective administrators, and never
  touches invitations or the one-time bootstrap rows.
