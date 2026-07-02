import { createClient } from "@/lib/supabase/server";
import { getActiveWorkspace } from "@/lib/auth/workspace";
import { NewDeckForm } from "./new-deck-form";

// Canvas v1 — new deck page. The form posts multipart/form-data to
// /api/decks/import; the route parses the HTML (either uploaded as a file
// or pasted into a textarea), uploads embedded images to Storage, and inserts
// the deck + slides. On success it redirects to /canvases/{id}; on failure it
// bounces back here with ?error=<code>.

const ERROR_COPY: Record<string, string> = {
  missing_title: "Give the deck a title before importing.",
  file_too_large: "That file is over 10 MB. Trim it before importing.",
  source_too_large: "Pasted HTML is over 10 MB. Trim it before importing.",
  invalid_form: "The form didn't parse. Reload and try again.",
  invalid_project:
    "That project doesn't exist anymore. Pick another one (or none) and try again.",
  no_slides:
    "Couldn't find any slides in that file. Canvas reads each slide from an element marked class=\"slide\" (a <section> or <div> per slide), or the direct children of a <div class=\"slides\"> container. Check your deck is structured that way.",
  import_failed:
    "Import failed — check the file is valid HTML and try again. If it persists, ping the team.",
};

export default async function NewCanvasPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; project?: string }>;
}) {
  const params = await searchParams;
  const errorCode = params?.error;
  const errorCopy = errorCode ? ERROR_COPY[errorCode] ?? "Import failed." : null;

  // Projects the deck can be filed under — scoped to the ACTIVE workspace,
  // because that's the workspace the import route will create the deck in
  // and validate the project against (a project from another workspace the
  // user belongs to would bounce with ?error=invalid_project). `?project=`
  // preselects — that's how the per-project "create one in this project"
  // CTA on /canvases lands here.
  const { workspace } = await getActiveWorkspace("/canvases/new");
  const supabase = await createClient();
  const { data: projects } = await supabase
    .from("canvas_project")
    .select("id, name")
    .eq("workspace_id", workspace.id)
    .order("name", { ascending: true });
  const preselectedProject =
    projects?.find((p) => p.id === params?.project)?.id ?? "";

  return (
    <main className="mx-auto max-w-2xl px-4 py-8 space-y-6 sm:px-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New deck</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Import an existing HTML deck or start from blank. Canvas decomposes
          the file into editable slides, hoists embedded images to Storage, and
          keeps the shared CSS as the deck theme.
        </p>
      </div>

      {errorCopy ? (
        <div className="rounded-[10px] border border-[color:var(--danger)]/30 bg-[color:var(--danger)]/5 px-4 py-3 text-sm text-[color:var(--danger)]">
          {errorCopy}
        </div>
      ) : null}

      <NewDeckForm
        projects={projects ?? []}
        preselectedProject={preselectedProject}
      />
    </main>
  );
}
