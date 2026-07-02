import { Fragment } from "react";

// Renders comment text with @mention handles highlighted. Purely presentational
// — the actual mentioned user_ids are resolved against the workspace member
// list and persisted (canvas_comment.mentions) server-side by createComment.
// Here we just style the @handle so it reads as a mention. Parent supplies
// whitespace-pre-wrap, so spacing/newlines are preserved.
//
// Two handle shapes match the resolver (lib/canvas/mention): the unique email
// handle the composer inserts (`@joao@acme.com`) and the legacy short handle
// (`@joao`). The email alternative is listed FIRST in the split/test patterns so
// a full email handle highlights as one span instead of stopping at the `@`
// domain boundary and leaking `@acme.com` as plain text.
const EMAIL = "@[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}";
const SHORT = "@[a-zA-Z0-9._-]+";
const SPLIT_RE = new RegExp(`(${EMAIL}|${SHORT})`, "g");
const HANDLE_RE = new RegExp(`^(?:${EMAIL}|${SHORT})$`);

export function MentionText({ text }: { text: string }) {
  const parts = text.split(SPLIT_RE);
  return (
    <>
      {parts.map((part, i) =>
        HANDLE_RE.test(part) ? (
          <span
            key={i}
            className="rounded-[3px] bg-[color:var(--accent-wash)] px-0.5 font-medium text-[color:var(--accent-dim)]"
          >
            {part}
          </span>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </>
  );
}
