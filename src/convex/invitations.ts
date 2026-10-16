import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { requirePermission, requireUser, logAudit } from "./auditAccess";
import { guestAuthEnabled } from "./access";
import { applyInitialMembership } from "./membershipCore";
import { PROVISIONABLE_INITIAL_ROLES } from "../lib/membership";
import { sha256Hex } from "../lib/sha256";
import {
  INVITATION_RESEND_COOLDOWN_MS,
  INVITATION_TTL_MS,
  MAX_ACTIVE_INVITATIONS_PER_ORG,
  MAX_INVITATIONS_PER_EMAIL_WINDOW_COUNT,
  MAX_INVITATIONS_PER_EMAIL_WINDOW_MS,
  type InvitationStatus,
  isReissueable,
  normalizeInvitationEmail,
} from "../lib/membership";
import { invitationEmailHtml, invitationEmailText } from "../lib/invitationEmail";

/**
 * Phase 3A — Batch 2C: secure organization invitations & onboarding.
 * ===========================================================================
 * INVITATION MODEL (see schema.ts organizationInvitations)
 *   Administrator → invitee email (not yet a member) → verified email-OTP
 *   sign-in by the recipient → membership + initial role in ONE transaction,
 *   fully audited. The privileged platform `admin` role is structurally
 *   excluded from invitations.
 *
 * TOKEN SECURITY (single source of truth):
 *   - secret: 32 random bytes (crypto.getRandomValues) → base64url; it NEVER
 *     travels through any listing, audit record, log or browser API other
 *     than the recipient's own emailed link and the DEV-ONLY trusted harness;
 *   - storage: only sha256Hex(secret) on the invitation row (by_secret_hash
 *     lookup); a guessed token cannot enumerate or inspect invitations;
 *   - lookup by HASH only; no timing/enumeration oracle (unknown hash → the
 *     same uniform refusal as any other invalid state);
 *   - single use: accepting FLIPS the row to terminal state in the very
 *     transaction that creates the membership — replays see the terminal
 *     state and are refused (Convex mutations serialize: concurrent accepts
 *     cannot double-provision);
 *   - resend/reissue REPLACES the hash with a fresh secret's hash, so every
 *     previously issued token is invalidated atomically.
 *
 * A TOKEN IS NOT AUTHENTICATION. Acceptance requires ALL of:
 *   (1) an existing, REAL (non-anonymous) Convex Auth identity,
 *   (2) a VERIFIED email (emailVerificationTime set),
 *   (3) the verified email EXACTLY equals the invited (normalized) email,
 *   (4) a hash-valid, actionable (pending) invitation, not expired/revoked,
 *   (5) no existing organization membership (one-profile-per-user invariant,
 *       which also blocks suspended/deactivated/cross-org bypasses).
 *
 * EMAIL DELIVERY:
 *   - production provider selection reuses the same env conventions as the
 *     OTP provider (IITAMS_EMAIL_PROVIDER=resend + RESEND_API_KEY/RESEND_FROM)
 *     but is logically separate from OTP authentication mail;
 *   - the development `freebuff_dev` OTP adapter is an OTP-only channel and
 *     is DELIBERATELY never used for invitation delivery;
 *   - "delivered/sent" is recorded ONLY after the provider accepts (2xx);
 *     missing credentials → invitation stays pending_delivery with an
 *     explicit error label — nothing claims a false success;
 *   - retries guard against duplicate sends (attempt counter + cooldown +
 *     staleness check against the CURRENT hash before every send).
 *
 * AUDIT (append-only, no secrets ever): user.invitation_created,
 * user.invitation_sent, user.invitation_delivery_failed,
 * user.invitation_reissued, user.invitation_revoked,
 * user.invitation_expired, user.invitation_accepted,
 * user.membership_provisioned.
 */

// ---------------------------------------------------------------------------
// Providers / internal helpers
// ---------------------------------------------------------------------------

/** Initial role on an invitation — same registry as Batch 2B provisioning
 * (the privileged admin role is not in this list by construction). */
const inviteableInitialRoleArg = v.union(
  v.literal("user"),
  v.literal("member"),
  v.literal("audit_director"),
  v.literal("audit_manager"),
  v.literal("auditor"),
  v.literal("audit_reviewer"),
  v.literal("management_user"),
  v.literal("executive_viewer"),
);

/** Cryptographically secure, URL-safe, unpredictable single-use secret. */
function generateInvitationSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  // base64url without padding: safe in emails and URLs.
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

