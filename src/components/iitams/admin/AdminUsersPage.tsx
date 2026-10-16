import { useMemo, useState } from "react";
import {
  Ban,
  MailPlus,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  UserMinus,
  UserPlus,
  Users,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import { AdminPageShell } from "./AdminShell";
import {
  DataTable,
  EmptyState,
  ListSkeleton,
  SearchFilterBar,
} from "@/components/iitams/audit/ListPageShell";
import type { Column } from "@/components/iitams/audit/ListPageShell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusChip, statusLabel } from "@/components/iitams/badges";
import { formatRelative } from "@/lib/format";
import {
  INITIAL_ROLE_LABELS,
  INVITATION_STATUS_LABELS,
  isValidInvitationEmail,
  MEMBERSHIP_STATUS_LABELS,
  type InvitationStatus,
  type MembershipStatus,
  type ProvisionableInitialRole,
} from "@/lib/membership";

interface DirectoryRow {
  _id: string;
  name: string;
  email: string | null;
  isAnonymous: boolean;
  role: string;
  provisioned: boolean;
  membershipStatus: MembershipStatus;
  jobTitle?: string;
  lastSeenAt?: number;
}

const ROLE_META: Record<string, string> = {
  admin: "Administrator",
  user: "Assurance User",
  member: "Member",
  audit_director: "Audit Director",
  audit_manager: "Audit Manager",
  auditor: "Auditor",
  audit_reviewer: "Audit Reviewer",
  management_user: "Management User",
  executive_viewer: "Executive Viewer",
};

function roleLabel(role: string): string {
  return ROLE_META[role] ?? statusLabel(role);
}

/**
 * Batch 2B — "Add Existing User" form dialog.
 * Administered provisioning of an EXISTING verified IITAMS account into the
 * CURRENT organization with an explicitly selected initial role. The role
 * picker exposes only the server-accepted initial roles (the privileged
 * platform admin role is deliberately excluded); the server re-validates
 * everything and eligibility failures surface as one safe message that
 * never discloses cross-organization membership data. The target email is
 * typed by the administrator — there is no global user search here by
 * design (no enumeration of accounts from other organizations).
 */
function AddExistingUserDialog({
  disabled,
}: {
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProvisionableInitialRole | "">("");
  const [jobTitle, setJobTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);
  const provision = useMutation(api.admin.provisionMember);

  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const emailError = touched && email.trim() !== "" && !emailValid
    ? "Enter a complete email address, e.g. name@agency.go.ke."
    : null;
  const ready = emailValid && role !== "";

  function resetFields() {
    setEmail("");
    setRole("");
    setJobTitle("");
    setConfirming(false);
    setTouched(false);
  }

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      await provision({
        email: email.trim().toLowerCase(),
        initialRole: role as ProvisionableInitialRole,
        ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      });
      toast.success(`${email.trim().toLowerCase()} provisioned with initial role ${INITIAL_ROLE_LABELS[role as ProvisionableInitialRole]}.`);
      setOpen(false);
      resetFields();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Provisioning was refused.",
      );
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetFields();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" disabled={disabled}>
          <UserPlus className="size-4" aria-hidden />
          Add Existing User
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add an existing user</DialogTitle>
          <DialogDescription>
            Provision a verified IITAMS account into your organization with an
            initial role. Only accounts whose email has already been verified
            by sign-in can be provisioned.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="provision-email">Verified user email</Label>
            <Input
              id="provision-email"
              type="email"
              autoComplete="off"
              placeholder="name@agency.go.ke"
              value={email}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "provision-email-error" : undefined}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
            />
            {emailError && (
              <p id="provision-email-error" className="text-xs text-critical">
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provision-role">Initial organization role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as ProvisionableInitialRole)}
            >
              <SelectTrigger id="provision-role" aria-required="true">
                <SelectValue placeholder="Select an initial role…" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(INITIAL_ROLE_LABELS) as ProvisionableInitialRole[]).map(
                  (r) => (
                    <SelectItem key={r} value={r}>
                      {INITIAL_ROLE_LABELS[r]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              The role is validated server-side. Creating another administrator
              is a separately controlled workflow and is not offered here.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="provision-title">Job title (optional)</Label>
            <Input
              id="provision-title"
              value={jobTitle}
              placeholder="e.g. Assurance Officer"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button disabled={!ready || submitting} onClick={() => setConfirming(true)}>
            {submitting ? "Provisioning…" : "Review and provision"}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Confirmation before any write. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm provisioning</AlertDialogTitle>
            <AlertDialogDescription>
              This will add{" "}
              <strong className="text-foreground">{email.trim().toLowerCase()}</strong>{" "}
              to your organization with initial role{" "}
              <strong className="text-foreground">
                {role ? INITIAL_ROLE_LABELS[role] : ""}
              </strong>
              {jobTitle.trim() ? (<> as “{jobTitle.trim()}”</>) : null}
              . The action is server-validated and recorded in the audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void submit()} disabled={submitting}>
              {submitting ? "Provisioning…" : "Confirm provisioning"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/**
 * Batch 2C — "Invite User" form dialog.
 * Sends a VERIFIED-EMAIL invitation to a user who has NOT yet joined the
 * organization (they may still need to register). The invitation never
 * grants anything by itself: the recipient must verify email ownership via
 * the existing email-OTP authentication. Delivery state is reported
 * truthfully — when no email provider is configured the toast and the
 * invitation table say so (no false "sent" success).
 */
function InviteUserDialog({
  disabled,
}: {
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ProvisionableInitialRole | "">("");
  const [jobTitle, setJobTitle] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [touched, setTouched] = useState(false);
  const createInvite = useMutation(api.invitations.createInvitation);

  const normalizedEmail = email.trim().toLowerCase();
  const emailValid = isValidInvitationEmail(email);
  const emailError = touched && normalizedEmail !== "" && !emailValid
    ? "Enter a complete email address, e.g. name@agency.go.ke."
    : null;
  const ready = emailValid && role !== "";

  function resetFields() {
    setEmail("");
    setRole("");
    setJobTitle("");
    setConfirming(false);
    setTouched(false);
  }

  async function submit() {
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      await createInvite({
        email: normalizedEmail,
        role: role as ProvisionableInitialRole,
        ...(jobTitle.trim() ? { jobTitle: jobTitle.trim() } : {}),
      });
      toast.success(
        `Invitation created for ${normalizedEmail} (${INITIAL_ROLE_LABELS[role as ProvisionableInitialRole]}). The recipient must verify their email to accept.`,
      );
      setOpen(false);
      resetFields();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "The invitation was refused.",
      );
    } finally {
      setSubmitting(false);
      setConfirming(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) resetFields();
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" disabled={disabled}>
          <MailPlus className="size-4" aria-hidden />
          Invite User
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a new user</DialogTitle>
          <DialogDescription>
            Invites someone who has not joined your organization yet. They must
            verify their email with a sign-in code before receiving their
            membership and initial role — the link alone never grants access.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email">Invitee email</Label>
            <Input
              id="invite-email"
              type="email"
              autoComplete="off"
              placeholder="name@agency.go.ke"
              value={email}
              aria-invalid={emailError ? true : undefined}
              aria-describedby={emailError ? "invite-email-error" : undefined}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => setTouched(true)}
            />
            {emailError && (
              <p id="invite-email-error" className="text-xs text-critical">
                {emailError}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-role">Initial organization role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as ProvisionableInitialRole)}
            >
              <SelectTrigger id="invite-role" aria-required="true">
                <SelectValue placeholder="Select an initial role…" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(INITIAL_ROLE_LABELS) as ProvisionableInitialRole[]).map(
                  (r) => (
                    <SelectItem key={r} value={r}>
                      {INITIAL_ROLE_LABELS[r]}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Select from the approved initial roles. Creating another
              administrator is a separately controlled workflow and is never
              part of invitations.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="invite-title">Job title (optional)</Label>
            <Input
              id="invite-title"
              value={jobTitle}
              placeholder="e.g. Assurance Officer"
              onChange={(e) => setJobTitle(e.target.value)}
            />
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button disabled={!ready || submitting} onClick={() => setConfirming(true)}>
            {submitting ? "Sending…" : "Review invitation"}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Explicit confirmation before any write, mirroring provisioning. */}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm invitation</AlertDialogTitle>
            <AlertDialogDescription>
              Send an organization invitation to{" "}
              <strong className="text-foreground">{normalizedEmail}</strong> with initial role{" "}
              <strong className="text-foreground">
                {role ? INITIAL_ROLE_LABELS[role] : ""}
              </strong>
              {jobTitle.trim() ? (<> as “{jobTitle.trim()}”</>) : null}
              . The recipient must verify their email address to activate the
              membership. The action is server-validated and recorded in the
              audit log.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Back</AlertDialogCancel>
            <AlertDialogAction onClick={() => void submit()} disabled={submitting}>
              {submitting ? "Sending…" : "Send invitation"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

interface InvitationRow {
  _id: string;
  email: string;
  role: string;
  jobTitle: string | null;
  status: InvitationStatus;
  createdAt: number;
  expiresAt: number;
  deliveryStatus: string;
  deliveryConfirmedAt: number | null;
  deliveryError: string | null;
  deliveryAttempts: number;
  revokedAt: number | null;
  acceptedAt: number | null;
}

/**
 * Batch 2C — organization-scoped invitation management table.
 * Shows this organization's invitations ONLY (server-side scoping), the
 * truthful delivery state, and the authorized actions (revoke/resend) for
 * callers holding `admin.manage`. No secrets, hashes or links are ever
 * rendered here — the acceptance link exists only in the recipient's email.
 */
function InvitationsPanel({ canManage }: { canManage: boolean }) {
  const invites = useQuery(api.invitations.listInvitations, {}) as
    | InvitationRow[]
    | undefined;
  const revoke = useMutation(api.invitations.revokeInvitation);
  const resend = useMutation(api.invitations.resendInvitation);
  const [pendingId, setPendingId] = useState<string | null>(null);

  async function mutate(
    row: InvitationRow,
    action: "revoke" | "resend",
  ) {
    setPendingId(row._id);
    try {
      if (action === "revoke") {
        await revoke({ invitationId: row._id as never });
        toast.success(`Invitation for ${row.email} revoked — the link no longer works.`);
      } else {
        await resend({ invitationId: row._id as never });
        toast.success(
          `A fresh invitation link was issued for ${row.email} — all previous links are now invalid.`,
        );
      }
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : `Invitation ${action} was refused.`,
      );
    } finally {
      setPendingId(null);
    }
  }

  const inviteColumns: Column<InvitationRow>[] = useMemo(
    () => [
      {
        header: "Invited",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{r.email}</p>
            {r.jobTitle && (
              <p className="truncate text-xs text-muted-foreground">{r.jobTitle}</p>
            )}
          </div>
        ),
      },
      {
        header: "Role",
        render: (r) => <span className="text-sm">{INITIAL_ROLE_LABELS[r.role as ProvisionableInitialRole] ?? r.role}</span>,
      },
      {
        header: "Status",
        render: (r) => (
          <div className="flex flex-col items-start gap-1">
            <StatusChip status={r.status} />
            <span className="text-[11px] text-muted-foreground">
              {INVITATION_STATUS_LABELS[r.status]}
            </span>
          </div>
        ),
      },
      {
        header: "Delivery",
        render: (r) => {
          if (r.status === "accepted") {
            return <span className="text-xs text-muted-foreground">Accepted {r.acceptedAt ? formatRelative(r.acceptedAt) : ""}</span>;
          }
          const label =
            r.deliveryStatus === "sent"
              ? `Sent ${r.deliveryConfirmedAt ? formatRelative(r.deliveryConfirmedAt) : ""}`
              : r.deliveryStatus === "failed"
                ? `Not sent${r.deliveryError ? ` — ${r.deliveryError}` : ""}`
                : r.deliveryStatus === "sending"
                  ? "Sending…"
                  : r.deliveryStatus === "not_yet"
                    ? "Not sent yet"
                    : r.deliveryStatus;
          return (
            <span className="text-xs text-muted-foreground">
              {label}
              {r.deliveryError && r.deliveryStatus === "failed" && (
                <span className="mt-0.5 block text-[11px] text-critical">{r.deliveryError}</span>
              )}
            </span>
          );
        },
      },
      {
        header: "Created",
        render: (r) => (
          <span className="text-xs tabular-nums text-muted-foreground">{formatRelative(r.createdAt)}</span>
        ),
      },
      {
        header: "Expires",
        render: (r) => (
          <span className="text-xs tabular-nums text-muted-foreground">{formatRelative(r.expiresAt)}</span>
        ),
      },
      ...(canManage
        ? [
            {
              header: "Manage",
              render: (r: InvitationRow) => {
                const busy = pendingId === r._id;
                if (r.status === "pending" || r.status === "pending_delivery" || r.status === "delivery_failed") {
                  return (
                    <div className="flex items-center gap-1.5">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        title="Issue a fresh link; the previous link stops working (server-enforced, audited)"
                        onClick={() => void mutate(r, "resend")}
                      >
                        <RefreshCw className="size-3.5" aria-hidden />
                        Resend
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busy}
                        title="Revoke this pending invitation (server-enforced, audited)"
                        onClick={() => void mutate(r, "revoke")}
                      >
                        <Ban className="size-3.5" aria-hidden />
                        Revoke
                      </Button>
                    </div>
                  );
                }
                return null;
              },
            } satisfies Column<InvitationRow>,
          ]
        : []),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canManage, pendingId],
  );

  if (invites === undefined) return null;

  return (
    <section className="mt-10">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Invitations</h2>
          <p className="text-sm text-muted-foreground">
            Pending and completed invitations for this organization. The
            recipient activates membership only after verifying their email —
            delivery failures never claim a sent email.
          </p>
        </div>
        <InviteUserDialog disabled={!canManage} />
      </div>
      {invites.length === 0 ? (
        <EmptyState
          icon={MailPlus}
          title="No invitations yet"
          description="Invite a user who has not joined your organization yet — they verify their email with a sign-in code and their membership is created automatically."
        />
      ) : (
        <DataTable columns={inviteColumns} rows={invites} rowKey={(r) => r._id} />
      )}
    </section>
  );
}

/**
 * User directory (Phase 3A — Batch 2A + 2B).
 * Displays name, email, organization membership, role and the real
 * organization-membership lifecycle status for every provisioned profile in
 * the caller's organization. Administrators holding `admin.manage` may
 * suspend, deactivate and reactivate memberships, and provision existing
 * verified users with an initial role; every control is server-enforced
 * and audited. Role changes after provisioning remain out of scope.
 */
export function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const session = useQuery(api.session.getSession);
  const rows = useQuery(api.admin.listUsers, {});
  const setStatus = useMutation(api.admin.setMembershipStatus);

  // Server-side permission decides whether lifecycle controls render; the
  // mutation independently re-checks `admin.manage` (UX gate only).
  const canManage = session?.permissions?.adminManage === true;

  // Role options derive from the live directory (real data, no invented tiers).
  const roleOptions = useMemo(() => {
    if (!rows) return [];
    return [...new Set(rows.map((r) => r.role))].sort().map((r) => ({
      value: r,
      label: roleLabel(r),
    }));
  }, [rows]);

  const statusOptions = useMemo(
    () =>
      (Object.keys(MEMBERSHIP_STATUS_LABELS) as MembershipStatus[]).map(
        (s) => ({ value: s, label: MEMBERSHIP_STATUS_LABELS[s] }),
      ),
    [],
  );

  async function changeMembership(row: DirectoryRow, next: MembershipStatus) {
    setPendingId(row._id);
    try {
      await setStatus({ profileId: row._id as never, status: next });
      toast.success(
        `${row.name} — membership ${next === "active" ? "reactivated" : next}.`,
      );
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Membership change was refused.",
      );
    } finally {
      setPendingId(null);
    }
  }

  const columns: Column<DirectoryRow>[] = useMemo(() => {
    const cols: Column<DirectoryRow>[] = [
      {
        header: "User",
        render: (r) => (
          <div className="min-w-0">
            <p className="truncate font-medium">
              {r.name}
              {r.isAnonymous && (
                <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Guest
                </span>
              )}
            </p>
            {r.jobTitle && (
              <p className="truncate text-xs text-muted-foreground">{r.jobTitle}</p>
            )}
          </div>
        ),
      },
      {
        header: "Email",
        render: (r) => (
          <span className="text-sm text-muted-foreground">{r.email ?? "—"}</span>
        ),
      },
      {
        header: "Organization",
        render: () => (
          <span className="text-sm text-muted-foreground">Current organization</span>
        ),
      },
      {
        header: "Role",
        render: (r) => (
          <span className="text-sm font-medium">{roleLabel(r.role)}</span>
        ),
      },
      {
        // Batch 2A: the real organization-membership lifecycle state —
        // suspended/deactivated members lose server-side org access unless
        // reactivated by an administrator holding admin.manage.
        header: "Membership",
        render: (r) => (
          <StatusChip status={r.provisioned ? r.membershipStatus : "not_started"} />
        ),
      },
      {
        header: "Last seen",
        render: (r) => (
          <span className="text-xs tabular-nums text-muted-foreground">
            {r.lastSeenAt ? formatRelative(r.lastSeenAt) : "—"}
          </span>
        ),
      },
    ];

    if (canManage) {
      cols.push({
        header: "Manage",
        render: (r) => {
          if (!r.provisioned) return null;
          const busy = pendingId === r._id;
          return (
            <div className="flex items-center gap-1.5">
              {r.membershipStatus === "active" ? (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Temporarily suspend this membership (server-enforced, audited)"
                    onClick={() => void changeMembership(r, "suspended")}
                  >
                    <PauseCircle className="size-3.5" aria-hidden />
                    Suspend
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    title="Deactivate this membership (server-enforced, audited)"
                    onClick={() => void changeMembership(r, "deactivated")}
                  >
                    <UserMinus className="size-3.5" aria-hidden />
                    Deactivate
                  </Button>
                </>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Reactivate this membership (server-enforced, audited)"
                  onClick={() => void changeMembership(r, "active")}
                >
                  <PlayCircle className="size-3.5" aria-hidden />
                  Reactivate
                </Button>
              )}
            </div>
          );
        },
      });
    }

    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage, pendingId]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    let out = rows;
    if (search) {
      const q = search.toLowerCase();
      out = out.filter(
        (r) =>
          r.name.toLowerCase().includes(q) ||
          (r.email ?? "").toLowerCase().includes(q) ||
          (r.jobTitle ?? "").toLowerCase().includes(q),
      );
    }
    if (roleFilter) out = out.filter((r) => r.role === roleFilter);
    if (statusFilter) out = out.filter((r) => r.membershipStatus === statusFilter);
    return out;
  }, [rows, search, roleFilter, statusFilter]);

  return (
    <AdminPageShell
      path="/admin/users"
      title="Users"
      description="Directory of provisioned members in your organization — name, email, membership, role and organization-membership status. Administrators can suspend, deactivate and reactivate memberships; every change is authorization-checked server-side and logged in the audit trail."
    >
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          {rows?.length ?? "…"} member{rows?.length === 1 ? "" : "s"} in this organization
        </p>
        <AddExistingUserDialog disabled={!canManage} />
      </div>
      <SearchFilterBar
        search={search}
        onSearch={setSearch}
        searchPlaceholder="Search by name, email or job title…"
        filters={[
          {
            label: "Role",
            value: roleFilter,
            onChange: setRoleFilter,
            options: [{ value: "", label: "All roles" }, ...roleOptions],
          },
          {
            label: "Membership",
            value: statusFilter,
            onChange: setStatusFilter,
            options: [
              { value: "", label: "All memberships" },
              ...statusOptions,
            ],
          },
        ]}
      />

      {rows === undefined ? (
        <ListSkeleton />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Users}
          title={
            search || roleFilter || statusFilter
              ? "No matching users"
              : "No directory members yet"
          }
          description={
            search || roleFilter || statusFilter
              ? "Adjust the search or filters to find directory members."
              : "Users appear here once they are provisioned into your organization with a role assignment."
          }
        />
      ) : (
        <DataTable columns={columns} rows={filtered} rowKey={(r) => r._id} />
      )}

      {/* Batch 2C — organization-scoped invitation management (this org only). */}
      <InvitationsPanel canManage={canManage} />
    </AdminPageShell>
  );
}
