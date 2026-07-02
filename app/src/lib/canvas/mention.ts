// Pure @mention helpers shared by the comment composer (autocomplete) and the
// server-side resolver in canvases/[id]/actions.ts. Kept free of React and
// Supabase so the matching rules can be unit-tested in isolation — the saved
// comment text is what the server re-parses into mentioned user_ids, so the
// parse/match rules here ARE the resolution contract.
//
// Two handle shapes are honored, in priority order:
//   1. Email handle  — `@joao.silva@acme.com`. The autocomplete inserts this
//      because an email is globally unique, so it resolves to exactly one
//      member with no first-name / local-part collision. The user never types
//      the ugly tail: they pick a row and we splice the full handle in.
//   2. Short handle  — `@joao` / `@joao.silva`. Matched against a member's
//      first name OR email local-part (lowercased). This is the legacy shape
//      (hand-typed comments, Claude-authored mentions) and stays supported, but
//      it can be ambiguous when two members share a first name or local-part —
//      which is exactly why the autocomplete prefers the email handle.

export type MentionMember = {
  id: string;
  name: string | null;
  email: string | null;
};

// A member as the dropdown needs it: identity plus the precomputed handle we
// splice into the textarea on select.
export type MentionCandidate = MentionMember & {
  /** Display label — real name when present, else the email local-part. */
  label: string;
  /** Canonical, unambiguous handle inserted on select, including the leading @. */
  handle: string;
};

// Email-shaped token: `@local@domain.tld`. Anchored charset matches the parts
// of an address we actually issue (no spaces/quotes). The capture excludes the
// leading @ so the value equals the stored email.
const EMAIL_HANDLE_RE = /@([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
// Short token: `@name` / `@local`. The email regex runs first and consumes the
// domain, so this only ever sees genuinely short handles.
const SHORT_HANDLE_RE = /@([a-zA-Z0-9._-]+)/g;

function firstName(name: string | null | undefined): string | null {
  const first = (name ?? "").trim().split(/\s+/)[0];
  return first ? first.toLowerCase() : null;
}

function emailLocal(email: string | null | undefined): string | null {
  const local = (email ?? "").split("@")[0];
  return local ? local.toLowerCase() : null;
}

// Resolve a comment body into the set of mentioned member ids. Mirrors (and is
// the single source of truth for) what createComment persists into
// canvas_comment.mentions. Email handles resolve uniquely; short handles fall
// back to first-name / local-part and may map to several members (all of whom
// are returned — the historical behavior).
export function resolveMentions(body: string, members: MentionMember[]): string[] {
  if (!body.includes("@") || members.length === 0) return [];

  const byEmail = new Map<string, string>();
  for (const m of members) {
    const e = (m.email ?? "").trim().toLowerCase();
    if (e) byEmail.set(e, m.id);
  }

  const resolved: string[] = [];
  const push = (id: string | undefined | null) => {
    if (id && !resolved.includes(id)) resolved.push(id);
  };

  // Pass 1 — email handles (unique). Track the spans they consume so the short
  // pass doesn't also match the local-part half of an email handle.
  const emailTokens = new Set<string>();
  for (const m of body.matchAll(EMAIL_HANDLE_RE)) {
    const email = m[1].toLowerCase();
    emailTokens.add(email);
    push(byEmail.get(email));
  }

  // Pass 2 — short handles. Skip any token that is the local-part of an email
  // handle we already matched (its `@domain` tail was consumed above), so
  // `@joao.silva@acme.com` doesn't also fire a stray `@joao.silva` short match.
  const consumedLocals = new Set(
    Array.from(emailTokens).map((e) => e.split("@")[0]),
  );
  const shortTokens = new Set<string>();
  for (const m of body.matchAll(SHORT_HANDLE_RE)) {
    const tok = m[1].toLowerCase();
    if (consumedLocals.has(tok)) continue;
    shortTokens.add(tok);
  }
  if (shortTokens.size > 0) {
    for (const member of members) {
      const nameFirst = firstName(member.name);
      const local = emailLocal(member.email);
      if (
        (nameFirst && shortTokens.has(nameFirst)) ||
        (local && shortTokens.has(local))
      ) {
        push(member.id);
      }
    }
  }

  return resolved;
}

// Build the dropdown candidate for a member: a display label plus the canonical
// email handle we splice on select. Members without an email can't get a unique
// handle, so we fall back to their first name / local label (best-effort — the
// autocomplete only surfaces members that have one).
export function toCandidate(member: MentionMember): MentionCandidate {
  const label = member.name?.trim() || (member.email ?? "").split("@")[0] || "member";
  const handle = member.email ? `@${member.email.trim()}` : `@${label}`;
  return { ...member, label, handle };
}

// Detect an active @mention being typed: the user's caret sits right after an
// `@token` with no whitespace between the `@` and the caret. Returns the token
// (text after `@`, may be empty right after typing `@`) and the index of the
// `@` so the caller can splice a replacement. Returns null when there is no
// open mention at the caret (e.g. caret after a space, or after a completed
// email handle).
export type MentionQuery = { token: string; atIndex: number };

export function activeMentionQuery(
  value: string,
  caret: number,
): MentionQuery | null {
  // Walk left from the caret to the nearest `@`, bailing on whitespace (a
  // mention can't span a space) — so we only trigger inside the token the user
  // is currently typing.
  let i = caret - 1;
  while (i >= 0) {
    const ch = value[i];
    if (ch === "@") {
      // The `@` must start a token: preceded by start-of-string or whitespace,
      // so an email already in the text (`a@b.com`) doesn't open the dropdown.
      const prev = value[i - 1];
      if (i === 0 || prev === undefined || /\s/.test(prev)) {
        return { token: value.slice(i + 1, caret), atIndex: i };
      }
      return null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

// Filter + rank candidates against the in-progress token. Case-insensitive
// substring match across the label, email, and first name; exact-prefix matches
// rank above mid-string ones so typing "jo" surfaces "joao" before "marjo".
// An empty token returns the full list (the user just typed "@").
export function filterMentionCandidates(
  candidates: MentionCandidate[],
  token: string,
  limit = 8,
): MentionCandidate[] {
  const q = token.trim().toLowerCase();
  if (!q) return candidates.slice(0, limit);

  const scored: { c: MentionCandidate; score: number }[] = [];
  for (const c of candidates) {
    const label = c.label.toLowerCase();
    const email = (c.email ?? "").toLowerCase();
    const local = email.split("@")[0];
    const haystacks = [label, email, local];
    // 0 = prefix match (best), 1 = substring match, -1 = no match.
    let score = -1;
    for (const h of haystacks) {
      if (h.startsWith(q)) {
        score = 2;
        break;
      }
      if (h.includes(q)) score = Math.max(score, 1);
    }
    if (score >= 0) scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((s) => s.c);
}

// Splice the selected candidate's handle into the textarea value, replacing the
// in-progress `@token`. Returns the new value and the caret position to set
// (just after the inserted handle + a trailing space). Pure so the composer can
// drive a controlled textarea deterministically.
export function applyMentionSelection(
  value: string,
  query: MentionQuery,
  candidate: MentionCandidate,
): { value: string; caret: number } {
  const before = value.slice(0, query.atIndex);
  const after = value.slice(query.atIndex + 1 + query.token.length);
  // One trailing space so the next word doesn't glue onto the handle and so the
  // short-handle regex sees the email handle as a closed token.
  const insert = `${candidate.handle} `;
  return {
    value: `${before}${insert}${after}`,
    caret: before.length + insert.length,
  };
}
