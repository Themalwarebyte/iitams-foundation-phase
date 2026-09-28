# IITAMS — Security Hardening Backlog

> Scope: what Phase 1 retained/improved, and every outstanding item, with
> priority and acceptance criteria. Phase 1 did **not** disable any control.

## 1. Security baseline in place (Phase 1)

| Control | Status | Implementation |
| --- | --- | --- |
| Authentication | ✅ | Convex Auth email-OTP + anonymous (demo); JWT sessions; httpOnly token handling by Convex Auth |
| Session protection | ✅ | Tokens issued/validated by Convex Auth; no client-side session state |
| RBAC | ✅ | `src/convex/access.ts` — role→permission map; every domain query resolves effective role server-side; fail-closed defaults |
| Multi-tenant isolation | ✅ | All domain rows scoped by `organizationId`; queries filter by acting user's active org |
| Input validation | ✅ (partial) | Convex validators on all function args; zod available for app-level forms |
| Output encoding | ✅ | React JSX escaping; no `dangerouslySetInnerHTML` anywhere in the codebase |
| Audit logging | ✅ | Append-only `auditLogs` with actor/action/entity/timestamp; activity surfaced on dashboard |
| Secrets separation | ✅ | No secrets in repo; server-only envs via Convex env; `.env*` blocked by platform policy (template documented in `docs/ENVIRONMENT_VARIABLES.md`) |
| Secure headers (self-host) | ✅ | `deploy/nginx.conf`: nosniff, DENY framing, referrer policy, permissions-policy; CSP placeholder documented |
| No dev credentials in runtime | ✅ | No hard-coded admin passwords anywhere; demo org is synthetic data, not a credential backdoor |
| Reduced attack surface | ✅ | Static SPA bundle; no server-side templating |

## 2. Outstanding backlog

| # | Item | Priority | Acceptance criteria |
| --- | --- | --- | --- |
| 1 | **Rate limiting** on OTP request/verify and auth endpoints | High | Per-email and per-IP throttles with lockout backoff; 429s surfaced gracefully |
| 2 | **CSP** finalised for production domains | High | `Content-Security-Policy` header active (nginx) without `unsafe-inline` for scripts |
| 3 | **Passwordless→policy bridge**: define OTP expiry/resend policy + optional password auth with Argon2/bcrypt if required by policy | High | Documented policy; OTP ≤ 10 min, single use; brute-force resisted |
| 4 | **File upload validation & evidence hashing** (evidence module, Phase 2) | High | MIME/extension/size allowlist; SHA-256 digest stored at ingest and verified on retrieval |
| 5 | **Provisioned-user workflow** (invite/approve; disable anonymous sign-in in production) | High | Admin-driven invites; anonymous provider disabled by env flag in prod |
| 6 | **Session revocation & device list** | Medium | Users see active sessions; admins can revoke |
| 7 | **Field-level classification enforcement** | Medium | `classification` field enforced at query layer (visual indicators already shipped) |
| 8 | **REST API authN/authZ + schema** (public API phase) | Medium | Token auth, per-scope permissions, OpenAPI spec published |
| 9 | **Automated dependency scanning** (Dependabot/audit in CI) | Medium | CI job fails on known high/critical vulns |
| 10 | **Backup encryption & restore drills** | Medium | Encrypted export artefacts; quarterly restore test log |
| 11 | **Pen-test of the platform itself** before production go-live | Medium | Findings triaged and closed |
| 12 | **Formal accessibility & security review** of admin module | Low | Findings tracked; admin actions re-authenticate for sensitive ops |
| 13 | **PII minimisation review** on user tables | Low | Only necessary identity fields stored; retention policy documented |

## 3. Residual-risk notes

- Demo seeding is explicitly gated behind an idempotent mutation keyed to the
  `IITAMS-DEMO` organization and creates no privileged credentials.
- The anonymous/guest sign-in path is convenient for evaluation but **must be
  disabled** for production (backlog #5).
- Email delivery of OTPs currently relies on the dev OTP flow (codes visible
  to deployment admins in the Convex dashboard); SMTP wiring is required
  before production use.
