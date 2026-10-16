import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import {
  BadgeCheck,
  CircleAlert,
  Building2,
  MailPlus,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatRelative } from "@/lib/format";
import { sha256Hex } from "@/lib/sha256";
import { normalizeInvitationEmail } from "@/lib/membership";

/**
 * Batch 2C — /invite/accept.
 * ===========================================================================
 * Recipient journey: link (contains the one-time secret) → the secret is
 * hashed CLIENT-SIDE and removed from the URL immediately (history
 * replacement) — the plaintext secret never goes to analytics, referrers,
 * the app's Convex functions, or any third party; only its hash does.
 *
 * The hash is kept in sessionStorage across the sign-in navigation (the
 * hash alone is useless for granting anything). Organization name and the
 * intended role are shown ONLY after the backend's hash validation.
 * Acceptance requires the signed-in, email-verified identity whose verified
 * email exactly matches the invited address (the server re-validates
 * everything; the UI is never authoritative).
 */

const INVITE_HASH_STORAGE_KEY = "iitams:inviteHash";

/** Uniform, information-free refusal we may show without a server round-trip. */
const LOCAL_TOKEN_REFUSAL = "This invitation is invalid, expired or already used";

type InspectResult =
  | { valid: true; organizationName: string; intendedRole: string; invitedEmail: string; jobTitle: string | null; expiresAt: number }
  | { valid: false; reason: string };

