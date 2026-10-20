# Preview owner access (non-production)

How the project owner gets a real, self-owned administrator account on a
**preview/demo** deployment. Nothing here is used on production data.

## 0. Backend reachability — do this first (verified 2026-10-19)

A preview that "loads but cannot sign in / shows nothing" is usually this: the
web client was built with a **loopback** Convex URL, so every browser except the
ones running inside the sandbox tries to reach its *own* `127.0.0.1:3210` and
fails. The client only reads one variable for this —
`new ConvexReactClient(import.meta.env.VITE_CONVEX_URL)` in `src/main.tsx`.

For an externally reachable preview, point the client at the workspace's
**public port-forward** URLs instead:

```bash
# values are public configuration, not secrets
VITE_CONVEX_URL=https://<cloud-port>-<workspace-id>.e2b.app
VITE_CONVEX_SITE_URL=https://<site-port>-<workspace-id>.e2b.app
```

Verify with evidence before claiming it works:

```bash
# 1. The served client really carries the public URL (not 127.0.0.1)
curl -s https://<preview-host>/src/main.tsx | grep -oE 'https?://[^"'"'"']+' | sort -u
# 2. The backend answers from *outside* the sandbox
curl -s -o /dev/null -w '%{http_code}\n' https://<cloud-port>-<workspace-id>.e2b.app/version
# 3. The realtime channel upgrades (Convex needs WebSockets, not just HTTP)
node -e 'const W=require("ws");const w=new W("wss://<cloud-port>-<workspace-id>.e2b.app/api/1.30.0/sync");w.on("open",()=>{console.log("upgrade ok");process.exit(0)});w.on("error",e=>{console.log("ERR",e.message);process.exit(1)})'
# 4. End-to-end through the app itself: the guest sign-in + dashboard smoke suite
bun test tests/browser.smoke.test.ts
```

**Residual risk you must accept knowingly.** Port forwarding makes the whole
development backend reachable from the internet (ports 3210 and 3211 answer an
unauthenticated `GET /version`), and a development deployment has guest sign-in
enabled by design. Keep such a preview short-lived, keep only demo/seed data on
it, never copy production data or credentials onto it, and prefer a dedicated
Convex **cloud development** deployment (deployment-scoped `CONVEX_DEPLOY_KEY`,
`npx convex deploy`) when the preview must stay reachable for more than a
session. Tester-token-gated harness routes (`/api/dev-*`) are the only dev
surface that should ever be reachable, and they refuse without the token.

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

**Interaction with the browser test suites:** the development OTP capture (the
bridge the suites read a code from) only runs in the *no-provider* branch. With
`IITAMS_EMAIL_PROVIDER=resend` active, codes are delivered by email instead and
the capture is inactive — so enable the provider for the owner's sign-in, and
expect the OTP-dependent suites to need it unset again (or a real inbox).

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
