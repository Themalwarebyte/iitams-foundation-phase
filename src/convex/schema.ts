import { authTables } from "@convex-dev/auth/server";
import { defineSchema, defineTable } from "convex/server";
import { Infer, v } from "convex/values";

// ============================================================================
// IDENTITY & ACCESS — roles (RBAC)
// ============================================================================
// default user roles. can add / remove based on the project as needed
export const ROLES = {
  ADMIN: "admin",
  USER: "user",
  MEMBER: "member",
} as const;

export const roleValidator = v.union(
  v.literal(ROLES.ADMIN),
  v.literal(ROLES.USER),
  v.literal(ROLES.MEMBER),
);
export type Role = Infer<typeof roleValidator>;

// ============================================================================
// SHARED DOMAIN ENUMERATIONS (validators reused across tables)
// ============================================================================

export const SEVERITIES = ["critical", "high", "medium", "low", "informational"] as const;
export const severityValidator = v.union(
  ...SEVERITIES.map((s) => v.literal(s)),
);
export type Severity = Infer<typeof severityValidator>;

export const CLASSIFICATIONS = ["public", "internal", "confidential", "restricted"] as const;
export const classificationValidator = v.union(
  ...CLASSIFICATIONS.map((c) => v.literal(c)),
);
export type DataClassification = Infer<typeof classificationValidator>;