type InvitationDoc = {
  _id: Id<"organizationInvitations">;
  organizationId: Id<"organizations">;
  email: string;
  role: string;
  jobTitle?: string;
  status: InvitationStatus;
  secretHash?: string;
  createdBy: Id<"users">;
  createdAt: number;
  expiresAt: number;
  deliveryStatus: "not_yet" | "sending" | "sent" | "failed" | "skipped";
  deliveryLastAttemptAt?: number;
  deliveryConfirmedAt?: number;
  deliveryAttempts?: number;
  deliveryError?: string;
  revokedAt?: number;
  revokedBy?: Id<"users">;
  acceptedAt?: number;
  acceptedUserId?: Id<"users">;
  acceptedProfileId?: Id<"userProfiles">;
};

/** One place where "expired" is evaluated (server-side only, never client). */
function isExpired(inv: InvitationDoc, now: number): boolean {
  return inv.expiresAt <= now;
}

function isActionable(status: InvitationStatus): boolean {
  return status === "pending" || status === "pending_delivery";
}

/** Uniform refusal: invalid, expired, revoked or already-used alike. */
const TOKEN_REFUSAL = "This invitation is invalid, expired or already used";

// ---------------------------------------------------------------------------
// Internal read/mutate helpers (scheduler + action plumbing)
// ---------------------------------------------------------------------------

