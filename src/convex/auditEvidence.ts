import { v } from "convex/values";
import { internalMutation, mutation, query } from "./_generated/server";
import {
  classificationValidator,
  evidenceStatusValidator,
} from "./schema";
import {
  requirePermission,
  requireEngagementAccess,
  logAudit,
} from "./auditAccess";

/**
 * Module 7 — Evidence Management.
 * Secure evidence handling: Convex file storage for bytes, server-computed
 * SHA-256 integrity hashes, classification-aware access control, and
 * access logging for every download. Evidence metadata and blobs are
 * organization-scoped; cross-tenant ids read as absent.
 *
 * Upload flow (two steps, both authorized):
 *   1. `generateUploadUrl`  → audit.manage caller receives a one-time URL
 *   2. `confirmUpload`      → called after the browser PUT; the server reads
 *      the stored file, computes SHA-256, and creates the evidence record.
 */

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "text/csv",
  "text/plain",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/json",
  "application/zip",
];

/** Restricted evidence may only be downloaded by privileged audit roles. */
function mayAccessClassification(
  role: string | undefined,
  classification: string,
): boolean {
  if (classification !== "restricted") return true;
  return (
    role === "admin" ||
    role === "audit_director" ||
    role === "audit_manager"
  );
}

/** One-time upload URL (Convex-managed storage; no secrets involved). */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requirePermission(ctx, "audit.manage");
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Finalize an upload: validates type/size, computes the SHA-256 integrity
 * hash server-side, and creates the evidence record. Called by the browser
 * after its PUT to the upload URL completes.
 */
export const confirmUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    fileType: v.string(),
    classification: classificationValidator,
    engagementId: v.optional(v.id("auditEngagements")),
    workingPaperId: v.optional(v.id("workingPapers")),
    source: v.optional(v.string()),
    description: v.optional(v.string()),
    collectedAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");

    if (!ALLOWED_TYPES.includes(args.fileType)) {
      throw new Error(`Unsupported file type: ${args.fileType}`);
    }

    // Read the stored blob server-side; compute SHA-256 for integrity.
    const blob = await ctx.storage.get(args.storageId);
    if (!blob) throw new Error("Uploaded file not found in storage");
    if (blob.size > MAX_EVIDENCE_BYTES) {
      await ctx.storage.delete(args.storageId);
      throw new Error("File exceeds the 10 MB evidence limit");
    }
    const digest = await crypto.subtle.digest("SHA-256", blob);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

    // Optional parent artefacts must belong to the same organization.
    if (args.engagementId) {
      const e = await ctx.db.get(args.engagementId);
      if (!e || e.organizationId !== access.organizationId) {
        await ctx.storage.delete(args.storageId);
        throw new Error("Engagement not found in your organization");
      }
    }
    if (args.workingPaperId) {
      const wp = await ctx.db.get(args.workingPaperId);
      if (!wp || wp.organizationId !== access.organizationId) {
        await ctx.storage.delete(args.storageId);
        throw new Error("Working paper not found in your organization");
      }
    }

    const now = Date.now();
    const evidenceId = await ctx.db.insert("evidence", {
      organizationId: access.organizationId,
      engagementId: args.engagementId,
      workingPaperId: args.workingPaperId,
      filename: args.filename,
      fileType: args.fileType,
      sizeBytes: blob.size,
      classification: args.classification,
      sha256,
      storageId: args.storageId,
      source: args.source,
      description: args.description,
      collectedAt: args.collectedAt,
      uploadedById: access.user?._id,
      status: "collected",
      createdAt: now,
      updatedAt: now,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "evidence.uploaded",
      entityType: "evidence",
      entityId: evidenceId,
      summary: `${args.filename} (${Math.round(blob.size / 1024)} KB, ${args.classification}, sha256 ${sha256.slice(0, 12)}…)`,
    });

    return { evidenceId, sha256, sizeBytes: blob.size };
  },
});

