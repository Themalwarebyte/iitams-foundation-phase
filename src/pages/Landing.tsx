import { motion, useReducedMotion } from "framer-motion";
import { Link } from "react-router";
import {
  ArrowRight,
  Activity,
  BarChart3,
  ClipboardCheck,
  FileText,
  Menu,
  Network,
  Shield,
  ShieldCheck,
  Waypoints,
  X,
} from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { VisualBackground } from "@/components/VisualBackground";
import { useAuth } from "@/hooks/use-auth";
import logo from "@/assets/logo.svg";
import bgFibre from "@/assets/bg-fibre-network.svg";
import bgDatacentre from "@/assets/bg-datacentre.svg";

const CAPABILITIES = [
  {
    icon: ClipboardCheck,
    title: "Audit Management",
    description:
      "From the audit universe through risk-based plans, engagements, working papers and findings to corrective-action follow-up.",
  },
  {
    icon: Waypoints,
    title: "ICT Risk Management",
    description:
      "A living risk register with 5×5 assessments, treatment tracking, heat maps and quarterly trend analytics.",
  },
  {
    icon: ShieldCheck,
    title: "Compliance Monitoring",
    description:
      "Frameworks such as ISO 27001, NIST CSF and the Data Protection Act 2019 mapped to a testable control library.",
  },
  {
    icon: Shield,
    title: "Cybersecurity Assurance",
    description:
      "Security assessments, vulnerability management, penetration testing and configuration reviews in one assurance view.",
  },
  {
    icon: Activity,
    title: "Business Continuity",
    description:
      "Critical services, business impact analysis, RTO/RPO tracking, DR plans, tests and lessons learned.",
  },
  {
    icon: BarChart3,
    title: "Executive Reporting",
    description:
      "Board-ready dashboards and exportable reports that consolidate audit, risk, compliance, cyber and BCM posture.",
  },
];

const ASSURANCE_STATS = [
  { value: "8", label: "Integrated modules" },
  { value: "5×5", label: "Risk model" },
  { value: "4", label: "Classification levels" },
  { value: "100%", label: "Self-hostable" },
];

const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.55,
      delay: i * 0.08,
      ease: [0.21, 0.65, 0.36, 1] as [number, number, number, number],
    },
  }),
};

