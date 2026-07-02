// Per-deck activity feed, derived at read time.
//
// Canvas already records every action somewhere — proposals in
// canvas_deck_edit (with proposer + resolver), content changes in
// canvas_slide_version (with author + source_prompt), snapshots in
// canvas_deck_snapshot, comments in canvas_comment, and the direct structural
// ops in canvas_deck_activity (slide deletes the CASCADE would erase, migration
// 0037; direct draw-create + duplicate whose only version is the skipped v1
// birth, migration 0073). This module merges those rows into one chronological
// "who did what" feed: "Alice added slide 5", "Bob deleted slide 3",
// "Mooching edited the deck theme".
//
// Pure and client-safe (no Supabase / Node imports) so it can be unit-tested
// directly: the history page fetches the rows, resolves display names, and
// calls buildDeckActivity.

export type ActivityTone =
  | "create"
  | "add"
  | "edit"
  | "delete"
  | "reorder"
  | "restore"
  | "snapshot"
  | "comment"
  | "reject"
  | "pending";

export type ActivityEvent = {
  id: string;
  /** ISO timestamp — the feed's sort key. */
  at: string;
  tone: ActivityTone;
  /** Resolved display name of the person who did it. */
  actor: string;
  /** True when the action arrived through the actor's Claude session (MCP). */
  viaClaude: boolean;
  /** Sentence after the actor name: "added slide 5 “Pricing”". */
  text: string;
  /** Secondary line: approver, rationale excerpt, comment body, … */
  meta?: string;
  /** True for not-yet-resolved proposals. */
  pending?: boolean;
};

export type ActivityDeckRow = {
  id: string;
  created_by: string | null;
  created_at: string;
};

export type ActivitySlideRow = {
  id: string;
  position: number;
  title: string;
};

export type ActivityEditRow = {
  id: string;
  kind: string;
  status: string;
  slide_id: string | null;
  proposed_by: string | null;
  proposed_by_kind: string;
  resolved_by: string | null;
  rationale: string | null;
  /** new_slide_payload->>'title' — only slide_create proposals carry it. */
  payload_title: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type ActivityVersionRow = {
  id: string;
  slide_id: string;
  version_no: number;
  author_kind: string;
  created_by: string | null;
  source_prompt: string | null;
  source_edit_id: string | null;
  created_at: string;
};

export type ActivitySnapshotRow = {
  id: string;
  label: string;
  description: string | null;
  kind: string;
  created_by: string | null;
  created_at: string;
};

export type ActivityCommentRow = {
  id: string;
  slide_id: string | null;
  parent_id: string | null;
  author_kind: string;
  author_id: string | null;
  // Client (guest) comments carry no author_id — their display name is stored
  // here (migration 0064). Absent/null for user/claude authors.
  author_name?: string | null;
  body: string;
  created_at: string;
};

/** Rows from canvas_deck_activity: slide_delete (0037), slide_create + slide_duplicate (0073). */
export type ActivityLogRow = {
  id: string;
  action: string;
  actor_id: string | null;
  actor_kind: string;
  subject_user_id: string | null;
  detail: Record<string, unknown>;
  created_at: string;
};

export type ActivityInput = {
  deck: ActivityDeckRow;
  slides: ActivitySlideRow[];
  edits: ActivityEditRow[];
  versions: ActivityVersionRow[];
  snapshots: ActivitySnapshotRow[];
  comments: ActivityCommentRow[];
  log: ActivityLogRow[];
};

const EXCERPT_CHARS = 120;
const TITLE_CHARS = 60;

function truncate(s: string, n: number): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

function joinMeta(parts: Array<string | null | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => Boolean(p));
  return kept.length ? kept.join(" · ") : undefined;
}