/** Snapshot of an invitation for the (internal) delivery action. */
export const getForDelivery = internalQuery({
  args: { invitationId: v.id("organizationInvitations") },
  handler: async (ctx, args): Promise<InvitationDoc | null> => {
    return (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
  },
});

export const getOrganizationName = internalQuery({
  args: { organizationId: v.id("organizations") },
  handler: async (ctx, args): Promise<string | null> => {
    const org = await ctx.db.get(args.organizationId);
    return org?.name ?? null;
  },
});

/**
 * MINT a deliverable secret INSIDE the delivery pipeline (never via a
 * scheduled-argument): generates a fresh 256-bit secret, stores ONLY its
 * hash, performs attempt bookkeeping, and returns the plaintext to the
 * calling action IN MEMORY (server-to-server return value, never persisted
 * beyond the call, never logged, never returned to any client).
 *
 * SECURITY INVARIANT (acceptance-review fix): Convex scheduled-function
 * arguments are durably stored until execution — passing a plaintext token
 * as an argument would leave a durable copy outside the invitation row.
 * The scheduler therefore carries ONLY the invitation id; the secret is
 * minted here, at send time, so at NO point does any plaintext live in
 * durable storage outside its in-memory lifetime.
 *
 * Because the mint REPLACES the hash, this is also where a resend/failed
 * retry atomically invalidates every previously issued token: the email is
 * sent only AFTER the new hash is committed, so a delivered token is always
 * the currently-valid one.
 */
export const mintDeliverableSecret = internalMutation({
  args: { invitationId: v.id("organizationInvitations") },
  handler: async (ctx, args) => {
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    if (!inv) return { ok: false as const, reason: "missing" };
    if (inv.status === "revoked" || inv.status === "accepted" || inv.status === "expired") {
      return { ok: false as const, reason: "terminal" };
    }
    if (isExpired(inv, Date.now())) {
      await expireIfDue(ctx, inv, Date.now());
      return { ok: false as const, reason: "expired" };
    }
    const attempts = inv.deliveryAttempts ?? 0;
    if (attempts >= MAX_SEND_ATTEMPTS_PER_INVITATION) {
      return { ok: false as const, reason: "attempt-budget-exhausted" };
    }
    const now = Date.now();
    const secret = generateInvitationSecret();
    const secretHash = sha256Hex(secret);
    await ctx.db.patch(inv._id, {
      secretHash,
      status: "pending_delivery",
      deliveryStatus: "sending",
      deliveryLastAttemptAt: now,
      deliveryAttempts: attempts + 1,
      deliveryError: undefined,
      deliveryConfirmedAt: undefined,
    });
    return {
      ok: true as const,
      secret,
      secretHash,
      email: inv.email,
      role: inv.role,
      jobTitle: inv.jobTitle,
      expiresAt: inv.expiresAt,
      organizationId: inv.organizationId,
      attempt: attempts + 1,
    };
  },
});

/**
 * Staleness guard immediately before the provider call: if a concurrent
 * action minted a DIFFERENT secret, or the invitation became terminal
 * (revoked/accepted/expired) between minting and sending, this send must
 * NOT go out (the token it carries would either be dead or split-brain).
 * Revocation between this check and the network call is still safe: the
 * acceptance path refuses terminal invitations regardless of any token.
 */
export const assertStillActionable = internalMutation({
  args: {
    invitationId: v.id("organizationInvitations"),
    secretHash: v.string(),
  },
  handler: async (ctx, args) => {
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    if (!inv) return { ok: false as const, reason: "missing" };
    if (inv.secretHash !== args.secretHash) {
      return { ok: false as const, reason: "superseded" };
    }
    if (!isActionable(inv.status)) {
      return { ok: false as const, reason: "terminal" };
    }
    if (isExpired(inv, Date.now())) {
      await expireIfDue(ctx, inv, Date.now());
      return { ok: false as const, reason: "expired" };
    }
    return { ok: true as const };
  },
});

export const MAX_SEND_ATTEMPTS_PER_INVITATION = 5;

/** Record the provider's verdict — never claims success without a 2xx. */
export const recordDeliveryOutcome = internalMutation({
  args: {
    invitationId: v.id("organizationInvitations"),
    delivered: v.boolean(),
    // Safe provider metadata / refusal label only (no credentials, no secret).
    messageId: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    if (!inv) return { ok: false as const };
    // SECURITY (acceptance-review): a delayed delivery attempt must never
    // resurrect a terminal invitation. If an administrator revoked the
    // invitation (or it expired / was consumed) while this attempt was in
    // flight, the outcome must be DISCARDED, not written over the terminal
    // state (which would silently un-revoke the invitation).
    if (!isReissueable(inv.status)) return { ok: false as const };
    const now = Date.now();
    if (args.delivered === true) {
      // Only a provider-confirmed send reaches `pending`/`sent`.
      await ctx.db.patch(inv._id, {
        status: "pending",
        deliveryStatus: "sent",
        deliveryConfirmedAt: now,
        deliveryError: undefined,
      });
      await logAudit(ctx, {
        organizationId: inv.organizationId,
        userId: undefined,
        actorLabel: "IITAMS invitation service",
        action: "user.invitation_sent",
        entityType: "organizationInvitations",
        entityId: inv._id,
        summary: `Invitation delivered to ${inv.email} (${inv.role} — expires ${new Date(inv.expiresAt).toISOString()}), provider-confirmed`,
      });
      return { ok: true as const };
    }
    // Failed: invitation stays actionable and reissueable; false success is
    // impossible: status remains pending_delivery + explicit error label.
    await ctx.db.patch(inv._id, {
      status: "delivery_failed",
      deliveryStatus: "failed",
      deliveryError: args.error,
    });
    await logAudit(ctx, {
      organizationId: inv.organizationId,
      userId: undefined,
      actorLabel: "IITAMS invitation service",
      action: "user.invitation_delivery_failed",
      entityType: "organizationInvitations",
      entityId: inv._id,
      summary: `Delivery to ${inv.email} did not complete${args.error ? `: ${args.error}` : ""}`,
    });
    return { ok: true as const };
  },
});

/** Flip pending → expired (with audit). Idempotent; used inline at acceptance
 * time, in admin mutations and by the trusted-harness sweep. */
async function expireIfDue(
  ctx: MutationCtx,
  inv: InvitationDoc,
  now: number,
) {
  if (!isActionable(inv.status) || !isExpired(inv, now)) return;
  await ctx.db.patch(inv._id, { status: "expired" });
  await ctx.db.insert("auditLogs", {
    organizationId: inv.organizationId,
    userId: undefined,
    actorLabel: "IITAMS invitation lifecycle",
    action: "user.invitation_expired",
    entityType: "organizationInvitations",
    entityId: inv._id,
    summary: `Invitation for ${inv.email} expired without acceptance (deadline ${new Date(inv.expiresAt).toISOString()})`,
    createdAt: now,
  });
}

/** Internal sweep — persisted expiry for actionable invitations. */
export const expireOverdue = internalMutation({
  args: { organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, args) => {
    const now = Date.now();
    const rows: InvitationDoc[] = args.organizationId
      ? await ctx.db
          .query("organizationInvitations")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", args.organizationId!),
          )
          .collect()
      : await ctx.db.query("organizationInvitations").collect();
    let expired = 0;
    for (const inv of rows) {
      if (isExpired(inv, now)) {
        await expireIfDue(ctx, inv, now);
        expired += 1;
      }
    }
    return { expired };
  },
});

// ---------------------------------------------------------------------------
// Delivery action (provider call lives here — actions may fetch)
// ---------------------------------------------------------------------------

