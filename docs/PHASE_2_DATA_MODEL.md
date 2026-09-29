# IITAMS Phase 2 Data Model

> Convex schema changes for the Core IT Audit Management Engine. Schema
> validation remains enabled (`schemaValidation: true`); every Phase-2 field
> added to existing tables is optional, so Phase-1 rows (including demo
> seed data) stay valid without migration.

## New tables (6)

### `auditPlanItems` — Module 2
| Field | Type | Notes |
|---|---|---|
| `organizationId` | `id<organizations>` | tenant boundary |
| `auditPlanId` | `id<auditPlans>` | parent plan |
| `auditUniverseItemId` | `id<auditUniverseItems>` | scheduled item |
| `priorityScore` | `number` | 0–100, **computed server-side** |
| `priorityBand` | `"low"\|"medium"\|"high"\|"critical"` | computed |
| `scoringInputs` | `{criticality,dataSensitivity,regulatoryImpact,securityExposure,previousFindings,changeFrequency}` (numbers) | snapshot at scheduling |
| `plannedStartDate` / `plannedEndDate` | optional `number` | |
| `estimatedEffortDays` | optional `number` | |
| `assignedManagerId` / `assignedManagerName` | optional | |
| `status` | `planned\|scheduled\|in_progress\|completed\|deferred\|cancelled` | |

Indexes: `by_plan(auditPlanId)`, `by_organization(organizationId)`, `by_universe_item(auditUniverseItemId)`.

### `auditAssignments` — Module 4
`organizationId`, `engagementId`, `userId`, `teamRole`
(`audit_director|audit_manager|lead_auditor|auditor|reviewer`),
`assignedById`, bookkeeping. Uniqueness of (engagement,user) enforced at the
mutation layer (re-assignment updates the role).
Indexes: `by_engagement`, `by_user`, `by_organization`.

### `auditPrograms` — Module 5
`organizationId`, `engagementId`, `code` (`AP-###`), `title`, `objective`,
`status` (`draft|approved|completed`), `createdById`.
Indexes: `by_engagement`, `by_organization`.

### `auditProcedures` — Module 5
`organizationId`, `auditProgramId`, `engagementId`, `code` (`AP-001.01`),
`procedureName`, `description`, `controlObjective`, `expectedEvidence`,
`assignedAuditorId`, `completionStatus`
(`not_started|in_progress|completed`), `result`
(`pass|fail|exception`), `resultNotes`, `completedAt`.
Indexes: `by_program`, `by_engagement`, `by_organization`, `by_assigned_auditor`.

### `workingPapers` — Module 6
`organizationId`, `engagementId`, `code` (`WP-###`), `title`, `description`,
`content` (auditor notes/test results), `createdById`, `reviewerId`,
`status` (`draft|submitted|reviewed|returned|approved`), `reviewComments`,
`submittedAt`, `reviewedAt`, `approvedAt`.
Indexes: `by_engagement`, `by_reviewer`, `by_organization`, `by_status(org,status)`.

### `workingPaperComments` — Module 6
`organizationId`, `workingPaperId`, `authorId`, `authorName`, `body`,
`createdAt`. Index: `by_paper(workingPaperId)`.

### `evidence` — Module 7
`organizationId`, `engagementId?`, `workingPaperId?`, `filename`, `fileType`
(MIME), `sizeBytes`, `classification`
(`public|internal|confidential|restricted`), `sha256` (server-computed),
`storageId` (`id<_storage>`), `source`, `description`, `collectedAt`,
`uploadedById`, `status`
(`collected|stored|reviewed|referenced|archived`).
Indexes: `by_organization`, `by_engagement`, `by_paper`, `by_sha`.

## Extended tables (5)

### `auditUniverseItems` — Module 1
Added: `description`, `category` (10 spec categories), `owner`,
`businessUnit`, `technologyType`, `criticality` (5-level), `businessImpact`,
`dataClassification`, `regulatoryImportance` (5-level), `securityExposure`
(5-level), `status` (`active|inactive|archived`), `createdById`.
New indexes: `by_status(org,status)`, `by_category(org,category)`.
Phase-1 fields (`code`, `domain`, `inherentRisk`, `lastAuditedAt`,
`nextAuditDue`) retained; `domain` mirrors `category` for compatibility.

### `auditPlans` — Module 2
Added: `period`, `coverageObjective`, `description`, `approvedById`,
`approvedByName`, `approvalDate`, `createdById`.

### `auditEngagements` — Modules 3–4
Added: `objective`, `scope`, `criteria`, `auditManagerId`,
`auditManagerName`, `endDate`, `createdById`.
Status validator extended with the seven lifecycle stages (Phase-1 values
retained for seeded rows). New indexes: `by_plan(planId)`,
`by_universe_item(universeItemId)`.

### `findings` — Modules 8–9
Added: `condition`, `criteria`, `rootCause`, `impact`, `recommendation`,
`riskRating` (1–25), `managementResponse`, `createdById`.
Status validator extended with the six lifecycle stages. New index:
`by_engagement(engagementId)`.

### `correctiveActions` — Module 9
Added: `description`, `responsiblePerson`, `responsiblePersonId`,
`completionEvidence`, `verifiedById`, `verifiedByName`, `verifiedAt`,
`lastReminderAt`. Status validator extended with
`open|completed|closed` (Phase-1 `not_started|implemented|verified|overdue`
retained).

## Extended validators & registry

- `roleValidator` / `IITAMS_ROLES` now include
  `audit_director`, `audit_manager`, `auditor`, `audit_reviewer`,
  `management_user`, `executive_viewer` (all optional on profiles).
- New shared validators: `universeCategoryValidator`,
  `criticalityLevelValidator`, `universeItemStatusValidator`,
  `planItemStatusValidator`, `priorityBandValidator`,
  `auditTeamRoleValidator`, `programStatusValidator`,
  `procedureStatusValidator`, `procedureResultValidator`,
  `workingPaperStatusValidator`, `evidenceStatusValidator`,
  extended `correctiveActionStatusValidator`.

## Tenancy & integrity rules

1. Every tenant table carries `organizationId` (non-optional on all new
   tables); indexes are org-prefixed so isolation is index-enforced.
2. Parent references are validated same-organization at the mutation layer
   (plan→org, item→org, engagement→org, procedure→program→engagement,
   evidence→engagement/workpaper, assignment→user profile org).
3. `auditLogs` remains **insert-only**; every Phase-2 mutation writes an
   entry via `logAudit` (create/update/transition/assign/verify/upload/
   download/reminder/integrity).
4. `evidence.sha256` is written only by the internal stamp mutation after
   server-side hashing; the public insert path stores `""`.
5. `userProfiles` gained index `by_organization(organizationId)` to support
   org-scoped user directories without scanning other tenants.

## Counts

- Tables: **24 → 30** (6 new domain tables; `evidenceBlobs` placeholder from
  the first draft was dropped before deployment).
- New indexes: 18 across the new/extended tables.
- Migration: none required — all extensions optional; demo seed data
  validates unchanged.
