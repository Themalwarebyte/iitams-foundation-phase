/**
 * Email-OTP request policy (shared by the sign-in page and its tests).
 * ==================================================================
 * The email-OTP sign-in action performs the verification-code write and the
 * delivery in one server call. When that call fails with a timeout or a
 * generic server error, completion is AMBIGUOUS: the code may already have
 * been stored (and delivered) or nothing may have happened.
 *
 * Automatically repeating the request in that situation is unsafe:
 *   - Convex Auth keeps exactly ONE active code per account, so a second
 *     request silently invalidates the first code, and the user can end up
 *     holding two emails of which only the newest works;
 *   - a "Server Error" is not necessarily transient (provider
 *     misconfiguration and delivery failures surface the same way);
 *   - a retry loop turns one user action into several code requests, which is
 *     exactly what rate limits exist to prevent.
 *
 * The policy is therefore: NEVER resend automatically. The user decides, and
 * an explicit resend is only offered after a short cooldown. Every message is
 * account-agnostic and never echoes provider or server detail, so it cannot be
 * used to learn whether an address has an account.
 */

/** Cooldown before the user may request another code from the OTP step. */
export const OTP_RESEND_COOLDOWN_MS = 30_000;

/** Must match the provider's `maxAge` in src/convex/auth/emailOtp.ts (15 min). */
export const OTP_CODE_TTL_MS = 15 * 60 * 1000;

/** No code request is ever repeated without a new user action. */
export const OTP_MAX_AUTOMATIC_ATTEMPTS = 1;

export type OtpRequestFailureKind = "transient" | "permanent";

/**
 * Classify a failed request. Only a timeout or generic server failure is
 * ambiguous; everything else (validation, rate limiting, provider errors) is
 * treated as a hard failure and is never presented as "try again immediately".
 */
export function classifyOtpRequestFailure(message: string): OtpRequestFailureKind {
  return /timed out|timeout|Server Error|fetch failed|network error/i.test(message)
    ? "transient"
    : "permanent";
}

/**
 * Message shown after a failed code request. Deliberately generic: it never
 * contains the raw server text (which could disclose provider configuration)
 * and is identical for known and unknown addresses.
 */
export function otpRequestFailureMessage(kind: OtpRequestFailureKind): string {
  return kind === "transient"
    ? "We could not confirm whether the code request completed. If an email arrives, use the newest code — earlier codes stop working. You can resend once the timer ends."
    : "We could not send a verification code right now. Please try again.";
}

/** Guidance shown on the OTP step when more than one email may arrive. */
export const OTP_NEWEST_CODE_GUIDANCE =
  "Each request replaces the previous code. If you receive more than one email, enter the newest code — earlier codes stop working.";

/** Milliseconds left before a resend may be requested (0 when available). */
export function otpResendRemainingMs(
  sentAt: number | null,
  now: number,
  cooldownMs: number = OTP_RESEND_COOLDOWN_MS,
): number {
  if (sentAt === null) return 0;
  const elapsed = now - sentAt;
  if (!Number.isFinite(elapsed) || elapsed >= cooldownMs) return 0;
  return Math.max(0, cooldownMs - Math.max(0, elapsed));
}

/** Whether the explicit "Resend code" control should be enabled. */
export function canResendOtp(
  sentAt: number | null,
  now: number,
  isBusy: boolean,
): boolean {
  return !isBusy && otpResendRemainingMs(sentAt, now) === 0;
}

export type OtpRequestResult =
  | { ok: true }
  | { ok: false; kind: OtpRequestFailureKind; message: string };

/**
 * Perform exactly ONE code request and describe the outcome. There is no retry
 * branch by construction: `request` is invoked once, whether it succeeds or
 * fails. Tests assert this single-invocation contract.
 */
export async function requestOtpOnce(
  request: () => Promise<void>,
): Promise<OtpRequestResult> {
  try {
    await request();
    return { ok: true };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error ?? "");
    const kind = classifyOtpRequestFailure(raw);
    return { ok: false, kind, message: otpRequestFailureMessage(kind) };
  }
}
