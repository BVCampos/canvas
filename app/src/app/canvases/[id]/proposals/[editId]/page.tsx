import { redirect } from "next/navigation";

// /canvases/{id}/proposals/{editId} — legacy standalone proposal page.
//
// The review act now lives in exactly two UIs: the inline chip (decide) and
// the ProposalSheet (read in full). The deck page already resolves the
// ?proposal param — pending → inline chip + sheet seed; non-pending → forced
// full sheet — so this route only has to land old deep links (inbox rows,
// notifications, pasted URLs) in the same place every other entry point uses.
export default async function ProposalDetailRedirect({
  params,
}: {
  params: Promise<{ id: string; editId: string }>;
}) {
  const { id, editId } = await params;
  redirect(`/canvases/${id}?proposal=${editId}&full=1`);
}
