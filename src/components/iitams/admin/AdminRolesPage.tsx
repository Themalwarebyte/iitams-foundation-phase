import { useMemo, useState } from "react";
import { KeyRound } from "lucide-react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { AdminPageShell } from "./AdminShell";
import { EmptyState, ListSkeleton } from "@/components/iitams/audit/ListPageShell";
import { statusLabel } from "@/components/iitams/badges";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

/**
 * Role visibility foundation (Phase 3A — read-only).
 * Renders the live role registry from the RBAC access model
 * (`IITAMS_ROLES` × `ROLE_PERMISSIONS` via the `listRoles` query) — the same
 * registry that powers server-side authorization. No role editing.
 */
export function AdminRolesPage() {
  const roles = useQuery(api.admin.listRoles, {});
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!roles) return [];
    if (!query) return roles;
    const q = query.toLowerCase();
    return roles.filter(
      (r) =>
        r.role.toLowerCase().includes(q) ||
        r.permissions.some((p) => p.toLowerCase().includes(q)),
    );
  }, [roles, query]);

  return (
    <AdminPageShell
      path="/admin/roles"
      title="Roles & Permissions"
      description="The effective permission set for every role in the IITAMS RBAC registry — the same registry the server enforces on every request. Visibility only: role editing arrives in a later batch."
    >
      <div className="mb-4">
        <label htmlFor="roles-filter" className="sr-only">
          Filter roles and permissions
        </label>
        <input
          id="roles-filter"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter by role or permission (e.g. audit.manage)…"
          className="w-full max-w-sm rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {roles === undefined ? (
        <ListSkeleton rows={4} />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No matching roles"
          description="No role or permission matches the current filter. Clear it to see the full registry."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {filtered.map((r) => (
            <Card key={r.role} className="flex flex-col">
              <CardHeader>
                <div className="flex items-center justify-between gap-2">
                  <CardTitle className="text-base">
                    {statusLabel(r.role)}
                  </CardTitle>
                  {r.role === "admin" && (
                    <Badge className="text-[10px] uppercase tracking-wide">Platform</Badge>
                  )}
                </div>
                <CardDescription>
                  {r.permissions.length} permission
                  {r.permissions.length === 1 ? "" : "s"} · registry id{" "}
                  <span className="font-mono text-[11px]">{r.role}</span>
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                {r.permissions.map((p) => (
                  <Badge
                    key={p}
                    variant="outline"
                    className="font-mono text-[11px] normal-case"
                  >
                    {p}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </AdminPageShell>
  );
}
