import { Link, useLocation } from "react-router";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { DEFAULT_PERMISSIONS, type PermissionSet } from "@/lib/permissions";
import { NAV_GROUPS } from "@/lib/nav";
import { cn } from "@/lib/utils";
import logo from "@/assets/logo.svg";

function NavSection({
  permissions,
  showPhase2,
}: {
  permissions: PermissionSet;
  showPhase2: boolean;
}) {
  const location = useLocation();

  return (
    <>
      {NAV_GROUPS.map((group) => {
        const items = group.items.filter((item) => {
          const allowed =
            !item.permission || permissions[item.permission] === true;
          // Phase-2 scaffolding items can be hidden entirely if desired;
          // they render with a "planned" marker when shown.
          return allowed && (showPhase2 || true);
        });
        if (items.length === 0) return null;

        return (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/80">
              {group.label}
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {items.map((item) => {
                  const active =
                    location.pathname === item.path ||
                    (item.path !== "/dashboard" &&
                      location.pathname.startsWith(item.path + "/"));
                  const Icon = item.icon;
                  return (
                    <SidebarMenuItem key={item.path}>
                      <SidebarMenuButton
                        asChild
                        isActive={active}
                        tooltip={item.label}
                        className={cn(
                          "cursor-pointer",
                          item.phase2 && "text-muted-foreground",
                        )}
                      >
                        <Link to={item.path}>
                          <Icon className="size-4 shrink-0" aria-hidden />
                          <span className="truncate">{item.label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        );
      })}
    </>
  );
}

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const session = useQuery(api.session.getSession) ?? undefined;
  const permissions: PermissionSet =
    session?.permissions ?? DEFAULT_PERMISSIONS;

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <Link
          to="/dashboard"
          className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-sidebar-accent transition-colors cursor-pointer"
        >
          <img src={logo} alt="IITAMS logo" className="size-8 shrink-0 rounded-md" />
          <div className="min-w-0 group-data-[collapsible=icon]:hidden">
            <p className="truncate text-sm font-bold tracking-tight leading-5">
              IITAMS
            </p>
            <p className="truncate text-[10px] uppercase tracking-widest text-muted-foreground">
              ICT Assurance
            </p>
          </div>
          <span className="sr-only">IITAMS home</span>
        </Link>
        {session?.organization && (
          <div className="mx-2 mb-1 rounded-md bg-sidebar-accent/60 px-2.5 py-2 group-data-[collapsible=icon]:hidden">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Organization
            </p>
            <p className="truncate text-xs font-semibold text-sidebar-foreground">
              {session.organization.name}
            </p>
            {session.organization.isDemo && (
              <p className="mt-0.5 text-[10px] font-medium uppercase tracking-wide text-warning-foreground bg-warning/20 rounded px-1 inline-block">
                Demo data
              </p>
            )}
          </div>
        )}
      </SidebarHeader>
      <SidebarContent>
        <NavSection permissions={permissions} showPhase2 />
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  );
}