/** Production invitation provider: Reuse the OTP email conventions, but the
 * invitation channel is logically separate from OTP authentication and the
 * OTP-only dev adapter is deliberately never used for invitations. */
function resolveInvitationEmailProvider(): "resend" | "none" {
  const raw = (process.env.IITAMS_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "resend") return "resend";
  // freebuff_dev is an OTP-only channel; anything else is "none".
  return "none";
}

export const deliverInvitationEmail = internalAction({
  args: {
    invitationId: v.id("organizationInvitations"),
    // SECURITY (acceptance-review): scheduled args are durably stored — they
    // must NEVER carry the plaintext secret. Only the id travels here; the
    // secret is minted at send time (see mintDeliverableSecret).
  },
  handler: async (ctx, args) => {
    const minted = await ctx.runMutation(internal.invitations.mintDeliverableSecret, {
      invitationId: args.invitationId,
    });
    if (!minted.ok) return; // terminal / expired / budget exhausted
    const stillActionable = await ctx.runMutation(internal.invitations.assertStillActionable, {
      invitationId: args.invitationId,
      secretHash: minted.secretHash,
    });
    if (!stillActionable.ok) return; // superseded/terminal — never send

    const inv = await ctx.runQuery(internal.invitations.getForDelivery, {
      invitationId: args.invitationId,
    });
    if (!inv) return;
    const orgName = await ctx.runQuery(internal.invitations.getOrganizationName, {
      organizationId: minted.organizationId,
    });
    if (!orgName) {
      await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
        invitationId: args.invitationId,
        delivered: false,
        error: "organization record unavailable",
      });
      return;
    }

    const provider = resolveInvitationEmailProvider();
    if (provider === "none") {
      await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
        invitationId: args.invitationId,
        delivered: false,
        error: "no email provider configured on this deployment",
      });
      return;
    }

    // ---
    // Resend (production provider) — attempt-scoped idempotency.
    // ---
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
        invitationId: args.invitationId,
        delivered: false,
        error: "RESEND_API_KEY is not configured on this deployment",
      });
      return;
    }
    const from = process.env.RESEND_FROM ?? "IITAMS <onboarding@resend.dev>";
    // Idempotency: unique PER INVITATION AND PER MINTED TOKEN AND ATTEMPT so
    // (a) a network retry of THIS exact call replays the same response,
    // (b) different tokens/payloads never share an idempotency key, and
    // (c) a timeout between provider acceptance and outcome recording is
    // resolved by re-running the SAME attempt (the scheduled action can be
    // re-invoked; the provider replays instead of double-sending).
    const idempotencyKey = `iamsg-lia:${args.invitationId}:${minted.attempt}:${minted.secretHash.slice(0, 16)}`;
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        signal: AbortSignal.timeout(10_000), // bounded; no unbounded retry loop
        body: JSON.stringify({
          from,
          to: [inv.email],
          subject: `IITAMS invitation — ${orgName}`,
          html: invitationEmailHtml({
            organizationName: orgName,
            role: toLabel(minted.role),
            email: minted.email,
            secret: minted.secret,
            expiresAt: minted.expiresAt,
            appOrigin: process.env.IITAMS_APP_ORIGIN ?? process.env.CONVEX_SITE_URL,
            jobTitle: minted.jobTitle,
          }),
          text: invitationEmailText({
            organizationName: orgName,
            role: toLabel(minted.role),
            email: minted.email,
            secret: minted.secret,
            expiresAt: minted.expiresAt,
            appOrigin: process.env.IITAMS_APP_ORIGIN ?? process.env.CONVEX_SITE_URL,
            jobTitle: minted.jobTitle,
          }),
        }),
      });
      if (!res.ok) {
        await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
          invitationId: args.invitationId,
          delivered: false,
          error: `provider refused delivery (HTTP ${res.status})`,
        });
        return;
      }
      const data = (await res.json().catch(() => ({}))) as { id?: string };
      await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
        invitationId: args.invitationId,
        delivered: true,
        messageId: typeof data.id === "string" ? data.id : undefined,
      });
    } catch (err) {
      await ctx.runMutation(internal.invitations.recordDeliveryOutcome, {
        invitationId: args.invitationId,
        delivered: false,
        error: `delivery network error: ${String(err).slice(0, 120)}`,
      });
    }
  },
});

/** Sector-appropriate label for the email body (no permission strings). */
function toLabel(role: string): string {
  switch (role) {
    case "user": return "Assurance User";
    case "member": return "Member";
    case "audit_director": return "Audit Director";
    case "audit_manager": return "Audit Manager";
    case "auditor": return "Auditor";
    case "audit_reviewer": return "Audit Reviewer";
    case "management_user": return "Management User";
    case "executive_viewer": return "Executive Viewer";
    default: return role;
  }
}

