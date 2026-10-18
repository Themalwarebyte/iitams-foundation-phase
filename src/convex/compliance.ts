import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { logAudit, requirePermission } from "./auditAccess";
import { effectiveMembershipStatus } from "../lib/membership";
import {
  COMPLIANCE_AUTHORITY_MAX,
  COMPLIANCE_CONTROL_IDENTIFIER_MAX,
  COMPLIANCE_CONTROL_TITLE_MAX,
  COMPLIANCE_IDENTIFIER_MAX,
  COMPLIANCE_NAME_MAX,
  COMPLIANCE_OWNER_MAX,
  COMPLIANCE_SOURCE_REFERENCE_MAX,
  COMPLIANCE_TEXT_MAX,
  COMPLIANCE_VERSION_MAX,
  CONTROL_APPLICABILITY_LABELS,
  CONTROL_DOMAIN_LABELS,
  CONTROL_IMPLEMENTATION_STATUS_LABELS,
  COMPLIANCE_FRAMEWORK_STATUS_LABELS,
  complianceFrameworkStatusValidator,
  controlApplicabilityValidator,
  controlDomainValidator,
  controlImplementationStatusValidator,
  isValidControlIdentifier,
  isValidFrameworkIdentifier,
  normalizeComplianceName,
  normalizeControlIdentifier,
  normalizeFrameworkIdentifier,
} from "../lib/compliance";

/**
 * Phase 3C — Batch 1: compliance framework catalogue and control register.
 * ======================================================================
 * Built ON the existing Phase-1 compliance tables (`complianceFrameworks`,
 * `controls`) — no parallel schema, no second permission system:
 *
 *   - Reads require `compliance.view`; writes require `compliance.manage` plus
 *     an ACTIVE membership (enforced server-side, plus the registry already
 *     defines both permissions).
 *   - The organization always comes from the caller's resolved access context;
 *     no query or mutation accepts an organization argument, and every
 *     id-addressed record is re-checked against that organization, so a
 *     foreign id is indistinguishable from a missing one.
 *   - Identifier rules live in src/lib/compliance.ts: a framework identifier is
 *     unique per organization and a control identifier is unique within its
 *     framework (and per organization when unlinked).
 *   - Every write appends one immutable audit entry naming actor, organization,
 *     entity and (for controls) the framework it belongs to.
 *   - No score, percentage, test result or evidence mapping is produced here:
 *     `effectiveness` stays `not_tested`, and implementation status is reported
 *     from the stored control rows.
 */

const FRAMEWORK_LIST_LIMIT = 500;
const CONTROL_SCAN_LIMIT = 500;
const CONTROL_PAGE_DEFAULT = 25;
const CONTROL_PAGE_MAX = 100;
const FRAMEWORK_CONTROL_SCAN = 500;
const OWNER_LIST_LIMIT = 200;

interface ComplianceAccess {
  organizationId: Id<"organizations">;
  userId: Id<"users">;
  label: string;
}

async function requireViewer(
  ctx: QueryCtx | MutationCtx,
): Promise<ComplianceAccess> {
  const access = await requirePermission(ctx, "compliance.view");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  };
}

