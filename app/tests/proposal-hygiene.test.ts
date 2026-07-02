import { describe, it, expect, vi } from "vitest";
import {
  supersedeOlderPendingProposals,
  expireStalePendingProposals,
  PROPOSAL_EXPIRY_DAYS,
} from "../src/lib/canvas/proposal-hygiene";

// A tiny chainable Supabase stub: records the filters applied and the update
// payload, and returns whatever rows the test seeds for the terminal select.
type Call = {
  table: string;
  op: "update" | "delete" | "select";
  filters: Record<string, unknown>;
  patch?: Record<string, unknown>;
  returned: unknown[];
};

function makeAdmin(seed: {
  updateReturns?: Record<string, unknown[]>;
  selectReturns?: Record<string, unknown[]>;
}) {
  const calls: Call[] = [];
  const admin = {
    from(table: string) {
      const call: Call = { table, op: "select", filters: {}, returned: [] };
      let selected = false;
      const builder: Record<string, unknown> = {};
      const chain = () => builder;
      builder.update = (patch: Record<string, unknown>) => {
        call.op = "update";
        call.patch = patch;
        return builder;
      };
      builder.delete = () => {
        call.op = "delete";
        return builder;
      };
      // select() is chainable (a query can filter after selecting columns); the
      // rows are produced when the chain is finally awaited via .then.
      builder.select = () => {
        selected = true;
        return builder;
      };
      for (const m of ["eq", "neq", "is", "in", "lt", "gt"]) {
        builder[m] = (col: string, val: unknown) => {
          call.filters[`${m}:${col}`] = val;
          return chain();
        };
      }
      // Every terminal await lands here. Rows depend on the op: an update().select()
      // returns updateReturns; a plain select returns selectReturns; a delete
      // returns nothing.
      builder.then = (
        resolve: (v: { data: unknown[] | null; error: null }) => void,
      ) => {
        if (call.op === "update") {
          call.returned = selected ? seed.updateReturns?.[table] ?? [] : [];
        } else if (call.op === "select") {
          call.returned = seed.selectReturns?.[table] ?? [];
        }
        calls.push(call);
        const data = call.op === "delete" ? null : call.returned;
        return Promise.resolve({ data, error: null }).then(resolve);
      };
      return builder;
    },
  };
  return { admin: admin as never, calls };
}

describe("supersedeOlderPendingProposals", () => {
  it("supersedes older pendings on the slide and cleans their notifications", async () => {
    const { admin, calls } = makeAdmin({
      updateReturns: { canvas_deck_edit: [{ id: "old-1" }, { id: "old-2" }] },
    });
    const ids = await supersedeOlderPendingProposals(admin, {
      slideId: "slide-1",
      proposedBy: "user-1",
      newEditId: "new-1",
    });
    expect(ids).toEqual(["old-1", "old-2"]);

    const update = calls.find((c) => c.table === "canvas_deck_edit" && c.op === "update");
    expect(update?.patch?.status).toBe("superseded");
    expect(update?.filters["eq:slide_id"]).toBe("slide-1");
    expect(update?.filters["eq:proposed_by"]).toBe("user-1");
    expect(update?.filters["eq:status"]).toBe("pending");
    expect(update?.filters["neq:id"]).toBe("new-1");
    // resolved_by = the proposer (so it reads as a supersede, not a reject).
    expect(update?.patch?.resolved_by).toBe("user-1");

    // Notifications for the superseded edits are cleared.
    const notif = calls.find((c) => c.table === "canvas_notification");
    expect(notif?.op).toBe("delete");
    expect(notif?.filters["in:edit_id"]).toEqual(["old-1", "old-2"]);
  });

  it("no notification cleanup when nothing was superseded", async () => {
    const { admin, calls } = makeAdmin({ updateReturns: { canvas_deck_edit: [] } });
    const ids = await supersedeOlderPendingProposals(admin, {
      slideId: "s",
      proposedBy: "u",
      newEditId: "n",
    });
    expect(ids).toEqual([]);
    expect(calls.some((c) => c.table === "canvas_notification")).toBe(false);
  });
});

describe("expireStalePendingProposals", () => {
  it("system-withdraws only pendings older than the cutoff, attributing to each proposer", async () => {
    const { admin, calls } = makeAdmin({
      selectReturns: {
        canvas_deck_edit: [
          { id: "stale-1", proposed_by: "u1" },
          { id: "stale-2", proposed_by: "u2" },
        ],
      },
      updateReturns: { canvas_deck_edit: [] },
    });
    const ids = await expireStalePendingProposals(admin, "deck-1");
    expect(ids).toEqual(["stale-1", "stale-2"]);

    const select = calls.find((c) => c.table === "canvas_deck_edit" && c.op === "select");
    expect(select?.filters["eq:deck_id"]).toBe("deck-1");
    expect(select?.filters["eq:status"]).toBe("pending");
    expect(typeof select?.filters["lt:created_at"]).toBe("string");

    // Each expiry stamps resolved_by = that row's proposer.
    const updates = calls.filter((c) => c.table === "canvas_deck_edit" && c.op === "update");
    expect(updates).toHaveLength(2);
    expect(updates[0].patch?.status).toBe("rejected");
    expect(updates.map((u) => u.patch?.resolved_by).sort()).toEqual(["u1", "u2"]);
  });

  it("no-ops when nothing is stale", async () => {
    const { admin, calls } = makeAdmin({ selectReturns: { canvas_deck_edit: [] } });
    const ids = await expireStalePendingProposals(admin, "deck-1");
    expect(ids).toEqual([]);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(0);
  });

  it("uses the documented default age", () => {
    expect(PROPOSAL_EXPIRY_DAYS).toBe(14);
    void vi; // keep vi import (unused-guard) — makeAdmin covers the mocking
  });
});