export function buildDeckActivity(
  input: ActivityInput,
  names: Map<string, string>,
): ActivityEvent[] {
  const nameOf = (id: string | null | undefined): string =>
    (id && names.get(id)) || "Unknown user";

  const slideById = new Map(input.slides.map((s) => [s.id, s]));
  const slideRef = (slideId: string | null): string => {
    const slide = slideId ? slideById.get(slideId) : undefined;
    if (!slide) return "a deleted slide";
    return `slide ${slide.position + 1} “${truncate(slide.title, TITLE_CHARS)}”`;
  };

  const events: ActivityEvent[] = [];

  // --- Deck creation -------------------------------------------------------
  events.push({
    id: `deck-${input.deck.id}`,
    at: input.deck.created_at,
    tone: "create",
    actor: nameOf(input.deck.created_by),
    viaClaude: false,
    text: "created this deck",
  });

  // --- Proposals (canvas_deck_edit) ----------------------------------------
  // One event per proposal: applied reads as the action itself ("added slide
  // …, approved by Y"), rejected/withdrawn as the resolution, pending as the
  // open proposal. Applied slide_delete rows never appear here — the row
  // cascade-deletes with the slide (see 0024/0037); deletions come from `log`.
  for (const e of input.edits) {
    const rationale = e.rationale ? `“${truncate(e.rationale, EXCERPT_CHARS)}”` : null;
    const viaClaude = e.proposed_by_kind === "claude";

    if (e.status === "applied") {
      const { text, tone } = appliedPhrase(e, slideRef);
      const approvedBy =
        e.resolved_by && e.resolved_by !== e.proposed_by
          ? `approved by ${nameOf(e.resolved_by)}`
          : null;
      events.push({
        id: `edit-${e.id}`,
        at: e.resolved_at ?? e.created_at,
        tone,
        actor: nameOf(e.proposed_by),
        viaClaude,
        text,
        meta: joinMeta([approvedBy, rationale]),
      });
    } else if (e.status === "rejected") {
      const noun = proposalNoun(e, slideRef);
      // canvas_withdraw_edit records resolved_by = proposer (see 0005) — same
      // end status as reject, distinguishable only by who resolved it.
      const withdrawn = e.resolved_by != null && e.resolved_by === e.proposed_by;
      events.push({
        id: `edit-${e.id}`,
        at: e.resolved_at ?? e.created_at,
        tone: "reject",
        actor: nameOf(withdrawn ? e.proposed_by : e.resolved_by),
        viaClaude: withdrawn && viaClaude,
        text: withdrawn
          ? `withdrew their proposal: ${noun}`
          : `rejected ${nameOf(e.proposed_by)}’s proposal: ${noun}`,
        meta: joinMeta([rationale]),
      });
    } else if (e.status === "pending") {
      events.push({
        id: `edit-${e.id}`,
        at: e.created_at,
        tone: "pending",
        actor: nameOf(e.proposed_by),
        viaClaude,
        text: `proposed ${proposalNoun(e, slideRef)}`,
        meta: joinMeta([rationale]),
        pending: true,
      });
    } else if (e.status === "superseded") {
      // A proposal set aside without a reviewer decision: either the proposer's
      // own newer proposal replaced this older one (supersede-on-propose,
      // proposal-hygiene.ts) or a variant pick swept the losing siblings
      // (canvas_apply_variant, 0066/0068). resolved_by (the proposer in the
      // first case, the picker in the second) tells them apart — same split as
      // the reject/withdraw branch above.
      const noun = proposalNoun(e, slideRef);
      const byProposer = e.resolved_by != null && e.resolved_by === e.proposed_by;
      events.push({
        id: `edit-${e.id}`,
        at: e.resolved_at ?? e.created_at,
        tone: "reject",
        actor: nameOf(byProposer ? e.proposed_by : e.resolved_by),
        viaClaude: byProposer && viaClaude,
        text: byProposer
          ? `set aside their earlier proposal: ${noun}`
          : `set aside ${nameOf(e.proposed_by)}’s proposal: ${noun}`,
        meta: joinMeta([rationale]),
      });
    }
  }

  // --- Versions without a proposal: restores + direct edits ----------------
  // Proposal-backed versions carry source_edit_id (covered above). version_no
  // 1 with no edit is the slide's import-time birth — covered by the
  // deck-created event, and listing 90 of them per import would be noise.
  const SNAPSHOT_RESTORE_RE = /^restored from snapshot '([\s\S]+)'$/;
  const VERSION_RESTORE_RE = /^restored from v(\d+)$/;
  const snapshotRestoreGroups = new Map<
    string,
    { first: ActivityVersionRow; label: string; count: number }
  >();

  for (const v of input.versions) {
    if (v.source_edit_id || v.version_no <= 1) continue;

    const prompt = v.source_prompt ?? "";
    const snapMatch = prompt.match(SNAPSHOT_RESTORE_RE);
    if (snapMatch) {
      // canvas_restore_snapshot stamps every advanced slide with the same
      // prompt + transaction timestamp — collapse them into one feed event.
      // %L doubles embedded quotes; undo that for display.
      const key = `${v.created_by ?? ""}|${prompt}|${v.created_at}`;
      const group = snapshotRestoreGroups.get(key);
      if (group) {
        group.count += 1;
      } else {
        snapshotRestoreGroups.set(key, {
          first: v,
          label: snapMatch[1].replace(/''/g, "'"),
          count: 1,
        });
      }
      continue;
    }

    const verMatch = prompt.match(VERSION_RESTORE_RE);
    if (verMatch) {
      events.push({
        id: `version-${v.id}`,
        at: v.created_at,
        tone: "restore",
        actor: nameOf(v.created_by),
        viaClaude: v.author_kind === "claude",
        text: `restored ${slideRef(v.slide_id)} to v${verMatch[1]}`,
      });
      continue;
    }

    // canvas_save_slide_direct (0033): the inline "Edit text" / raw-HTML save.
    events.push({
      id: `version-${v.id}`,
      at: v.created_at,
      tone: "edit",
      actor: nameOf(v.created_by),
      viaClaude: v.author_kind === "claude",
      text: `edited ${slideRef(v.slide_id)} directly`,
      meta:
        prompt && prompt !== "Direct edit"
          ? `“${truncate(prompt, EXCERPT_CHARS)}”`
          : undefined,
    });
  }

  for (const group of snapshotRestoreGroups.values()) {
    events.push({
      id: `version-${group.first.id}`,
      at: group.first.created_at,
      tone: "restore",
      actor: nameOf(group.first.created_by),
      viaClaude: group.first.author_kind === "claude",
      text: `restored snapshot “${truncate(group.label, TITLE_CHARS)}”`,
      meta: `${group.count} slide${group.count === 1 ? "" : "s"} rolled forward`,
    });
  }

  // --- Snapshots ------------------------------------------------------------
  // Auto-snapshot kinds double as action markers: pre_export fires on every
  // download/share-link, pre_share on "mark as sent". pre_restore is skipped
  // (the restore itself is already an event above) and daily is system noise.
  for (const s of input.snapshots) {
    const base = {
      id: `snapshot-${s.id}`,
      at: s.created_at,
      tone: "snapshot" as const,
      actor: nameOf(s.created_by),
      viaClaude: false,
    };
    if (s.kind === "manual") {
      events.push({
        ...base,
        text: `saved snapshot “${truncate(s.label, TITLE_CHARS)}”`,
        meta: s.description ? truncate(s.description, EXCERPT_CHARS) : undefined,
      });
    } else if (s.kind === "pre_export") {
      events.push({ ...base, text: "exported the deck" });
    } else if (s.kind === "pre_share") {
      events.push({ ...base, text: "marked the deck as sent to the client" });
    } else if (s.kind === "pre_consolidate") {
      events.push({ ...base, text: "started a consolidate run" });
    }
  }

  // --- Comments --------------------------------------------------------------
  for (const c of input.comments) {
    const target = c.slide_id ? slideRef(c.slide_id) : "the deck";
    // Client (guest) comments have no user account, so nameOf would render
    // "Unknown user"; use the stored guest name with a "(guest)" suffix.
    const actor =
      c.author_kind === "client"
        ? `${c.author_name?.trim() || "Guest"} (guest)`
        : nameOf(c.author_id);
    events.push({
      id: `comment-${c.id}`,
      at: c.created_at,
      tone: "comment",
      actor,
      viaClaude: c.author_kind === "claude",
      text: c.parent_id
        ? `replied to a comment on ${target}`
        : `commented on ${target}`,
      meta: `“${truncate(c.body, EXCERPT_CHARS)}”`,
    });
  }

  // --- Direct structural ops (canvas_deck_activity, migrations 0037 + 0073) ---
  // Slide deletions (0037) plus the direct additive ops (0073): a drawn slide
  // (slide_create) and an in-app / cross-deck copy (slide_duplicate). Each is a
  // direct, non-proposal op whose only other trace the read-time derivation
  // can't use — a delete CASCADE-erases its rows, and an additive op's sole
  // version is the v1 birth the version pass skips as import noise.
  for (const row of input.log) {
    const title = typeof row.detail.slide_title === "string" ? row.detail.slide_title : null;
    const position = typeof row.detail.position === "number" ? row.detail.position : null;
    const ref =
      title !== null && position !== null
        ? `slide ${position + 1} “${truncate(title, TITLE_CHARS)}”`
        : title !== null
          ? `slide “${truncate(title, TITLE_CHARS)}”`
          : "a slide";
    const base = {
      id: `activity-${row.id}`,
      at: row.created_at,
      actor: nameOf(row.actor_id),
      viaClaude: row.actor_kind === "claude",
    };
    if (row.action === "slide_delete") {
      const rationale =
        typeof row.detail.rationale === "string" && row.detail.rationale
          ? `“${truncate(row.detail.rationale, EXCERPT_CHARS)}”`
          : null;
      const proposedBy = row.subject_user_id
        ? `proposed by ${nameOf(row.subject_user_id)}${
            row.detail.proposed_by_kind === "claude" ? " via agent" : ""
          }`
        : null;
      events.push({
        ...base,
        tone: "delete",
        text: `deleted ${ref}`,
        meta: joinMeta([proposedBy, rationale]),
      });
    } else if (row.action === "slide_create") {
      events.push({ ...base, tone: "add", text: `added ${ref}` });
    } else if (row.action === "slide_duplicate") {
      events.push({ ...base, tone: "add", text: `duplicated ${ref}` });
    }
  }

  // Newest first. ISO-8601 strings (uniform source) compare lexically in
  // chronological order; tie-break on id so the order is deterministic.
  events.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return events;
}