export const auditEngagementStatusValidator = v.union(
  v.literal("planned"),
  v.literal("in_progress"),
  v.literal("fieldwork"),
  v.literal("reporting"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const findingStatusValidator = v.union(
  v.literal("open"),
  v.literal("in_remediation"),
  v.literal("resolved"),
  v.literal("risk_accepted"),
  v.literal("closed"),
);

export const riskStatusValidator = v.union(
  v.literal("open"),
  v.literal("assessing"),
  v.literal("mitigating"),
  v.literal("treated"),
  v.literal("accepted"),
  v.literal("closed"),
);

export const controlEffectivenessValidator = v.union(
  v.literal("effective"),
  v.literal("partially_effective"),
  v.literal("ineffective"),
  v.literal("not_tested"),
);

export const vulnerabilityStatusValidator = v.union(
  v.literal("open"),
  v.literal("confirmed"),
  v.literal("remediated"),
  v.literal("risk_accepted"),
  v.literal("false_positive"),
);

export const drTestStatusValidator = v.union(
  v.literal("planned"),
  v.literal("completed"),
  v.literal("failed"),
  v.literal("deferred"),
);

export const notificationSeverityValidator = v.union(
  v.literal("info"),
  v.literal("success"),
  v.literal("warning"),
  v.literal("critical"),
);

// Common bookkeeping timestamps. Each domain table declares its own
// organizationId (the multi-tenant boundary) explicitly.
const auditFields = {
  createdAt: v.number(),
  updatedAt: v.number(),
};

const schema = defineSchema(
  {
    // default auth tables using convex auth.
    ...authTables, // do not remove or modify

    // the users table is the default users table that is brought in by the authTables
    users: defineTable({
      name: v.optional(v.string()), // name of the user. do not remove
      image: v.optional(v.string()), // image of the user. do not remove
      email: v.optional(v.string()), // email of the user. do not remove
      emailVerificationTime: v.optional(v.number()), // email verification time. do not remove
      isAnonymous: v.optional(v.boolean()), // is the user anonymous. do not remove

      role: v.optional(roleValidator), // role of the user. do not remove
    }).index("email", ["email"]), // index for the email. do not remove or modify

    // ------------------------------------------------------------------
    // ORGANIZATION MANAGEMENT — Ministries, Departments, Agencies & Counties
    // ------------------------------------------------------------------
    organizations: defineTable({
      name: v.string(),
      code: v.string(), // e.g. "MICDE", "KRA", "Nairobi County"
      type: v.union(
        v.literal("ministry"),
        v.literal("department"),
        v.literal("agency"),
        v.literal("county"),
        v.literal("state_corporation"),
      ),
      description: v.optional(v.string()),
      isDemo: v.optional(v.boolean()),
      createdAt: v.number(),
      updatedAt: v.number(),
    }).index("code", ["code"]),

    // Profile extension for the auth user (separate from auth-owned fields).
    // Presence of a profile row with an explicit organizationId marks the user
    // as provisioned; organization access requires it (no fallbacks).
    userProfiles: defineTable({
      userId: v.id("users"),
      organizationId: v.optional(v.id("organizations")),
      // Explicit validated role — never inferred from permission strings.
      role: v.optional(roleValidator),
      jobTitle: v.optional(v.string()),
      department: v.optional(v.string()),
      phone: v.optional(v.string()),
      // Deliberate permission overrides (grants), separate from role
      // assignment. Evaluated explicitly where a feature requires it.
      permissionOverrides: v.optional(v.array(v.string())),
      lastSeenAt: v.optional(v.number()),
    }).index("userId", ["userId"]),

    // ------------------------------------------------------------------
    // AUDIT MANAGEMENT
    // ------------------------------------------------------------------
    auditUniverseItems: defineTable({
      organizationId: v.id("organizations"),
      code: v.string(),
      name: v.string(),
      domain: v.string(), // e.g. "Infrastructure", "Applications", "Data"
      inherentRisk: severityValidator,
      lastAuditedAt: v.optional(v.number()),
      nextAuditDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    auditPlans: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      fiscalYear: v.string(),
      status: v.union(
        v.literal("draft"),
        v.literal("approved"),
        v.literal("in_execution"),
        v.literal("closed"),
      ),
      totalEngagements: v.number(),
      completedEngagements: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    auditEngagements: defineTable({
      organizationId: v.id("organizations"),
      code: v.string(),
      name: v.string(),
      planId: v.optional(v.id("auditPlans")),
      universeItemId: v.optional(v.id("auditUniverseItems")),
      status: auditEngagementStatusValidator,
      leadAuditorId: v.optional(v.id("users")),
      startDate: v.optional(v.number()),
      targetEndDate: v.optional(v.number()),
      progressPct: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    findings: defineTable({
      organizationId: v.id("organizations"),
      engagementId: v.optional(v.id("auditEngagements")),
      code: v.string(),
      title: v.string(),
      description: v.optional(v.string()),
      severity: severityValidator,
      status: findingStatusValidator,
      ownerName: v.optional(v.string()),
      dueDate: v.optional(v.number()),
      isOverdue: v.optional(v.boolean()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"])
      .index("by_severity", ["organizationId", "severity"]),

    correctiveActions: defineTable({
      organizationId: v.id("organizations"),
      findingId: v.optional(v.id("findings")),
      title: v.string(),
      status: v.union(
        v.literal("not_started"),
        v.literal("in_progress"),
        v.literal("implemented"),
        v.literal("verified"),
        v.literal("overdue"),
      ),
      ownerName: v.optional(v.string()),
      dueDate: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    // ------------------------------------------------------------------
    // ICT RISK MANAGEMENT
    // ------------------------------------------------------------------
    risks: defineTable({
      organizationId: v.id("organizations"),
      code: v.string(),
      title: v.string(),
      category: v.string(), // e.g. "Cyber", "Infrastructure", "Data", "Third-party"
      inherentLikelihood: v.number(), // 1-5
      inherentImpact: v.number(), // 1-5
      residualLikelihood: v.number(),
      residualImpact: v.number(),
      status: riskStatusValidator,
      ownerName: v.optional(v.string()),
      reviewDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    // ------------------------------------------------------------------
    // COMPLIANCE MANAGEMENT
    // ------------------------------------------------------------------
    complianceFrameworks: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(), // ISO 27001, NIST CSF, Data Protection Act 2019...
      code: v.string(),
      totalControls: v.number(),
      implementedControls: v.number(),
      complianceScorePct: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    controls: defineTable({
      organizationId: v.id("organizations"),
      frameworkId: v.optional(v.id("complianceFrameworks")),
      code: v.string(),
      name: v.string(),
      effectiveness: controlEffectivenessValidator,
      lastTestedAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_effectiveness", ["organizationId", "effectiveness"]),

    // ------------------------------------------------------------------
    // CYBERSECURITY ASSURANCE & VULNERABILITY MANAGEMENT
    // ------------------------------------------------------------------
    vulnerabilities: defineTable({
      organizationId: v.id("organizations"),
      cveId: v.optional(v.string()),
      assetName: v.string(),
      title: v.string(),
      severity: severityValidator,
      cvssScore: v.optional(v.number()),
      status: vulnerabilityStatusValidator,
      discoveredAt: v.number(),
      remediationDue: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_severity", ["organizationId", "severity"])
      .index("by_status", ["organizationId", "status"]),

    securityAssessments: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      type: v.union(
        v.literal("penetration_test"),
        v.literal("network_assessment"),
        v.literal("application_security"),
        v.literal("configuration_review"),
        v.literal("red_team"),
      ),
      status: v.union(
        v.literal("scheduled"),
        v.literal("in_progress"),
        v.literal("completed"),
      ),
      startedAt: v.optional(v.number()),
      completedAt: v.optional(v.number()),
      criticalFindings: v.number(),
      highFindings: v.number(),
      mediumFindings: v.number(),
      lowFindings: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_type", ["organizationId", "type"]),

    // ------------------------------------------------------------------
    // BUSINESS CONTINUITY / DISASTER RECOVERY
    // ------------------------------------------------------------------
    criticalServices: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      rtoHours: v.number(),
      rpoHours: v.number(),
      currentRtoHours: v.optional(v.number()),
      currentRpoHours: v.optional(v.number()),
      readinessScorePct: v.number(),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    drTests: defineTable({
      organizationId: v.id("organizations"),
      name: v.string(),
      scope: v.string(),
      scheduledFor: v.number(),
      status: drTestStatusValidator,
      lessonsLearned: v.optional(v.string()),
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    })
      .index("by_organization", ["organizationId"])
      .index("by_status", ["organizationId", "status"]),

    // ------------------------------------------------------------------
    // REPORTING & ANALYTICS — pre-aggregated time series
    // ------------------------------------------------------------------
    riskTrendSnapshots: defineTable({
      organizationId: v.id("organizations"),
      periodLabel: v.string(), // e.g. "2025-Q3"
      periodStart: v.number(),
      openRisks: v.number(),
      criticalHighRisks: v.number(),
      avgResidualScore: v.number(), // 1-25
      isDemo: v.optional(v.boolean()),
      ...auditFields,
    }).index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // NOTIFICATIONS
    // ------------------------------------------------------------------
    notifications: defineTable({
      organizationId: v.optional(v.id("organizations")),
      userId: v.optional(v.id("users")),
      title: v.string(),
      body: v.optional(v.string()),
      severity: notificationSeverityValidator,
      href: v.optional(v.string()),
      readAt: v.optional(v.number()),
      isDemo: v.optional(v.boolean()),
      createdAt: v.number(),
    })
      .index("by_user", ["userId"])
      .index("by_organization", ["organizationId"]),

    // ------------------------------------------------------------------
    // AUDIT LOGGING — immutable trail of significant actions
    // ------------------------------------------------------------------
    auditLogs: defineTable({
      organizationId: v.optional(v.id("organizations")),
      userId: v.optional(v.id("users")),
      actorLabel: v.optional(v.string()),
      action: v.string(), // e.g. "engagement.created"
      entityType: v.string(),
      entityId: v.optional(v.string()),
      summary: v.optional(v.string()),
      createdAt: v.number(),
    }).index("by_organization", ["organizationId"]),
  },
  {
    // Production behaviour: documents are validated against this schema on
    // every write. Demo seed data satisfies these validators.
    schemaValidation: true,
  },
);

export default schema;
