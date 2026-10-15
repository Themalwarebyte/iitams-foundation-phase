import React, { Suspense, lazy, useEffect } from "react";
import { useLocation } from "react-router";
import { useConvex } from "convex/react";
import { api } from "../convex/_generated/api";

/**
 * Freebuff/Vly development tooling — DEV-ONLY MODULE.
 * Imported dynamically from main.tsx under `import.meta.env.DEV`, so
 * production builds neither include nor reference this file. It hosts the Vly
 * preview toolbar, the development error-reporting instrumentation and the
 * route-sync bridge used by the Freebuff preview shell.
 */

const VlyToolbar = lazy(() =>
  import("../../vly-toolbar-readonly.tsx").then((m) => ({
    default: m.VlyToolbar,
  })),
);

const InstrumentationProvider = lazy(() =>
  import("../instrumentation.tsx").then((m) => ({
    default: m.InstrumentationProvider,
  })),
);

/** Silent error boundary — a toolbar crash must not take the app down. */
class ToolbarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };
  static getDerivedStateFromError() {
    return { hasError: true };
  }
  componentDidCatch(err: Error) {
    console.warn("[VlyToolbar] Caught error, toolbar disabled:", err.message);
  }
  render() {
    return this.state.hasError ? null : this.props.children;
  }
}

/**
 * Route-sync bridge for the Freebuff preview shell. Mounted inside the
 * Router (see main.tsx) so useLocation() is legal here.
 */
function RouteSyncer() {
  const location = useLocation();
  useEffect(() => {
    window.parent.postMessage(
      { type: "iframe-route-change", path: location.pathname },
      "*",
    );
  }, [location.pathname]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "navigate") {
        if (event.data.direction === "back") window.history.back();
        if (event.data.direction === "forward") window.history.forward();
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  return null;
}

/**
 * DEV-ONLY QA bridge for automated browser tests. Exposes a minimal hook
 * (window.__IITAMS_DEV_QA__) that escalates the current GUEST session to the
 * demo audit-manager tier via the demo-gated mutation, so permission-gated
 * audit workflows can be exercised end-to-end. This module is never part of
 * a production bundle (import.meta.env.DEV-gated import in main.tsx), and
 * the underlying mutation refuses every non-guest/non-demo caller.
 */
function DevQaBridge() {
  const client = useConvex();
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ = {
      async upgradeDemoRole() {
        return await client.mutation(api.session.requestDemoRoleUpgrade, {});
      },
      async becomeDemoAdmin() {
        return await client.mutation(api.session.requestDemoAdminUpgrade, {});
      },
      async whoAmI() {
        return await client.query(api.session.getSession, {});
      },
      async seedVerifiedTestUser(email: string) {
        return await client.mutation(api.session.seedVerifiedTestUser, {
          email,
          name: email.split("@")[0],
        });
      },
      /**
       * DEV-ONLY pending-OTP reader for the browser-test bridge: returns the
       * verification code captured by the email-otp provider's no-delivery
       * branch so tests can complete a REAL email-OTP authentication for a
       * seeded test identity. Backend-gated by api.devOtp.pending (refuses
       * unless guest auth is enabled).
       */
      async pendingOtp(email: string) {
        return await client.query(api.devOtp.pending, { email });
      },
      /**
       * DEV-ONLY authorization probe: attempts an admin.view–guarded query
       * and reports only whether it was DENIED (never returns queried rows).
       * Used by the effective-membership e2e to prove the member's OWN
       * session is refused by the backend authorization boundary.
       */
      async probeAdminApi() {
        try {
          await client.query(api.admin.listUsers, {});
          return { denied: false };
        } catch {
          return { denied: true };
        }
      },
      /**
       * DEV-ONLY authorization probe: attempts to provision the given email
       * and reports ONLY whether the backend REFUSED. Returns no user data.
       * Used by the effective-membership e2e to prove that suspended and
       * deactivated memberships cannot regain access through provisioning.
       */
      async probeProvision(email: string) {
        try {
          await client.mutation(api.admin.provisionMember, {
            email,
            initialRole: "member",
          });
          return { refused: false };
        } catch {
          return { refused: true };
        }
      },
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__;
    };
  }, [client]);
  return null;
}

/** Router-scoped dev bridge; rendered only inside <BrowserRouter>. */
export function DevRouteBridge() {
  return (
    <>
      <RouteSyncer />
      <DevQaBridge />
    </>
  );
}

export function DevTools() {
  return (
    <>
      <ToolbarErrorBoundary>
        <Suspense fallback={null}>
          <VlyToolbar />
        </Suspense>
      </ToolbarErrorBoundary>
      <Suspense fallback={null}>
        <InstrumentationProvider>
          <span style={{ display: "none" }} />
        </InstrumentationProvider>
      </Suspense>
      {/* NOTE: no <RouteSyncer /> here — DevTools renders outside the Router.
          The router-scoped bridge is DevRouteBridge, mounted in main.tsx
          inside <BrowserRouter>. */}
    </>
  );
}
