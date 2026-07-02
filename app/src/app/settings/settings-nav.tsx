"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { WorkspaceRole } from "@/lib/auth/workspace";
import { cn } from "@/lib/utils";

type NavItem = {
  href: string;
  label: string;
  // If set, only roles in this list see the tab. Undefined = everyone.
  roles?: readonly WorkspaceRole[];
};

const NAV: readonly NavItem[] = [
  // Personal settings first — the /settings index lands here, and it's the
  // one section every role (including guests) can act on.
  { href: "/settings/account", label: "Account" },
  { href: "/settings/workspace", label: "Workspace" },
  // The workspace's design tokens + voice rules agents generate against.
  { href: "/settings/brand", label: "Brand", roles: ["owner", "admin"] },
  { href: "/settings/members", label: "Members", roles: ["owner", "admin"] },
  // Usage/activation analytics over canvas_usage_event (admin-only).
  { href: "/settings/analytics", label: "Analytics", roles: ["owner", "admin"] },
  // Guests can't mint MCP tokens (is_workspace_member_full gates it), so the
  // tab would only lead to a manager that always fails for them.
  {
    href: "/settings/mcp",
    label: "Connections",
    roles: ["owner", "admin", "member"],
  },
  // Admin audit of every live public link in the workspace.
  { href: "/settings/sharing", label: "Public links", roles: ["owner", "admin"] },
];

export function SettingsNav({ role }: { role: WorkspaceRole }) {
  const pathname = usePathname();
  const visible = NAV.filter((item) => !item.roles || item.roles.includes(role));

  return (
    // Two shapes from one element: below lg it's the original horizontal tab
    // row (overflow-x-auto + whitespace-nowrap so it never pushes past a
    // narrow viewport); at lg+ the full-width settings layout turns it into a
    // sticky left rail so the section list stays scannable on wide screens.
    <nav className="flex gap-1 border-b border-border -mt-2 overflow-x-auto whitespace-nowrap lg:sticky lg:top-20 lg:mt-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:whitespace-normal lg:border-b-0">
      {visible.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              // shrink-0 so tabs keep their tap size inside the scroll row
              // instead of squeezing on a narrow screen. The lg: overrides
              // restyle the same link as a sidebar row (rounded hover surface
              // instead of an underline).
              "shrink-0 px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors lg:mb-0 lg:rounded-md lg:border-b-0 lg:px-2.5 lg:py-1.5",
              active
                ? "border-foreground text-foreground lg:bg-fog"
                : "border-transparent text-muted-foreground hover:text-foreground lg:hover:bg-fog/60",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
