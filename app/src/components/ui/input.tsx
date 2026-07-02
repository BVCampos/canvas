import * as React from "react";
import { cn } from "@/lib/utils";

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, type = "text", ...props }, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        // `text-base` (16px) on mobile is deliberate: iOS Safari auto-zooms
        // the viewport when a focused input's font-size is below 16px, which
        // is jarring and leaves the page zoomed-in afterwards. We keep the
        // 14px (`sm:text-sm`) aesthetic from tablet up where that zoom
        // behaviour doesn't apply. Height bumps to 10 (40px) on mobile for a
        // comfortable touch target, settling back to 36px at sm+.
        "flex h-10 w-full rounded-[8px] border bg-card px-3 text-base text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50 sm:h-9 sm:text-sm",
        className,
      )}
      {...props}
    />
  );
});
Input.displayName = "Input";
