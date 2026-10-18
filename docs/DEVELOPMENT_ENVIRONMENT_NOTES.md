# Development environment notes (IITAMS)

Operational notes for local development hosts. Nothing here is a production
requirement; production deployments follow
[`ENVIRONMENT_VARIABLES.md`](ENVIRONMENT_VARIABLES.md) and
[`SELF_HOSTING_ARCHITECTURE.md`](SELF_HOSTING_ARCHITECTURE.md).

## 1. Convex local backend vs. host glibc

**Observed:** on a host with **glibc 2.35** (Ubuntu 22.04-class), the newest
precompiled Convex local backends (`precompiled-2026-10-06-*`,
`precompiled-2026-10-10-*`) fail to start, because those binaries are linked
against **glibc 2.38/2.39**. The CLI download succeeds, so the failure appears
as a backend that never becomes ready rather than a clear version error.

**Reproducible fix in use:** the local deployment pins its backend version in
the generated, git-ignored local config:

```
.convex/local/default/config.json   →   "backendVersion": "precompiled-2026-09-28-5c7cb5b"
```

That pinned build runs on glibc 2.35, and `npx convex dev` reuses it instead of
downloading a newer, incompatible binary. Keep the pin when restoring a
workspace; the file is generated and never committed, so it cannot leak or
conflict between developers.

**If a newer CLI/pin still selects an incompatible binary:**

1. Prefer a compatible _host or container_ (glibc 2.39+, e.g. a current
   `debian:bookworm`/Ubuntu 24.04 image) — this is the only fully supported
   long-term answer.
2. Otherwise re-pin the known-good `backendVersion` above in
   `.convex/local/default/config.json` and remove the incompatible cache
   directory under `~/.cache/convex/binaries/`.

**Do not** commit precompiled backend binaries, wrapper scripts or shims to
the repository. A manually redirected cached binary living outside the repo is
a host-local workaround, not a project dependency, and must never be relied on
as the documented setup.

## 2. Rotating the development deployment's auth signing keys

Auth tokens are signed with the deployment's `JWT_PRIVATE_KEY` (+ `JWKS` and
`JWT_PRIVATE_KEY_ID`). Because these are deployment variables, a plain
`npx convex env list` prints them in full — multi-line PEM values included — so
never paste that output into a transcript, an issue, or a chat log.

Rotation procedure (development deployments only; production rotation needs
explicit authorization):

```bash
# 1. Generate a fresh RS256 keypair WITHOUT printing it.
node -e '
const { generateKeyPairSync, randomBytes } = require("node:crypto");
const fs = require("node:fs");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const kid = randomBytes(8).toString("hex");
fs.writeFileSync("/tmp/jwt-new.pem",
  privateKey.export({ type: "pkcs8", format: "pem" }).toString());
fs.writeFileSync("/tmp/jwks-new.json",
  JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), alg: "RS256", use: "sig", kid }] }));
fs.writeFileSync("/tmp/jwt-kid.txt", kid);
'

# 2. Apply with --from-file so the secret never enters shell history or logs.
npx convex env set JWT_PRIVATE_KEY    --from-file /tmp/jwt-new.pem
npx convex env set JWKS               --from-file /tmp/jwks-new.json
npx convex env set JWT_PRIVATE_KEY_ID --from-file /tmp/jwt-kid.txt

# 3. Remove the local key material.
shred -u /tmp/jwt-new.pem /tmp/jwks-new.json /tmp/jwt-kid.txt

# 4. Verify authentication still works (anonymous + email OTP sign-in).
bun test tests/riskMonitoring.test.ts -t "structural guards"
```

Rotation invalidates existing sessions on that deployment — expected, and why
it is done on non-production deployments without ceremony. If a signing key is
ever exposed, rotate it; do not "monitor" it.

## 3. Dev credential hygiene check (2026-10)

A development test run once emitted auth material into diagnostic output. The
check and its outcome:

- **What was emitted:** short-lived, per-session Convex Auth tokens and
  development OTP codes returned by the token-guarded local test harness
  (`/api/dev-otp`, `/api/dev-seed-test-user`, `/api/dev-grant-demo-role`).
  Those routes require `IITAMS_TESTER_TOKEN` and the guest-auth dev gate, and
  every value they return is a per-session artefact that expires on its own.
- **What was NOT emitted:** the deployment's auth **signing** credential
  (`JWT_PRIVATE_KEY`, `JWKS`, `JWT_PRIVATE_KEY_ID`). Those are Convex
  deployment variables — they are never copied into `.env*`, are not readable
  by application code (`docs/SECRET_MANAGEMENT.md` §3), and do not appear in
  the workspace environment (`freebuff-env list` shows only
  `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `VITE_CONVEX_SITE_URL`,
  `IITAMS_ENABLE_FREEBUFF_DEVTOOLS`).
- **Verification:** a scan of the working tree and the **full git history**
  (`git log --all -S`) for `BEGIN … PRIVATE KEY` blocks, `eyJhbGciOi` JWT
  payloads, `fb_email_*`, `sk_live_/sk_test_*` and `AKIA…` returns **0
  matches**; `.gitignore` excludes `.env*` (except `.env.example`), `*.pem`,
  `*.key`, `secrets/` and the harness secret `.iitams-tester-token`.

**Determination:** no development signing credential was exposed, so no
rotation is required. Rotate via §2 only if key material is ever actually
observed in output — and never print `npx convex env list` on a deployment
to "check".
