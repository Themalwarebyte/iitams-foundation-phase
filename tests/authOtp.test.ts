import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  OTP_MAX_AUTOMATIC_ATTEMPTS,
  OTP_NEWEST_CODE_GUIDANCE,
  OTP_RESEND_COOLDOWN_MS,
  canResendOtp,
  classifyOtpRequestFailure,
  otpRequestFailureMessage,
  otpResendRemainingMs,
  requestOtpOnce,
} from "../src/lib/authOtp";

/**
 * Email-OTP request safety (Batch 3 follow-up).
 * ===========================================
 * A failed verification-code request is AMBIGUOUS when it times out: the code
 * may already have been stored and delivered. Because Convex Auth keeps one
 * active code per account, an automatic retry would invalidate the code the
 * user already received. These tests pin the contract:
 *
 *   - a request is attempted exactly once, success or failure;
 *   - transient failures are described generically and never trigger a second
 *     code request;
 *   - permanent failures are never presented as "retry immediately";
 *   - resending is an explicit user action gated by a cooldown;
 *   - no failure message leaks server text or account existence.
 */

describe("email OTP request policy", () => {
  test("a successful request runs exactly once", async () => {
    let calls = 0;
    const result = await requestOtpOnce(async () => {
      calls += 1;
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
    expect(OTP_MAX_AUTOMATIC_ATTEMPTS).toBe(1);
  });

  test("a transient failure is reported without issuing a second code", async () => {
    let calls = 0;
    const result = await requestOtpOnce(async () => {
      calls += 1;
      throw new Error("Function execution timed out (maximum duration: 1s)");
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("transient");
    expect(result.message).toContain("could not confirm");
    expect(result.message).toContain("newest code");
    // No automatic retry: one user action, one code request.
    expect(calls).toBe(OTP_MAX_AUTOMATIC_ATTEMPTS);
  });

  test("a permanent failure is not retried and is described generically", async () => {
    let calls = 0;
    const result = await requestOtpOnce(async () => {
      calls += 1;
      throw new Error("Resend delivery failed (403): sender domain not verified");
    });
    expect(calls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.kind).toBe("permanent");
    expect(result.message).toBe(
      "We could not send a verification code right now. Please try again.",
    );
    // Raw provider configuration never reaches the sign-in surface.
    expect(result.message).not.toContain("403");
    expect(result.message).not.toContain("sender domain");
  });

  test("failure classification separates ambiguous from hard failures", () => {
    expect(classifyOtpRequestFailure("Function execution timed out")).toBe(
      "transient",
    );
    expect(classifyOtpRequestFailure("Server Error")).toBe("transient");
    expect(classifyOtpRequestFailure("fetch failed")).toBe("transient");
    expect(classifyOtpRequestFailure("Invalid email address")).toBe("permanent");
    expect(classifyOtpRequestFailure("Too many requests")).toBe("permanent");
    expect(classifyOtpRequestFailure("Resend delivery failed (401)")).toBe(
      "permanent",
    );
  });

  test("failure messages are account-agnostic", () => {
    for (const message of [
      otpRequestFailureMessage("transient"),
      otpRequestFailureMessage("permanent"),
    ]) {
      expect(message.toLowerCase()).not.toContain("no account");
      expect(message.toLowerCase()).not.toContain("not registered");
      expect(message.toLowerCase()).not.toContain("unknown user");
      expect(message.toLowerCase()).not.toContain("existing account");
    }
  });

  test("the resend cooldown is enforced from the last request", () => {
    const sentAt = 1_000_000;
    expect(otpResendRemainingMs(sentAt, sentAt)).toBe(OTP_RESEND_COOLDOWN_MS);
    expect(otpResendRemainingMs(sentAt, sentAt + 1_000)).toBe(
      OTP_RESEND_COOLDOWN_MS - 1_000,
    );
    expect(otpResendRemainingMs(sentAt, sentAt + OTP_RESEND_COOLDOWN_MS)).toBe(0);
    expect(otpResendRemainingMs(sentAt, sentAt + OTP_RESEND_COOLDOWN_MS + 5)).toBe(
      0,
    );
    expect(otpResendRemainingMs(null, sentAt)).toBe(0);
    // A clock that jumps backwards never grants an early resend.
    expect(otpResendRemainingMs(sentAt, sentAt - 5_000)).toBe(
      OTP_RESEND_COOLDOWN_MS,
    );
  });

  test("resending is an explicit, cooldown-gated user action", () => {
    const sentAt = 1_000_000;
    expect(canResendOtp(sentAt, sentAt + 5_000, false)).toBe(false);
    expect(canResendOtp(sentAt, sentAt + 5_000, true)).toBe(false);
    expect(canResendOtp(sentAt, sentAt + OTP_RESEND_COOLDOWN_MS, false)).toBe(
      true,
    );
    expect(canResendOtp(sentAt, sentAt + OTP_RESEND_COOLDOWN_MS, true)).toBe(
      false,
    );
    expect(canResendOtp(null, sentAt, false)).toBe(true);
  });

  test("the UI explains which code to use when several emails arrive", () => {
    expect(OTP_NEWEST_CODE_GUIDANCE).toContain("newest code");
    expect(OTP_NEWEST_CODE_GUIDANCE).toContain("earlier codes stop working");
  });
});

describe("Auth page wiring", () => {
  const pageSrc = readFileSync("src/pages/Auth.tsx", "utf8");

  test("the sign-in page performs one request per action (no retry loop)", () => {
    expect(pageSrc).toContain("requestOtpOnce");
    expect(pageSrc).not.toContain("maxAttempts");
    expect(pageSrc).not.toContain("attempt++");
    expect(pageSrc).not.toMatch(/for \(let attempt/);
  });

  test("resending is gated by the cooldown and always user-triggered", () => {
    expect(pageSrc).toContain("canResendOtp");
    expect(pageSrc).toContain("otpResendRemainingMs");
    expect(pageSrc).toContain("Resend code");
    expect(pageSrc).toContain("OTP_NEWEST_CODE_GUIDANCE");
  });

  test("raw server errors are never displayed to the user", () => {
    // `setError` never receives a raw exception message directly.
    expect(pageSrc).not.toMatch(/setError\(\s*error instanceof Error/);
    expect(pageSrc).not.toMatch(/setError\(\s*error\.message/);
    expect(pageSrc).toContain("The verification code you entered is incorrect or has expired.");
  });

  test("verification is still performed by the real backend sign-in", () => {
    const verification = pageSrc.slice(pageSrc.indexOf("handleOtpSubmit"));
    expect(verification).toContain('signIn("email-otp", formData)');
  });
});