export default function Landing() {
  const { isAuthenticated, isLoading } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  const primaryCta = isAuthenticated ? "Open dashboard" : "Request access";
  const primaryHref = isAuthenticated ? "/dashboard" : "/auth";

  return (
    <div className="min-h-screen bg-background">
      {/* Top navigation */}
      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/75">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <Link to="/" className="flex items-center gap-2.5 cursor-pointer">
            <img src={logo} alt="IITAMS" className="size-8 rounded-md" />
            <span className="text-lg font-bold tracking-tight">IITAMS</span>
            <span className="hidden text-[10px] font-semibold uppercase tracking-widest text-muted-foreground md:inline">
              ICT Audit & Assurance
            </span>
          </Link>

          <nav className="hidden items-center gap-6 text-sm font-medium md:flex" aria-label="Primary">
            <a href="#capabilities" className="text-muted-foreground transition-colors hover:text-foreground">
              Capabilities
            </a>
            <a href="#modules" className="text-muted-foreground transition-colors hover:text-foreground">
              Modules
            </a>
            <a href="#assurance" className="text-muted-foreground transition-colors hover:text-foreground">
              Assurance
            </a>
          </nav>

          <div className="flex items-center gap-2">
            {!isLoading && isAuthenticated && (
              <Button asChild size="sm" className="cursor-pointer">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            )}
            {!isLoading && !isAuthenticated && (
              <>
                <Button asChild variant="ghost" size="sm" className="hidden cursor-pointer sm:inline-flex">
                  <Link to="/auth">Sign in</Link>
                </Button>
                <Button asChild size="sm" className="cursor-pointer">
                  <Link to="/auth">Request access</Link>
                </Button>
              </>
            )}
            <button
              type="button"
              className="inline-flex size-9 items-center justify-center rounded-md border border-border/70 cursor-pointer md:hidden"
              aria-expanded={menuOpen}
              aria-controls="mobile-nav"
              aria-label={menuOpen ? "Close menu" : "Open menu"}
              onClick={() => setMenuOpen((v) => !v)}
            >
              {menuOpen ? <X className="size-4" /> : <Menu className="size-4" />}
            </button>
          </div>
        </div>
        {menuOpen && (
          <nav
            id="mobile-nav"
            aria-label="Mobile"
            className="border-t border-border/60 bg-background px-4 py-3 md:hidden"
          >
            <a href="#capabilities" onClick={() => setMenuOpen(false)} className="block py-2 text-sm font-medium">
              Capabilities
            </a>
            <a href="#modules" onClick={() => setMenuOpen(false)} className="block py-2 text-sm font-medium">
              Modules
            </a>
            <a href="#assurance" onClick={() => setMenuOpen(false)} className="block py-2 text-sm font-medium">
              Assurance
            </a>
            <Link to="/auth" className="block py-2 text-sm font-medium text-primary">
              Sign in / Request access
            </Link>
          </nav>
        )}
      </header>

      <main id="main-content">
        {/* Hero on the interactive background */}
        <section className="relative">
          <VisualBackground
            className="min-h-[560px] lg:min-h-[640px]"
            particles
            images={[bgFibre, bgDatacentre]}
            ariaLabel="Abstract illustration of national fibre network and data-centre infrastructure"
          >
            <div className="mx-auto flex max-w-7xl flex-col justify-center px-4 py-24 sm:px-6 lg:px-8 lg:py-28">
              <motion.div
                initial="hidden"
                animate="visible"
                custom={0}
                variants={prefersReducedMotion ? undefined : fadeUp}
              >
                <Badge
                  variant="outline"
                  className="gap-2 border-white/25 bg-white/10 text-white backdrop-blur"
                >
                  <ShieldCheck className="size-3.5" aria-hidden />
                  Integrated ICT Governance & Assurance
                </Badge>
              </motion.div>
              <motion.h1
                initial="hidden"
                animate="visible"
                custom={1}
                variants={prefersReducedMotion ? undefined : fadeUp}
                className="mt-5 max-w-3xl text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-5xl lg:text-6xl"
              >
                Unified assurance for Kenya&apos;s digital government
              </motion.h1>
              <motion.p
                initial="hidden"
                animate="visible"
                custom={2}
                variants={prefersReducedMotion ? undefined : fadeUp}
                className="mt-5 max-w-2xl text-base leading-7 text-white/75 sm:text-lg sm:leading-8"
              >
                IITAMS is a unified ICT governance and assurance platform for
                risk-based IT auditing, cybersecurity assurance, ICT risk
                management, compliance monitoring, vulnerability management and
                business continuity oversight across ministries, departments,
                agencies and counties.
              </motion.p>
              <motion.div
                initial="hidden"
                animate="visible"
                custom={3}
                variants={prefersReducedMotion ? undefined : fadeUp}
                className="mt-8 flex flex-wrap items-center gap-3"
              >
                <Button asChild size="lg" className="cursor-pointer bg-white text-ink hover:bg-white/90">
                  <Link to={primaryHref}>
                    {primaryCta}
                    <ArrowRight className="ml-2 size-4" aria-hidden />
                  </Link>
                </Button>
                <Button
                  asChild
                  size="lg"
                  variant="outline"
                  className="cursor-pointer border-white/30 bg-transparent text-white hover:bg-white/10 hover:text-white"
                >
                  <a href="#capabilities">Explore capabilities</a>
                </Button>
              </motion.div>
              <motion.dl
                initial="hidden"
                animate="visible"
                custom={4}
                variants={prefersReducedMotion ? undefined : fadeUp}
                className="mt-14 grid max-w-2xl grid-cols-2 gap-6 sm:grid-cols-4"
              >
                {ASSURANCE_STATS.map((s) => (
                  <div key={s.label}>
                    <dt className="order-2 text-xs font-medium uppercase tracking-wide text-white/60">
                      {s.label}
                    </dt>
                    <dd className="order-1 text-2xl font-bold tracking-tight text-white">
                      {s.value}
                    </dd>
                  </div>
                ))}
              </motion.dl>
            </div>
          </VisualBackground>
        </section>

        {/* Capability pillars */}
        <section id="capabilities" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-widest text-primary">
              Capabilities
            </p>
            <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
              One platform across the assurance lifecycle
            </h2>
            <p className="mt-4 text-base leading-7 text-muted-foreground">
              Six integrated domains replace scattered spreadsheets and point
              tools, giving audit committees and ICT leadership a single,
              evidence-backed view of technology risk.
            </p>
          </div>
          <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {CAPABILITIES.map((cap, i) => {
              const Icon = cap.icon;
              return (
                <motion.div
                  key={cap.title}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 20 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, margin: "-60px" }}
                  transition={{ duration: 0.45, delay: (i % 3) * 0.08 }}
                >
                  <Card className="h-full border-border/70 shadow-none transition-colors hover:border-primary/40">
                    <CardHeader>
                      <div className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        <Icon className="size-5" aria-hidden />
                      </div>
                      <CardTitle className="text-lg tracking-tight">{cap.title}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <CardDescription className="text-sm leading-6">
                        {cap.description}
                      </CardDescription>
                    </CardContent>
                  </Card>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* Module surface band */}
        <section id="modules" className="border-y border-border/60 bg-muted/40">
          <div className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
            <div className="grid items-start gap-10 lg:grid-cols-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-widest text-primary">
                  Inside the platform
                </p>
                <h2 className="mt-2 text-3xl font-bold tracking-tight sm:text-4xl">
                  Built for the way government assurance actually works
                </h2>
                <p className="mt-4 text-base leading-7 text-muted-foreground">
                  Multi-organization (MDAC) context, permission-aware navigation,
                  immutable audit logging and a documented 5×5 risk model —
                  engineered for public-sector accountability from the first commit.
                </p>
                <ul className="mt-8 space-y-4">
                  {[
                    {
                      icon: Network,
                      title: "Organization & MDAC aware",
                      body: "Every record is scoped to a ministry, department, agency or county with strict tenant isolation.",
                    },
                    {
                      icon: ShieldCheck,
                      title: "Permission-aware navigation",
                      body: "Users see only the modules their role grants — RBAC enforced in the backend, mirrored in the UI.",
                    },
                    {
                      icon: FileText,
                      title: "Immutable audit logs",
                      body: "Significant actions are appended to a tamper-evident activity trail, ready for oversight review.",
                    },
                  ].map((item) => {
                    const Icon = item.icon;
                    return (
                      <li key={item.title} className="flex gap-3.5">
                        <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                          <Icon className="size-4.5" aria-hidden />
                        </span>
                        <div>
                          <p className="font-semibold">{item.title}</p>
                          <p className="mt-0.5 text-sm leading-6 text-muted-foreground">
                            {item.body}
                          </p>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>

              <div className="relative">
                <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
                  <div className="border-b border-border/70 bg-grid-dense px-5 py-4">
                    <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                      Executive view — demo
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-px bg-border/60 sm:grid-cols-3">
                    {[
                      { label: "Active audits", value: "4" },
                      { label: "Open findings", value: "6" },
                      { label: "Critical risks", value: "2" },
                      { label: "Compliance", value: "75%" },
                      { label: "Critical vulns", value: "2" },
                      { label: "BCM readiness", value: "81%" },
                    ].map((tile) => (
                      <div key={tile.label} className="bg-card px-5 py-6">
                        <p className="text-2xl font-bold tabular-nums tracking-tight">
                          {tile.value}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">{tile.label}</p>
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border/70 px-5 py-4">
                    <p className="text-xs leading-5 text-muted-foreground">
                      Illustrative demo figures — the live dashboard computes
                      every KPI from your organization&apos;s own records.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Assurance / trust band */}
        <section id="assurance" className="mx-auto max-w-7xl px-4 py-20 sm:px-6 lg:px-8">
          <div className="overflow-hidden rounded-xl border border-border/70 bg-ink text-white">
            <div className="bg-grid-network relative">
              <div className="relative mx-auto max-w-3xl px-6 py-16 text-center">
                <Badge
                  variant="outline"
                  className="border-white/25 bg-white/10 text-white"
                >
                  Self-hosting ready
                </Badge>
                <h2 className="mt-4 text-3xl font-bold tracking-tight sm:text-4xl">
                  Your data stays under your control
                </h2>
                <p className="mx-auto mt-4 max-w-xl text-base leading-7 text-white/70">
                  IITAMS is engineered for standard infrastructure — Docker,
                  PostgreSQL and environment-variable configuration — so it can
                  run on government-owned servers behind your own reverse proxy.
                </p>
                <div className="mt-8 flex flex-wrap justify-center gap-3">
                  <Button asChild size="lg" className="cursor-pointer bg-white text-ink hover:bg-white/90">
                    <Link to={primaryHref}>
                      {primaryCta}
                      <ArrowRight className="ml-2 size-4" aria-hidden />
                    </Link>
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:px-6 lg:px-8">
          <div className="flex items-center gap-2">
            <img src={logo} alt="" aria-hidden className="size-5 rounded" />
            <span>
              <span className="font-semibold text-foreground">IITAMS</span> —
              Integrated Information Technology Audit Management System
            </span>
          </div>
          <p>
            Design language inspired by Kenya&apos;s Ministry of ICT & the Digital
            Economy.
          </p>
        </div>
      </footer>
    </div>
  );
}
