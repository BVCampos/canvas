import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  applyMentionSelection,
  filterMentionCandidates,
  resolveMentions,
  toCandidate,
  type MentionMember,
} from "../src/lib/canvas/mention";

// The pure @mention engine shared by the composer autocomplete and the
// server-side resolver in canvases/[id]/actions.ts. The saved comment text is
// what the server re-parses into mentioned user_ids, so resolveMentions IS the
// resolution contract; the rest (query detection, filter, splice) drives the
// composer's dropdown. No React, no DB.

const members: MentionMember[] = [
  { id: "u-joao-acme", name: "Joao Silva", email: "joao.silva@acme.com" },
  { id: "u-joao-beta", name: "Joao Souza", email: "joao@beta.com" },
  { id: "u-bern", name: "Bernardo Campos", email: "bernardo@21x.com" },
  { id: "u-noname", name: null, email: "ana@acme.com" },
];

describe("resolveMentions — email handles (unique)", () => {
  it("resolves an email handle to exactly one member", () => {
    const ids = resolveMentions("hey @joao.silva@acme.com take a look", members);
    expect(ids).toEqual(["u-joao-acme"]);
  });

  it("disambiguates two members who share a first name via the email handle", () => {
    const ids = resolveMentions(
      "@joao.silva@acme.com vs @joao@beta.com",
      members,
    );
    expect(ids).toEqual(["u-joao-acme", "u-joao-beta"]);
  });

  it("does not also fire a short match for the local-part of an email handle", () => {
    // "@joao.silva@acme.com" must NOT additionally resolve the OTHER joao via a
    // stray "@joao" short match — only the email's owner.
    const ids = resolveMentions("@joao.silva@acme.com", members);
    expect(ids).toEqual(["u-joao-acme"]);
  });

  it("ignores an email handle that matches no member", () => {
    expect(resolveMentions("@ghost@nowhere.com", members)).toEqual([]);
  });
});

describe("resolveMentions — short handles (legacy)", () => {
  it("matches a first name", () => {
    expect(resolveMentions("ping @bernardo please", members)).toEqual(["u-bern"]);
  });

  it("matches an email local-part", () => {
    expect(resolveMentions("ping @ana", members)).toEqual(["u-noname"]);
  });

  it("returns BOTH members when a short handle is ambiguous (the reason the composer prefers email handles)", () => {
    const ids = resolveMentions("@joao", members);
    expect(ids.sort()).toEqual(["u-joao-acme", "u-joao-beta"].sort());
  });

  it("dedupes a member mentioned twice", () => {
    expect(resolveMentions("@bernardo and again @bernardo", members)).toEqual([
      "u-bern",
    ]);
  });

  it("is case-insensitive on the token", () => {
    expect(resolveMentions("@Bernardo", members)).toEqual(["u-bern"]);
  });
});

describe("resolveMentions — edge cases", () => {
  it("returns [] when the body has no @", () => {
    expect(resolveMentions("no mentions here", members)).toEqual([]);
  });

  it("returns [] when there are no members", () => {
    expect(resolveMentions("@bernardo", [])).toEqual([]);
  });

  it("does not treat an inline email (no leading-@ token) as a mention via short match", () => {
    // "write to joao@beta.com" has an @ but the local-part isn't a standalone
    // @token, so the email handle regex needs the leading @. It should still
    // match the email handle form only when prefixed by @.
    const ids = resolveMentions("write to joao@beta.com", members);
    // The EMAIL handle regex requires a leading @ before the local part, so a
    // bare "joao@beta.com" is matched as "@beta" short? No — there's no leading
    // @ on "joao". The "@beta.com" fragment has a leading @ but isn't an email
    // shape on its own. Net: no resolution.
    expect(ids).toEqual([]);
  });
});

describe("activeMentionQuery", () => {
  it("detects an open mention at the caret", () => {
    const v = "hey @ber";
    expect(activeMentionQuery(v, v.length)).toEqual({ token: "ber", atIndex: 4 });
  });

  it("detects an empty token right after typing @", () => {
    const v = "hey @";
    expect(activeMentionQuery(v, v.length)).toEqual({ token: "", atIndex: 4 });
  });

  it("returns null after a space closes the token", () => {
    const v = "hey @ber ";
    expect(activeMentionQuery(v, v.length)).toBeNull();
  });

  it("does not open on an @ that is part of an email (preceded by a non-space)", () => {
    const v = "joao@beta";
    expect(activeMentionQuery(v, v.length)).toBeNull();
  });

  it("opens at start-of-string", () => {
    const v = "@be";
    expect(activeMentionQuery(v, v.length)).toEqual({ token: "be", atIndex: 0 });
  });

  it("uses the caret position, not end-of-string", () => {
    const v = "@joao and @bern";
    // caret right after the first token
    expect(activeMentionQuery(v, 5)).toEqual({ token: "joao", atIndex: 0 });
  });
});

describe("filterMentionCandidates", () => {
  const candidates = members.map(toCandidate);

  it("returns all candidates for an empty token (just typed @)", () => {
    expect(filterMentionCandidates(candidates, "")).toHaveLength(members.length);
  });

  it("ranks prefix matches above substring matches", () => {
    // "ana" is a prefix of the no-name member's local-part; "bernardo" contains
    // no "ana". Query "an" should surface ana first.
    const out = filterMentionCandidates(candidates, "an");
    expect(out[0].id).toBe("u-noname");
  });

  it("matches across label, email, and local-part", () => {
    const out = filterMentionCandidates(candidates, "21x");
    expect(out.map((c) => c.id)).toContain("u-bern");
  });

  it("respects the limit", () => {
    expect(filterMentionCandidates(candidates, "", 2)).toHaveLength(2);
  });

  it("returns [] when nothing matches", () => {
    expect(filterMentionCandidates(candidates, "zzz")).toEqual([]);
  });
});

describe("toCandidate", () => {
  it("builds the email handle and a display label from the name", () => {
    const c = toCandidate(members[0]);
    expect(c.handle).toBe("@joao.silva@acme.com");
    expect(c.label).toBe("Joao Silva");
  });

  it("falls back to the email local-part as the label when there is no name", () => {
    const c = toCandidate(members[3]);
    expect(c.label).toBe("ana");
    expect(c.handle).toBe("@ana@acme.com");
  });
});

describe("applyMentionSelection", () => {
  it("splices the handle in place of the in-progress token and trails a space", () => {
    const value = "hey @jo and hi";
    const query = activeMentionQuery(value, 7)!; // caret at end of "@jo"
    const candidate = toCandidate(members[0]);
    const out = applyMentionSelection(value, query, candidate);
    expect(out.value).toBe("hey @joao.silva@acme.com  and hi");
    // caret sits right after the inserted handle + its trailing space
    expect(out.value.slice(0, out.caret)).toBe("hey @joao.silva@acme.com ");
  });

  it("the spliced result round-trips through resolveMentions to the right member", () => {
    const value = "@jo";
    const query = activeMentionQuery(value, value.length)!;
    const out = applyMentionSelection(value, query, toCandidate(members[1]));
    expect(resolveMentions(out.value, members)).toEqual(["u-joao-beta"]);
  });
});
