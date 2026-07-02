// Regression test for the proposal-review sheet's load path.
//
// Bug it guards: getProposalSheetData is a server action, so the call can
// REJECT (not just resolve with {ok:false}) when the function invocation fails
// in production — a 5xx, a cold-start timeout, a thrown redirect. The sheet
// derives `loading` as "selected && no data && no error", and the original
// effect awaited the action with no catch, so a rejection set neither piece of
// state and the panel hung on its skeleton forever (no error, no Retry). The
// graceful SheetError path was only reachable for a *returned* {ok:false}.
//
// loadProposalSheet funnels both call sites through a try/catch so a THROWN
// failure surfaces as an error exactly like a returned one. These cases lock
// that in.

import { describe, expect, it } from "vitest";
import { loadProposalSheet } from "../src/app/canvases/load-proposal-sheet";
import type { ProposalSheetData } from "../src/app/canvases/proposal-queries";

// Minimal stand-in; the helper never inspects the shape, only passes it through.
const FAKE_DATA = { proposerName: "Bernardo" } as unknown as ProposalSheetData;

describe("loadProposalSheet", () => {
  it("passes data through on {ok:true}", async () => {
    const out = await loadProposalSheet(async () => ({ ok: true, data: FAKE_DATA }));
    expect(out).toEqual({ data: FAKE_DATA, error: null });
  });

  it("surfaces a returned error on {ok:false}", async () => {
    const out = await loadProposalSheet(async () => ({ ok: false, error: "not_found" }));
    expect(out).toEqual({ data: null, error: "not_found" });
  });

  it("surfaces a THROWN failure as an error (the regression — a prod 5xx must not hang the sheet)", async () => {
    const out = await loadProposalSheet(async () => {
      throw new Error("503 — server action failed");
    });
    expect(out.data).toBeNull();
    expect(out.error).toBe("503 — server action failed");
  });

  it("falls back to a generic message for a non-Error throw", async () => {
    const out = await loadProposalSheet(async () => {
      throw "boom";
    });
    expect(out.data).toBeNull();
    expect(out.error).toBe("Failed to load proposal.");
  });
});
