import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import logo from "@/assets/logo.svg";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/hooks/use-auth";
import { NAV_GROUPS } from "@/lib/nav";
import { DEFAULT_PERMISSIONS, type PermissionSet } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import {
  Bell,
  CircleHelp,
  LogOut,
  Search,
  Settings,
  ShieldCheck,
} from "lucide-react";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  user: "Assurance User",
  member: "Member",
};

const NOTIF_TONE: Record<string, string> = {
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  critical: "text-critical",
};

export function TopBar() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  const session = useQuery(api.session.getSession) ?? undefined;
  const permissions: PermissionSet =
    session?.permissions ?? DEFAULT_PERMISSIONS;
  const notifications = useQuery(api.notifications.listForUser) ?? [];
  const markRead = useMutation(api.notifications.markRead);
  const markAllRead = useMutation(api.notifications.markAllRead);

  const unread = notifications.filter((n) => n.readAt === null).length;

  const searchable = useMemo(
    () =>
      NAV_GROUPS.flatMap((g) =>
        g.items
          .filter((i) => !i.permission || permissions[i.permission] === true)
          .map((i) => ({ ...i, group: g.label })),
      ),
    [permissions],
  );

  const handleSignOut = async () => {
    await signOut();
    navigate("/");
  };

  const initials = (user?.name ?? user?.email ?? "U")
    .split(/[\s@.]+/)
    .slice(0, 2)
    .map((p) => p.charAt(0).toUpperCase())
    .join("");

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border/70 bg-background/85 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <SidebarTrigger className="-ml-1 cursor-pointer" aria-label="Toggle sidebar" />
      <Separator orientation="vertical" className="h-5" />

      {/* Organization / MDAC context */}
      <div className="hidden min-w-0 items-center gap-2 md:flex">
        <img src={logo} alt="" aria-hidden className="size-6 rounded" />
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink asChild>
                <Link to="/dashboard" className="cursor-pointer">
                  {session?.organization?.name ?? "IITAMS"}
                </Link>
              </BreadcrumbLink>
            </BreadcrumbItem>
            {session?.organization?.isDemo && (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <Badge
                    variant="outline"
                    className="bg-warning/15 text-[10px] uppercase tracking-wide text-foreground/90 border-warning/40"
                  >
                    Demo data
                  </Badge>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex-1" />

      {/* Global search */}
      <Button
        variant="outline"
        size="sm"
        className="hidden h-8 w-44 cursor-pointer justify-start gap-2 text-muted-foreground sm:flex lg:w-56"
        onClick={() => setSearchOpen(true)}
        aria-label="Search modules"
      >
        <Search className="size-3.5" aria-hidden />
        <span className="text-xs">Search modules…</span>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="cursor-pointer sm:hidden"
        onClick={() => setSearchOpen(true)}
        aria-label="Search modules"
      >
        <Search className="size-4" aria-hidden />
      </Button>

      {/* Help */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="cursor-pointer" aria-label="Help">
            <CircleHelp className="size-4" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Help & support</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={() => navigate("/help")}>
            <CircleHelp className="mr-2 size-4" aria-hidden />
            User guide
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer"
            onClick={() => window.open("https://ict.go.ke", "_blank", "noopener")}
          >
            <ShieldCheck className="mr-2 size-4" aria-hidden />
            MICDE programme site
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Notifications */}
      <Popover open={notifOpen} onOpenChange={setNotifOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            className="relative cursor-pointer"
            aria-label={`Notifications${unread > 0 ? `, ${unread} unread` : ""}`}
          >
            <Bell className="size-4" aria-hidden />
            {unread > 0 && (
              <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-critical text-[9px] font-bold text-critical-foreground">
                {unread > 9 ? "9+" : unread}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-0">
          <div className="flex items-center justify-between border-b border-border/70 px-4 py-2.5">
            <p className="text-sm font-semibold">Notifications</p>
            {unread > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 cursor-pointer text-xs"
                onClick={() => markAllRead({})}
              >
                Mark all read
              </Button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && (
              <p className="px-4 py-8 text-center text-sm text-muted-foreground">
                No notifications yet.
              </p>
            )}
            {notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                className={cn(
                  "flex w-full flex-col gap-0.5 border-b border-border/50 px-4 py-3 text-left transition-colors hover:bg-accent/60 cursor-pointer",
                  n.readAt === null && "bg-primary/[0.04]",
                )}
                onClick={() => {
                  void markRead({ id: n.id as never });
                  if (n.href) navigate(n.href);
                  setNotifOpen(false);
                }}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "size-1.5 shrink-0 rounded-full",
                      NOTIF_TONE[n.severity] ?? "text-muted-foreground",
                      "bg-current",
                    )}
                    aria-hidden
                  />
                  <span className="truncate text-sm font-medium">{n.title}</span>
                </span>
                {n.body && (
                  <span className="line-clamp-2 pl-3.5 text-xs text-muted-foreground">
                    {n.body}
                  </span>
                )}
              </button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Profile */}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-9 cursor-pointer gap-2 px-1.5"
            aria-label="Account menu"
          >
            <Avatar className="size-7">
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                {initials || "U"}
              </AvatarFallback>
            </Avatar>
            <span className="hidden min-w-0 flex-col items-start lg:flex">
              <span className="max-w-36 truncate text-xs font-semibold leading-4">
                {user?.name ?? user?.email ?? "Account"}
              </span>
              <span className="text-[10px] leading-3 text-muted-foreground">
                {ROLE_LABEL[session?.role ?? "member"] ?? session?.role}
              </span>
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel>
            <p className="truncate text-sm font-semibold">
              {user?.name ?? "Unnamed user"}
            </p>
            <p className="truncate text-xs font-normal text-muted-foreground">
              {user?.email ?? "Signed in"}
            </p>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="cursor-pointer" onClick={() => navigate("/workspace")}>
            <Settings className="mr-2 size-4" aria-hidden />
            My workspace
          </DropdownMenuItem>
          <DropdownMenuItem
            className="cursor-pointer text-destructive focus:text-destructive"
            onClick={handleSignOut}
          >
            <LogOut className="mr-2 size-4" aria-hidden />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Global search dialog */}
      <CommandDialog open={searchOpen} onOpenChange={setSearchOpen}>
        <CommandInput placeholder="Search modules, e.g. “findings”, “risk register”…" />
        <CommandList>
          <CommandEmpty>No matching module.</CommandEmpty>
          {(["Overview", "Audit Management", "ICT Risk", "Compliance", "Cybersecurity Assurance", "Business Continuity", "Reports & Analytics", "Administration"] as const).map(
            (groupName) => {
              const groupItems = searchable.filter((i) => i.group === groupName);
              if (groupItems.length === 0) return null;
              return (
                <CommandGroup key={groupName} heading={groupName}>
                  {groupItems.map((item) => {
                    const Icon = item.icon;
                    return (
                      <CommandItem
                        key={item.path}
                        onSelect={() => {
                          navigate(item.path);
                          setSearchOpen(false);
                        }}
                        className="cursor-pointer"
                      >
                        <Icon className="mr-2 size-4 opacity-70" aria-hidden />
                        {item.label}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              );
            },
          )}
        </CommandList>
      </CommandDialog>
    </header>
  );
}
