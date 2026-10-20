import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import type { MutationCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import {
  CYBER_EVIDENCE_DESCRIPTION_MAX,
  CYBER_EVIDENCE_FILENAME_MAX,
  CYBER_EVIDENCE_MAX_BYTES,
  CYBER_EVIDENCE_TYPES,
  cyberEvidenceClassificationValidator,
  mayReadRestrictedCyberEvidence,
} from "../lib/cyber";
import {
  appendCyberEvent,
  logCyberAudit,
  optionalText,
  presentCyberEvidence,
  requireCyberManager,
  requireOwnedAssessment,
  requireOwnedVulnerability,
  requireText,
  resolveCyberAccess,
} from "./cyberCore";

/**
 * Cybersecurity evidence (Phase 4A — Batch 1)
 * ===========================================
 * Vulnerability evidence is its own record type. The audit `evidence` table is
 * engagement/working-paper shaped (`audit.manage`) and the compliance evidence
 * table is control-shaped (`compliance.manage`); reusing either would leak
 * cybersecurity documents into another module's views and import its lifecycle.
 * Storage, the server-side SHA-256 integrity pattern and the classification
 * gate are reused from `auditEvidence.ts` / `complianceTesting.ts` — there is
 * no parallel file-store design.
 *
 *  - Writes require `cyber.manage` and an active membership.
 *  - The record is always scoped to this organization and to a vulnerability
 *    and/or an assessment re-validated against it.
 *  - `sizeBytes`/`fileType` are re-validated server-side; the browser's
 *    pre-upload checks are convenience only.
 *  - Hashing runs in a scheduled action because mutations cannot read bytes.
 *  - Downloading restricted evidence requires `cyber.manage`, and every
 *    issuance is audited.
 */

const EVIDENCE_LIST_LIMIT = 200;

async function requireEvidenceSubjects(
  ctx: MutationCtx,
  manager: { organizationId: Id<"organizations"> },
  args: {
    vulnerabilityId?: Id<"vulnerabilities">;
    assessmentId?: Id<"securityAssessments">;
  },
) {
  if (!args.vulnerabilityId && !args.assessmentId) {
    throw new Error("Evidence must be linked to a vulnerability or an assessment");
  }
  if (args.vulnerabilityId) {
    await requireOwnedVulnerability(
      ctx,
      manager.organizationId,
      args.vulnerabilityId,
    );
  }
  if (args.assessmentId) {
    await requireOwnedAssessment(
      ctx,
      manager.organizationId,
      args.assessmentId,
    );
  }
}

/** One-time upload URL for cybersecurity evidence (cyber.manage only). */
export const generateEvidenceUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireCyberManager(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/** Finalize an upload: validates the declaration and schedules hashing. */
export const confirmEvidenceUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    vulnerabilityId: v.optional(v.id("vulnerabilities")),
    assessmentId: v.optional(v.id("securityAssessments")),
    filename: v.string(),
    fileType: v.string(),
    sizeBytes: v.number(),
    classification: cyberEvidenceClassificationValidator,
    description: v.optional(v.string()),
    source: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const manager = await requireCyberManager(ctx);
    await requireEvidenceSubjects(ctx, manager, args);

    const filename = requireText(
      args.filename,
      "File name",
      CYBER_EVIDENCE_FILENAME_MAX,
    );
    if (!(CYBER_EVIDENCE_TYPES as readonly string[]).includes(args.fileType)) {
      throw new Error(`Unsupported file type: ${args.fileType}`);
    }
    if (
      !Number.isFinite(args.sizeBytes) ||
      args.sizeBytes <= 0 ||
      args.sizeBytes > CYBER_EVIDENCE_MAX_BYTES
    ) {
      throw new Error("File size must be between 1 byte and 10 MB");
    }

    const now = Date.now();
    const evidenceId = await ctx.db.insert("cyberEvidence", {
      organizationId: manager.organizationId,
      vulnerabilityId: args.vulnerabilityId,
      assessmentId: args.assessmentId,
      filename,
      fileType: args.fileType,
      sizeBytes: Math.floor(args.sizeBytes),
      classification: args.classification,
      description: optionalText(
        args.description,
        "Description",
        CYBER_EVIDENCE_DESCRIPTION_MAX,
      ),
      source: optionalText(args.source, "Source", 200),
      sha256: "",
      integrity: "pending",
      storageId: args.storageId,
      uploadedById: manager.userId,
      uploadedByLabel: manager.label,
      createdAt: now,
      updatedAt: now,
    });

    await ctx.scheduler.runAfter(
      0,
      internal.cyberEvidence.computeEvidenceHash,
      { evidenceId, storageId: args.storageId },
    );

    await appendCyberEvent(ctx, {
      organizationId: manager.organizationId,
      vulnerabilityId: args.vulnerabilityId,
      assessmentId: args.assessmentId,
      type: "evidence_recorded",
      actorUserId: manager.userId,
      actorLabel: manager.label,
      summary: `Evidence ${filename} (${args.classification}) recorded; server-side integrity hash scheduled`,
    });
    await logCyberAudit(ctx, manager, {
      action: "cyber.evidence_uploaded",
      entityType: "cyberEvidence",
      entityId: String(evidenceId),
      relatedEntityType: args.vulnerabilityId
        ? "vulnerabilities"
        : "securityAssessments",
      relatedEntityId: String(args.vulnerabilityId ?? args.assessmentId),
      summary: `Evidence ${filename} (${args.classification}) recorded`,
    });
    return { evidenceId, integrity: "pending" as const };
  },
});

