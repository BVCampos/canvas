"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import Link from "next/link";
import { signOutAction } from "@/lib/auth/actions";
import { cn } from "@/lib/utils";
import { avatarGradient, AVATAR_INNER_RING } from "@/lib/avatar";
import { ThemeToggle } from "@/components/theme-toggle";
import { MenuSurface } from "@/components/ui/menu-surface";

function ChevronDown({ className }: { className?: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2.25 3.75L5 6.25L7.75 3.75"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LogOut({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M5 2.5H3.25C2.69772 2.5 2.25 2.94772 2.25 3.5V9.5C2.25 10.0523 2.69772 10.5 3.25 10.5H5M8.25 8.25L10.75 6.5L8.25 4.75M10.5 6.5H5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Sparkle({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M6.5 1.75L7.6 5.4L11.25 6.5L7.6 7.6L6.5 11.25L5.4 7.6L1.75 6.5L5.4 5.4L6.5 1.75Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Sliders({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M2 3.75H4.4M7.6 3.75H11M2 9.25H6.4M9.6 9.25H11"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="6" cy="3.75" r="1.35" stroke="currentColor" strokeWidth="1.2" />
      <circle cx="8" cy="9.25" r="1.35" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function Plug({ className }: { className?: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 13 13"
      fill="none"
      aria-hidden
      className={className}
    >
      <path
        d="M5 2.5V4.75M8 2.5V4.75M3.75 4.75H9.25V7.25C9.25 8.63071 8.13071 9.75 6.75 9.75H6.25C4.86929 9.75 3.75 8.63071 3.75 7.25V4.75ZM6.5 9.75V11.25"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function UserMenu({
  name,
  email,
  initials,
}: {
  name: string;
  email: string;
  initials: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onEscape(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onClickOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onClickOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  function handleSignOut() {
    startTransition(async () => {
      await signOutAction();
    });
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          // Mobile: avatar-only trigger (name + chevron hidden below sm), so
          // drop the right padding to pr-0.5 for a balanced circular tap
          // target. Desktop (sm+) keeps the pill with name + chevron.
          "group flex h-8 items-center gap-2 rounded-full border border-transparent py-0.5 pl-0.5 pr-0.5 transition-all hover:border-border hover:bg-paper hover:shadow-[0_1px_2px_rgba(14,26,43,0.04)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:pr-3",
          open &&
            "border-border bg-paper shadow-[0_1px_2px_rgba(14,26,43,0.04)]",
        )}
      >
        <div
          className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
          style={{
            background: avatarGradient(email),
            boxShadow: AVATAR_INNER_RING,
          }}
          aria-hidden
        >
          {initials}
        </div>
        {/* Avatar-only on mobile: the name + chevron crowd the topbar row on
            a 360px phone, and identity is still confirmed inside the dropdown
            panel below. Reveal both at sm+. */}
        <span className="hidden text-[13px] font-medium text-foreground sm:inline">
          {name}
        </span>
        <ChevronDown
          className={cn(
            "hidden text-steel transition-transform duration-150 sm:block",
            open ? "rotate-180" : "group-hover:translate-y-px",
          )}
        />
      </button>

      {open && (
        <MenuSurface
          onClose={() => setOpen(false)}
          className="absolute right-0 top-full z-50 mt-2 w-64 origin-top-right animate-in fade-in slide-in-from-top-1 duration-150 rounded-lg border border-border bg-paper p-1 shadow-[0_10px_30px_-12px_rgba(14,26,43,0.22),0_2px_6px_-2px_rgba(14,26,43,0.08)]"
        >
          <div className="flex items-center gap-2.5 px-2 py-2">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full text-[11px] font-semibold text-white"
              style={{
                background: avatarGradient(email),
                boxShadow: AVATAR_INNER_RING,
              }}
              aria-hidden
            >
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium text-foreground">
                {name}
              </div>
              <div className="truncate text-[11px] text-muted-foreground">
                {email}
              </div>
            </div>
          </div>

          <div className="my-1 h-px bg-border" />

          <Link
            href="/settings"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog"
          >
            <Sliders className="text-steel" />
            <span>Settings</span>
          </Link>

          <Link
            href="/settings/mcp"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog"
          >
            <Plug className="text-steel" />
            <span>Connections</span>
          </Link>

          <Link
            href="/releases"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] text-foreground transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog"
          >
            <Sparkle className="text-steel" />
            <span>What&apos;s new</span>
          </Link>

          <div className="my-1 h-px bg-border" />

          <ThemeToggle />

          <div className="my-1 h-px bg-border" />

          <button
            type="button"
            role="menuitem"
            onClick={handleSignOut}
            disabled={pending}
            className={cn(
              "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors hover:bg-fog focus-visible:outline-none focus-visible:bg-fog disabled:cursor-default",
              pending && "opacity-60",
            )}
          >
            <LogOut className="text-steel" />
            <span>{pending ? "Signing out…" : "Sign out"}</span>
          </button>
        </MenuSurface>
      )}
    </div>
  );
}