async function requireManager(
  ctx: MutationCtx,
): Promise<ComplianceAccess> {
  const access = await requirePermission(ctx, "compliance.manage");
  if (!access.organizationId || !access.user) {
    throw new Error("No organization context");
  }
  if (!access.isProvisioned) {
    throw new Error("Caller membership is not active");
  }
  return {
    organizationId: access.organizationId,
    userId: access.user._id,
    label: access.user.name ?? access.user.email ?? "User",
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function requireText(value: string, field: string, max: number): string {
  const cleaned = normalizeComplianceName(value);
  if (!cleaned) throw new Error(`${field} is required`);
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalText(
  value: string | undefined,
  field: string,
  max: number,
): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.trim();
  if (!cleaned) return undefined;
  if (cleaned.length > max) {
    throw new Error(`${field} must be at most ${max} characters`);
  }
  return cleaned;
}

function optionalDate(value: number | undefined, field: string) {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) {
    throw new Error(`${field} must be a valid date`);
  }
  return Math.floor(value);
}

function frameworkStatusLabel(status: Doc<"complianceFrameworks">["status"]) {
  return status ? COMPLIANCE_FRAMEWORK_STATUS_LABELS[status] : "Active";
}

/** Count the controls linked to one framework, with their implementation mix. */
async function controlCounts(
  ctx: QueryCtx | MutationCtx,
  organizationId: Id<"organizations">,
  frameworkId: Id<"complianceFrameworks">,
) {
  const rows = await ctx.db
    .query("controls")
    .withIndex("by_organization_framework", (q) =>
      q.eq("organizationId", organizationId).eq("frameworkId", frameworkId),
    )
    .take(FRAMEWORK_CONTROL_SCAN);
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    const key = row.implementationStatus ?? "not_implemented";
    byStatus[key] = (byStatus[key] ?? 0) + 1;
  }
  return {
    controls: rows.length,
    implemented: byStatus.implemented ?? 0,
    inProgress: byStatus.in_progress ?? 0,
    notImplemented: byStatus.not_implemented ?? 0,
    notApplicable: byStatus.not_applicable ?? 0,
    planned: byStatus.planned ?? 0,
    /** True when the framework has more controls than a single page summarises. */
    truncated: rows.length >= FRAMEWORK_CONTROL_SCAN,
  };
}

function presentFramework(
  framework: Doc<"complianceFrameworks">,
  counts: Awaited<ReturnType<typeof controlCounts>>,
) {
  return {
    _id: framework._id,
    name: framework.name,
    code: framework.code,
    version: framework.version ?? null,
    issuingAuthority: framework.issuingAuthority ?? null,
    description: framework.description ?? null,
    scope: framework.scope ?? null,
    effectiveDate: framework.effectiveDate ?? null,
    status: framework.status ?? "active",
    statusLabel: frameworkStatusLabel(framework.status),
    createdByLabel: framework.createdByLabel ?? null,
    createdAt: framework.createdAt,
    updatedAt: framework.updatedAt,
    counts,
    // Phase-1 demo aggregates are surfaced ONLY when they exist on the row, so
    // legacy demo data is never presented as a current compliance score.
    legacyDemoScorePct: framework.complianceScorePct ?? null,
  };
}

function presentControl(control: Doc<"controls">) {
  return {
    _id: control._id,
    code: control.code,
    title: control.name,
    description: control.description ?? null,
    domain: control.domain ?? null,
    domainLabel: control.domain ? CONTROL_DOMAIN_LABELS[control.domain] : null,
    objective: control.objective ?? null,
    sourceReference: control.sourceReference ?? null,
    applicability: control.applicability ?? null,
    applicabilityLabel: control.applicability
      ? CONTROL_APPLICABILITY_LABELS[control.applicability]
      : null,
    implementationStatus: control.implementationStatus ?? "not_implemented",
    implementationStatusLabel:
      CONTROL_IMPLEMENTATION_STATUS_LABELS[
        control.implementationStatus ?? "not_implemented"
      ],
    ownerUserId: control.ownerUserId ?? null,
    ownerName: control.ownerName ?? null,
    // Testing is a later batch: an untested control always reports `not_tested`.
    effectiveness: control.effectiveness,
    lastTestedAt: control.lastTestedAt ?? null,
    frameworkId: control.frameworkId ?? null,
    createdByLabel: control.createdByLabel ?? null,
    createdAt: control.createdAt,
    updatedAt: control.updatedAt,
  };
}

/** Active members of the caller's organization (owner picker). */
export const controlOwners = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await requireViewer(ctx);
    const profiles = await ctx.db
      .query("userProfiles")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(OWNER_LIST_LIMIT);
    const owners = [];
    for (const profile of profiles) {
      if (effectiveMembershipStatus(profile.membershipStatus) !== "active") {
        continue;
      }
      const user = await ctx.db.get(profile.userId);
      if (!user || user.isAnonymous === true) continue;
      owners.push({
        userId: profile.userId,
        label: user.name ?? user.email ?? "Member",
        email: user.email ?? null,
        role: profile.role,
      });
    }
    return owners.sort((a, b) => a.label.localeCompare(b.label));
  },
});

// ---------------------------------------------------------------------------
// Framework catalogue
// ---------------------------------------------------------------------------

/**
 * Organization-scoped framework directory. `search`/`status` narrow the current
 * page; the list is cursor-paginated over the organization index (newest
 * first), so no single execution reads an unbounded history.
 */
