"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type TextareaHTMLAttributes,
} from "react";
import { cn } from "@/lib/utils";
import {
  activeMentionQuery,
  applyMentionSelection,
  filterMentionCandidates,
  toCandidate,
  type MentionCandidate,
  type MentionMember,
} from "@/lib/canvas/mention";

// A controlled <textarea> with @mention autocomplete for the comment composer.
//
// Why a dedicated component: the comment overlay has two composers (new comment
// + reply) that both need the same behavior, and the dropdown has to coordinate
// caret tracking, keyboard nav, and an outside-click dismiss that a bare
// textarea can't. The parse/filter/splice logic is the pure helper set in
// lib/canvas/mention (unit-tested); this component is just the DOM + keyboard
// shell around it.
//
// The inserted handle is a member's full email (`@joao@acme.com`) — globally
// unique, so the server resolver maps it to exactly one member with no
// first-name / local-part collision. The user never types the tail: they pick a
// row and we splice the handle in.
//
// Keyboard contract while the dropdown is OPEN: ArrowUp/Down move the highlight,
// Enter/Tab accept the highlighted candidate, Escape closes the dropdown (and
// stops there — it does NOT bubble to the overlay's Esc handler, so one Escape
// dismisses the menu without also exiting comment mode). When the dropdown is
// CLOSED, the textarea's own onKeyDown (e.g. ⌘↵ to submit) runs untouched.

type MentionTextareaProps = {
  value: string;
  onChange: (next: string) => void;
  members: MentionMember[];
  // Forwarded to the textarea so the host keeps ⌘↵-to-submit, placeholder,
  // autofocus, sizing classes, etc. onKeyDown is intercepted first (for menu
  // navigation) and only forwarded when the menu is closed / the key isn't ours.
  textareaProps?: Omit<
    TextareaHTMLAttributes<HTMLTextAreaElement>,
    "value" | "onChange"
  >;
};

export function MentionTextarea({
  value,
  onChange,
  members,
  textareaProps,
}: MentionTextareaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(0);
  // `active` is the highlighted row; `dismissedAt` is the `@`-index the user
  // last closed the menu at via Escape. The menu is OPEN as a derived value (no
  // open-state effect → no cascading render) and stays closed only while the
  // caret sits on the exact mention the user dismissed; moving to a new mention
  // re-opens it.
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);

  // Only members with an email can get a unique handle; the rest can't be
  // disambiguated, so they're excluded as mention targets (matching the
  // resolver, which needs an email/name to match a short handle).
  const candidates = useMemo(
    () => members.filter((m) => m.email || m.name).map(toCandidate),
    [members],
  );

  // The live @-query at the caret, recomputed whenever the value or caret moves.
  const query = useMemo(
    () => activeMentionQuery(value, caret),
    [value, caret],
  );
  const matches = useMemo(
    () => (query ? filterMentionCandidates(candidates, query.token) : []),
    [query, candidates],
  );

  // Derived open-state: an active query with matches, not dismissed at this
  // exact `@`. Clamp the highlight here too so it never points past a shrunk
  // match set (typing narrows the list) without a separate reset effect.
  const open =
    focused &&
    Boolean(query) &&
    matches.length > 0 &&
    !(dismissedAt !== null && query?.atIndex === dismissedAt);
  const activeIndex = matches.length ? Math.min(active, matches.length - 1) : 0;

  const syncCaret = useCallback(() => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? el.value.length);
  }, []);

  const choose = useCallback(
    (candidate: MentionCandidate) => {
      if (!query) return;
      const next = applyMentionSelection(value, query, candidate);
      onChange(next.value);
      setActive(0);
      // Restore focus + place the caret right after the inserted handle. Done in
      // a microtask so it lands after React commits the new value.
      queueMicrotask(() => {
        const el = ref.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(next.caret, next.caret);
        setCaret(next.caret);
      });
    },
    [query, value, onChange],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (open && matches.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (Math.min(i, matches.length - 1) + 1) % matches.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive(
          (i) =>
            (Math.min(i, matches.length - 1) - 1 + matches.length) %
            matches.length,
        );
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        choose(matches[activeIndex] ?? matches[0]);
        return;
      }
      if (e.key === "Escape") {
        // Swallow so the overlay's Esc-to-exit doesn't also fire — one Escape
        // closes the menu and nothing more. Record WHERE we dismissed so the
        // menu stays shut for this mention but re-opens at the next one.
        e.preventDefault();
        e.stopPropagation();
        setDismissedAt(query?.atIndex ?? null);
        return;
      }
    }
    // Menu closed (or key isn't ours): let the host handle it (⌘↵ submit, etc.).
    textareaProps?.onKeyDown?.(e);
  };

  return (
    <div className="relative">
      <textarea
        {...textareaProps}
        ref={ref}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // selectionStart is already at the post-edit caret here.
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={syncCaret}
        onClick={syncCaret}
        onSelect={syncCaret}
        onFocus={(e) => {
          setFocused(true);
          textareaProps?.onFocus?.(e);
        }}
        // The dropdown rows use onMouseDown + preventDefault so a row click never
        // blurs the textarea; a real blur (Tab away, click elsewhere) closes the
        // menu by flipping `focused`.
        onBlur={(e) => {
          setFocused(false);
          textareaProps?.onBlur?.(e);
        }}
      />
      {open && matches.length > 0 ? (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-full z-40 mt-1 max-h-48 overflow-y-auto rounded-[8px] border border-border bg-popover p-1 shadow-lg"
        >
          {matches.map((m, i) => (
            <li key={m.id} role="option" aria-selected={i === activeIndex}>
              <button
                type="button"
                // mousedown + preventDefault so the row commits without ever
                // blurring the textarea (which would otherwise close the menu).
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(m);
                }}
                onMouseEnter={() => setActive(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded-[6px] px-2 py-1.5 text-left text-sm",
                  i === activeIndex
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground",
                )}
              >
                <span className="truncate font-medium">{m.label}</span>
                {m.email ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {m.email}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
