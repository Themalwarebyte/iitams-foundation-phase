import React, { Suspense, lazy, useEffect } from "react";
import { useLocation } from "react-router";

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

/** Router-scoped dev bridge; rendered only inside <BrowserRouter>. */
export function DevRouteBridge() {
  return <RouteSyncer />;
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