export const listFrameworks = query({
  args: {
    search: v.optional(v.string()),
    status: v.optional(complianceFrameworkStatusValidator),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const requested = args.numItems ?? CONTROL_PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(
        Number.isFinite(requested) ? Math.floor(requested) : CONTROL_PAGE_DEFAULT,
        1,
      ),
      CONTROL_PAGE_MAX,
    );

    const page = await ctx.db
      .query("complianceFrameworks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .order("desc")
      .paginate({ numItems, cursor: args.cursor ?? null });

    const search = args.search?.trim().toLowerCase();
    const rows = [];
    for (const framework of page.page) {
      if (args.status && (framework.status ?? "active") !== args.status) continue;
      if (search) {
        const haystack = [
          framework.name,
          framework.code,
          framework.version,
          framework.issuingAuthority,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      rows.push(
        presentFramework(
          framework,
          await controlCounts(ctx, viewer.organizationId, framework._id),
        ),
      );
    }

    const frameworks = await ctx.db
      .query("complianceFrameworks")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(FRAMEWORK_LIST_LIMIT);
    const byStatus: Record<string, number> = {};
    for (const framework of frameworks) {
      const key = framework.status ?? "active";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      summary: {
        total: frameworks.length,
        active: byStatus.active ?? 0,
        planned: byStatus.planned ?? 0,
        retired: byStatus.retired ?? 0,
      },
    };
  },
});

/** One framework with its control register; `null` for another organization. */
export const getFramework = query({
  args: { frameworkId: v.id("complianceFrameworks") },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const framework = await ctx.db.get(args.frameworkId);
    if (!framework || framework.organizationId !== viewer.organizationId) {
      return null;
    }
    const counts = await controlCounts(
      ctx,
      viewer.organizationId,
      framework._id,
    );
    const controls = await ctx.db
      .query("controls")
      .withIndex("by_organization_framework", (q) =>
        q
          .eq("organizationId", viewer.organizationId)
          .eq("frameworkId", framework._id),
      )
      .take(CONTROL_SCAN_LIMIT);
    return {
      ...presentFramework(framework, counts),
      controls: controls
        .map(presentControl)
        .sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true })),
      controlsTruncated: controls.length >= CONTROL_SCAN_LIMIT,
    };
  },
});

// ---------------------------------------------------------------------------
// Control register
// ---------------------------------------------------------------------------

/**
 * Cursor-paginated control register. Optionally narrowed to one framework, a
 * domain, an implementation status or a search term; the pagination cursor is
 * an index cursor over the organization's controls, so every control stays
 * reachable without an organization-wide document scan.
 */
