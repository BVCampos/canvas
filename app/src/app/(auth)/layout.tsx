export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // min-h-dvh (not min-h-screen): mobile Safari's collapsing URL bar makes
  // 100vh taller than the visible viewport, which would push the centered auth
  // card below the fold. Dynamic viewport units track the visible area so the
  // card stays optically centered.
  return (
    <div className="min-h-dvh flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-sm">{children}</div>
    </div>
  );
}
