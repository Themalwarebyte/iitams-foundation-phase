import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * Preview owner access — structural guards.
 * ========================================
 * The documented operator procedure is the ONLY path that may establish an
 * owner administrator outside the normal lifecycle. These guards pin its
 * safety properties so a later refactor cannot quietly turn it into a public
 * privilege-escalation endpoint:
 *
 *  - internal mutation only (no client/HTTP surface);
 *  - double gate (deployment flag + high-entropy operator token);
 *  - non-production only (target organization must be `isDemo`);
 *  - identity is proven by the normal email-OTP flow (verified, non-anonymous);
 *  - one-profile invariant preserved (no cross-organization migration);
 *  - the one-time bootstrap and invitations are never touched;
 *  - the promotion is audited as an operator action.
 */

const src = readFileSync("src/convex/previewOwner.ts", "utf8");
const httpSrc = readFileSync("src/convex/http.ts", "utf8");
const docs = readFileSync("docs/PREVIEW_OWNER_ACCESS.md", "utf8");

describe("Preview owner procedure — structural guards", () => {
  test("is an internal mutation with no client or HTTP surface", () => {
    expect(src).toContain("export const establishPreviewOwner = internalMutation({");
    expect(src).toMatch(/import \{ internalMutation \} from "\.\/_generated\/server"/);
    expect(src).not.toContain("export const establishPreviewOwner = mutation(");
    expect(httpSrc).not.toContain("establishPreviewOwner");
    expect(httpSrc).not.toContain("previewOwner");
  });

  test("requires the deployment flag AND a high-entropy operator token", () => {
    expect(src).toContain('process.env.IITAMS_OWNER_PROVISIONING_ENABLED !== "true"');
    expect(src).toContain("IITAMS_OWNER_PROVISIONING_TOKEN");
    expect(src).toContain("expected.length < 24");
    expect(src).toContain("args.operatorToken !== expected");
  });

  test("refuses any organization that is not explicitly a demo/preview org", () => {
    expect(src).toContain("org.isDemo !== true");
    expect(src).toContain("explicitly demo/preview organization");
  });

  test("requires a verified, non-anonymous account and preserves one-membership", () => {
    expect(src).toContain("user.isAnonymous === true");
    expect(src).toContain("!user.emailVerificationTime");
    expect(src).toContain('existing.organizationId !== org._id');
    expect(src).toContain("already belongs to another organization");
  });

  test("never touches the bootstrap invariant or invitations, and is audited", () => {
    // Strip comments first: the docblock names the tables it promises not to
    // touch, so only executable references count.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("initialBootstraps");
    expect(code).not.toContain("invitations");
    expect(code).not.toContain("administratorGrants");
    expect(src).toContain("admin.preview_owner_established");
    expect(src).toContain("Deployment operator (CLI preview provisioning)");
  });

  test("the runbook documents the one-shot lifecycle in the right order", () => {
    const enable = docs.indexOf("npx convex env set IITAMS_OWNER_PROVISIONING_ENABLED true");
    const run = docs.indexOf("npx convex run previewOwner:establishPreviewOwner");
    const disable = docs.indexOf("npx convex env unset IITAMS_OWNER_PROVISIONING_ENABLED");
    expect(enable).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(enable);
    expect(disable).toBeGreaterThan(run);
    // Provider acceptance is distinguished from actual receipt.
    expect(docs).toContain("Provider acceptance is not inbox receipt");
    // OTP-only: the runbook may state that no passwords exist, but must never
    // instruct an operator to set or supply one.
    expect(docs).not.toMatch(/(set|create|choose|assign|reset|enter|use)\s+(a\s+)?password/i);
  });
});
