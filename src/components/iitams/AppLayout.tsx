import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Loader2, ShieldQuestion, UserCog } from "lucide-react";
import { AppSidebar } from "./AppSidebar";
import { TopBar } from "./TopBar";

function ProvisioningPanel({
  title,
  description,
  showBackHome = false,
}: {
  title: string;
  description: React.ReactNode;
  showBackHome?: boolean;
}) {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-muted">
        {showBackHome ? (
          <UserCog className="size-5 text-muted-foreground" aria-hidden />
        ) : (
          <Loader2 className="size-5 animate-spin text-muted-foreground" aria-hidden />
        )}
      </div>
      <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p>
      {showBackHome && (
        <Button variant="outline" size="sm" asChild className="mt-6">
          <a href="/">Back to overview</a>
        </Button>
      )}
    </div>
  );
}

/**
 * Authenticated shell: sidebar + top bar + content. Every protected IITAMS
 * page renders inside this layout.
 *
 * Provisioning is EXPLICIT (Phase-1 closure): there is no silent server-side
 * fallback to "the first organization". Guest (anonymous) sessions are
 * provisioned into the demo organization through the audited
 * `joinDemoOrganization` mutation, which only ever attaches to the
 * `IITAMS-DEMO` org. Real users without an explicit organization assignment
 * see an "awaiting provisioning" state and receive no tenant data until an
 * administrator assigns them (admin workflow, Phase 2).
 */
export function AppLayout({ children }: { children: React.ReactNode }) {
  const session = useQuery(api.session.getSession);
  const joinDemo = useMutation(api.session.joinDemoOrganization);

  const attemptedRef = useRef(false);
  const [joinFailed, setJoinFailed] = useState(false);

  const awaiting = session?.awaitingProvisioning === true;
  const guestAwaiting = awaiting && session?.isAnonymous === true;

  useEffect(() => {
    if (!guestAwaiting || attemptedRef.current) return;
    attemptedRef.current = true;
    joinDemo({})
      .then((res) => {
        if (!res.joined) setJoinFailed(true);
      })
      .catch((err) => {
        console.error("Demo provisioning failed:", err);
        setJoinFailed(true);
      });
  }, [guestAwaiting, joinDemo]);

  // Session still loading (undefined): render the shell; children handle
  // their own skeleton states.
  if (session === undefined) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main
            id="main-content"
            className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8"
          >
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    );
  }

  // Real (non-anonymous) user without an explicit organization assignment:
  // safe state, no tenant data, no navigation.
  if (awaiting && !guestAwaiting) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main
            id="main-content"
            className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8"
          >
            <ProvisioningPanel
              showBackHome
              title="Account awaiting provisioning"
              description={
                <>
                  <ShieldQuestion className="mr-1.5 inline size-4 align-[-2px]" aria-hidden />
                  Your account is verified, but no organization (MDAC) has been
                  assigned to it yet. For data isolation, IITAMS never guesses
                  your organization — an administrator must assign you to one
                  before module data becomes available.
                </>
              }
            />
          </main>
        </SidebarInset>
      </SidebarProvider>
    );
  }

  // Guest awaiting demo provisioning: run the audited join, show progress.
  if (guestAwaiting) {
    return (
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <TopBar />
          <main
            id="main-content"
            className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8"
          >
            {joinFailed ? (
              <ProvisioningPanel
                showBackHome
                title="Demo workspace unavailable"
                description={
                  <>
                    The demonstration workspace could not be provisioned on
                    this deployment. Guest access requires the
                    <code className="mx-1 rounded bg-muted px-1 py-0.5 text-xs">
                      IITAMS-DEMO
                    </code>
                    organization to exist and guest auth to be enabled.
                  </>
                }
              />
            ) : (
              <ProvisioningPanel
                title="Preparing your demo workspace"
                description="Attaching your guest session to the demonstration organization — synthetic data only, no production records."
              />
            )}
          </main>
        </SidebarInset>
      </SidebarProvider>
    );
  }

  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <TopBar />
        <main
          id="main-content"
          className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8"
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
}