/** Evidence list for the organization (optionally per engagement/paper). */
export const list = query({
  args: {
    engagementId: v.optional(v.id("auditEngagements")),
    workingPaperId: v.optional(v.id("workingPapers")),
    search: v.optional(v.string()),
    classification: v.optional(classificationValidator),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) return [];
    let rows = await ctx.db
      .query("evidence")
      .withIndex("by_organization", (q) =>
        q.eq("organizationId", access.organizationId!),
      )
      .collect();
    if (args.engagementId)
      rows = rows.filter((r) => r.engagementId === args.engagementId);
    if (args.workingPaperId)
      rows = rows.filter((r) => r.workingPaperId === args.workingPaperId);
    if (args.classification)
      rows = rows.filter((r) => r.classification === args.classification);
    if (args.search) {
      const q = args.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.filename.toLowerCase().includes(q) ||
          (r.description ?? "").toLowerCase().includes(q) ||
          (r.source ?? "").toLowerCase().includes(q),
      );
    }
    return rows
      .map((r) => ({
        ...r,
        // Restricted items are hidden from non-privileged viewers entirely.
        restrictedHidden: !mayAccessClassification(access.role, r.classification),
      }))
      .filter((r) => !r.restrictedHidden)
      .sort((a, b) => b.createdAt - a.createdAt);
  },
});

/**
 * Download URL + access logging. Every fetch writes an entry to the
 * immutable audit log (who fetched what, when). Classification rules apply.
 */
export const getDownloadUrl = mutation({
  args: { evidenceId: v.id("evidence") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.view");
    if (!access.organizationId) throw new Error("No organization context");

    const ev = await ctx.db.get(args.evidenceId);
    // Tenant isolation + classification gate.
    if (!ev || ev.organizationId !== access.organizationId) {
      throw new Error("Evidence not found");
    }
    if (!mayAccessClassification(access.role, ev.classification)) {
      throw new Error("Restricted evidence requires audit management access");
    }

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "evidence.accessed",
      entityType: "evidence",
      entityId: args.evidenceId,
      summary: `Downloaded ${ev.filename} (${ev.classification})`,
    });

    const url = ev.storageId
      ? await ctx.storage.getUrl(ev.storageId)
      : null;
    return { url, sha256: ev.sha256, filename: ev.filename };
  },
});

/** Update metadata / lifecycle state (audit.manage required). */
export const updateEvidence = mutation({
  args: {
    id: v.id("evidence"),
    status: v.optional(evidenceStatusValidator),
    description: v.optional(v.string()),
    source: v.optional(v.string()),
    classification: v.optional(classificationValidator),
    workingPaperId: v.optional(v.id("workingPapers")),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const ev = await ctx.db.get(args.id);
    if (!ev || ev.organizationId !== access.organizationId) {
      throw new Error("Evidence not found");
    }

    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const key of [
      "status",
      "description",
      "source",
      "classification",
      "workingPaperId",
    ] as const) {
      if (args[key] !== undefined) patch[key] = args[key];
    }
    await ctx.db.patch(args.id, patch);

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? undefined,
      action: "evidence.updated",
      entityType: "evidence",
      entityId: args.id,
      summary: `${ev.filename} metadata updated`,
    });
    return { ok: true };
  },
});

/**
 * Internal integrity verification used by tests and the admin console:
 * recomputes the SHA-256 of the stored blob and compares it to the recorded
 * hash. Returns a boolean verdict without exposing bytes.
 */
export const verifyIntegrity = internalMutation({
  args: { evidenceId: v.id("evidence") },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.evidenceId);
    if (!ev) return { ok: false, reason: "not_found" as const };
    if (!ev.storageId) return { ok: false, reason: "blob_missing" as const };
    const blob = await ctx.storage.get(ev.storageId);
    if (!blob) return { ok: false, reason: "blob_missing" as const };
    const digest = await crypto.subtle.digest("SHA-256", blob);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return {
      ok: sha256 === ev.sha256,
      reason: sha256 === ev.sha256
        ? ("intact" as const)
        : ("hash_mismatch" as const),
    };
  },
});
