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

## 3. Write/query stalls on a weak development host (2026-10)

**Observed:** on this 2 vCPU / 2 GB development host (no swap) the local Convex
backend holds ~0.9 GB RSS against a ~465 MB dev database (~256k document
versions, ~1.04M index entries). Two headless-Chromium pages running at once
drove `MemAvailable` from ~580 MB down to ~70 MB. In those windows otherwise
trivial functions intermittently exceeded Convex's 1 s per-function budget:

- `auth:store` (`createVerificationCode`) — 0.9 s warning, then
  `Function execution timed out (maximum duration: 1s)`;
- `devOtp:capture` and `verifyCodeAndSignIn` — 0.86–0.96 s warnings;
- `admin:listUsers` and `adminLifecycle:listAdministratorLifecycle` timeouts.

**Not query design and not database size alone:** with the same backend idle,
`/api/query users:currentUser` answered in 1–2 ms and the full `auth:signIn`
action (verification-code write + dev OTP capture) completed in 45–60 ms across
eight consecutive calls. The stalls are host resource pressure.

**App mitigation:** `src/pages/Auth.tsx` does NOT retry an email-OTP request
automatically. A timeout is ambiguous — the verification code may already have
been stored and delivered — and Convex Auth keeps only ONE active code per
account, so a second request silently invalidates the code in the first email.
Instead, a transient failure moves the user to the code step with a generic
explanation, and a resend is an explicit, cooldown-gated user action (30 s).
The policy and its messages live in `src/lib/authOtp.ts` and are covered by
`tests/authOtp.test.ts`. Nothing in authentication is relaxed: every request
still creates one ordinary verification code and the code is verified by the
real backend.

**Operational guidance:** run browser suites one at a time, and restart the
managed preview (`freebuff-preview restart` — never a manual kill) when the
backend RSS regrows past ~0.9 GB. On this host a full `tsc -b` and the
production bundle can exceed a 180 s shell cap while the host is memory-starved
— see §5 for the measured cause and the verified procedure (enable swap first).

## 4. Dev credential hygiene check (2026-10)

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

## 5. Why the production build "did not fit" on this host — and the verified fix (2026-10-19)

Measured on the sandbox while the managed preview was running:

| Observation | Value |
| --- | --- |
| Logical CPUs visible to the workspace | **1** (`nproc`) |
| Total memory / swap | 1983 MB / **0 MB** |
| Typical memory in use | ~1.4 GB (convex-local-backend ≈ 1.0–1.1 GB RSS, Vite ≈ 130 MB, `convex dev` ≈ 110 MB) |
| Free memory while the build runs | 60–90 MB — the build process is killed |
| `find`/`cat` over `node_modules`, `src` | fast (< 0.2 s); raw disk ≈ 360 MB/s |

**Root cause: addressable memory, not CPU.** Earlier attempts looked like CPU
starvation — `tsc -b` and `vite build` reported only ~7–12 s of user CPU in a
150 s window — which is what allocation under memory pressure looks like from
the outside. Instrumenting the build showed the real limit: it reaches ~550 MB
RSS in about 20 s and then dies (`FATAL ERROR: Reached heap limit Allocation
failed` when the V8 heap is capped; a silent host kill when it is not). A plain
`node`/`bun` busy loop on the same host reaches 94 % of a CPU, so CPU was never
the constraint. The old conclusion ("blocked by CPU/shell limits") was wrong
and is superseded here.

**Verified procedure — add swap before the heavy checks.** The build needs
~700 MB of addressable memory; this host can only spare ~550 MB of RAM, so give
it a backing store (host-local, never committed):

```bash
fallocate -l 3G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
```

With that swap in place, on the *same* 1-vCPU sandbox and with the managed
preview still running:

| Check | Result |
| --- | --- |
| `bun tsc -b --noEmit` | exit 0 — 24 s wall |
| `bun run lint` | exit 0 — 0 errors, 21 pre-existing warnings — 33 s wall |
| `bun run build` (`tsc -b && vite build`) | exit 0 — 41 s wall ("✓ built in 13.2 s"; peak RSS 550 MB, 118 MB of swap) |

`dist/` stays git-ignored and must never be committed. If swap cannot be enabled
(a locked-down container with no `CAP_SYS_ADMIN`), the checks are genuinely
**blocked** — record them as blocked, never as passed — and run them on a runner
with ≥ 2 vCPU / 4 GB or through the Freebuff production build pipeline
(`freebuff-deploy check` → Deploy), which runs the same `bun run build` in a
clean builder.

**Long runs are a separate limit.** The whole configured unit set
(`bun run test:unit` — 23 files) needs roughly 6–8 minutes here, so it exceeds a
single shell command. Run the exact configured file list in documented chunks,
one `bun test <file>` invocation per file with a `timeout`, and record each
file's exit code and pass/fail/skip counts separately. Browser suites stay
sequential, one file per invocation, and are the first thing to stop if the
backend RSS passes ~0.9 GB.