export const listControls = query({
  args: {
    frameworkId: v.optional(v.id("complianceFrameworks")),
    domain: v.optional(controlDomainValidator),
    implementationStatus: v.optional(controlImplementationStatusValidator),
    search: v.optional(v.string()),
    cursor: v.optional(v.string()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const viewer = await requireViewer(ctx);
    const requested = args.numItems ?? CONTROL_PAGE_DEFAULT;
    const numItems = Math.min(
      Math.max(
        Number.isFinite(requested) ? Math.floor(requested) : CONTROL_PAGE_DEFAULT,
        1,
      ),
      CONTROL_PAGE_MAX,
    );

    // A foreign framework id must not disclose anything: re-check it first.
    let framework: Doc<"complianceFrameworks"> | null = null;
    if (args.frameworkId) {
      const candidate = await ctx.db.get(args.frameworkId);
      if (
        !candidate ||
        candidate.organizationId !== viewer.organizationId
      ) {
        return {
          rows: [],
          continueCursor: "",
          isDone: true,
          framework: null,
          summary: { total: 0, byStatus: {} },
        };
      }
      framework = candidate;
    }

    const page = args.frameworkId
      ? await ctx.db
          .query("controls")
          .withIndex("by_organization_framework", (q) =>
            q
              .eq("organizationId", viewer.organizationId)
              .eq("frameworkId", args.frameworkId as Id<"complianceFrameworks">),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null })
      : await ctx.db
          .query("controls")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", viewer.organizationId),
          )
          .order("desc")
          .paginate({ numItems, cursor: args.cursor ?? null });

    const search = args.search?.trim().toLowerCase();
    const rows = [];
    for (const control of page.page) {
      if (args.domain && control.domain !== args.domain) continue;
      if (
        args.implementationStatus &&
        (control.implementationStatus ?? "not_implemented") !==
          args.implementationStatus
      ) {
        continue;
      }
      if (search) {
        const haystack = [
          control.code,
          control.name,
          control.description,
          control.sourceReference,
          control.ownerName,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(search)) continue;
      }
      rows.push(presentControl(control));
    }

    const scanned = await ctx.db
      .query("controls")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", viewer.organizationId),
      )
      .take(CONTROL_SCAN_LIMIT);
    const byStatus: Record<string, number> = {};
    for (const control of scanned) {
      const key = control.implementationStatus ?? "not_implemented";
      byStatus[key] = (byStatus[key] ?? 0) + 1;
    }

    return {
      rows,
      continueCursor: page.continueCursor,
      isDone: page.isDone,
      framework: framework
        ? {
            _id: framework._id,
            code: framework.code,
            name: framework.name,
            status: framework.status ?? "active",
          }
        : null,
      summary: { total: scanned.length, byStatus },
    };
  },
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** Create an organization-scoped framework adoption record. */
export const createFramework = mutation({
  args: {
    name: v.string(),
    identifier: v.string(),
    version: v.optional(v.string()),
    issuingAuthority: v.optional(v.string()),
    description: v.optional(v.string()),
    scope: v.optional(v.string()),
    effectiveDate: v.optional(v.number()),
    status: v.optional(complianceFrameworkStatusValidator),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);

    const name = requireText(args.name, "Framework name", COMPLIANCE_NAME_MAX);
    const code = normalizeFrameworkIdentifier(args.identifier);
    if (code.length > COMPLIANCE_IDENTIFIER_MAX) {
      throw new Error(
        `Framework identifier must be at most ${COMPLIANCE_IDENTIFIER_MAX} characters`,
      );
    }
    if (!isValidFrameworkIdentifier(code)) {
      throw new Error(
        "Framework identifier must start with a letter or digit and may contain letters, digits, dots, dashes, slashes and underscores",
      );
    }
    const version = optionalText(
      args.version,
      "Version",
      COMPLIANCE_VERSION_MAX,
    );
    const issuingAuthority = optionalText(
      args.issuingAuthority,
      "Issuing authority",
      COMPLIANCE_AUTHORITY_MAX,
    );
    const description = optionalText(
      args.description,
      "Description",
      COMPLIANCE_TEXT_MAX,
    );
    const scope = optionalText(args.scope, "Scope", COMPLIANCE_TEXT_MAX);
    const effectiveDate = optionalDate(args.effectiveDate, "Effective date");
    const status = args.status ?? "active";

    // Identifier uniqueness within the organization (and only the caller's).
    const existing = await ctx.db
      .query("complianceFrameworks")
      .withIndex("by_organization_code", (q) =>
        q.eq("organizationId", manager.organizationId).eq("code", code),
      )
      .unique();
    if (existing) {
      throw new Error(
        `A framework with identifier ${code} already exists in your organization`,
      );
    }

    const now = Date.now();
    const frameworkId = await ctx.db.insert("complianceFrameworks", {
      organizationId: manager.organizationId,
      name,
      code,
      version,
      issuingAuthority,
      description,
      scope,
      effectiveDate,
      status,
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.framework_created",
      entityType: "complianceFrameworks",
      entityId: String(frameworkId),
      summary: `Framework ${code} (${name}) added to the organization's framework register with status ${COMPLIANCE_FRAMEWORK_STATUS_LABELS[status]}`,
    });
    return { frameworkId };
  },
});

