import { describe, expect, it } from "vitest";
import {
  buildDeckActivity,
  type ActivityEditRow,
  type ActivityInput,
  type ActivityVersionRow,
} from "../src/lib/canvas/activity";

// Three actors so proposer / approver / rejecter phrasing is distinguishable.
const ALICE = "00000000-0000-0000-0000-000000000001";
const BOB = "00000000-0000-0000-0000-000000000002";
const MOOCHING = "00000000-0000-0000-0000-000000000003";
const names = new Map([
  [ALICE, "Alice"],
  [BOB, "Bob"],
  [MOOCHING, "Mooching"],
]);

const SLIDE_A = "aaaaaaaa-0000-0000-0000-000000000001";

const emptyInput: ActivityInput = {
  deck: { id: "deck-1", created_by: ALICE, created_at: "2026-06-01T10:00:00+00:00" },
  slides: [{ id: SLIDE_A, position: 2, title: "Pricing" }],
  edits: [],
  versions: [],
  snapshots: [],
  comments: [],
  log: [],
};

const baseEdit: ActivityEditRow = {
  id: "edit-id",
  kind: "slide_edit",
  status: "applied",
  slide_id: SLIDE_A,
  proposed_by: ALICE,
  proposed_by_kind: "user",
  resolved_by: BOB,
  rationale: null,
  payload_title: null,
  created_at: "2026-06-02T10:00:00+00:00",
  resolved_at: "2026-06-02T11:00:00+00:00",
};

function build(overrides: Partial<ActivityInput>) {
  return buildDeckActivity({ ...emptyInput, ...overrides }, names);
}

