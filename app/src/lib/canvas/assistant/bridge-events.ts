// The wire contract between the local bridge (bridge/canvas-agent.mjs) and the
// bridge event endpoint (app/src/app/api/assistant/bridge/event/route.ts).
//
// The bridge POSTs one of these JSON bodies per turn phase (see ADR-0006):
//
//   start    -> opens an assistant row (streaming), returns its id
//   delta    -> updates the assistant row's content (cumulative snapshot)
//   finish   -> marks the turn complete; persists session_id on the THREAD (ADR-0007)
//   error    -> marks the turn errored
//   canceled -> marks the turn STOPPED (user hit Stop); keeps partial content (ADR-0008)
//
// This module is the single typed source for that union so event/route.ts can
// narrow on `type` instead of poking a `Record<string, unknown>`. The bridge
// stays plain JS and references this via a JSDoc @typedef pointer; the union
// here is the authoritative shape both sides agree on.

export type BridgeStartEvent = {
  type: "start";
  user_message_id: string;
  deck_id: string;
};

export type BridgeDeltaEvent = {
  type: "delta";
  assistant_message_id: string;
  content: string;
};

export type BridgeFinishEvent = {
  type: "finish";
  assistant_message_id: string;
  user_message_id: string;
  content?: string;
  session_id?: string;
};

export type BridgeErrorEvent = {
  type: "error";
  user_message_id: string;
  assistant_message_id?: string;
  error: string;
};

// The user stopped the turn (ADR-0008). Carries the partial content streamed so
// far so the chatbox keeps what Claude produced before the abort. assistant_message_id
// is optional, like error's — a stop before `start` landed has no assistant row.
export type BridgeCanceledEvent = {
  type: "canceled";
  user_message_id: string;
  assistant_message_id?: string;
  content?: string;
};

export type BridgeEvent =
  | BridgeStartEvent
  | BridgeDeltaEvent
  | BridgeFinishEvent
  | BridgeErrorEvent
  | BridgeCanceledEvent;

export type BridgeEventType = BridgeEvent["type"];

// A parsed body is either a known variant (narrowed) or a typed rejection. The
// route maps `kind: "reject"` to the exact same status/error JSON it returned
// before this union existed — runtime behavior is unchanged, only the typing is
// tighter.
export type ParsedBridgeEvent =
  | { kind: "event"; event: BridgeEvent }
  | { kind: "reject"; status: number; error: string };

const isString = (v: unknown): v is string => typeof v === "string";

// Validate + narrow a raw JSON body to a BridgeEvent. This preserves the prior
// per-handler validation EXACTLY:
//   - unknown / missing type           -> 400 unknown_type
//   - delta with non-string content    -> 400 bad_field
// Ownership checks (the 404 not_found gates on *_message_id) still happen in the
// handlers against the DB, unchanged — those aren't pure-shape validation.
export function parseBridgeEvent(body: Record<string, unknown>): ParsedBridgeEvent {
  const type = String(body.type ?? "");
  switch (type) {
    case "start":
      return {
        kind: "event",
        event: {
          type: "start",
          // Coerced to string here for typing; the handler's ownRow() rejects a
          // non-string/unowned id with 404 not_found, same as before.
          user_message_id: String(body.user_message_id ?? ""),
          deck_id: String(body.deck_id ?? ""),
        },
      };
    case "delta":
      // The one pure-shape rejection that lived in the handler: a non-string
      // content would clamp() to "" and wipe the row. Keep the exact 400/bad_field.
      if (!isString(body.content)) {
        return { kind: "reject", status: 400, error: "bad_field" };
      }
      return {
        kind: "event",
        event: {
          type: "delta",
          assistant_message_id: String(body.assistant_message_id ?? ""),
          content: body.content,
        },
      };
    case "finish":
      return {
        kind: "event",
        event: {
          type: "finish",
          assistant_message_id: String(body.assistant_message_id ?? ""),
          user_message_id: String(body.user_message_id ?? ""),
          ...(isString(body.content) ? { content: body.content } : {}),
          ...(isString(body.session_id) && body.session_id
            ? { session_id: body.session_id }
            : {}),
        },
      };
    case "error":
      return {
        kind: "event",
        event: {
          type: "error",
          user_message_id: String(body.user_message_id ?? ""),
          ...(isString(body.assistant_message_id)
            ? { assistant_message_id: body.assistant_message_id }
            : {}),
          // clamp()/default-message handling stays in the handler; here we just
          // carry whatever was sent (non-string -> "" preserves prior behavior).
          error: isString(body.error) ? body.error : "",
        },
      };
    case "canceled":
      // Mirrors finish/error: ids coerced for typing (the handler's ownRow gate
      // does the real 404 check); content carried through only if a string, so
      // the handler keeps the partial reply when present and leaves it untouched
      // otherwise.
      return {
        kind: "event",
        event: {
          type: "canceled",
          user_message_id: String(body.user_message_id ?? ""),
          ...(isString(body.assistant_message_id)
            ? { assistant_message_id: body.assistant_message_id }
            : {}),
          ...(isString(body.content) ? { content: body.content } : {}),
        },
      };
    default:
      return { kind: "reject", status: 400, error: "unknown_type" };
  }
}
