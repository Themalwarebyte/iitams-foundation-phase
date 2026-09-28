import type { LucideIcon } from "lucide-react";
import {
  AlertOctagon,
  AlertTriangle,
  CircleCheck,
  Circle,
  Info,
} from "lucide-react";

export type Severity = "critical" | "high" | "medium" | "low" | "informational";
export type DataClassification =
  | "public"
  | "internal"
  | "confidential"
  | "restricted";

/**
 * Severity system — WCAG-conscious: every severity pairs a distinct icon and
 * label with its colour, so status never depends on colour alone.
 */
export const SEVERITY_META: Record<
  Severity,
  {
    label: string;
    icon: LucideIcon;
    /** Filled chip (colored background) */
    chip: string;
    /** Soft badge (tinted background, strong text) */
    badge: string;
    /** Raw chart colour token */
    color: string;
  }
> = {
  critical: {
    label: "Critical",
    icon: AlertOctagon,
    chip: "bg-critical text-critical-foreground",
    badge: "bg-critical/10 text-critical border-critical/30",
    color: "var(--critical)",
  },
  high: {
    label: "High",
    icon: AlertTriangle,
    chip: "bg-warning text-warning-foreground",
    badge: "bg-warning/15 text-foreground/90 border-warning/40",
    color: "var(--warning)",
  },
  medium: {
    label: "Medium",
    icon: Circle,
    chip: "bg-info text-info-foreground",
    badge: "bg-info/10 text-info border-info/30",
    color: "var(--info)",
  },
  low: {
    label: "Low",
    icon: CircleCheck,
    chip: "bg-success text-success-foreground",
    badge: "bg-success/10 text-success border-success/30",
    color: "var(--success)",
  },
  informational: {
    label: "Informational",
    icon: Info,
    chip: "bg-muted text-muted-foreground",
    badge: "bg-muted text-muted-foreground border-border",
    color: "var(--muted-foreground)",
  },
};

/**
 * Data classification visuals (Public / Internal / Confidential / Restricted).
 * Phase 1 renders indicators only; policy enforcement arrives with the
 * evidence-management backend in a later phase.
 */
export const CLASSIFICATION_META: Record<
  DataClassification,
  { label: string; className: string; description: string }
> = {
  public: {
    label: "Public",
    className: "bg-success/10 text-success border-success/30",
    description: "Cleared for public release",
  },
  internal: {
    label: "Internal",
    className: "bg-info/10 text-info border-info/30",
    description: "For internal circulation within the organization",
  },
  confidential: {
    label: "Confidential",
    className: "bg-warning/15 text-foreground/90 border-warning/40",
    description: "Named recipients only; do not forward",
  },
  restricted: {
    label: "Restricted",
    className: "bg-critical/10 text-critical border-critical/30",
    description: "Highest sensitivity — access on strict need-to-know",
  },
};