describe("buildDeckActivity", () => {
  it("always includes the deck-created event", () => {
    const events = build({});
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor: "Alice",
      text: "created this deck",
      tone: "create",
      at: "2026-06-01T10:00:00+00:00",
    });
  });

  it("renders an applied edit as the action, crediting the approver", () => {
    const [event] = build({ edits: [baseEdit] });
    expect(event.actor).toBe("Alice");
    expect(event.text).toBe("edited slide 3 “Pricing”");
    expect(event.meta).toBe("approved by Bob");
    expect(event.at).toBe("2026-06-02T11:00:00+00:00"); // resolved_at, not created_at
  });

  it("omits the approver when the proposer self-approved", () => {
    const [event] = build({
      edits: [{ ...baseEdit, resolved_by: ALICE, rationale: "tighten copy" }],
    });
    expect(event.meta).toBe("“tighten copy”");
  });

  it("uses the payload title for slide_create (the slide row may not exist yet)", () => {
    const [event] = build({
      edits: [
        {
          ...baseEdit,
          kind: "slide_create",
          slide_id: null,
          payload_title: "Roadmap",
          proposed_by_kind: "claude",
        },
      ],
    });
    expect(event.text).toBe("added slide “Roadmap”");
    expect(event.tone).toBe("add");
    expect(event.viaClaude).toBe(true);
  });

  it("distinguishes rejection from withdrawal by who resolved", () => {
    const [rejected] = build({
      edits: [{ ...baseEdit, status: "rejected", resolved_by: BOB }],
    });
    expect(rejected.actor).toBe("Bob");
    expect(rejected.text).toBe("rejected Alice’s proposal: an edit to slide 3 “Pricing”");

    const [withdrawn] = build({
      edits: [{ ...baseEdit, status: "rejected", resolved_by: ALICE }],
    });
    expect(withdrawn.actor).toBe("Alice");
    expect(withdrawn.text).toBe("withdrew their proposal: an edit to slide 3 “Pricing”");
  });

  it("marks pending proposals", () => {
    const [event] = build({
      edits: [{ ...baseEdit, status: "pending", resolved_by: null, resolved_at: null }],
    });
    expect(event.pending).toBe(true);
    expect(event.text).toBe("proposed an edit to slide 3 “Pricing”");
    expect(event.at).toBe(baseEdit.created_at);
  });

  it("falls back to “a deleted slide” when the slide is gone", () => {
    const [event] = build({
      edits: [{ ...baseEdit, slide_id: "bbbbbbbb-0000-0000-0000-000000000099" }],
    });
    expect(event.text).toBe("edited a deleted slide");
  });

  const baseVersion: ActivityVersionRow = {
    id: "version-id",
    slide_id: SLIDE_A,
    version_no: 4,
    author_kind: "user",
    created_by: BOB,
    source_prompt: null,
    source_edit_id: null,
    created_at: "2026-06-03T09:00:00+00:00",
  };

  it("skips proposal-backed versions and v1 birth rows", () => {
    const events = build({
      versions: [
        { ...baseVersion, source_edit_id: "some-edit" },
        { ...baseVersion, id: "v1", version_no: 1 },
      ],
    });
    expect(events).toHaveLength(1); // deck-created only
  });

  it("classifies single-version restores from source_prompt", () => {
    const [event] = build({
      versions: [{ ...baseVersion, source_prompt: "restored from v2" }],
    });
    expect(event.text).toBe("restored slide 3 “Pricing” to v2");
    expect(event.tone).toBe("restore");
  });

  it("collapses a snapshot restore into one event with a slide count", () => {
    const prompt = "restored from snapshot 'Client''s cut'";
    const restores = ["r1", "r2", "r3"].map((id) => ({
      ...baseVersion,
      id,
      source_prompt: prompt,
    }));
    const events = build({ versions: restores });
    expect(events).toHaveLength(2); // grouped restore + deck-created
    expect(events[0].text).toBe("restored snapshot “Client's cut”");
    expect(events[0].meta).toBe("3 slides rolled forward");
  });

  it("renders direct saves, surfacing a real summary but not the default", () => {
    const events = build({
      versions: [
        { ...baseVersion, source_prompt: "Direct edit" },
        { ...baseVersion, id: "v-sum", source_prompt: "fixed the chart label" },
      ],
    });
    const [withSummary, noSummary] = [
      events.find((e) => e.id === "version-v-sum")!,
      events.find((e) => e.id === "version-version-id")!,
    ];
    expect(noSummary.text).toBe("edited slide 3 “Pricing” directly");
    expect(noSummary.meta).toBeUndefined();
    expect(withSummary.meta).toBe("“fixed the chart label”");
  });

  it("maps snapshot kinds to actions and skips pre_restore/daily", () => {
    const base = {
      label: "Cut",
      description: null,
      created_by: MOOCHING,
      created_at: "2026-06-04T08:00:00+00:00",
    };
    const events = build({
      snapshots: [
        { ...base, id: "s1", kind: "manual" },
        { ...base, id: "s2", kind: "pre_export" },
        { ...base, id: "s3", kind: "pre_restore" },
        { ...base, id: "s4", kind: "daily" },
      ],
    });
    const texts = events.map((e) => e.text);
    expect(texts).toContain("saved snapshot “Cut”");
    expect(texts).toContain("exported the deck");
    expect(events).toHaveLength(3); // 2 snapshots + deck-created
  });

  it("renders comments and replies with an excerpt", () => {
    const events = build({
      comments: [
        {
          id: "c1",
          slide_id: SLIDE_A,
          parent_id: null,
          author_kind: "claude",
          author_id: MOOCHING,
          body: "Numbers look off here",
          created_at: "2026-06-05T08:00:00+00:00",
        },
        {
          id: "c2",
          slide_id: null,
          parent_id: "c1",
          author_kind: "user",
          author_id: BOB,
          body: "Agreed",
          created_at: "2026-06-05T09:00:00+00:00",
        },
      ],
    });
    const root = events.find((e) => e.id === "comment-c1")!;
    expect(root.text).toBe("commented on slide 3 “Pricing”");
    expect(root.meta).toBe("“Numbers look off here”");
    expect(root.viaClaude).toBe(true);
    expect(events.find((e) => e.id === "comment-c2")!.text).toBe(
      "replied to a comment on the deck",
    );
  });

  it("renders slide deletions from the activity log with proposer attribution", () => {
    const [event] = build({
      log: [
        {
          id: "a1",
          action: "slide_delete",
          actor_id: BOB,
          actor_kind: "user",
          subject_user_id: ALICE,
          detail: {
            slide_title: "Old intro",
            position: 0,
            rationale: "outdated",
            proposed_by_kind: "claude",
          },
          created_at: "2026-06-06T08:00:00+00:00",
        },
      ],
    });
    expect(event.actor).toBe("Bob");
    expect(event.text).toBe("deleted slide 1 “Old intro”");
    expect(event.tone).toBe("delete");
    expect(event.meta).toBe("proposed by Alice via agent · “outdated”");
  });

  it("renders a superseded proposal as a 'set aside' event, split by who resolved it", () => {
    // Variant pick: a DIFFERENT actor (the picker) swept the losing sibling.
    const [byPicker] = build({
      edits: [{ ...baseEdit, status: "superseded", proposed_by: ALICE, resolved_by: BOB }],
    });
    expect(byPicker.actor).toBe("Bob");
    expect(byPicker.text).toBe("set aside Alice’s proposal: an edit to slide 3 “Pricing”");
    expect(byPicker.tone).toBe("reject");
    expect(byPicker.viaClaude).toBe(false);

    // Self-supersede: the proposer's own newer proposal replaced this one.
    const [bySelf] = build({
      edits: [
        {
          ...baseEdit,
          status: "superseded",
          proposed_by: ALICE,
          resolved_by: ALICE,
          proposed_by_kind: "claude",
        },
      ],
    });
    expect(bySelf.actor).toBe("Alice");
    expect(bySelf.text).toBe("set aside their earlier proposal: an edit to slide 3 “Pricing”");
    // Self-supersede via the agent stays credited to Claude.
    expect(bySelf.viaClaude).toBe(true);
  });

  it("renders direct additive ops (slide_create / slide_duplicate) from the activity log", () => {
    const events = build({
      log: [
        {
          id: "a-create",
          action: "slide_create",
          actor_id: ALICE,
          actor_kind: "user",
          subject_user_id: null,
          detail: { slide_title: "Sketch", position: 4 },
          created_at: "2026-06-06T08:00:00+00:00",
        },
        {
          id: "a-dup",
          action: "slide_duplicate",
          actor_id: BOB,
          actor_kind: "user",
          subject_user_id: null,
          detail: {
            slide_title: "Pricing",
            position: 3,
            source_slide_id: SLIDE_A,
            source_slide_title: "Pricing",
          },
          created_at: "2026-06-06T09:00:00+00:00",
        },
      ],
    });
    const created = events.find((e) => e.id === "activity-a-create")!;
    const duplicated = events.find((e) => e.id === "activity-a-dup")!;
    // position is 0-based in the detail; the feed renders it 1-based.
    expect(created.text).toBe("added slide 5 “Sketch”");
    expect(created.tone).toBe("add");
    expect(created.actor).toBe("Alice");
    expect(duplicated.text).toBe("duplicated slide 4 “Pricing”");
    expect(duplicated.tone).toBe("add");
    expect(duplicated.actor).toBe("Bob");
  });

  it("sorts newest-first across sources", () => {
    const events = build({
      edits: [baseEdit], // 2026-06-02T11
      snapshots: [
        {
          id: "s1",
          label: "Cut",
          description: null,
          kind: "manual",
          created_by: BOB,
          created_at: "2026-06-07T08:00:00+00:00",
        },
      ],
    });
    expect(events.map((e) => e.id)).toEqual([
      "snapshot-s1",
      "edit-edit-id",
      "deck-deck-1",
    ]);
  });

  it("labels unknown actors without throwing", () => {
    const [event] = build({
      edits: [{ ...baseEdit, proposed_by: "not-in-map", resolved_by: null }],
    });
    expect(event.actor).toBe("Unknown user");
  });
});
