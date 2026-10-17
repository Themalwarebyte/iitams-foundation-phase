# Administrator bootstrap & lifecycle

> How the FIRST administrator of an organization gets created, why no other
> path can mint the `admin` role, and how to operate a fresh deployment.

## Overview

The privileged `admin` role (the registry entry in `src/convex/access.ts`) can
be assigned on a `userProfiles` row by **exactly three server paths**, all in
`src/convex/adminLifecycle.ts`:

1. **`claimInitialAdministrator`** — the one-time, deployment-controlled
   *bootstrap* documented here.
2. **`grantAdministrator`** + **`acceptAdministratorGrant`** — an existing
   administrator starts a *pending* grant for an eligible member of the same
   organization; nothing elevates until the target's own authenticated,
   email-verified identity accepts. Rejection, cancellation and a hard TTL
   (AdminGrantTTL_MS) are explicit terminals.
3. **`revokeAdministrator`** — an existing administrator removes another
   administrator's privilege and restores the *exact previous role* recorded
   on the accepted grant or bootstrap row (never an automatic `member`
   fallback).

Ordinary (non-administrator) role changes use `admin.changeMemberRole` and can
never assign `admin`; see [`ADMINISTRATOR_RECOVERY.md`](ADMINISTRATOR_RECOVERY.md)
for routine management versus exceptional operator recovery.

There is deliberately **no super-admin** and **no cross-organization
authority**: every mutation resolves the caller's own organization first.

## The one-time bootstrap

### Configuration (deployment environment only)

All three values are **Convex deployment variables** — set them with
`npx convex env set KEY value`. They are never bundled into browser assets
(the value of the token also never lives in source or client code):

| Variable | Meaning |
| --- | --- |
| `IITAMS_BOOTSTRAP_ORG_CODE` | `code` of the target organization (e.g. `HQ-MAIN`). |
| `IITAMS_BOOTSTRAP_ADMIN_EMAIL` | The designated administrator's email (lower-cased, trimmed). |
| `IITAMS_BOOTSTRAP_TOKEN` | High-entropy one-time activation secret. |

If any of the three is missing, bootstrap is *unconfigured* and the mutation
refuses with a generic error (no configuration oracle).

### Flow

1. The designated person **signs in with their own account** (email OTP) and
   completes email verification.
2. They submit the activation token (UI: administrator bootstrap screen;
   function: `claimInitialAdministrator`).
3. The mutation refuses unless **all** of these hold:
   - the caller is not an anonymous guest identity;
   - the caller's email is verified and matches
     `IITAMS_BOOTSTRAP_ADMIN_EMAIL` exactly (normalized);
   - `sha256(token presented) === sha256(IITAMS_BOOTSTRAP_TOKEN)`;
   - the configured organization exists;
   - no `initialBootstraps` row is recorded yet for the organization
     (the secret is **one-time, deployment-lifetime**);
   - the organization has **zero active administrators**;
   - the caller holds no conflicting membership in another organization, and
     any existing org membership is active.

### One-profile invariant

The caller's profile is looked up **once across all organizations**:

- Profile in another organization → refuse, change nothing.
- Unassigned row (`organizationId` unset) → completed **in place**.
- Active profile in this organization → elevated **in place**; unrelated
  metadata (jobTitle, department, session data) is preserved verbatim.
- Inactive profile → refuse for explicit review.
- No profile anywhere → the only path that inserts one.

### Durable, atomic consumption

The role write and the consumption marker happen in **one mutation**: an
`initialBootstraps` row persists  the target user/email, the *previous role*
(unused for bootstrap restore only — revocation restores it), and
`tokenHash: sha256(activation token)`. The **plaintext token is never
stored** — in the database, audit trail, or logs. Once the row exists the
bootstrap stays dead even if `IITAMS_BOOTSTRAP_TOKEN` is accidentally left
configured in the environment.

### Post-claim

`expireDueGrants` (internalMutation) reaps overdue pending grants; the
directory (`listAdministratorLifecycle`) presents only *effective*
administrators — rows whose trusted demo-role grant has expired are excluded
with the same predicate the last-administrator guard uses, so the UI can
never point an operator at a credential that is no longer valid.

## Operator runbook (fresh deployment)

```bash
# 1. Configure the bootstrap on the Convex deployment (example values):
npx convex env set IITAMS_BOOTSTRAP_ORG_CODE "HQ-MAIN"
npx convex env set IITAMS_BOOTSTRAP_ADMIN_EMAIL "ict.oair@example.go.ke"
npx convex env set IITAMS_BOOTSTRAP_TOKEN "$(openssl rand -hex 24)"

# 2. Deliver the token to the designated administrator out-of-band
#    (password manager / secure note). It never flows through the app.

# 3. The administrator signs in (email OTP), verifies their email, and
#    submits the token in the administrator bootstrap screen.

# 4. Deactivate in production storage policy: after the durable consumption
#    row exists the bootstrap cannot run again, but removing the env values
#    is still recommended hygiene:
npx convex env unset IITAMS_BOOTSTRAP_TOKEN
```

Recovery if the first claim is somehow impossible (e.g. email entered wrong):
unset and re-set all three variables *before* any consumption; after
consumption the deployment simply uses the normal grant lifecycle instead
(admin → pending grant → target accepts).

If an organization has lost **every** administrator (bootstrap already
consumed and no admin left to approve a grant), the deployment operator uses
the exceptional CLI-only path — `recoverOrganizationAdministrator` — described
in [`ADMINISTRATOR_RECOVERY.md`](ADMINISTRATOR_RECOVERY.md). It is an internal
mutation, disabled by default, and refuses while any effective administrator
remains.

## Test coverage

`tests/security.adminlifecycle.test.ts` guards the whole boundary:

- structural: registry key uniqueness, hash-only persistence, the token
  never reaching browser-facing code, env-only configuration, signed-in and
  verified identity requirements, PENDING-by-default grants, atomic
  acceptance, exact previous-role restoration, last-admin guard in both
  revocation and membership-status flows;
- runtime (against the deployed backend): invalid secrets refused,
  concurrent grant serialization, expiry semantics, no actor/target
  conflation in the audit trail, and the expired-demo-grant directory
  exclusion;
- **bootstrap fixture tests** (first-claim and durable consumption) register
  as explicit `[test:PREREQ-FAILED]` prerequisite skips when the deployment's
  `initialBootstraps` row already exists — i.e. when the fixture is not
  fresh — because bootstrap is a *deployment-lifetime one-shot*: they run
  only on a backend whose bootstrap has not been consumed yet.

> Note for test authors: the local `convex dev` backend runs a
> deterministic clock that only advances on write transactions. Tests that
> wait for an expiry on wall time must trigger a write (any mutation, e.g.
> the harness hygiene sweep) after the wait before asserting server-side
> expiry effects.
