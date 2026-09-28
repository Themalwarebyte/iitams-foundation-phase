import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AppLayout } from "@/components/iitams/AppLayout";
import {
  Breadcrumbs,
  ModulePlaceholder,
  PageHeader,
} from "@/components/iitams/PageHeader";
import { NAV_INDEX } from "@/lib/nav";

/**
 * Phase-1 module page. Every sidebar route resolves to a real, protected page:
 * functional modules will host their Phase-2 feature work here; the rest
 * present an honest, professionally-styled scaffolding state.
 */
export default function ModulePage({ path }: { path: string }) {
  const entry = NAV_INDEX.get(path);
  const data = useQuery(api.dashboard.executive, {});
  const isCore =
    data !== undefined &&
    [
      "/audit/findings",
      "/audit/corrective-actions",
      "/risk/register",
      "/risk/heat-map",
      "/risk/trends",
      "/compliance/dashboard",
      "/cyber/vulnerabilities",
      "/bcm/critical-services",
      "/bcm/dr-tests",
    ].includes(path);

  const content = (
    <>
      <Breadcrumbs path={path} />
      <PageHeader
        eyebrow={entry?.group}
        title={entry?.label ?? "Module"}
        description={
          isCore
            ? "Phase 1 establishes the navigation, permissions and aggregate data for this module; record management arrives in Phase 2."
            : "This module's data model, permissions and navigation are established. Interactive workflows arrive in the next phase."
        }
        actions={
          data?.isDemoData ? (
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Demo data
            </span>
          ) : undefined
        }
      />
      <ModulePlaceholder
        icon={undefined}
        title={`${entry?.label ?? "Module"} — ready for Phase 2`}
        description="Backend schema, session permissions and routing are already wired for this module."
      />
    </>
  );

  return <AppLayout>{content}</AppLayout>;
}
