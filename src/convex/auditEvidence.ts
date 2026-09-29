import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server";
import { internal } from "./_generated/api";
import {
  classificationValidator,
  evidenceStatusValidator,
} from "./schema";
import {
  requirePermission,
  logAudit,
} from "./auditAccess";

/**
 * Module 7 — Evidence Management.
 * Secure evidence handling: Convex file storage for bytes, SERVER-computed
 * SHA-256 integrity hashes (via a scheduled internal action, because Convex
 * mutations cannot read blob bytes), classification-aware access control,
 * and access logging for every download. Evidence metadata is
 * organization-scoped; cross-tenant ids read as absent.
 *
 * Upload flow (three steps, all authorized):
 *   1. `generateUploadUrl` — audit.manage caller receives a one-time URL
 *   2. `confirmUpload`     — called after the browser PUT; validates the
 *      declaration, creates the evidence record and schedules hashing
 *   3. internal action     — fetches the stored blob by URL, computes the
 *      SHA-256 server-side and stamps it onto the record
 *
 * Browsers enforce the 10 MB / MIME-type limits before the PUT; the server
 * re-validates the MIME type on confirmation.
 */

const MAX_EVIDENCE_BYTES = 10 * 1024 * 1024; // 10 MB (enforced client-side pre-PUT)
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
 * Finalize an upload: validates the declaration, creates the evidence record
 * with the storage pointer, and schedules the server-side SHA-256 hashing
 * action. Called by the browser after its PUT to the upload URL completes.
 */
export const confirmUpload = mutation({
  args: {
    storageId: v.id("_storage"),
    filename: v.string(),
    fileType: v.string(),
    sizeBytes: v.number(),
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
    if (args.sizeBytes <= 0 || args.sizeBytes > MAX_EVIDENCE_BYTES) {
      throw new Error("File size must be between 1 byte and 10 MB");
    }

    // Referenced artefacts must belong to the same organization.
    if (args.engagementId) {
      const e = await ctx.db.get(args.engagementId);
      if (!e || e.organizationId !== access.organizationId) {
        throw new Error("Engagement not found in your organization");
      }
    }
    if (args.workingPaperId) {
      const wp = await ctx.db.get(args.workingPaperId);
      if (!wp || wp.organizationId !== access.organizationId) {
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
      sizeBytes: args.sizeBytes,
      classification: args.classification,
      // Stamped by the scheduled hashing action (empty until then).
      sha256: "",
      storageId: args.storageId,
      source: args.source,
      description: args.description,
      collectedAt: args.collectedAt,
      uploadedById: access.user?._id,
      status: "collected",
      createdAt: now,
      updatedAt: now,
    });

    // Server-side integrity hashing happens asynchronously (Convex mutation
    // contexts cannot read blob bytes).
    await ctx.scheduler.runAfter(0, internal.auditEvidence.computeEvidenceHash, {
      evidenceId,
      storageId: args.storageId,
    });

    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: access.user?._id,
      actorLabel: access.user?.name ?? access.user?.email ?? undefined,
      action: "evidence.uploaded",
      entityType: "evidence",
      entityId: evidenceId,
      summary: `${args.filename} (${Math.round(args.sizeBytes / 1024)} KB, ${args.classification})`,
    });

    return { evidenceId };
  },
});

/**
 * INTERNAL — compute the SHA-256 of a stored evidence blob and stamp it on
 * the record. Runs as an action because only action/query contexts can
 * access blob bytes (via the download URL).
 */
export const computeEvidenceHash = internalAction({
  args: {
    evidenceId: v.id("evidence"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) return;
    const res = await fetch(url);
    if (!res.ok) return;
    const buf = await res.arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await ctx.runMutation(internal.auditEvidence.stampEvidenceHash, {
      evidenceId: args.evidenceId,
      sha256,
    });
  },
});

/** INTERNAL — write the computed hash onto the evidence record. */
export const stampEvidenceHash = internalMutation({
  args: {
    evidenceId: v.id("evidence"),
    sha256: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.evidenceId, {
      sha256: args.sha256,
      updatedAt: Date.now(),
    });
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
      .filter((r) => mayAccessClassification(access.role, r.classification))
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

    const url = ev.storageId ? await ctx.storage.getUrl(ev.storageId) : null;
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
 * Re-run server-side integrity verification for one evidence record.
 * Recomputes the SHA-256 of the stored blob and compares it with the
 * recorded hash. Returns a verdict without exposing bytes.
 */
export const verifyIntegrity = mutation({
  args: { evidenceId: v.id("evidence") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "audit.manage");
    if (!access.organizationId) throw new Error("No organization context");
    const ev = await ctx.db.get(args.evidenceId);
    if (!ev || ev.organizationId !== access.organizationId) {
      throw new Error("Evidence not found");
    }
    if (!ev.storageId) return { ok: false, verdict: "blob_missing" as const };

    await ctx.scheduler.runAfter(0, internal.auditEvidence.verifyEvidenceHash, {
      evidenceId: ev._id,
      storageId: ev.storageId,
      expectedSha256: ev.sha256,
    });
    // Verification result is audited asynchronously by the action.
    return { ok: true, verdict: "verification_scheduled" as const };
  },
});

/** INTERNAL — recompute a hash and record the verification verdict. */
export const verifyEvidenceHash = internalAction({
  args: {
    evidenceId: v.id("evidence"),
    storageId: v.id("_storage"),
    expectedSha256: v.string(),
  },
  handler: async (ctx, args) => {
    const url = await ctx.storage.getUrl(args.storageId);
    if (!url) {
      await ctx.runMutation(internal.auditEvidence.recordIntegrityVerdict, {
        evidenceId: args.evidenceId,
        verdict: "blob_missing",
      });
      return;
    }
    const res = await fetch(url);
    const buf = res.ok ? await res.arrayBuffer() : null;
    if (!buf) {
      await ctx.runMutation(internal.auditEvidence.recordIntegrityVerdict, {
        evidenceId: args.evidenceId,
        verdict: "blob_missing",
      });
      return;
    }
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    await ctx.runMutation(internal.auditEvidence.recordIntegrityVerdict, {
      evidenceId: args.evidenceId,
      verdict: sha256 === args.expectedSha256 ? "intact" : "hash_mismatch",
    });
  },
});

/** INTERNAL — persist an integrity verdict to the audit log. */
export const recordIntegrityVerdict = internalMutation({
  args: {
    evidenceId: v.id("evidence"),
    verdict: v.union(
      v.literal("intact"),
      v.literal("hash_mismatch"),
      v.literal("blob_missing"),
    ),
  },
  handler: async (ctx, args) => {
    const ev = await ctx.db.get(args.evidenceId);
    if (!ev) return;
    await ctx.db.insert("auditLogs", {
      organizationId: ev.organizationId,
      action: "evidence.integrity_verified",
      entityType: "evidence",
      entityId: args.evidenceId,
      summary: `Integrity check for ${ev.filename}: ${args.verdict}`,
      createdAt: Date.now(),
    });
  },
});
