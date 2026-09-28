import '@vly-ai/integrations';
import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { VlyToolbar } from "../vly-toolbar-readonly.tsx";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, useEffect, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes, useLocation } from "react-router";
import "./index.css";

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const ModulePage = lazy(() => import("./pages/ModulePage.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading IITAMS…</div>
    </div>
  );
}

/** Silent error boundary — if VlyToolbar crashes it renders nothing instead of
 *  crashing the whole app (e.g. hook errors in the browser runtime). */
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

/** Hard guard so runtime errors never leave the preview as a blank page. */
class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; message: string; stack: string }
> {
  state = { hasError: false, message: "", stack: "" };
  static getDerivedStateFromError(error: Error) {
    return {
      hasError: true,
      message: error.message || "Unknown runtime error",
      stack: error.stack || "",
    };
  }
  componentDidCatch(err: Error) {
    console.error("[Preview] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Preview runtime error</p>
            <p className="mt-2 text-xs text-muted-foreground break-words">
              {this.state.message}
            </p>
            {this.state.stack && (
              <pre className="mt-3 text-left text-[10px] leading-4 text-muted-foreground/80 max-h-40 overflow-auto rounded border border-border/60 p-2">
                {this.state.stack}
              </pre>
            )}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL as string);

/**
 * Module registry mirroring the sidebar navigation (src/lib/nav.ts).
 * Every route renders the protected ModulePage so deep links land on real,
 * permission-gated pages rather than 404s.
 */
const MODULE_ROUTES = [
  // Overview
  "/workspace",
  "/notifications",
  // Audit Management
  "/audit/universe",
  "/audit/plans",
  "/audit/engagements",
  "/audit/programs",
  "/audit/working-papers",
  "/audit/evidence",
  "/audit/findings",
  "/audit/management-responses",
  "/audit/corrective-actions",
  "/audit/follow-up",
  // ICT Risk
  "/risk/register",
  "/risk/assessments",
  "/risk/treatments",
  "/risk/heat-map",
  "/risk/trends",
  // Compliance
  "/compliance/frameworks",
  "/compliance/controls",
  "/compliance/assessments",
  "/compliance/control-testing",
  "/compliance/evidence-mapping",
  "/compliance/dashboard",
  // Cybersecurity Assurance
  "/cyber/assessments",
  "/cyber/vulnerabilities",
  "/cyber/penetration-tests",
  "/cyber/network-assessments",
  "/cyber/application-security",
  "/cyber/configuration-reviews",
  // Business Continuity
  "/bcm/critical-services",
  "/bcm/bia",
  "/bcm/rto-rpo",
  "/bcm/dr-plans",
  "/bcm/dr-tests",
  "/bcm/lessons-learned",
  // Reports & Analytics
  "/reports/executive",
  "/reports/audit",
  "/reports/risk",
  "/reports/compliance",
  "/reports/cybersecurity",
  "/reports/bcm",
  // Administration
  "/admin/organizations",
  "/admin/users",
  "/admin/roles",
  "/admin/integrations",
  "/admin/system",
  "/admin/audit-logs",
] as const;

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


createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      <ToolbarErrorBoundary>
        <VlyToolbar />
      </ToolbarErrorBoundary>
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          <RouteSyncer />
          <Suspense fallback={<RouteLoading />}>
            <Routes>
              <Route path="/" element={<Landing />} />
              <Route
                path="/auth"
                element={<AuthPage redirectAfterAuth="/dashboard" />}
              />
              <Route
                path="/dashboard"
                element={
                  <RequireAuth
                    title="Sign in to view the Executive Dashboard"
                    description="The IITAMS executive dashboard consolidates audit, risk, compliance, cybersecurity and continuity posture for your organization."
                  >
                    <Dashboard />
                  </RequireAuth>
                }
              />
              {MODULE_ROUTES.map((path) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    <RequireAuth
                      title="Sign in to open this module"
                      description="IITAMS modules are available to authorized users of your organization."
                    >
                      <ModulePage path={path} />
                    </RequireAuth>
                  }
                />
              ))}
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
