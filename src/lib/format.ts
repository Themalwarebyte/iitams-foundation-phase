import { format, formatDistanceToNowStrict, parseISO } from "date-fns";

/** "12 Mar 2026" */
export function formatDate(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "—";
  const date = typeof value === "string" ? parseISO(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return format(date, "d MMM yyyy");
}

/** "in 12 days" / "3 days ago" */
export function formatRelative(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat("en-KE").format(value);
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${Math.round(value)}%`;
}

/** Canonical date-fns format used for compact table timestamps. */
export const TABLE_DATE_FORMAT = "d MMM yyyy";