/** INTERNAL — compute the SHA-256 of a stored blob and stamp the record. */
export const computeEvidenceHash = internalAction({
  args: {
    evidenceId: v.id("cyberEvidence"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      await ctx.runMutation(internal.cyberEvidence.recordEvidenceIntegrity, {
        evidenceId: args.evidenceId,
        sha256: "",
        integrity: "blob_missing",
      });
      return { integrity: "blob_missing" as const };
    }
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await ctx.runMutation(internal.cyberEvidence.recordEvidenceIntegrity, {
      evidenceId: args.evidenceId,
      sha256,
      integrity: "intact",
    });
    return { integrity: "intact" as const, sha256 };
  },
});

/** INTERNAL — persist an integrity verdict. */
export const recordEvidenceIntegrity = internalMutation({
  args: {
    evidenceId: v.id("cyberEvidence"),
    sha256: v.string(),
    integrity: v.union(
      v.literal("pending"),
      v.literal("intact"),
      v.literal("hash_mismatch"),
      v.literal("blob_missing"),
    ),
  },
  handler: async (ctx, args) => {
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence) return { ok: false as const };
    const now = Date.now();
    await ctx.db.patch(evidence._id, {
      sha256: args.sha256,
      integrity: args.integrity,
      integrityCheckedAt: now,
      updatedAt: now,
    });
    return { ok: true as const };
  },
});

/** Evidence for one vulnerability or one assessment (org-scoped). */
export const listEvidence = query({
  args: {
    vulnerabilityId: v.optional(v.id("vulnerabilities")),
    assessmentId: v.optional(v.id("securityAssessments")),
  },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    if (!args.vulnerabilityId && !args.assessmentId) {
      throw new Error("Specify a vulnerability or an assessment to list evidence for");
    }
    if (args.vulnerabilityId) {
      await requireOwnedVulnerability(
        ctx,
        access.organizationId,
        args.vulnerabilityId,
      );
    }
    if (args.assessmentId) {
      await requireOwnedAssessment(
        ctx,
        access.organizationId,
        args.assessmentId,
      );
    }
    const rows = args.vulnerabilityId
      ? await ctx.db
          .query("cyberEvidence")
          .withIndex("by_organization_vulnerability", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("vulnerabilityId", args.vulnerabilityId),
          )
          .take(EVIDENCE_LIST_LIMIT)
      : await ctx.db
          .query("cyberEvidence")
          .withIndex("by_organization_assessment", (q) =>
            q
              .eq("organizationId", access.organizationId)
              .eq("assessmentId", args.assessmentId),
          )
          .take(EVIDENCE_LIST_LIMIT);
    return rows
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(presentCyberEvidence);
  },
});

