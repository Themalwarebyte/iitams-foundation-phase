import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import { PageHeader } from "@/components/iitams/PageHeader";
import { RequireAuth } from "@/components/RequireAuth";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { Loader2, ShieldAlert, ShieldCheck, Clock, X } from "lucide-react";

/**
 * /privilege-requests — recipient-side administrator-grant review (Batch A1).
 * ==========================================================================
 * The recipient's OWN authenticated decision point for pending administrator
 * grants. Authorization reality: only the grant's intended target can accept
 * or reject (server-side; the grant id is refused for any other authenticated
 * user), confirmation never changes a role unless the backend validates the
 * pending grant, and an expired grant can promote nobody.
 */

interface PendingGrant {
  _id: string;
  initiatorLabel: string;
  previousRole: string;
  requestedAt: number;
  expiresAt: number;
  expired: boolean;
}

function when(ts: number): string {
  return new Date(ts).toLocaleString();
}

function GrantRequests() {
  const grants = useQuery(api.adminLifecycle.myPendingAdministratorGrants, {});
  const accept = useMutation(api.adminLifecycle.acceptAdministratorGrant);
  const reject = useMutation(api.adminLifecycle.rejectAdministratorGrant);

  const [busy, setBusy] = useState<string | null>(null);
  const [toAccept, setToAccept] = useState<PendingGrant | null>(null);
  const [toReject, setToReject] = useState<PendingGrant | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function confirmAccept() {
    if (!toAccept) return;
    setBusy(toAccept._id);
    setError(null);
    try {
      await accept({ grantId: toAccept._id as never });
      setDone(
        "Administrator privileges are active. Reload the dashboard to see your new role.",
      );
    } catch (e) {
      setError(String(e).replace(/^Error: |^Uncaught Error: /, ""));
    } finally {
      setBusy(null);
      setToAccept(null);
    }
  }

  async function confirmReject() {
    if (!toReject) return;
    setBusy(toReject._id);
    setError(null);
    try {
      await reject({ grantId: toReject._id as never });
      setDone("Request declined. Your role is unchanged.");
    } catch (e) {
      setError(String(e).replace(/^Error: |^Uncaught Error: /, ""));
    } finally {
      setBusy(null);
      setToReject(null);
    }
  }

  if (grants === undefined) {
    return (
      <AppLayout>
        <PageHeader
          eyebrow="Privilege requests"
          title="Administrator grant requests"
          description="Pending privilege requests addressed to you."
        />
        <div className="flex min-h-[30vh] items-center justify-center" aria-busy="true">
          <Loader2 className="size-6 animate-spin text-muted-foreground" aria-hidden />
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout>
      <PageHeader
        eyebrow="Privilege requests"
        title="Administrator grant requests"
        description="Review pending requests to grant you the platform administrator role. Privileges activate only after YOUR explicit confirmation — rejecting or ignoring a request changes nothing."
      />

      <div className="mx-auto max-w-2xl space-y-4">
        {error && (
          <Card className="border-critical/30">
            <CardContent className="pt-4 text-sm text-critical">{error}</CardContent>
          </Card>
        )}
        {done && (
          <Card className="border-primary/30">
            <CardContent className="pt-4 text-sm">{done}</CardContent>
          </Card>
        )}

        {grants.length === 0 ? (
          <Card className="border-dashed shadow-none">
            <CardHeader className="text-center">
              <div className="mx-auto mb-2 flex size-12 items-center justify-center rounded-full bg-muted">
                <ShieldCheck className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <CardTitle className="text-base">No pending requests</CardTitle>
              <CardDescription>
                When an administrator requests to grant you the platform
                administrator role, it appears here for your confirmation.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          grants.map((g) => (
            <Card key={g._id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="flex items-center gap-2 text-base">
                      <ShieldAlert className="size-4 text-warning" aria-hidden />
                      Administrator grant requested
                    </CardTitle>
                    <CardDescription>
                      Requested by <strong>{g.initiatorLabel}</strong> on {when(g.requestedAt)}
                    </CardDescription>
                  </div>
                  {g.expired && (
                    <span className="inline-flex shrink-0 items-center rounded-full border border-critical/25 bg-critical/10 px-2 py-0.5 text-[11px] font-medium text-critical">
                      Expired
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <ul className="space-y-1 text-sm text-muted-foreground">
                  <li>
                    Effect: you would become a{" "}
                    <strong>Platform Administrator</strong> (previous role{" "}
                    {g.previousRole}, restored verbatim if the privilege is later revoked).
                  </li>
                  <li>
                    Confirmation window closes {when(g.expiresAt)} — expired
                    requests never activate.
                  </li>
                </ul>
                {!g.expired && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setToAccept(g)} disabled={busy !== null}>
                      Review &amp; accept
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setToReject(g)}
                      disabled={busy !== null}
                    >
                      <X className="size-3.5" aria-hidden />
                      Decline
                    </Button>
                  </div>
                )}
                {busy === g._id && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true">
                    <Loader2 className="size-3 animate-spin" aria-hidden /> Submitting your decision…
                  </p>
                )}
              </CardContent>
            </Card>
          ))
        )}

        <AlertDialog open={!!toAccept} onOpenChange={(o) => !o && setToAccept(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Accept administrator privileges?</AlertDialogTitle>
              <AlertDialogDescription>
                This grants your account the platform administrator role for
                your organization, effective immediately. Requested by{" "}
                {toAccept?.initiatorLabel}. Your previous role (
                {toAccept?.previousRole}) is preserved in the audit record and
                restored verbatim if an administrator later revokes this privilege.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy !== null}>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void confirmAccept()} disabled={busy !== null}>
                Confirm acceptance
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Dialog open={!!toReject} onOpenChange={(o) => !o && setToReject(null)}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Clock className="size-4" aria-hidden /> Decline this grant?
              </DialogTitle>
              <DialogDescription>
                No privilege change happens. The requesting administrator is
                notified and the request closes as declined.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setToReject(null)} disabled={busy !== null}>
                Keep reviewing
              </Button>
              <Button variant="destructive" size="sm" onClick={() => void confirmReject()} disabled={busy !== null}>
                Decline request
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </AppLayout>
  );
}

export default function PrivilegeRequestsPage() {
  return (
    <RequireAuth
      title="Sign in to review privilege requests"
      description="Administrator-grant confirmations are tied to your own verified account."
    >
      <GrantRequests />
    </RequireAuth>
  );
}
