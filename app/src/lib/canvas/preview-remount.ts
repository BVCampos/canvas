// Decide whether a change in the deck's slide list should REMOUNT the preview
// iframe or can be absorbed in place (speed discovery 2026-07 #5.2).
//
// The preview iframe is keyed on a signature of every slide's
// `id:position:current_version_id`. Any change bumps the key and remounts —
// which refetches every slide's HTML, re-assembles the whole deck, re-parses
// it, and re-fetches every image with fresh signed URLs. One patched headline
// paid for the whole deck reloading. (The version ID, not the number, keys the
// signature: it's what a canvas_deck_slide realtime WAL row carries, so the
// realtime reducer can converge another tab on the same key the loader uses.)
//
// The insight: when the ONLY change is a version bump the HOST itself just
// produced (an inline direct-save), the iframe ALREADY shows the edited
// content — the CANVAS_EDITOR committed it in the DOM and dropped
// contenteditable on stopEdit. Remounting only throws that away and reloads
// the identical bytes. So we skip the remount for changes that are purely
// self-applied version bumps on a structurally-identical slide set. Anything
// structural (add / remove / reorder) or any version bump the host DIDN'T
// author (a teammate's edit, an approved proposal, a restore) still remounts,
// because the iframe's in-DOM content wouldn't reflect it.

export type SlideSig = { id: string; position: number; version: string };

// Parse the "id:position:version|id:position:version|…" signature string the
// workspace builds from its slide rows. `version` is the current_version_id
// (a UUID or "0" for a slide with no version yet) — neither it nor the slide
// id contains a colon, so the last two colon fields are position and version.
export function parseSlideSignature(signature: string): SlideSig[] {
  if (!signature) return [];
  return signature.split("|").map((part) => {
    const lastColon = part.lastIndexOf(":");
    const prevColon = part.lastIndexOf(":", lastColon - 1);
    return {
      id: part.slice(0, prevColon),
      position: Number(part.slice(prevColon + 1, lastColon)),
      version: part.slice(lastColon + 1),
    };
  });
}

export type RemountDecision =
  | { remount: true }
  // Skip the remount; `consumed` are the self-applied signature keys that
  // matched (so the caller can drop them from its pending set).
  | { remount: false; consumed: string[] };

// The per-slide self-applied key: `${id}:${versionId}`. Position is
// deliberately excluded — an inline edit never moves a slide, and matching on
// the version id alone keeps the key stable if positions renumber for an
// unrelated reason.
export function selfAppliedKey(slideId: string, versionId: string): string {
  return `${slideId}:${versionId}`;
}

// Given the previous and next signatures and the set of self-applied
// `${id}:${version}` keys, decide whether to remount.
export function decideRemount(
  prevSignature: string,
  nextSignature: string,
  selfApplied: ReadonlySet<string>,
): RemountDecision {
  if (prevSignature === nextSignature) return { remount: false, consumed: [] };

  const prev = parseSlideSignature(prevSignature);
  const next = parseSlideSignature(nextSignature);

  // Structural change → the slide SET or ORDER moved. The iframe's DOM can't
  // absorb an add/remove/reorder in place, so remount.
  if (prev.length !== next.length) return { remount: true };
  const prevById = new Map(prev.map((s) => [s.id, s]));
  for (const s of next) {
    const before = prevById.get(s.id);
    if (!before || before.position !== s.position) return { remount: true };
  }

  // Same slides, same positions: the only differences are version bumps.
  // Skip the remount ONLY if every bumped slide is one the host self-applied.
  const consumed: string[] = [];
  for (const s of next) {
    const before = prevById.get(s.id)!;
    if (before.version === s.version) continue;
    const key = selfAppliedKey(s.id, s.version);
    if (!selfApplied.has(key)) return { remount: true };
    consumed.push(key);
  }
  return { remount: false, consumed };
}