/**
 * Audited evidence download. A URL is only issued to a caller allowed to read
 * the record's classification; restricted evidence requires `cyber.manage`.
 */
export const evidenceDownloadUrl = mutation({
  args: { evidenceId: v.id("cyberEvidence") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.organizationId !== access.organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (
      !mayReadRestrictedCyberEvidence(access.canManage) &&
      evidence.classification === "restricted"
    ) {
      throw new Error("Restricted evidence requires cyber.manage access");
    }
    if (!evidence.storageId) {
      throw new Error("The stored file for this evidence record is missing");
    }
    const url = await ctx.storage.getUrl(evidence.storageId);
    if (!url) {
      throw new Error("The stored file for this evidence record is missing");
    }
    await logCyberAudit(ctx, access, {
      action: "cyber.evidence_downloaded",
      entityType: "cyberEvidence",
      entityId: String(evidence._id),
      relatedEntityType: evidence.vulnerabilityId
        ? "vulnerabilities"
        : "securityAssessments",
      relatedEntityId: String(evidence.vulnerabilityId ?? evidence.assessmentId),
      summary: `Evidence ${evidence.filename} (${evidence.classification}) retrieved`,
    });
    return { url, sha256: evidence.sha256 || null, filename: evidence.filename };
  },
});

/** Re-check a stored blob's hash and persist the verdict. */
export const verifyEvidenceIntegrity = mutation({
  args: { evidenceId: v.id("cyberEvidence") },
  handler: async (ctx, args) => {
    const access = await resolveCyberAccess(ctx);
    const evidence = await ctx.db.get(args.evidenceId);
    if (!evidence || evidence.organizationId !== access.organizationId) {
      throw new Error("Evidence not found in your organization");
    }
    if (evidence.classification === "restricted" && !access.canManage) {
      throw new Error(
        "Restricted evidence integrity can only be checked by a cybersecurity manager",
      );
    }
    if (!evidence.storageId) {
      const now = Date.now();
      await ctx.db.patch(evidence._id, {
        integrity: "blob_missing",
        integrityCheckedAt: now,
        updatedAt: now,
      });
      return { verdict: "blob_missing" as const };
    }
    await ctx.scheduler.runAfter(
      0,
      internal.cyberEvidence.reverifyEvidence,
      {
        evidenceId: evidence._id,
        storageId: evidence.storageId,
        expectedSha256: evidence.sha256,
      },
    );
    await logCyberAudit(ctx, access, {
      action: "cyber.evidence_integrity_checked",
      entityType: "cyberEvidence",
      entityId: String(evidence._id),
      relatedEntityType: evidence.vulnerabilityId
        ? "vulnerabilities"
        : "securityAssessments",
      relatedEntityId: String(evidence.vulnerabilityId ?? evidence.assessmentId),
      summary: `Integrity re-check requested for ${evidence.filename}`,
    });
    return { verdict: "queued" as const };
  },
});

/** INTERNAL — recompute a hash and record intact / mismatch / missing. */
export const reverifyEvidence = internalAction({
  args: {
    evidenceId: v.id("cyberEvidence"),
    storageId: v.id("_storage"),
    expectedSha256: v.string(),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      await ctx.runMutation(internal.cyberEvidence.recordEvidenceIntegrity, {
        evidenceId: args.evidenceId,
        sha256: args.expectedSha256,
        integrity: "blob_missing",
      });
      return { verdict: "blob_missing" as const };
    }
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buffer);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const integrity = sha256 === args.expectedSha256 ? "intact" : "hash_mismatch";
    await ctx.runMutation(internal.cyberEvidence.recordEvidenceIntegrity, {
      evidenceId: args.evidenceId,
      sha256,
      integrity,
    });
    return { verdict: integrity };
  },
});
