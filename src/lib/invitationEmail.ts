/**
 * IITAMS invitation email templates (Batch 2C).
 * ===========================================================================
 * Professional invitation email, logically separate from OTP authentication
 * mail. Contains ONLY recipient-appropriate information:
 *   - IITAMS platform identity,
 *   - the inviting organization's name,
 *   - what the invitation is and which initial role it grants,
 *   - the expiration date,
 *   - the secure acceptance link (carries the single-use secret),
 *   - a clear unknown-recipient notice.
 * It NEVER contains: admin contact details, other members, organization
 * internals, permission strings, or any authentication secret.
 */

const BRAND_BG = "#0C3D49";
const BRAND_ACCENT = "#4EB5F5";
const TEXT_MUTED = "#5f6b73";

export interface InvitationEmailParams {
  organizationName: string;
  role: string;
  email: string;
  /** Single-use secret — rendered ONLY inside the acceptance link. */
  secret: string;
  expiresAt: number;
  /** Deployed web origin (env-configured); omitted → relative path only. */
  appOrigin?: string;
  jobTitle?: string;
}

function formatDate(iso: string): string {
  // Provider-safe deterministic formatting (no locale dependence).
  const d = new Date(iso);
  const months = [
    "January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December",
  ];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function invitationAcceptanceUrl(
  params: Pick<InvitationEmailParams, "appOrigin" | "secret">,
): string {
  const prefix = (params.appOrigin ?? "").trim().replace(/\/+$/, "");
  const suffix = `/invite/accept?secret=${encodeURIComponent(params.secret)}`;
  return prefix ? `${prefix}${suffix}` : suffix;
}

export function invitationEmailHtml(p: InvitationEmailParams): string {
  const acceptUrl = invitationAcceptanceUrl(p);
  const roleLine = p.jobTitle
    ? `${p.role}${` · ${p.jobTitle}`}`
    : p.role;
  return `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Segoe UI,Helvetica,Arial,sans-serif;color:#1a2733;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 12px;">
      <tr><td align="center">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(12,61,73,.12);">
          <tr><td style="background:${BRAND_BG};padding:28px 40px;">
            <p style="margin:0;color:#ffffff;font-size:20px;font-weight:700;letter-spacing:.5px;">IITAMS</p>
            <p style="margin:4px 0 0;color:${BRAND_ACCENT};font-size:12px;letter-spacing:1.5px;text-transform:uppercase;">Integrated IT Audit Management System</p>
          </td></tr>
          <tr><td style="padding:36px 40px 8px;">
            <h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;color:#1a2733;">You've been invited to join ${escapeHtml(p.organizationName)}</h1>
            <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#3d4a54;">
              An administrator of <strong>${escapeHtml(p.organizationName)}</strong> has invited you to join their
              organization on IITAMS, the government-grade IT audit, risk and compliance platform.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid #e2e8ee;border-radius:10px;margin:0 0 20px;">
              <tr><td style="padding:14px 18px;border-bottom:1px solid #e2e8ee;">
                <span style="font-size:12px;color:${TEXT_MUTED};">Your intended role</span><br>
                <strong style="font-size:15px;">${escapeHtml(roleLine)}</strong>
              </td></tr>
              <tr><td style="padding:14px 18px;">
                <span style="font-size:12px;color:${TEXT_MUTED};">Invitation sent to</span><br>
                <strong style="font-size:15px;">${escapeHtml(p.email)}</strong>
              </td></tr>
            </table>
            <p style="margin:0 0 22px;font-size:14px;line-height:1.6;color:#3d4a54;">
              To accept, confirm that <strong>${escapeHtml(p.email)}</strong> belongs to you by signing in with the
              email verification code. Your organization membership and role are created only after that
              verification — the invitation link alone never grants access.
            </p>
            ${acceptUrl.startsWith("http") ? `<p style="margin:0 0 28px;">
              <a href="${acceptUrl}" style="display:inline-block;background:${BRAND_BG};color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 28px;border-radius:8px;">Accept invitation</a>
            </p>
            <p style="margin:0 0 6px;font-size:13px;color:${TEXT_MUTED};">If the button doesn't work, copy this address into your browser:</p>
            <p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:${BRAND_BG};">${acceptUrl}</p>` : `
            <p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:${BRAND_BG};">${acceptUrl}</p>`}
            <p style="margin:0;font-size:13px;color:${TEXT_MUTED};">This invitation expires on <strong>${formatDate(new Date(p.expiresAt).toISOString())}</strong>.</p>
          </td></tr>
          <tr><td style="padding:18px 40px 30px;border-top:1px solid #eef2f5;">
            <p style="margin:0;font-size:12px;line-height:1.6;color:${TEXT_MUTED};">
              Not expecting this invitation? You can safely ignore it — nothing happens until you sign in
              and verify your email address, and no account is created for you from this email alone.
            </p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function invitationEmailText(p: InvitationEmailParams): string {
  const url = invitationAcceptanceUrl(p);
  return [
    `IITAMS — invitation to join ${p.organizationName}`,
    "",
    `An administrator of ${p.organizationName} has invited you to join their organization`,
    `on IITAMS, the government-grade IT audit, risk and compliance platform.`,
    "",
    `Intended role: ${p.role}${p.jobTitle ? ` (${p.jobTitle})` : ""}`,
    `Invitation sent to: ${p.email}`,
    `Expires: ${formatDate(new Date(p.expiresAt).toISOString())}`,
    "",
    "To accept, confirm that this address belongs to you by signing in with the",
    "email verification code. Your membership and role are created only after",
    "that verification — the invitation link alone never grants access.",
    "",
    `Accept here: ${url}`,
    "",
    "Not expecting this invitation? You can safely ignore it — nothing happens",
    "until you sign in and verify your email address.",
  ].join("\n");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
