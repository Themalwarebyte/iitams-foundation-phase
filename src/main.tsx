import { Toaster } from "@/components/ui/sonner";
import { RequireAuth } from "@/components/RequireAuth";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { ConvexReactClient } from "convex/react";
import React, { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./index.css";

// ---------------------------------------------------------------------------
// Freebuff/Vly development tooling — DEV BUNDLES ONLY. All Vly-specific code
// lives in src/dev/DevTools.tsx, which is dynamically imported only when
// `import.meta.env.DEV` is true. A production build never requests that
// module, so dist/ output contains no Vly/Freebuff code, endpoints or names.
// ---------------------------------------------------------------------------
const DevTools = import.meta.env.DEV
  ? lazy(() => import("./dev/DevTools.tsx").then((m) => ({ default: m.DevTools })))
  : null;
const DevRouteBridge = import.meta.env.DEV
  ? lazy(() => import("./dev/DevTools.tsx").then((m) => ({ default: m.DevRouteBridge })))
  : null;

// Lazy load route components for better code splitting
const Landing = lazy(() => import("./pages/Landing.tsx"));
const AuthPage = lazy(() => import("./pages/Auth.tsx"));
const Dashboard = lazy(() => import("./pages/Dashboard.tsx"));
const ModulePage = lazy(() => import("./pages/ModulePage.tsx"));
const NotFound = lazy(() => import("./pages/NotFound.tsx"));
// Phase 2 audit pages (named exports mapped to default for lazy())
const UniversePage = lazy(() =>
  import("./components/iitams/audit/UniversePage").then((m) => ({
    default: m.UniversePage,
  })),
);
const PlansPage = lazy(() =>
  import("./components/iitams/audit/PlansPage").then((m) => ({
    default: m.PlansPage,
  })),
);
const EngagementsPage = lazy(() =>
  import("./components/iitams/audit/EngagementsPage").then((m) => ({
    default: m.EngagementsPage,
  })),
);
const ProgramsPage = lazy(() =>
  import("./components/iitams/audit/ProgramsPage").then((m) => ({
    default: m.ProgramsPage,
  })),
);
const WorkpapersPage = lazy(() =>
  import("./components/iitams/audit/WorkpapersPage").then((m) => ({
    default: m.WorkpapersPage,
  })),
);
const EvidencePage = lazy(() =>
  import("./components/iitams/audit/EvidencePage").then((m) => ({
    default: m.EvidencePage,
  })),
);
const FindingsPage = lazy(() =>
  import("./components/iitams/audit/FindingsPage").then((m) => ({
    default: m.FindingsPage,
  })),
);
const ActionsPage = lazy(() =>
  import("./components/iitams/audit/ActionsPage").then((m) => ({
    default: m.ActionsPage,
  })),
);
const ReportsPage = lazy(() =>
  import("./components/iitams/audit/ReportsPage").then((m) => ({
    default: m.ReportsPage,
  })),
);

// Simple loading fallback for route transitions
function RouteLoading() {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="animate-pulse text-muted-foreground">Loading IITAMS…</div>
    </div>
  );
}

/** Protected wrapper for the Phase-2 audit module routes. */
function AuditRoute({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth
      title="Sign in to open this module"
      description="IITAMS modules are available to authorized users of your organization."
    >
      {children}
    </RequireAuth>
  );
}

/** Redirect helper for renamed Phase-1 paths. */
function AuditRedirect({ to }: { to: string }) {
  return <Navigate to={to} replace />;
}

/** Hard guard so runtime errors never leave the app as a blank page. */
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
    console.error("[IITAMS] Root crash:", err);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-background text-foreground p-6">
          <div className="max-w-lg text-center">
            <p className="text-sm font-semibold">Application error</p>
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
  // Audit Management (Phase-1 scaffold routes retained for the remaining modules)
  "/audit/management-responses",
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RootErrorBoundary>
      {DevTools && (
        <Suspense fallback={null}>
          <DevTools />
        </Suspense>
      )}
      <ConvexAuthProvider client={convex}>
        <BrowserRouter>
          {DevRouteBridge && (
            <Suspense fallback={null}>
              <DevRouteBridge />
            </Suspense>
          )}
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
              {/* Phase 2 — Core IT Audit Management Engine */}
              <Route path="/audit/universe" element={<AuditRoute><UniversePage path="/audit/universe" /></AuditRoute>} />
              <Route path="/audit/plans" element={<AuditRoute><PlansPage path="/audit/plans" /></AuditRoute>} />
              <Route path="/audit/engagements" element={<AuditRoute><EngagementsPage path="/audit/engagements" /></AuditRoute>} />
              <Route path="/audit/programs" element={<AuditRoute><ProgramsPage path="/audit/programs" /></AuditRoute>} />
              <Route path="/audit/workpapers" element={<AuditRoute><WorkpapersPage path="/audit/workpapers" /></AuditRoute>} />
              <Route path="/audit/evidence" element={<AuditRoute><EvidencePage path="/audit/evidence" /></AuditRoute>} />
              <Route path="/audit/findings" element={<AuditRoute><FindingsPage path="/audit/findings" /></AuditRoute>} />
              <Route path="/audit/actions" element={<AuditRoute><ActionsPage path="/audit/actions" /></AuditRoute>} />
              <Route path="/audit/reports" element={<AuditRoute><ReportsPage path="/audit/reports" /></AuditRoute>} />
              {/* Phase-1 legacy audit paths → Phase-2 spec routes */}
              <Route path="/audit/working-papers" element={<AuditRedirect to="/audit/workpapers" />} />
              <Route path="/audit/corrective-actions" element={<AuditRedirect to="/audit/actions" />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
        <Toaster />
      </ConvexAuthProvider>
    </RootErrorBoundary>
  </StrictMode>,
);
