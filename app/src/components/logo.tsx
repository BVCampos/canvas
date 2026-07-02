import { cn } from "@/lib/utils";

export function Logo({
  className,
  showWordmark = true,
}: {
  className?: string;
  showWordmark?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className="relative flex h-8 w-8 items-center justify-center rounded-[8px] shadow-[0_1px_2px_rgba(14,26,43,0.18),0_4px_10px_-3px_rgba(14,26,43,0.20),inset_0_1px_0_rgba(255,255,255,0.06)]"
        style={{
          background:
            "linear-gradient(150deg, #0e1a2b 0%, #142440 55%, #1f3354 100%)",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="h-[18px] w-[18px]"
          aria-hidden
        >
          <rect x="2" y="6" width="13" height="13" rx="2.5" fill="#2563eb" />
          <rect
            x="9"
            y="6"
            width="13"
            height="13"
            rx="2.5"
            fill="#e67a3b"
            fillOpacity="0.92"
          />
        </svg>
      </div>
      {showWordmark && (
        <div className="leading-none">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">
            Canvas
          </div>
          <div className="mt-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Multiplayer decks
          </div>
        </div>
      )}
    </div>
  );
}