export function InviteAcceptPage() {
  const navigate = useNavigate();
  const accept = useMutation(api.invitations.acceptInvitation);
  // One-time hash read + URL strip as a lazy state initializer (not an
  // effect): the secret is hashed CLIENT-SIDE and removed from the visible
  // URL on first render; only the hash ever reaches the backend or storage.
  const [secretHash] = useState<string | null>(() => {
    try {
      const url = new URL(window.location.href);
      const secret = url.searchParams.get("secret");
      if (secret) {
        url.searchParams.delete("secret");
        window.history.replaceState(null, "", url.pathname + url.search);
        const hash = sha256Hex(secret);
        try {
          sessionStorage.setItem(INVITE_HASH_STORAGE_KEY, hash);
        } catch {
          /* storage unavailable: single-visit flow still works */
        }
        return hash;
      }
      const stored = sessionStorage.getItem(INVITE_HASH_STORAGE_KEY);
      if (stored && /^[a-f0-9]{64}$/.test(stored)) return stored;
      return null;
    } catch {
      return null;
    }
  });
  const noSecret = secretHash === null;
  const [accepting, setAccepting] = useState(false);

  const session = useQuery(api.session.getSession);
  const inspection = useQuery(
    api.invitations.inspectInvitation,
    secretHash ? { secretHash: secretHash as never } : "skip",
  ) as InspectResult | undefined;

  async function acceptNow() {
    if (secretHash === null || accepting) return;
    setAccepting(true);
    try {
      await accept({ secretHash: secretHash as never });
      try {
        sessionStorage.removeItem(INVITE_HASH_STORAGE_KEY);
      } catch { /* ignore */ }
      toast.success("Invitation accepted — welcome to IITAMS.");
      navigate("/dashboard", { replace: true });
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : LOCAL_TOKEN_REFUSAL,
      );
    } finally {
      setAccepting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Render states
  // ---------------------------------------------------------------------------

  if (noSecret) {
    return (
      <InviteCard title="This is an IITAMS invitation page">
        <StateBlock
          icon={<CircleAlert className="size-8 text-muted-foreground" />}
          text={
            "No invitation was found on this page. Open the acceptance link from " +
            "your invitation email, or ask your organization's administrator to " +
            "resend the invitation."
          }
        />
      </InviteCard>
    );
  }

  if (inspection === undefined) {
    return (
      <InviteCard title="Reading your invitation…">
        <p className="text-sm text-muted-foreground">Validating the invitation link…</p>
      </InviteCard>
    );
  }

  if (!inspection.valid) {
    return (
      <InviteCard title="IITAMS invitation">
        <StateBlock
          icon={<CircleAlert className="size-8 text-muted-foreground" />}
          text={inspection.reason || LOCAL_TOKEN_REFUSAL}
        />
        <p className="mt-4 text-xs text-muted-foreground">
          If you believe this is an error, contact the administrator who sent the
          invitation — they can review and resend it from Administration → Users.
        </p>
      </InviteCard>
    );
  }

  const invitedEmail = normalizeInvitationEmail(inspection.invitedEmail);
  const sessionEmail = session ? normalizeInvitationEmail(session.email ?? "") : null;
  const isGuest = !session || session === null ? false : session.isAnonymous;
  const emailMatches = sessionEmail !== null && sessionEmail === invitedEmail;
  const signedOut = session === undefined ? false : session === null;

  return (
    <InviteCard title="You've been invited to IITAMS">
      <div className="space-y-4">
        <div className="rounded-lg border bg-muted/30 p-4">
          <div className="flex items-start gap-3">
            <Building2 className="mt-0.5 size-5 text-muted-foreground" aria-hidden />
            <div className="min-w-0 space-y-1">
              <p className="text-sm text-muted-foreground">Inviting organization</p>
              <p className="truncate font-semibold">{inspection.organizationName}</p>
            </div>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">Intended role</dt>
              <dd className="font-medium">{inspection.intendedRole}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Invited address</dt>
              <dd className="truncate font-medium">{inspection.invitedEmail}</dd>
            </div>
            {inspection.jobTitle && (
              <div className="col-span-2">
                <dt className="text-xs text-muted-foreground">Job title</dt>
                <dd className="font-medium">{inspection.jobTitle}</dd>
              </div>
            )}
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Expires</dt>
              <dd className="font-medium">{formatRelative(inspection.expiresAt)}</dd>
            </div>
          </dl>
        </div>

        <p className="text-xs leading-relaxed text-muted-foreground">
          {signedOut ? (
            "IITAMS verifies that you own this email address before creating your membership or granting any role. The invitation link alone never grants access."
          ) : isGuest ? (
            "You are currently in a guest session. Guest sessions cannot accept invitations — sign out and continue with the invited email address."
          ) : !emailMatches ? (
            sessionEmail === undefined
              ? "Loading your session…"
              : `You are signed in as ${sessionEmail}. Sign out and sign in with the invited address (${inspection.invitedEmail}) to accept this invitation.`
          ) : (
            `Your verified email ${inspection.invitedEmail} matches the invitation. Confirming creates your ${inspection.intendedRole} membership — no additional administrator step is needed.`
          )}
        </p>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-4" aria-hidden />
            Email-verified acceptance
          </span>
          {signedOut ? (
            <Button asChild>
              <Link to="/auth?returnTo=%2Finvite%2Faccept">
                <MailPlus className="size-4" aria-hidden />
                Verify your email and continue
              </Link>
            </Button>
          ) : emailMatches && !isGuest ? (
            <Button onClick={() => void acceptNow()} disabled={accepting}>
              <BadgeCheck className="size-4" aria-hidden />
              {accepting ? "Accepting…" : "Confirm and join"}
            </Button>
          ) : (
            <Button asChild variant="outline">
              <Link to="/auth">Continue with the invited email</Link>
            </Button>
          )}
        </div>

        {emailMatches && !isGuest && (
          <p className="text-xs text-muted-foreground">
            Troubleshooting: if acceptance is refused because membership already
            exists, your account belongs to another organization — contact your
            administrator.
          </p>
        )}
      </div>
    </InviteCard>
  );
}

function InviteCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10">
      <Card className="w-full max-w-lg">
        <CardHeader className="pb-0">
          <div className="flex items-center gap-2">
            <div className="rounded-md bg-primary px-2 py-1 text-sm font-bold tracking-wide text-primary-foreground">
              IITAMS
            </div>
            <span className="rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Organization invitation
            </span>
          </div>
          <h1 className="mt-3 text-xl font-semibold">{title}</h1>
        </CardHeader>
        <CardContent className="pt-2">{children}</CardContent>
      </Card>
    </div>
  );
}

function StateBlock({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-6 text-center">
      {icon}
      <p className="max-w-sm text-sm leading-relaxed text-muted-foreground">{text}</p>
    </div>
  );
}
