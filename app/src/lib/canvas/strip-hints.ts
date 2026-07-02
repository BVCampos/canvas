// Importer hint-strip — Phase 1 fixup.
//
// Claude-generated decks sometimes ship with a small "editor hint" overlay
// baked into each slide — typically a corner label that reads
// "CLIQUE NOS TEXTOS PARA EDITAR" ("click texts to edit") or the English
// equivalent. Those hints are leftover scaffolding for an in-page editing UI
// that *the source HTML* implements via `contenteditable` + localStorage.
//
// Canvas does NOT honor inline click-to-edit (see ADR 0003 — editing happens
// via Claude/MCP, not by clicking text in the preview). So the hint is a
// false promise: a user clicks the text expecting an editor, nothing happens,
// the deck looks broken.
//
// This module runs once at import time over each slide's html_body and
// removes elements whose text content matches editor-hint patterns. We deal
// in raw strings (no DOM) because the parser already does and pulling in a
// DOM library just for this would be overkill.
//
// Heuristics (conservative — we'd rather miss a hint than strip real content):
//   - The element is a neutral inline/block container (div / span / p / small / etc.).
//   - Its visible text matches one of the editor-hint phrases below.
//   - The text is short (< 50 chars after collapsing whitespace).
//   - The element does NOT contain any structural / interactive descendants
//     (headings, paragraphs, links, buttons, lists, sections, images, ...) —
//     hints in real decks are always leaf wrappers around the hint phrase.
//
// We strip the matched element and its full subtree. Whitespace text nodes
// between siblings are preserved. The walker recurses inner content first so
// nested hints get cleaned up bottom-up before the parent gets evaluated.

const HINT_PATTERNS: RegExp[] = [
  /CLIQUE\s+NOS?\s+TEXTOS?\s+PARA\s+EDITAR/i,
  /click\s+(?:on\s+)?(?:the\s+)?text(?:s)?\s+to\s+edit/i,
  /clique\s+(?:no|nos)\s+(?:texto|textos)/i,
  /edit(?:ar)?\s+(?:a|o)?\s*(?:texto|text)/i,
];

// Tags whose presence inside a candidate means "this isn't a leaf hint
// wrapper — leave it alone." We allow inline emphasis tags (em/strong/i/b/u)
// and <br> through because hints in real-world decks are sometimes wrapped
// in a styling span.
//
// Note: `aside` and `label` are intentionally absent — they appear in
// STRIPPABLE_TAGS instead, because some real-world decks sometimes wrap the
// hint phrase in `<aside class="hint">…</aside>` or a stray `<label>` overlay.
// Keeping them out of STRUCTURAL_TAGS lets the walker treat them as
// leaf-wrapper candidates rather than as content to preserve.
const STRUCTURAL_TAGS = new Set([
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "iframe",
  "video",
  "audio",
  "img",
  "svg",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "p",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "form",
  "fieldset",
  "blockquote",
  "pre",
  "code",
  "figure",
  "picture",
  "canvas",
]);

// Elements we'll consider stripping. Limited to neutral inline/block
// containers plus a couple of overlay-style wrappers (`label`, `aside`)
// that some decks use for the hint pill. Tags NOT in this list are
// preserved even if their text matches a hint pattern — that includes
// `section`, `article`, `main`, `header`, `footer`, `nav`, headings,
// lists, tables, form controls (other than `label`), links, and media.
// In other words: when a `<label>` or `<aside>` is a leaf containing
// only hint-shaped text, it gets stripped; when it wraps real
// structural children, the inner `containsStructural` guard keeps it.
const STRIPPABLE_TAGS = new Set([
  "div",
  "span",
  "p",
  "small",
  "em",
  "strong",
  "i",
  "b",
  "u",
  "label",
  "aside",
]);

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Returns the html with editor-hint elements removed. Idempotent. */
export function stripEditorHints(html: string): string {
  if (!html) return html;
  // Fast bail-out: if none of the patterns matches anywhere in the body,
  // skip the relatively expensive walker. This makes the typical
  // hint-free import a no-op.
  const anyHint = HINT_PATTERNS.some((re) => re.test(html));
  if (!anyHint) return html;
  return walk(html);
}

