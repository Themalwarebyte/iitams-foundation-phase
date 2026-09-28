import type { LucideIcon } from "lucide-react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Bell,
  Bug,
  Building2,
  ClipboardCheck,
  ClipboardList,
  Command,
  Database,
  FileCheck2,
  FileSearch,
  FileText,
  Fingerprint,
  Flame,
  FolderOpen,
  Gauge,
  Globe,
  History,
  KeyRound,
  LayoutDashboard,
  LifeBuoy,
  Lightbulb,
  Network,
  PieChart,
  Plug,
  RefreshCcw,
  ScrollText,
  Settings,
  Shield,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  SquareStack,
  Target,
  TestTube2,
  TrendingUp,
  Users,
  Waypoints,
} from "lucide-react";
import type { PermissionSet } from "./permissions";

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  /** Required permission; hidden from the sidebar when not granted. */
  permission?: keyof PermissionSet;
  /** Flags an item as Phase-1 scaffolding (visible, not yet functional). */
  phase2?: boolean;
}

export interface NavGroup {
  label: string;
  icon: LucideIcon;
  /** When every item in the group is hidden, the group is hidden too. */
  items: NavItem[];
}

export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    icon: LayoutDashboard,
    items: [
      { label: "Executive Dashboard", path: "/dashboard", icon: LayoutDashboard, permission: "dashboard" },
      { label: "My Workspace", path: "/workspace", icon: SquareStack, permission: "workspace" },
      { label: "Notifications", path: "/notifications", icon: Bell, permission: "dashboard" },
    ],
  },
  {
    label: "Audit Management",
    icon: ClipboardCheck,
    items: [
      { label: "Audit Universe", path: "/audit/universe", icon: Globe, permission: "audit" },
      { label: "Audit Plans", path: "/audit/plans", icon: ClipboardList, permission: "audit" },
      { label: "Audit Engagements", path: "/audit/engagements", icon: FolderOpen, permission: "audit" },
      { label: "Audit Programs", path: "/audit/programs", icon: FileSearch, permission: "audit", phase2: true },
      { label: "Working Papers", path: "/audit/working-papers", icon: FileText, permission: "audit", phase2: true },
      { label: "Evidence", path: "/audit/evidence", icon: Database, permission: "audit", phase2: true },
      { label: "Findings", path: "/audit/findings", icon: Flame, permission: "audit" },
      { label: "Management Responses", path: "/audit/management-responses", icon: ScrollText, permission: "audit", phase2: true },
      { label: "Corrective Actions", path: "/audit/corrective-actions", icon: RefreshCcw, permission: "audit" },
      { label: "Follow-up Audits", path: "/audit/follow-up", icon: History, permission: "audit", phase2: true },
    ],
  },
  {
    label: "ICT Risk",
    icon: AlertTriangle,
    items: [
      { label: "Risk Register", path: "/risk/register", icon: Waypoints, permission: "risk" },
      { label: "Risk Assessments", path: "/risk/assessments", icon: Gauge, permission: "risk", phase2: true },
      { label: "Risk Treatments", path: "/risk/treatments", icon: LifeBuoy, permission: "risk", phase2: true },
      { label: "Risk Heat Map", path: "/risk/heat-map", icon: Target, permission: "risk" },
      { label: "Risk Trends", path: "/risk/trends", icon: TrendingUp, permission: "risk" },
    ],
  },
  {
    label: "Compliance",
    icon: ShieldCheck,
    items: [
      { label: "Frameworks", path: "/compliance/frameworks", icon: SquareStack, permission: "compliance" },
      { label: "Control Library", path: "/compliance/controls", icon: KeyRound, permission: "compliance" },
      { label: "Assessments", path: "/compliance/assessments", icon: ClipboardCheck, permission: "compliance", phase2: true },
      { label: "Control Testing", path: "/compliance/control-testing", icon: FileCheck2, permission: "compliance", phase2: true },
      { label: "Evidence Mapping", path: "/compliance/evidence-mapping", icon: FileSearch, permission: "compliance", phase2: true },
      { label: "Compliance Dashboard", path: "/compliance/dashboard", icon: PieChart, permission: "compliance" },
    ],
  },
  {
    label: "Cybersecurity Assurance",
    icon: Shield,
    items: [
      { label: "Security Assessments", path: "/cyber/assessments", icon: ShieldCheck, permission: "cyber" },
      { label: "Vulnerabilities", path: "/cyber/vulnerabilities", icon: Bug, permission: "cyber" },
      { label: "Penetration Tests", path: "/cyber/penetration-tests", icon: Siren, permission: "cyber" },
      { label: "Network Assessments", path: "/cyber/network-assessments", icon: Network, permission: "cyber", phase2: true },
      { label: "Application Security", path: "/cyber/application-security", icon: Command, permission: "cyber", phase2: true },
      { label: "Configuration Reviews", path: "/cyber/configuration-reviews", icon: SlidersHorizontal, permission: "cyber", phase2: true },
    ],
  },
  {
    label: "Business Continuity",
    icon: Activity,
    items: [
      { label: "Critical Services", path: "/bcm/critical-services", icon: Building2, permission: "bcm" },
      { label: "Business Impact Analysis", path: "/bcm/bia", icon: BarChart3, permission: "bcm", phase2: true },
      { label: "RTO / RPO", path: "/bcm/rto-rpo", icon: Fingerprint, permission: "bcm" },
      { label: "DR Plans", path: "/bcm/dr-plans", icon: FileText, permission: "bcm", phase2: true },
      { label: "DR Tests & Exercises", path: "/bcm/dr-tests", icon: TestTube2, permission: "bcm" },
      { label: "Lessons Learned", path: "/bcm/lessons-learned", icon: Lightbulb, permission: "bcm", phase2: true },
    ],
  },
  {
    label: "Reports & Analytics",
    icon: BarChart3,
    items: [
      { label: "Executive Reports", path: "/reports/executive", icon: FileText, permission: "reports" },
      { label: "Audit Reports", path: "/reports/audit", icon: ScrollText, permission: "reports", phase2: true },
      { label: "Risk Reports", path: "/reports/risk", icon: TrendingUp, permission: "reports", phase2: true },
      { label: "Compliance Reports", path: "/reports/compliance", icon: FileCheck2, permission: "reports", phase2: true },
      { label: "Cybersecurity Reports", path: "/reports/cybersecurity", icon: Shield, permission: "reports", phase2: true },
      { label: "BCM Reports", path: "/reports/bcm", icon: Activity, permission: "reports", phase2: true },
    ],
  },
  {
    label: "Administration",
    icon: Settings,
    items: [
      { label: "Organizations / MDACs", path: "/admin/organizations", icon: Building2, permission: "admin" },
      { label: "Users", path: "/admin/users", icon: Users, permission: "admin" },
      { label: "Roles & Permissions", path: "/admin/roles", icon: KeyRound, permission: "admin" },
      { label: "Integrations", path: "/admin/integrations", icon: Plug, permission: "admin" },
      { label: "System Configuration", path: "/admin/system", icon: SlidersHorizontal, permission: "admin" },
      { label: "Audit Logs", path: "/admin/audit-logs", icon: History, permission: "admin" },
    ],
  },
];

/** Flat path → label lookup used by breadcrumbs. */
export const NAV_INDEX: Map<string, { label: string; group: string }> = new Map(
  NAV_GROUPS.flatMap((group) =>
    group.items.map((item) => [
      item.path,
      { label: item.label, group: group.label },
    ] as const),
  ),
);