// ---------------------------------------------------------------------------
// Administrator operations
// ---------------------------------------------------------------------------

/** Shared creation core — caller authorization ALWAYS happens in the public
 * wrapper before this runs. The invitation row is created WITHOUT a token
 * (no plaintext here either); the delivery action mints the secret at send
 * time, so NO durable plaintext copy exists anywhere in the pipeline. */
async function createInvitationRow(
  ctx: MutationCtx,
  input: {
    organizationId: Id<"organizations">;
    email: string;
    role: string;
    jobTitle?: string;
    createdBy: Id<"users">;
    adminLabel: string;
  },
) {
  const now = Date.now();

  // ---- duplicate prevention (atomic: Convex serializes mutations) ----
  const existing = (await ctx.db
    .query("organizationInvitations")
    .withIndex("by_organization_email", (q) =>
      q.eq("organizationId", input.organizationId).eq("email", input.email))
    .collect()) as InvitationDoc[];
  const actionable = existing.filter(
    (r) =>
      (r.status === "pending_delivery" || r.status === "pending" || r.status === "delivery_failed") &&
      r.expiresAt > now,
  );
  if (actionable.length > 0) {
    throw new Error(
      "An invitation for this email is already pending or awaiting acceptance",
    );
  }

  // ---- anti-flooding: per-email rolling window + org-wide cap ----
  const sameEmailRecent = existing.filter(
    (r) => now - r.createdAt < MAX_INVITATIONS_PER_EMAIL_WINDOW_MS,
  ).length;
  if (sameEmailRecent >= MAX_INVITATIONS_PER_EMAIL_WINDOW_COUNT) {
    throw new Error("Invitation limit reached for this email address — try again later");
  }
  const orgTotal = await ctx.db
    .query("organizationInvitations")
    .withIndex("by_organization", (q) => q.eq("organizationId", input.organizationId))
    .collect();
  const orgActive = (orgTotal as InvitationDoc[]).filter(
    (r: InvitationDoc) =>
      (r.status === "pending_delivery" || r.status === "pending" || r.status === "delivery_failed") &&
      r.expiresAt > now,
  ).length;
  if (orgActive >= MAX_ACTIVE_INVITATIONS_PER_ORG) {
    throw new Error("The organization has reached its open-invitation limit");
  }

  const invitationId = await ctx.db.insert("organizationInvitations", {
    organizationId: input.organizationId,
    email: input.email,
    role: input.role as
      | "user"
      | "member"
      | "audit_director"
      | "audit_manager"
      | "auditor"
      | "audit_reviewer"
      | "management_user"
      | "executive_viewer",
    ...(input.jobTitle !== undefined ? { jobTitle: input.jobTitle } : {}),
    status: "pending_delivery",
    // secretHash is minted INSIDE the delivery action right before the send
    // (no plaintext ever reaches durable storage anywhere).
    createdBy: input.createdBy,
    createdAt: now,
    expiresAt: now + INVITATION_TTL_MS,
    deliveryStatus: "not_yet",
    deliveryAttempts: 0,
  });
  // Immutable audit entry (NO secret, NO codes, NO credentials).
  await ctx.db.insert("auditLogs", {
    organizationId: input.organizationId,
    userId: undefined,
    actorId: input.createdBy,
    actorLabel: input.adminLabel,
    action: "user.invitation_created",
    entityType: "organizationInvitations",
    entityId: invitationId,
    summary: `Invitation created for ${input.email} with initial role ${input.role} (expires ${new Date(now + INVITATION_TTL_MS).toISOString()})`,
    createdAt: now,
  });

  // Delivery pipeline: the scheduled action receives ONLY the invitation id
  // (scheduled args are durably stored — never a plaintext token).
  await ctx.scheduler.runAfter(0, internal.invitations.deliverInvitationEmail, {
    invitationId,
  });

  return invitationId;
}

/**
 * Administrator creates an invitation for a NOT-YET-MEMBER email address.
 * Caller: authenticated + `admin.manage` + ACTIVE organization membership.
 * The organization ALWAYS comes from the server-side access context.
 *
 * Creates NO user account, NO userProfiles membership — the invitee does not
 * exist or is unassigned. Nothing about membership is implied here.
 */