function walk(html: string): string {
  let result = "";
  let cursor = 0;
  const len = html.length;

  while (cursor < len) {
    const openIdx = findNextOpenTag(html, cursor);
    if (openIdx < 0) {
      result += html.slice(cursor);
      break;
    }
    // Emit literal text / inert tokens up to the next open tag.
    result += html.slice(cursor, openIdx);

    const tagInfo = parseOpenTag(html, openIdx);
    if (!tagInfo) {
      // Couldn't parse — treat the '<' as literal and keep going.
      result += html[openIdx];
      cursor = openIdx + 1;
      continue;
    }

    const { tagName, isSelfClosing, openEnd } = tagInfo;
    const lower = tagName.toLowerCase();

    // Void / self-closing — emit and advance.
    if (isSelfClosing || VOID_TAGS.has(lower)) {
      result += html.slice(openIdx, openEnd);
      cursor = openEnd;
      continue;
    }

    // Find the matching close tag (balanced; tolerates nesting of the same tag).
    const closeStart = findMatchingClose(html, openEnd, lower);
    if (closeStart < 0) {
      // No matching close — bail and treat the open as literal so we don't
      // lose downstream content.
      result += html.slice(openIdx, openEnd);
      cursor = openEnd;
      continue;
    }
    const closeEnd = html.indexOf(">", closeStart) + 1;
    const innerRaw = html.slice(openEnd, closeStart);

    // Recurse bottom-up: clean the inside first, then decide if THIS element
    // (now with hints removed) is itself a leaf hint wrapper.
    const innerClean = walk(innerRaw);

    if (STRIPPABLE_TAGS.has(lower) && isLeafHint(innerClean)) {
      // Drop this element entirely.
      cursor = closeEnd;
      continue;
    }

    result += html.slice(openIdx, openEnd);
    result += innerClean;
    result += html.slice(closeStart, closeEnd);
    cursor = closeEnd;
  }

  return result;
}

function findNextOpenTag(html: string, from: number): number {
  // Skip past comments — they sometimes contain text that looks like markup.
  let i = from;
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt < 0) return -1;
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const next = html.charCodeAt(lt + 1);
    const isLetter = (next >= 65 && next <= 90) || (next >= 97 && next <= 122);
    if (!isLetter && next !== 47 /* '/' */) {
      i = lt + 1;
      continue;
    }
    // Closing tag — skip past it; balance is handled by the caller.
    if (next === 47) {
      const gt = html.indexOf(">", lt);
      i = gt < 0 ? html.length : gt + 1;
      continue;
    }
    return lt;
  }
  return -1;
}

type ParsedOpenTag = {
  tagName: string;
  isSelfClosing: boolean;
  openEnd: number;
};

function parseOpenTag(html: string, openIdx: number): ParsedOpenTag | null {
  // html[openIdx] === '<' and the next char is a letter (the caller verifies).
  let i = openIdx + 1;
  const nameStart = i;
  while (i < html.length) {
    const code = html.charCodeAt(i);
    const isNameChar =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 45 /* '-' */ ||
      code === 58 /* ':' */;
    if (!isNameChar) break;
    i += 1;
  }
  if (i === nameStart) return null;
  const tagName = html.slice(nameStart, i);

  // Walk to the next unquoted '>'.
  let quote = 0;
  while (i < html.length) {
    const ch = html.charCodeAt(i);
    if (quote) {
      if (ch === quote) quote = 0;
    } else if (ch === 34 /* '"' */ || ch === 39 /* "'" */) {
      quote = ch;
    } else if (ch === 62 /* '>' */) {
      const isSelfClosing = html.charCodeAt(i - 1) === 47 /* '/' */;
      return { tagName, isSelfClosing, openEnd: i + 1 };
    }
    i += 1;
  }
  return null;
}

function findMatchingClose(html: string, from: number, tagName: string): number {
  const openRe = new RegExp(`<${escapeRegex(tagName)}\\b`, "i");
  const closeRe = new RegExp(`</${escapeRegex(tagName)}\\s*>`, "i");
  let depth = 1;
  let i = from;
  while (i < html.length) {
    const tail = html.slice(i);
    const oRel = tail.search(openRe);
    const cRel = tail.search(closeRe);
    if (cRel < 0) return -1;
    if (oRel >= 0 && oRel < cRel) {
      depth += 1;
      i = i + oRel + 1;
    } else {
      depth -= 1;
      const closeAt = i + cRel;
      if (depth === 0) return closeAt;
      i = closeAt + 1;
    }
  }
  return -1;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * True if `innerHtml` is the body of a leaf hint wrapper:
 *   - contains no structural / interactive tags (only inline emphasis allowed)
 *   - visible text matches one of the hint patterns
 *   - text is < 50 chars after whitespace collapse
 */
function isLeafHint(innerHtml: string): boolean {
  if (containsStructural(innerHtml)) return false;
  const text = stripTagsAndCollapse(innerHtml);
  if (!text) return false;
  if (text.length >= 50) return false;
  return HINT_PATTERNS.some((re) => re.test(text));
}

function containsStructural(html: string): boolean {
  const tagRe = /<([a-zA-Z][a-zA-Z0-9-]*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (STRUCTURAL_TAGS.has(m[1].toLowerCase())) return true;
  }
  return false;
}

function stripTagsAndCollapse(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}