// "X <did the thing>" for an applied proposal.
function appliedPhrase(
  e: ActivityEditRow,
  slideRef: (id: string | null) => string,
): { text: string; tone: ActivityTone } {
  switch (e.kind) {
    case "slide_create":
      return {
        text: e.payload_title
          ? `added slide “${truncate(e.payload_title, TITLE_CHARS)}”`
          : "added a slide",
        tone: "add",
      };
    case "slide_title":
      return { text: `renamed ${slideRef(e.slide_id)}`, tone: "edit" };
    case "slide_styles":
      return { text: `restyled ${slideRef(e.slide_id)}`, tone: "edit" };
    case "slide_reorder":
      return { text: "reordered the slides", tone: "reorder" };
    case "slide_delete":
      // Shouldn't survive as 'applied' (the row cascade-deletes), but render
      // sensibly if one ever does.
      return { text: `deleted ${slideRef(e.slide_id)}`, tone: "delete" };
    case "theme_css":
      return { text: "edited the deck theme", tone: "edit" };
    case "nav_js":
      return { text: "edited the deck navigation", tone: "edit" };
    case "deck_title":
      return { text: "renamed the deck", tone: "edit" };
    case "slide_edit":
    case "slide_html":
    default:
      return { text: `edited ${slideRef(e.slide_id)}`, tone: "edit" };
  }
}

// "…proposed <noun>" / "…rejected X's proposal: <noun>".
function proposalNoun(
  e: ActivityEditRow,
  slideRef: (id: string | null) => string,
): string {
  switch (e.kind) {
    case "slide_create":
      return e.payload_title
        ? `a new slide “${truncate(e.payload_title, TITLE_CHARS)}”`
        : "a new slide";
    case "slide_title":
      return `a rename of ${slideRef(e.slide_id)}`;
    case "slide_styles":
      return `a restyle of ${slideRef(e.slide_id)}`;
    case "slide_reorder":
      return "a slide reorder";
    case "slide_delete":
      return `deleting ${slideRef(e.slide_id)}`;
    case "theme_css":
      return "a theme edit";
    case "nav_js":
      return "a navigation edit";
    case "deck_title":
      return "a deck rename";
    case "slide_edit":
    case "slide_html":
    default:
      return `an edit to ${slideRef(e.slide_id)}`;
  }
}
