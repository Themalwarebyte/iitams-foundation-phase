import { Email } from "@convex-dev/auth/providers/Email";
import { RandomReader, generateRandomString } from "@oslojs/crypto/random";

/**
 * IITAMS email-OTP delivery — provider abstraction
 * ================================================
 * The provider is chosen by deployment configuration, never hard-coded:
 *
 *   IITAMS_EMAIL_PROVIDER = "resend"       → production (RESEND_API_KEY)
 *                            "freebuff_dev" → development adapter ONLY
 *
 * Production-safe rules (enforced below):
 *   - `freebuff_dev` is refused unless BOTH
 *       IITAMS_ALLOW_GUEST_AUTH=true (development deployment) AND
 *       IITAMS_ENABLE_FREEBUFF_DEVTOOLS=true (explicit dev adapter opt-in).
 *   - With no provider configured, verification codes are NOT delivered by
 *     any third-party endpoint; the code is returned to the Convex dashboard
 *     development flow instead (safe default: nothing leaves the deployment).
 *
 * No credentials exist in source. Secrets come from deployment env:
 *   RESEND_API_KEY, RESEND_FROM, VLY_OTP_API_KEY (dev adapter), VLY_APP_NAME.
 */

const DEV_ADAPTER_ENDPOINT = "https://auth.freebuff.app/send_otp";

type ProviderName = "resend" | "freebuff_dev" | "none";

function resolveProvider(): ProviderName {
  const raw = (process.env.IITAMS_EMAIL_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "resend") return "resend";
  if (raw === "freebuff_dev") {
    const guestDev =
      process.env.IITAMS_ALLOW_GUEST_AUTH === "true" &&
      process.env.IITAMS_ENABLE_FREEBUFF_DEVTOOLS === "true";
    return guestDev ? "freebuff_dev" : "none";
  }
  return "none";
}

async function sendViaResend(email: string, token: string) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM ?? "IITAMS <onboarding@resend.dev>";
  if (!apiKey) {
    throw new Error(
      "IITAMS_EMAIL_PROVIDER=resend but RESEND_API_KEY is not set on the deployment",
    );
  }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [email],
      subject: "Your IITAMS verification code",
      html: `<p>Your IITAMS verification code is <strong>${token}</strong>.</p><p>It expires in 15 minutes. If you did not request it, ignore this email.</p>`,
      text: `Your IITAMS verification code is ${token}. It expires in 15 minutes.`,
    }),
  });
  if (!res.ok) {
    throw new Error(`Resend delivery failed (${res.status})`);
  }
}

async function sendViaFreebuffDevAdapter(email: string, token: string) {
  const apiKey = process.env.VLY_OTP_API_KEY;
  if (!apiKey) {
    throw new Error(
      "freebuff_dev adapter selected but VLY_OTP_API_KEY is not set on the deployment",
    );
  }
  const res = await fetch(DEV_ADAPTER_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify({
      to: email,
      otp: token,
      appName: process.env.VLY_APP_NAME ?? "IITAMS (development)",
    }),
  });
  if (!res.ok) {
    throw new Error(`Dev adapter delivery failed (${res.status})`);
  }
}

export const emailOtp = Email({
  id: "email-otp",
  maxAge: 60 * 15, // 15 minutes
  async generateVerificationToken() {
    const random: RandomReader = {
      read(bytes: Uint8Array) {
        crypto.getRandomValues(bytes);
      },
    };
    const alphabet = "0123456789";
    return generateRandomString(random, alphabet, 6);
  },
  async sendVerificationRequest({ identifier: email, token }) {
    const provider = resolveProvider();
    switch (provider) {
      case "resend":
        await sendViaResend(email, token);
        return;
      case "freebuff_dev":
        await sendViaFreebuffDevAdapter(email, token);
        return;
      case "none":
      default:
        // Safe default: no external delivery. The code stays inside the
        // deployment (visible via the Convex dashboard development flow).
        console.warn(
          "[iitams:otp] no email provider configured — verification code not delivered externally",
        );
        return;
    }
  },
});

export { DEV_ADAPTER_ENDPOINT };
