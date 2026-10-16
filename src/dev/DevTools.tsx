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
 * (window.__IITAMS_DEV_QA__) with session inspection and authorization
 * PROBES only — it deliberately contains NO privilege-escalation helpers.
 * Role elevation for permission-gated e2e journeys is performed by the
 * TRUSTED TEST RUNNER via the token-guarded server-side harness
 * (src/convex/http.ts: POST /api/dev-grant-demo-role) after the runner reads
 * the guest's own userId through whoAmI(); the tester secret never enters
 * the browser. This module is never part of a production bundle
 * (import.meta.env.DEV-gated import in main.tsx).
 */
function DevQaBridge() {
  const client = useConvex();
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__IITAMS_DEV_QA__ = {
      async whoAmI() {
        return await client.query(api.session.getSession, {});
      },
      // NOTE (Batch 2B hardening + demo-escalation hardening): NO OTP,
      // test-identity or privilege-escalation helpers here. The bridge
      // deliberately exposes no function that can read any user's
      // verification code, mint verified identities, or elevate the guest's
      // own role — all three live behind the trusted, token-guarded
      // server-side test harness (src/convex/http.ts: POST /api/dev-otp,
      // POST /api/dev-seed-test-user, POST /api/dev-grant-demo-role) and are
      // invoked directly by the trusted test runner, never through the
      // browser.
      //
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