export const createInvitation = mutation({
  args: {
    email: v.string(),
    role: inviteableInitialRoleArg,
    jobTitle: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    if (!access.isProvisioned) throw new Error("Caller membership is not active");

    const email = normalizeInvitationEmail(args.email);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new Error("Enter a valid email address");
    }
    if (email === (access.user.email ?? "").trim().toLowerCase()) {
      throw new Error("You already belong to this organization");
    }

    const invitationId = await createInvitationRow(ctx, {
      organizationId: access.organizationId,
      email,
      role: args.role,
      jobTitle: args.jobTitle?.trim() || undefined,
      createdBy: access.user._id,
      adminLabel: access.user.name ?? access.user.email ?? "Administrator",
    });

    return { ok: true as const, invitationId, status: "pending_delivery" as const, expiresAt: Date.now() + INVITATION_TTL_MS };
  },
});

/**
 * Revoke a pending invitation (organization-scoped). Terminal: an accepted,
 * expired or already-revoked invitation cannot be revoked again.
 */
export const revokeInvitation = mutation({
  args: { invitationId: v.id("organizationInvitations") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    // Tenant isolation: a valid id from another organization is invisible.
    if (!inv || inv.organizationId !== access.organizationId) {
      throw new Error("Invitation not found");
    }
    // Revocable = anything not yet terminal (accepted/revoked/expired). A
    // delivery_failed invitation MUST remain revocable: otherwise a failed
    // send would trap the invitation in a state the administrator cannot
    // cancel. Revoking while a send is in flight is still safe — the delivering
    // action re-verifies status before sending, and the token is refused at
    // acceptance time regardless.
    if (!isReissueable(inv.status)) {
      throw new Error("Only pending or failed invitations can be revoked");
    }
    const now = Date.now();
    await ctx.db.patch(inv._id, {
      status: "revoked",
      revokedAt: now,
      revokedBy: access.user._id,
    });
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: undefined,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "user.invitation_revoked",
      entityType: "organizationInvitations",
      entityId: inv._id,
      summary: `Pending invitation for ${inv.email} revoked by administrator (link is now dead)`,
    });
    return { ok: true as const };
  },
});

/**
 * Resend/reissue: generates a FRESH secret (invalidating every previously
 * issued token for this invitation atomically) and restarts delivery.
 * Rate-limited (cooldown + attempt budget).
 */
export const resendInvitation = mutation({
  args: { invitationId: v.id("organizationInvitations") },
  handler: async (ctx, args) => {
    const access = await requirePermission(ctx, "admin.manage");
    if (!access.organizationId || !access.user) {
      throw new Error("No organization context");
    }
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    if (!inv || inv.organizationId !== access.organizationId) {
      throw new Error("Invitation not found");
    }
    if (isExpired(inv, Date.now())) {
      await expireIfDue(ctx, inv, Date.now());
      throw new Error("This invitation has expired");
    }
    if (!isReissueable(inv.status)) {
      throw new Error("Only pending or failed invitations can be resent");
    }
    if (inv.status === "pending_delivery" && inv.deliveryStatus === "sending") {
      throw new Error("A delivery attempt is already in progress");
    }
    const lastAt = inv.deliveryLastAttemptAt ?? inv.createdAt;
    if (Date.now() - lastAt < INVITATION_RESEND_COOLDOWN_MS) {
      throw new Error("Please wait before resending this invitation");
    }
    if ((inv.deliveryAttempts ?? 0) >= MAX_SEND_ATTEMPTS_PER_INVITATION) {
      throw new Error("The resend limit for this invitation has been reached");
    }

    // SECURITY (acceptance-review): scheduled args carry ONLY the id — the
    // delivery action mints a FRESH secret (invalidating every previously
    // issued token by hash replacement) right before its send, so no
    // plaintext ever lands in durable scheduler storage.
    await ctx.db.patch(inv._id, {
      status: "pending_delivery",
      deliveryStatus: "not_yet",
      deliveryError: undefined,
    });
    await ctx.scheduler.runAfter(0, internal.invitations.deliverInvitationEmail, {
      invitationId: inv._id,
    });
    await logAudit(ctx, {
      organizationId: access.organizationId,
      userId: undefined,
      actorId: access.user._id,
      actorLabel: access.user.name ?? access.user.email ?? "Administrator",
      action: "user.invitation_reissued",
      entityType: "organizationInvitations",
      entityId: inv._id,
      summary: `Fresh invitation link issued for ${inv.email} — all previously issued links are invalidated`,
    });
    return { ok: true as const, status: "pending_delivery" as const };
  },
});

