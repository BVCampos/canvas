import { notFound } from "next/navigation";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { createClient } from "@/lib/supabase/server";
import { normalizeBrandTokens } from "@/lib/canvas/brand";
import { BrandForm } from "./brand-form";

// /settings/brand — the workspace brand kit (migration 0065): named colors,
// font stacks, and writing-voice rules that agents read via read_brand and
// that the in-app assistant carries as per-turn context. Admin/owner only
// (the tab is role-gated too; this is the enforcement the URL can't bypass).

export default async function BrandSettingsPage() {
  const { workspace, role } = await getActiveWorkspace("/settings/brand");
  if (role !== "owner" && role !== "admin") {
    notFound();
  }

  const supabase = await createClient();
  const { data: brand } = await supabase
    .from("canvas_brand")
    .select("name, tokens, voice")
    .eq("workspace_id", workspace.id)
    .maybeSingle();

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Brand</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          The palette, type, and voice agents use when they generate slides for{" "}
          <strong className="font-medium text-foreground">{workspace.name}</strong>
          . Connected agents read it with <code className="font-machine text-xs">read_brand</code>;
          the in-app assistant carries it on every turn.
        </p>
      </div>

      <BrandForm
        initialName={brand?.name ?? ""}
        initialTokens={normalizeBrandTokens(brand?.tokens)}
        initialVoice={brand?.voice ?? ""}
      />
    </>
  );
}
