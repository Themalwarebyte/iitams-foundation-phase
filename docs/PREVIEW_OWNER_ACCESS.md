# Preview owner access (non-production)

How the project owner gets a real, self-owned administrator account on a
**preview/demo** deployment. Nothing here is used on production data.

## 1. Email OTP delivery (prerequisite)

IITAMS signs users in with an email one-time code; there are no passwords.
The code is only emailed when the deployment has a provider configured. With no
provider, codes are captured for the development dashboard flow and **no email
is delivered** (`[iitams:otp] no email provider configured` appears in the
backend logs).

Set these on the **Convex deployment** (Convex dashboard → Deployment settings →
Environment variables, or `npx convex env set …`). Never commit them:

| Variable | Value |
| --- | --- |
| `IITAMS_EMAIL_PROVIDER` | `resend` |
| `RESEND_API_KEY` | Resend API key (secret, paste in the secret UI only) |
| `RESEND_FROM` | Verified sender, e.g. `IITAMS <no-reply@your-domain>` |

Notes:

- `RESEND_FROM` must use a domain verified in Resend; Resend's sandbox sender
  only delivers to the account owner's own address.
- `SITE_URL` / `CONVEX_SITE_URL` are needed for invitation/invite **links**,
  not for OTP codes. Set `SITE_URL` to the preview origin so invitation emails
  point at the preview, not localhost.
- Guest sign-in (`IITAMS_ALLOW_GUEST_AUTH`) is a separate development switch and
  is not a substitute for an identified account.

**Provider acceptance is not inbox receipt.** Confirm the owner actually
receives a code before treating email sign-in as working.

## 2. Owner account creation (identity proof)

1. Open the preview `/auth` page.
2. Enter the owner's own email address and request a code.
3. Enter the received code. Convex Auth verifies the address and creates the
   account (`emailVerificationTime` is set).

At this point the account exists but has **no organization membership and no
role** — it is correctly denied everything until an administrator assigns it.

## 3. Operator procedure: establish the preview owner

Because the one-time bootstrap is already consumed and the emergency recovery
path correctly refuses while administrators exist, the documented path for a
**demo/preview** organization is the internal, double-gated operator mutation
`previewOwner:establishPreviewOwner`.

It is an `internalMutation` (deployment credentials only — no browser/HTTP
surface), and it refuses unless:

- `IITAMS_OWNER_PROVISIONING_ENABLED=true` on the deployment, **and**
- the `operatorToken` argument matches `IITAMS_OWNER_PROVISIONING_TOKEN`
  (high-entropy, ≥ 24 characters), **and**
- the target organization is explicitly flagged `isDemo` (never production),
- the account exists, is not anonymous, and has a verified email,
- the account does not already belong to a different organization (the
  one-profile invariant is preserved).

The one-time bootstrap row and invitations are never touched.

```bash
# 1. Generate a one-shot operator token (store it in the secret manager only)
openssl rand -hex 24

# 2. Enable the procedure and store the token on the deployment
npx convex env set IITAMS_OWNER_PROVISIONING_ENABLED true
npx convex env set IITAMS_OWNER_PROVISIONING_TOKEN "<the generated token>"

# 3. Establish the owner (organization code must be the demo/preview org)
npx convex run previewOwner:establishPreviewOwner \
  '{"organizationCode":"IITAMS-DEMO","email":"owner@example.com","operatorToken":"<the generated token>"}'

# 4. Disable the procedure again — it is one-shot operational tooling
npx convex env unset IITAMS_OWNER_PROVISIONING_ENABLED
npx convex env unset IITAMS_OWNER_PROVISIONING_TOKEN
```

The audit trail records `admin.preview_owner_established` with the actor
**“Deployment operator (CLI preview provisioning)”**, so it is never confused
with an in-app administrator decision.

## 4. Verify

1. Sign out and sign in again with the owner email (fresh session).
2. The dashboard loads and the sidebar shows **Administration**.
3. `/admin/users` lists the owner as `admin` / active.
4. `/admin/access-reviews` is available (read + manage).

Revoking this access is ordinary administration: use the administrator
lifecycle to revoke the role, or suspend the membership.

## Do not

- Do not reset the one-time bootstrap or reuse a test fixture as the owner.
- Do not use the emergency recovery path while administrators exist.
- Do not enable `IITAMS_OWNER_PROVISIONING_*` on production, and never leave the
  flag enabled after the one-time run.
- Do not paste API keys into chat or commit them.