/** Organization-scoped invitation management (admin.view). No secrets, no
 * hashes; safe delivery metadata only. Also persists due expiry. */
export const listInvitations = query({
  args: {},
  handler: async (ctx) => {
    const access = await requirePermission(ctx, "admin.view");
    if (!access.organizationId) return [];
    const now = Date.now();
    const rows = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_organization", (q) => q.eq("organizationId", access.organizationId!))
      .order("desc")
      .collect();
    // Display state: due-but-unswept rows present truthfully as expired.
    return rows.map((inv) => {
      const effective: InvitationStatus =
        isActionable(inv.status) && inv.expiresAt <= now ? "expired" : inv.status;
      return {
        _id: inv._id,
        email: inv.email,
        role: inv.role,
        jobTitle: inv.jobTitle ?? null,
        status: effective,
        createdAt: inv.createdAt,
        expiresAt: inv.expiresAt,
        deliveryStatus: inv.deliveryStatus,
        deliveryConfirmedAt: inv.deliveryConfirmedAt ?? null,
        deliveryError: inv.deliveryError ?? null,
        deliveryAttempts: inv.deliveryAttempts ?? 0,
        revokedAt: inv.revokedAt ?? null,
        acceptedAt: inv.acceptedAt ?? null,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// Recipient-facing flows
// ---------------------------------------------------------------------------

/**
 * Inspect an invitation via its HASH (never the plaintext; the acceptance
 * page hashes the link secret client-side). Returns exactly what a
 * validated recipient needs to decide: organization name, intended role and
 * invited address. Invalid/expired/revoked/used → uniform refusal shape —
 * probing yields NO information about any other invitation.
 */
export const inspectInvitation = query({
  args: { secretHash: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.secretHash)) {
      return { valid: false as const, reason: TOKEN_REFUSAL };
    }
    const inv = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.secretHash))
      .unique();
    if (!inv) return { valid: false as const, reason: TOKEN_REFUSAL };
    if (!isActionable(inv.status)) {
      return { valid: false as const, reason: TOKEN_REFUSAL };
    }
    const now = Date.now();
    if (isExpired(inv, now)) {
      return { valid: false as const, reason: TOKEN_REFUSAL };
    }
    const org = await ctx.db.get(inv.organizationId);
    return {
      valid: true as const,
      organizationName: org?.name ?? "your organization",
      intendedRole: toLabel(inv.role),
      invitedEmail: inv.email,
      jobTitle: inv.jobTitle ?? null,
      expiresAt: inv.expiresAt,
    };
  },
});

/**
 * Accept an invitation (single transaction):
 *   membership creation/profile completion + terminal acceptance state +
 *   audit entries. Only the caller's OWN authenticated, email-verified
 *   identity is used — the client supplies NOTHING except the hash.
 */
export const acceptInvitation = mutation({
  args: { secretHash: v.string() },
  handler: async (ctx, args) => {
    if (!/^[a-f0-9]{64}$/.test(args.secretHash)) {
      throw new Error(TOKEN_REFUSAL);
    }

    // ---- invitation state (hash-driven lookup; uniform refusals) ----
    const inv = await ctx.db
      .query("organizationInvitations")
      .withIndex("by_secret_hash", (q) => q.eq("secretHash", args.secretHash))
      .unique();
    if (!inv) throw new Error(TOKEN_REFUSAL);
    const now = Date.now();
    if (isExpired(inv, now)) {
      await expireIfDue(ctx, inv as InvitationDoc, now);
      throw new Error(TOKEN_REFUSAL);
    }
    // Non-terminal statuses keep the token valid: a transient send failure
    // (delivery_failed) must NOT dead-letter the invitation link — the
    // administrator can resend (fresh hash) or revoke, and acceptance stays
    // exactly-once because success transitions to the terminal "accepted".
    if (!isReissueable(inv.status)) throw new Error(TOKEN_REFUSAL);

    // ---- recipient identity: real, verified, exact email match ----
    // A token is NOT authentication: the acceptance authority is the
    // recipient's OWN verified identity (never a role, never the token).
    const access = await requireUser(ctx);
    if (!access.user) throw new Error(TOKEN_REFUSAL);
    const user = await ctx.db.get(access.user._id);
    if (!user) throw new Error(TOKEN_REFUSAL);
    if (user.isAnonymous === true) {
      throw new Error(
        "Sign in with the invited email address to accept this invitation (guest sessions cannot accept)",
      );
    }
    if (!user.emailVerificationTime) {
      throw new Error("Verify your email address with the code we emailed you before accepting this invitation");
    }
    const verifiedEmail = normalizeInvitationEmail(user.email ?? "");
    if (!verifiedEmail || verifiedEmail !== inv.email) {
      throw new Error(
        "This invitation was issued to a different email address than the one verified here",
      );
    }

    // ---- membership invariant via the shared membership-write core ----
    // Identical rules to authorized admin provisioning (one-profile-per-user,
    // no cross-org/suspended bypass, unassigned profiles completed in place —
    // see src/convex/membershipCore.ts).

    // ---- accepted role comes ONLY from the stored invitation ----
    const role = inv.role;
    if (!(PROVISIONABLE_INITIAL_ROLES as readonly string[]).includes(role)) {
      // Structural safety: only a badly-written DB row could get here
      // (the schema validator excludes the admin role already).
      throw new Error(TOKEN_REFUSAL);
    }

    // ---- transactional write: profile + terminal acceptance state ----
    const profileId = await applyInitialMembership(ctx, {
      user,
      organizationId: inv.organizationId,
      initialRole: role,
      ...(inv.jobTitle !== undefined ? { jobTitle: inv.jobTitle } : {}),
      preserveExistingJobTitle: true,
      conflictRefusal: () =>
        "This account already holds an organization membership. Ask your organization's administrator for help.",
    });

    await ctx.db.patch(inv._id, {
      status: "accepted",
      acceptedAt: now,
      acceptedUserId: user._id,
      acceptedProfileId: profileId,
    });

    const targetLabel = user.name ?? user.email ?? "New member";
    await ctx.db.insert("auditLogs", {
      organizationId: inv.organizationId,
      userId: user._id,
      actorId: user._id,
      actorLabel: targetLabel,
      action: "user.invitation_accepted",
      entityType: "organizationInvitations",
      entityId: inv._id,
      summary: `${targetLabel} verified ${verifiedEmail} and accepted the invitation (${role})`,
      createdAt: now,
    });
    await ctx.db.insert("auditLogs", {
      organizationId: inv.organizationId,
      userId: user._id,
      actorId: user._id,
      actorLabel: `${targetLabel} (via verified invitation)`,
      action: "user.membership_provisioned",
      entityType: "userProfiles",
      entityId: profileId,
      summary: `Membership provisioned through verified invitation acceptance with initial role ${role}`,
      createdAt: now,
    });

    return { ok: true as const, role, organizationId: inv.organizationId };
  },
});

// ---------------------------------------------------------------------------
// Trusted test-harness internals (dev deployments only). The internal
// reissue returns the fresh secret ONLY to the token-guarded HTTP route
// (see src/convex/http.ts) so browser tests can complete a REAL recipient
// journey without Production ever exposing links to ordinary sessions.
// ---------------------------------------------------------------------------

export const harnessReissueInvitation = internalMutation({
  args: { invitationId: v.id("organizationInvitations") },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Invitation-link reissue is only available on development deployments");
    }
    const inv = (await ctx.db.get(args.invitationId)) as InvitationDoc | null;
    if (!inv) throw new Error("Invitation not found");
    if (!isReissueable(inv.status) && !isActionable(inv.status)) {
      throw new Error("Invitation is not reissueable");
    }
    if (isExpired(inv, Date.now())) {
      await expireIfDue(ctx, inv, Date.now());
      throw new Error("This invitation has expired");
    }
    const secret = generateInvitationSecret();
    await ctx.db.patch(inv._id, {
      secretHash: sha256Hex(secret),
      status: "pending_delivery",
      deliveryStatus: "not_yet",
      deliveryError: undefined,
      deliveryConfirmedAt: undefined,
    });
    return { secret, email: inv.email, role: inv.role, expiresAt: inv.expiresAt };
  },
});

export const harnessExpireInvitations = internalMutation({
  args: { organizationId: v.optional(v.id("organizations")) },
  handler: async (ctx, args) => {
    if (!guestAuthEnabled()) {
      throw new Error("Invitation expiry sweep is only available on development deployments");
    }
    const now = Date.now();
    const rows: InvitationDoc[] = args.organizationId
      ? await ctx.db
          .query("organizationInvitations")
          .withIndex("by_organization", (q) =>
            q.eq("organizationId", args.organizationId!),
          )
          .collect()
      : await ctx.db.query("organizationInvitations").collect();
    let expired = 0;
    for (const inv of rows) {
      if (isExpired(inv, now)) {
        await expireIfDue(ctx, inv, now);
        expired += 1;
      }
    }
    return { expired };
  },
});
