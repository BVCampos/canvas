export default function InviteLoading() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col items-center gap-4">
        <div className="h-10 w-10 animate-pulse rounded-[10px] bg-muted" />
        <div className="h-6 w-48 animate-pulse rounded-[6px] bg-muted" />
        <div className="h-4 w-64 animate-pulse rounded-[6px] bg-muted" />
      </div>
      <div className="h-10 w-full animate-pulse rounded-[8px] bg-muted" />
    </div>
  );
}