/** Update a framework adoption record. */
export const updateFramework = mutation({
  args: {
    frameworkId: v.id("complianceFrameworks"),
    name: v.optional(v.string()),
    version: v.optional(v.string()),
    issuingAuthority: v.optional(v.string()),
    description: v.optional(v.string()),
    scope: v.optional(v.string()),
    effectiveDate: v.optional(v.number()),
    status: v.optional(complianceFrameworkStatusValidator),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const framework = await ctx.db.get(args.frameworkId);
    if (!framework || framework.organizationId !== manager.organizationId) {
      throw new Error("Framework not found in your organization");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.name !== undefined) {
      patch.name = requireText(args.name, "Framework name", COMPLIANCE_NAME_MAX);
    }
    if (args.version !== undefined) {
      patch.version = optionalText(args.version, "Version", COMPLIANCE_VERSION_MAX);
    }
    if (args.issuingAuthority !== undefined) {
      patch.issuingAuthority = optionalText(
        args.issuingAuthority,
        "Issuing authority",
        COMPLIANCE_AUTHORITY_MAX,
      );
    }
    if (args.description !== undefined) {
      patch.description = optionalText(
        args.description,
        "Description",
        COMPLIANCE_TEXT_MAX,
      );
    }
    if (args.scope !== undefined) {
      patch.scope = optionalText(args.scope, "Scope", COMPLIANCE_TEXT_MAX);
    }
    if (args.effectiveDate !== undefined) {
      patch.effectiveDate = optionalDate(args.effectiveDate, "Effective date");
    }
    if (args.status !== undefined) patch.status = args.status;

    await ctx.db.patch(framework._id, patch);
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.framework_updated",
      entityType: "complianceFrameworks",
      entityId: String(framework._id),
      summary: `Framework ${framework.code} updated (${Object.keys(patch)
        .filter((k) => k !== "updatedAt")
        .join(", ")})`,
    });
    return { ok: true as const };
  },
});

/** Add a control to one of the organization's frameworks. */
export const createControl = mutation({
  args: {
    frameworkId: v.id("complianceFrameworks"),
    identifier: v.string(),
    title: v.string(),
    description: v.optional(v.string()),
    domain: v.optional(controlDomainValidator),
    objective: v.optional(v.string()),
    sourceReference: v.optional(v.string()),
    applicability: v.optional(controlApplicabilityValidator),
    ownerUserId: v.optional(v.id("users")),
    ownerName: v.optional(v.string()),
    implementationStatus: v.optional(controlImplementationStatusValidator),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);

    // The framework must belong to the caller's organization; a foreign id
    // resolves exactly like a missing one.
    const framework = await ctx.db.get(args.frameworkId);
    if (!framework || framework.organizationId !== manager.organizationId) {
      throw new Error("Framework not found in your organization");
    }

    const code = normalizeControlIdentifier(args.identifier);
    if (code.length > COMPLIANCE_CONTROL_IDENTIFIER_MAX) {
      throw new Error(
        `Control identifier must be at most ${COMPLIANCE_CONTROL_IDENTIFIER_MAX} characters`,
      );
    }
    if (!isValidControlIdentifier(code)) {
      throw new Error(
        "Control identifier must start with a letter or digit and may contain letters, digits, dots, dashes, slashes and underscores",
      );
    }
    const title = requireText(args.title, "Control title", COMPLIANCE_CONTROL_TITLE_MAX);
    const description = optionalText(
      args.description,
      "Description",
      COMPLIANCE_TEXT_MAX,
    );
    const objective = optionalText(args.objective, "Objective", COMPLIANCE_TEXT_MAX);
    const sourceReference = optionalText(
      args.sourceReference,
      "Source reference",
      COMPLIANCE_SOURCE_REFERENCE_MAX,
    );
    const implementationStatus = args.implementationStatus ?? "not_implemented";

    // Uniqueness within (organization, framework).
    const duplicate = await ctx.db
      .query("controls")
      .withIndex("by_organization_framework_code", (q) =>
        q
          .eq("organizationId", manager.organizationId)
          .eq("frameworkId", framework._id)
          .eq("code", code),
      )
      .unique();
    if (duplicate) {
      throw new Error(
        `Control ${code} already exists in framework ${framework.code}`,
      );
    }

    // An owner is an ACTIVE member of the SAME organization, validated here
    // rather than trusted from the client; a free-text owner name is allowed
    // when no provisioned member is chosen.
    let ownerName = optionalText(args.ownerName, "Owner", COMPLIANCE_OWNER_MAX);
    if (args.ownerUserId !== undefined) {
      const ownerProfile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) => q.eq("userId", args.ownerUserId as Id<"users">))
        .unique();
      if (
        !ownerProfile ||
        ownerProfile.organizationId !== manager.organizationId ||
        effectiveMembershipStatus(ownerProfile.membershipStatus) !== "active"
      ) {
        throw new Error("Owner is not an active member of your organization");
      }
      const owner = await ctx.db.get(args.ownerUserId);
      ownerName = owner?.name ?? owner?.email ?? ownerName;
    }

    const now = Date.now();
    const controlId = await ctx.db.insert("controls", {
      organizationId: manager.organizationId,
      frameworkId: framework._id,
      code,
      name: title,
      description,
      domain: args.domain,
      objective,
      sourceReference,
      applicability: args.applicability ?? "applicable",
      ownerUserId: args.ownerUserId,
      ownerName,
      implementationStatus,
      // Not a test result: control testing does not exist yet.
      effectiveness: "not_tested",
      createdByUserId: manager.userId,
      createdByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_created",
      entityType: "controls",
      entityId: String(controlId),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: String(framework._id),
      summary: `Control ${code} (${title}) added to framework ${framework.code} as ${CONTROL_IMPLEMENTATION_STATUS_LABELS[implementationStatus]}`,
    });
    return { controlId };
  },
});

