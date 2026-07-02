import type {
  ProposalSheetData,
  ProposalSheetResult,
} from "@/app/canvases/proposal-queries";

export type ProposalSheetLoad = {
  data: ProposalSheetData | null;
  error: string | null;
};

// Normalizes a getProposalSheetData call into a {data, error} pair.
//
// The point of this helper is the catch: getProposalSheetData is a server
// action, so the call can REJECT (not just resolve with {ok:false}) when the
// underlying function invocation fails — a 5xx / cold-start timeout / network
// blip in production, or a thrown redirect. The sheet's loading state is
// derived as "selected && no data && no error", so a swallowed rejection
// (which sets neither) would leave the panel pinned on its skeleton forever
// with no error and no Retry. Funnelling both call sites through here turns a
// thrown failure into a surfaced error, so the existing SheetError + Retry UI
// handles it like any other failure instead of hanging.
export async function loadProposalSheet(
  run: () => Promise<ProposalSheetResult>,
): Promise<ProposalSheetLoad> {
  try {
    const result = await run();
    return result.ok
      ? { data: result.data, error: null }
      : { data: null, error: result.error };
  } catch (e) {
    return {
      data: null,
      error: e instanceof Error ? e.message : "Failed to load proposal.",
    };
  }
}
