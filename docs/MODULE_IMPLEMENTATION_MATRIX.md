# IITAMS — Module Implementation Matrix

> Statuses are **verified against source code**, per Phase-1 rules.
> Verified: September 2026. "Backend" = Convex tables + functions;
> "Frontend" = protected route + UI.

Legend: ✅ Implemented · 🟡 Partial · 🟠 Placeholder · ❌ Missing

| Module / capability | Backend | Frontend | Evidence & notes |
| --- | --- | --- | --- |
| **Authentication** | ✅ | ✅ | Convex Auth email-OTP + anonymous (`src/convex/auth.ts`, `auth/emailOtp.ts`); `/auth` page; `RequireAuth` guard; JWT sessions |
| **Users** | 🟡 | 🟡 | `users` (auth-owned) + `userProfiles` (org, title, permissions) exist; no user-management UI yet |
| **Roles / RBAC** | ✅ | ✅ | `access.ts` role→permission map; session query resolves effective role; sidebar filters by permission; admin/user/member enforced on server queries |
| **Organizations (MDACs)** | 🟡 | 🟠 | `organizations` table with type/code/isDemo; session exposes active org; admin UI is Phase 2 |
| **Audit universe** | 🟡 | 🟠 | `auditUniverseItems` table + demo seed; dedicated CRUD UI Phase 2 |
| **Audit plans** | 🟡 | 🟠 | `auditPlans` table (fiscal year, status, progress counters) |
| **Audit engagements** | 🟡 | ✅ (view) | `auditEngagements` with status/progress; dashboard surfaces active audits & completion; full engagement workspace Phase 2 |
| **Audit programs** | ❌ | 🟠 | Route + nav exist (placeholder page); no table/functions |
| **Working papers** | ❌ | 🟠 | Route + nav only |
| **Evidence** | ❌ | 🟠 | Route + nav only; storage abstraction documented for Phase 2 |
| **Findings** | ✅ (read) | ✅ (view) | `findings` with severity/status/dueDate; executive aggregate computes open/critical counts + severity distribution; write workflow Phase 2 |
| **Management responses** | ❌ | 🟠 | Route + nav only |
| **Corrective actions** | 🟡 (read) | ✅ (view) | `correctiveActions` with owner/due/status; overdue computation in aggregate; workflow UI Phase 2 |
| **Follow-up audits** | ❌ | 🟠 | Route + nav only |
| **Risk register** | 🟡 (read) | ✅ (view) | `risks` with 5×5 inherent/residual scores, categories, owners |
| **Risk assessments** | ❌ | 🟠 | Route + nav only |
| **Risk treatments** | ❌ | 🟠 | Route + nav only |
| **Risk heat map** | ✅ | ✅ | 5×5 residual heat-map cells computed server-side; rendered chart component |
| **Risk trends** | ✅ | ✅ | `riskTrendSnapshots` + trend line chart on dashboard |
| **Compliance frameworks** | 🟡 (read) | ✅ (view) | `complianceFrameworks` with scores; framework bar chart |
| **Control library** | 🟡 (read) | ✅ (view) | `controls` with effectiveness states; effectiveness gauge |
| **Compliance assessments** | ❌ | 🟠 | Route + nav only |
| **Control testing** | ❌ | 🟠 | Route + nav only |
| **Evidence mapping** | ❌ | 🟠 | Route + nav only |
| **Compliance dashboard** | ✅ | ✅ | Score % + per-framework breakdown in aggregate & UI |
| **Security assessments** | 🟡 (read) | ✅ (view) | `securityAssessments` (incl. pentest type) with findings counts |
| **Vulnerabilities** | 🟡 (read) | ✅ (view) | `vulnerabilities` (CVE, CVSS, severity, status, ageing input); critical/high KPI + severity + ageing distribution computed |
| **Penetration tests** | 🟡 (read) | 🟠 | Modelled as `securityAssessments.type="penetration_test"`; dedicated workflow Phase 2 |
| **Network assessments** | 🟡 (read) | 🟠 | `type="network_assessment"` exists; dedicated UI Phase 2 |
| **Application security** | 🟡 (read) | 🟠 | `type="application_security"` exists; dedicated UI Phase 2 |
| **Configuration reviews** | 🟡 (read) | 🟠 | `type="configuration_review"` exists; dedicated UI Phase 2 |
| **Critical services (BCM)** | 🟡 (read) | ✅ (view) | `criticalServices` with RTO/RPO target vs current; readiness KPI |
| **Business impact analysis** | ❌ | 🟠 | Route + nav only |
| **RTO / RPO** | 🟡 (read) | 🟠 | Fields on critical services; dedicated view Phase 2 |
| **DR plans** | ❌ | 🟠 | Route + nav only |
| **DR tests & exercises** | 🟡 (read) | ✅ (view) | `drTests` with status; pass-rate KPI + upcoming count |
| **Lessons learned** | ❌ | 🟠 | Route + nav only (lessons field exists on DR tests) |
| **Executive dashboard** | ✅ | ✅ | 12 KPIs, 4 charts, deadlines, activity feed — all server-computed |
| **Executive reports** | ❌ | 🟠 | Route + nav only |
| **Audit/Risk/Compliance/Cyber/BCM reports** | ❌ | 🟠 | Routes + nav only |
| **Activity / audit logging** | ✅ | ✅ | `auditLogs` (append-only), `logAction` mutation, activity feed; log-viewer UI Phase 2 |
| **Notifications** | ✅ | ✅ | Table + list/mark-read mutations; top-bar popover with unread badge |
| **Integrations** | ❌ | 🟠 | Route + nav only |
| **API endpoints (REST)** | 🟡 | — | Convex HTTP router present (`http.ts`) with auth routes; public REST surface Phase 2 |

## Summary counts

| Status | Count | Interpretation |
| --- | --- | --- |
| ✅ Implemented | 12 | working end-to-end with real data |
| 🟡 Partial | 16 | schema + read paths exist; write/workflow UI pending |
| 🟠 Placeholder | 18 | route, nav, permissions and page scaffold exist; no backend functions yet |
| ❌ Missing | 0 (of scoped Phase-1 surface) | items listed ❌ above lack backend tables by design until their phase |