/** Update a control's descriptive or implementation fields. */
export const updateControl = mutation({
  args: {
    controlId: v.id("controls"),
    title: v.optional(v.string()),
    description: v.optional(v.string()),
    domain: v.optional(controlDomainValidator),
    objective: v.optional(v.string()),
    sourceReference: v.optional(v.string()),
    applicability: v.optional(controlApplicabilityValidator),
    ownerUserId: v.optional(v.id("users")),
    ownerName: v.optional(v.string()),
    implementationStatus: v.optional(controlImplementationStatusValidator),
  },
  handler: async (ctx, args) => {
    const manager = await requireManager(ctx);
    const control = await ctx.db.get(args.controlId);
    if (!control || control.organizationId !== manager.organizationId) {
      throw new Error("Control not found in your organization");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    if (args.title !== undefined) {
      patch.name = requireText(args.title, "Control title", COMPLIANCE_CONTROL_TITLE_MAX);
    }
    if (args.description !== undefined) {
      patch.description = optionalText(
        args.description,
        "Description",
        COMPLIANCE_TEXT_MAX,
      );
    }
    if (args.domain !== undefined) patch.domain = args.domain;
    if (args.objective !== undefined) {
      patch.objective = optionalText(args.objective, "Objective", COMPLIANCE_TEXT_MAX);
    }
    if (args.sourceReference !== undefined) {
      patch.sourceReference = optionalText(
        args.sourceReference,
        "Source reference",
        COMPLIANCE_SOURCE_REFERENCE_MAX,
      );
    }
    if (args.applicability !== undefined) patch.applicability = args.applicability;
    if (args.implementationStatus !== undefined) {
      patch.implementationStatus = args.implementationStatus;
    }
    if (args.ownerUserId !== undefined) {
      const ownerProfile = await ctx.db
        .query("userProfiles")
        .withIndex("userId", (q) =>
          q.eq("userId", args.ownerUserId as Id<"users">),
        )
        .unique();
      if (
        !ownerProfile ||
        ownerProfile.organizationId !== manager.organizationId ||
        effectiveMembershipStatus(ownerProfile.membershipStatus) !== "active"
      ) {
        throw new Error("Owner is not an active member of your organization");
      }
      const owner = await ctx.db.get(args.ownerUserId);
      patch.ownerUserId = args.ownerUserId;
      patch.ownerName = owner?.name ?? owner?.email ?? undefined;
    } else if (args.ownerName !== undefined) {
      patch.ownerUserId = undefined;
      patch.ownerName = optionalText(
        args.ownerName,
        "Owner",
        COMPLIANCE_OWNER_MAX,
      );
    }

    await ctx.db.patch(control._id, patch);
    await logAudit(ctx, {
      organizationId: manager.organizationId,
      userId: manager.userId,
      actorId: manager.userId,
      actorLabel: manager.label,
      action: "compliance.control_updated",
      entityType: "controls",
      entityId: String(control._id),
      relatedEntityType: "complianceFrameworks",
      relatedEntityId: control.frameworkId ? String(control.frameworkId) : undefined,
      summary: `Control ${control.code} updated (${Object.keys(patch)
        .filter((k) => k !== "updatedAt")
        .join(", ")})`,
    });
    return { ok: true as const };
  },
});
