#!/usr/bin/env node
// canvas-agent — the local bridge for the Canvas in-app assistant (see ADR-0006).
//
// Runs on YOUR machine using the local agent provider you choose. It polls
// Canvas for prompts typed in the web chatbox, runs the agent with the Canvas
// MCP server wired in, and streams the reply back. Credentials never leave this
// machine; Canvas runs no inference. Supported adapters: Claude Code and Codex.
//
// Usage:
//   CANVAS_MCP_TOKEN=mcp_xxx node canvas-agent.mjs
//   CANVAS_URL=https://canvas.21xventures.com CANVAS_MCP_TOKEN=mcp_xxx canvas-agent
//
// Select with CANVAS_AGENT_PROVIDER=claude|codex (default: claude). Each adapter
// reuses the corresponding CLI's existing local login.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// The bridge's own version, read from its package.json. Reported to Canvas on
// every poll (x-bridge-version header) so the chatbox can tell an outdated
// bridge from a current one and nudge an update. Best-effort: "unknown" if the
// file can't be read.
const BRIDGE_VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

// The bridge POSTs `start` / `delta` / `finish` / `error` / `canceled` events to
// /api/assistant/bridge/event. The authoritative typed shape of that wire
// contract lives on the server side:
// @see {@link ../app/src/lib/canvas/assistant/bridge-events.ts} (BridgeEvent union)
// This file stays plain JS; keep the POST bodies below in sync with that union.
//
// Stop (ADR-0008): while a turn runs the loop below is blocked in `for await`,
// so the bridge can't learn about a user Stop through the normal poll. It instead
// asks /api/assistant/bridge/cancel-check on a short interval and aborts the turn
// the moment a stop is pending, then reports it with a `canceled` event.

const CANVAS_URL = (process.env.CANVAS_URL || "http://localhost:3001").replace(/\/$/, "");
// Token comes ONLY from the env var — never a positional CLI arg, which would
// leak the bearer token to `ps` output and shell history.
const TOKEN = process.env.CANVAS_MCP_TOKEN;
const AGENT_PROVIDER = (process.env.CANVAS_AGENT_PROVIDER || "claude").toLowerCase();
const POLL_MS = Number(process.env.CANVAS_POLL_MS || 2500);
const MODEL = process.env.CANVAS_MODEL || undefined; // undefined → provider default
const MAX_TURNS = Number(process.env.CANVAS_MAX_TURNS || 40);
// Wall-clock cap on a single turn. main() runs turns sequentially, so one hung
// `claude -p` would otherwise freeze every thread for this user. We abort the
// query past this and surface it through the normal per-turn error path so the
// web row is reported `error` instead of being stranded "working…".
const TURN_TIMEOUT_MS = Number(process.env.CANVAS_TURN_TIMEOUT_MS || 120_000);
// How often, during a running turn, the bridge asks Canvas whether the user hit
// Stop (ADR-0008). The turn loop is blocked in `for await`, so this runs on its
// own interval and aborts via turnAbort the moment a stop is pending. ~1.2s feels
// instant without hammering the endpoint.
const CANCEL_POLL_MS = Number(process.env.CANVAS_CANCEL_POLL_MS || 1200);

// Preflight: the Claude Agent SDK needs Node 20+. On an older Node the failure
// is otherwise a raw ESM/SDK stack trace deep into the first turn — surface the
// real cause up front with a one-line fix instead.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
if (Number.isFinite(NODE_MAJOR) && NODE_MAJOR < 20) {
  console.error(
    `canvas-agent needs Node 20 or newer (you have ${process.versions.node}).\n` +
      "  Upgrade Node (e.g. `nvm install 20 && nvm use 20`) and re-run.\n",
  );
  process.exit(1);
}

if (!TOKEN) {
  console.error(
    "Missing CANVAS_MCP_TOKEN. Create one in Settings → Connections and pass it as\n" +
      "  CANVAS_MCP_TOKEN=mcp_xxx canvas-agent\n",
  );
  process.exit(1);
}

if (!new Set(["claude", "codex"]).has(AGENT_PROVIDER)) {
  console.error(
    `Unsupported CANVAS_AGENT_PROVIDER=${AGENT_PROVIDER}. Use "claude" or "codex".`,
  );
  process.exit(1);
}

// Claude is restricted to the Canvas MCP server only. We run in 'dontAsk'
// permission mode (see options below): pre-approved tools auto-run, everything
// else is auto-DENIED with no prompt — so a headless run never hangs and never
// touches your machine. The allowlist is the Canvas server scope plus every
// Canvas tool by name (belt and suspenders, in case server-scope matching
// changes). Built-in shell/file tools are hard-denied on top of that.
//
// Keep this list in sync with the Canvas MCP tool registry
// (app/src/lib/canvas/mcp/tools.ts). A new tool that isn't listed just won't be
// auto-approved until added here — fail-closed, which is the safe default.
const CANVAS_TOOLS = [
  "add_comment", "apply_trusted_proposal", "comment_on_proposal", "copy_slide", "create_deck", "create_project",
  "create_snapshot", "diff_slide_versions", "diff_snapshots", "get_deck",
  "get_proposal", "list_comments", "list_decks", "list_projects",
  "list_proposals", "list_slide_versions", "list_snapshots", "list_sources",
  "lock_slide", "propose_deck_edit", "propose_delete_slide",
  "propose_deck_patch", "propose_duplicate_slide", "propose_new_slide",
  "propose_reorder_slides", "propose_slide_edit", "propose_slide_variants", "propose_slide_patch",
  "propose_theme_edit", "read_brand", "read_full_deck", "read_slide", "read_slide_version",
  "read_snapshot", "read_source", "read_theme", "release_slide",
  "render_deck", "render_proposal", "render_slide", "reply_to_comment",
  "resolve_comment", "revert_proposal", "withdraw_proposal", "write_slide_notes",
];
const ALLOWED_TOOLS = ["mcp__canvas", ...CANVAS_TOOLS.map((t) => `mcp__canvas__${t}`)];
const DISALLOWED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task"];

const SYSTEM_APPEND = [
  "You are the local in-app agent inside Canvas, a propose-first multiplayer deck editor.",
  "You are working on ONE specific deck — its id is given in the user's message.",
  "Use the Canvas MCP tools to read the deck and PROPOSE edits; a human approves every",
  "change by default. Prefer propose_slide_patch for small edits. After a slide",
  "proposal, call render_proposal and visually verify it before saying the work is ready.",
  "If that verified patch is eligible for apply_trusted_proposal and the image is correct,",
  "apply it; otherwise leave it in human Review. Keep replies short and state the outcome.",
].join(" ");

const base = `${CANVAS_URL}/api/assistant/bridge`;
const legacyMcpUrl = `${CANVAS_URL}/api/mcp/${TOKEN}`;
const bearerMcpUrl = `${CANVAS_URL}/api/mcp`;

async function postJson(path, body) {
  // Token rides the Authorization header, not the query string: a query token
  // leaks into access logs / proxy logs / Referer, and this token also grants
  // full deck-write via MCP. The server accepts both for one release.
  const res = await fetch(`${base}/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
      "x-bridge-version": BRIDGE_VERSION,
      "x-agent-provider": AGENT_PROVIDER,
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    throw new Error(`${path} -> ${res.status} ${await res.text().catch(() => "")}`);
  }
  return res.json();
}

// Like postJson but retries with short backoff. Used for the state-CLOSING
// POSTs (finish / error): losing one leaves the web row stuck "working…"
// forever, so a transient blip (Wi-Fi drop) must not silently swallow it. On
// final failure it throws loudly so the caller can log — never returns silently.
async function postJsonRetry(path, body, tries = 3) {
  const backoff = [500, 1500];
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      return await postJson(path, body);
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(backoff[i] ?? 1500);
    }
  }
  throw lastErr;
}

async function poll() {
  const out = await postJson("poll", {});
  return out.messages ?? [];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The provider session id per thread (ADR-0007). Seeded from poll's
// resume_session_id (the thread row), but kept fresh in-process so two turns of
// the SAME thread claimed in one poll batch chain correctly — the second resumes
// the session the first just produced, before the thread row write has landed.
const sessionByThread = new Map();

// The server clamps every write to this many chars (MAX_CONTENT in
// event/route.ts). We don't change that cap here; we just notice when we cross
// it so silent truncation is observable in the bridge log (C3).
const SERVER_CONTENT_CAP = 200_000;

async function runClaudeAgent({ prompt, sessionId, abortController, onText }) {
  const options = {
    abortController,
    mcpServers: { canvas: { type: "http", url: legacyMcpUrl } },
    allowedTools: ALLOWED_TOOLS,
    disallowedTools: DISALLOWED_TOOLS,
    settingSources: [],
    tools: [],
    permissionMode: "dontAsk",
    systemPrompt: { type: "preset", preset: "claude_code", append: SYSTEM_APPEND },
    maxTurns: MAX_TURNS,
  };
  if (MODEL) options.model = MODEL;
  if (sessionId) options.resume = sessionId;

  let nextSessionId = sessionId;
  for await (const event of query({ prompt, options })) {
    if (event.session_id) nextSessionId = event.session_id;
    if (event.type !== "assistant" || !event.message?.content) continue;
    for (const block of event.message.content) {
      if (block.type === "text" && block.text) {
        await onText(block.text);
      } else if (block.type === "tool_use") {
        const tool = String(block.name || "").replace(/^mcp__canvas__/, "");
        await onText(`\n\n_…${tool}_\n`);
      }
    }
  }
  return nextSessionId;
}

// Codex's non-interactive JSONL interface gives us a provider-neutral local
// adapter without shipping credentials to Canvas. It runs in an empty temp
// directory, read-only, with user/project instructions ignored; the only
// configured MCP server is Canvas and its token rides an environment-backed
// Authorization header rather than a URL or process argument.
async function runCodexAgent({ prompt, sessionId, abortController, onText }) {
  const workdir = join(tmpdir(), "canvas-agent-codex");
  await mkdir(workdir, { recursive: true });
  const toolList = `[${CANVAS_TOOLS.map((tool) => JSON.stringify(tool)).join(",")}]`;
  const config = [
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    // Pin the read-only sandbox via a config override, not just the `--sandbox`
    // flag: `codex exec resume` does NOT accept `--sandbox`, so without this a
    // resume turn would silently fall back to Codex's default sandbox. Carrying
    // it in the shared config keeps the policy identical for fresh and resume
    // turns — it can't diverge. (Fresh also passes the equivalent
    // `--sandbox read-only` flag below; both set the same value.)
    "-c",
    'sandbox_mode="read-only"',
    "-c",
    `mcp_servers.canvas.url=${JSON.stringify(bearerMcpUrl)}`,
    "-c",
    'mcp_servers.canvas.bearer_token_env_var="CANVAS_MCP_TOKEN"',
    "-c",
    "mcp_servers.canvas.required=true",
    "-c",
    `mcp_servers.canvas.enabled_tools=${toolList}`,
  ];
  if (MODEL) config.push("--model", MODEL);

  // SYSTEM_APPEND is the system preamble. Send it only on a FRESH turn: a resume
  // already carries it in the session, so re-prepending it would repeat the full
  // instructions as user text every turn (the Claude path sends it once as a
  // system preset).
  // `--cd <workdir>` pins the working directory on a fresh turn; `codex exec
  // resume` doesn't accept `--cd`, so a resume runs in the session's recorded
  // working directory — the read-only sandbox above still applies either way.
  const args = sessionId
    ? ["exec", "resume", ...config, sessionId, prompt]
    : [
        "exec",
        "--sandbox",
        "read-only",
        "--cd",
        workdir,
        ...config,
        `${SYSTEM_APPEND}\n\n${prompt}`,
      ];

  return await new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      env: { ...process.env, CANVAS_MCP_TOKEN: TOKEN },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let nextSessionId = sessionId;
    let stderr = "";
    let turnError = null;
    let chain = Promise.resolve();

    // Cancel/timeout: ask the child to stop, then escalate. If it ignores
    // SIGTERM the awaited promise would never resolve and would wedge this
    // thread's sequential loop, so SIGKILL it after a short grace period. The
    // close/error handlers clear this timer on exit so it never dangles.
    let killTimer;
    const abort = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 4000);
    };
    abortController.signal.addEventListener("abort", abort, { once: true });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-4000);
    });

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === "thread.started" && event.thread_id) {
        nextSessionId = event.thread_id;
      }
      if (event.type === "turn.failed" || event.type === "error") {
        turnError = event.error?.message || event.message || "Codex turn failed";
      }
      const item = event.item;
      if (event.type === "item.completed" && item?.type === "agent_message" && item.text) {
        chain = chain.then(() => onText(item.text));
      } else if (
        event.type === "item.started" &&
        item?.type === "mcp_tool_call" &&
        item.tool
      ) {
        chain = chain.then(() => onText(`\n\n_…${item.tool}_\n`));
      }
    });

    child.on("error", (error) => {
      abortController.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      reject(
        new Error(
          error.code === "ENOENT"
            ? "Codex CLI is not installed. Install it and run `codex login`, then restart canvas-agent."
            : error.message,
        ),
      );
    });
    child.on("close", (code, signal) => {
      abortController.signal.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      chain.then(() => {
        if (abortController.signal.aborted) {
          reject(new Error("Agent turn aborted"));
        } else if (code !== 0 || turnError) {
          reject(new Error(turnError || stderr.trim() || `Codex exited with ${code ?? signal}`));
        } else {
          resolve(nextSessionId);
        }
      }, reject);
    });
  });
}

async function runLocalAgent(options) {
  return AGENT_PROVIDER === "codex"
    ? runCodexAgent(options)
    : runClaudeAgent(options);
}

// Run one prompt through the selected local provider and stream the reply back.
async function runTurn(msg) {
  let text = "";
  let sessionId =
    sessionByThread.get(msg.thread_id) || msg.resume_session_id || undefined;
  let lastFlush = 0;
  // Set true the instant the SDK stream ends normally. If a later state-closing
  // POST (finish) fails, this tells us the turn actually SUCCEEDED — its content
  // is already in the row from the last delta — so we must NOT report a turn
  // error (which the user would see as red and resend → duplicate work). (I3)
  let streamCompleted = false;
  // One-time warning when accumulated text passes the server's clamp (C3).
  let warnedTruncation = false;
  // Opened lazily inside the try so a `start` failure is caught by the per-turn
  // boundary instead of escaping runTurn and killing the daemon (C1).
  let assistant_message_id;
  // Per-turn wall-clock guard: abort a hung query so it can't freeze the
  // sequential loop. Cleared on normal completion; set `timedOut` so the catch
  // can report a clear timeout error rather than a generic "aborted".
  const turnAbort = new AbortController();
  let timedOut = false;
  let turnTimer = setTimeout(() => {
    timedOut = true;
    turnAbort.abort();
  }, TURN_TIMEOUT_MS);
  const clearTurnTimer = () => {
    if (turnTimer) {
      clearTimeout(turnTimer);
      turnTimer = undefined;
    }
  };

  // Stop support (ADR-0008): poll Canvas on a short interval for a pending stop
  // on THIS prompt and abort the turn if one lands. `canceled` (vs `timedOut`)
  // tells the catch below to report a `canceled` event — keeping the partial
  // output and labelling the row "Stopped" — instead of an error. The in-flight
  // guard skips a tick while the previous probe is still outstanding (a slow
  // network must not pile up overlapping requests).
  let canceled = false;
  let cancelInFlight = false;
  let cancelTimer = setInterval(async () => {
    if (cancelInFlight || canceled) return;
    cancelInFlight = true;
    try {
      const res = await postJson("cancel-check", { user_message_id: msg.id });
      if (res?.canceled) {
        canceled = true;
        turnAbort.abort();
      }
    } catch {
      // Transient (a blip, or the turn already settling). The next tick retries;
      // clearCancelPoll() stops the interval once the turn ends.
    } finally {
      cancelInFlight = false;
    }
  }, CANCEL_POLL_MS);
  const clearCancelPoll = () => {
    if (cancelTimer) {
      clearInterval(cancelTimer);
      cancelTimer = undefined;
    }
  };

  const flush = async (force) => {
    const now = Date.now();
    if (!force && now - lastFlush < 600) return;
    lastFlush = now;
    if (!assistant_message_id) return; // start hasn't landed yet
    if (!warnedTruncation && text.length > SERVER_CONTENT_CAP) {
      warnedTruncation = true;
      console.warn(
        `⚠ ${msg.id}: reply exceeded the server cap (${SERVER_CONTENT_CAP} chars); ` +
          `further content will be truncated server-side.`,
      );
    }
    // Log a dropped delta instead of swallowing it: a degrading stream should be
    // visible, not silent (C3). A lost delta isn't fatal — the next one (or the
    // finish) carries the full cumulative snapshot.
    await postJson("event", {
      type: "delta",
      assistant_message_id,
      content: text,
    }).catch((err) => {
      console.error(
        `⚠ ${msg.id}: dropped a delta (${err instanceof Error ? err.message : err})`,
      );
    });
  };

  try {
    // The `start` POST is INSIDE the per-turn boundary and retried like the other
    // state-closing POSTs (C1): a transient failure here used to throw out of
    // runTurn → process.exit(1), stranding the prompt "running" forever. Now a
    // retried-then-failed start reports an `error` for msg.id (the catch below)
    // so the web row closes instead.
    const started = await postJsonRetry("event", {
      type: "start",
      user_message_id: msg.id,
      deck_id: msg.deck_id,
    });
    assistant_message_id = started.assistant_message_id;

    const prompt =
      `Deck id: ${msg.deck_id}\n\n${msg.content}`;

    const onText = async (chunk) => {
      text += chunk;
      await flush(false);
    };
    try {
      sessionId = await runLocalAgent({
        prompt,
        sessionId,
        abortController: turnAbort,
        onText,
      });
    } catch (err) {
      // Stale resume pointer (provider evicted/lost the conversation — e.g.
      // Claude's "No conversation found with session ID …"). The session id is
      // an optimization, not the turn's substance: clear it and rerun the same
      // prompt fresh instead of failing the whole turn.
      const message = err instanceof Error ? err.message : String(err);
      const staleSession =
        sessionId &&
        !turnAbort.signal.aborted &&
        /no conversation found|session(?:\s+id)?\s+.*not found|not found.*session/i.test(
          message,
        );
      if (!staleSession) throw err;
      console.warn(
        `⚠ ${msg.id}: resume session ${sessionId} is gone (${message.slice(0, 120)}); retrying fresh`,
      );
      sessionByThread.delete(msg.thread_id);
      sessionId = undefined;
      // Drop anything the failed attempt streamed — flushes send cumulative
      // snapshots, so the fresh run's first flush overwrites the row.
      text = "";
      sessionId = await runLocalAgent({
        prompt,
        sessionId: undefined,
        abortController: turnAbort,
        onText,
      });
    }

    // The SDK stream ended normally: the turn succeeded. Stop the timeout guard
    // so it can't abort a turn that already finished, and stop the stop-poll. From
    // here on, a failed state-closing POST must not be reported as a turn error
    // (I3) — the content is already in the row from the last delta.
    clearTurnTimer();
    clearCancelPoll();
    streamCompleted = true;

    if (!text.trim()) {
      text = "Done — check the review rail for the proposed edits.";
    }
    // Remember this thread's session for the next turn in the same run (the
    // finish below also persists it to the thread row for future runs).
    if (sessionId) sessionByThread.set(msg.thread_id, sessionId);
    // State-closing POST: retry so a transient blip doesn't strand the row, and
    // only log success once it actually landed.
    await postJsonRetry("event", {
      type: "finish",
      assistant_message_id,
      user_message_id: msg.id,
      content: text,
      session_id: sessionId,
    });
    console.log(`✓ answered ${msg.id} (${text.length} chars)`);
  } catch (err) {
    // Stop the guards regardless of how we got here (a timeout/cancel already
    // fired one, but a different error means they're still pending).
    clearTurnTimer();
    clearCancelPoll();
    const message = timedOut
      ? `The assistant timed out after ${Math.round(TURN_TIMEOUT_MS / 1000)}s and was stopped.`
      : err instanceof Error
        ? err.message
        : String(err);
    if (streamCompleted) {
      // The stream already finished — this is a failed `finish` POST, not a turn
      // failure. Reporting an `error` here would flip a SUCCEEDED turn red and
      // make the user resend → duplicate proposals (I3). Log loudly, don't post.
      console.error(
        `✗ ${msg.id}: turn succeeded but the finish POST failed (${message}). ` +
          `The reply is already in the web row from the last delta; the only ` +
          `cost is a lost session pointer (a cold restart next turn). NOT ` +
          `reporting a turn error — the turn did not fail.`,
      );
      return;
    }
    if (canceled) {
      // The user hit Stop (ADR-0008): the abort came from the cancel poll, not a
      // failure. Settle the turn as 'canceled', KEEPING the partial text streamed
      // so far — the web row flips to "Stopped", not a red error. Reported through
      // the state-closing event path (retried) like finish/error.
      console.log(`⏹ stopped ${msg.id} (${text.length} chars)`);
      try {
        await postJsonRetry("event", {
          type: "canceled",
          user_message_id: msg.id,
          assistant_message_id,
          content: text,
        });
      } catch (reportErr) {
        console.error(
          `⏹ ${msg.id}: failed to report the stop to Canvas — the web row may be ` +
            `stuck "working…" until the next poll reaps it: ` +
            `${reportErr instanceof Error ? reportErr.message : reportErr}`,
        );
      }
      return;
    }
    console.error(`✗ ${msg.id}: ${message}`);
    // Genuine mid-stream (or start) failure. The error POST is the state-closing
    // signal — retry it, and if even that fails (double fault: Wi-Fi down), log
    // loudly rather than swallow.
    try {
      await postJsonRetry("event", {
        type: "error",
        user_message_id: msg.id,
        // May be undefined if `start` itself failed — the server treats a
        // missing assistant id as "no assistant row opened" and surfaces the
        // error on the prompt row instead.
        assistant_message_id,
        error: message,
      });
    } catch (reportErr) {
      console.error(
        `✗ ${msg.id}: failed to report the error to Canvas — the web row may be ` +
          `stuck "working…" until the next poll reaps it: ` +
          `${reportErr instanceof Error ? reportErr.message : reportErr}`,
      );
    }
  }
}

// Bound how many threads run concurrently so a burst of queued prompts can't
// spawn unbounded `claude -p` processes. Each thread-group's turns run
// sequentially (they share a resume session, so same-thread turns MUST be
// ordered); independent thread-groups run in parallel up to this cap.
const MAX_CONCURRENT_THREADS = Math.max(
  1,
  Number(process.env.CANVAS_MAX_CONCURRENT_THREADS || 3),
);

async function runThreadGroups(groups) {
  let cursor = 0;
  const runGroup = async () => {
    while (cursor < groups.length) {
      // `cursor++` is atomic between awaits (single-threaded JS), so no two
      // workers ever claim the same group.
      const group = groups[cursor++];
      for (const msg of group) {
        try {
          const preview =
            typeof msg?.content === "string" ? msg.content.slice(0, 80) : "(no content)";
          console.log(`→ ${preview}`);
          await runTurn(msg);
        } catch (err) {
          console.error(
            `✗ skipped a message (${msg?.id ?? "?"}): ` +
              `${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  };
  const workers = Math.min(MAX_CONCURRENT_THREADS, groups.length);
  await Promise.all(Array.from({ length: workers }, () => runGroup()));
}

async function main() {
  console.log(
    `canvas-agent (${AGENT_PROVIDER}) → ${CANVAS_URL}  (polling every ${POLL_MS}ms)`,
  );
  console.log("Type prompts in the Canvas web chatbox. Ctrl-C to stop.\n");

  let warnedOffline = false;
  let confirmedConnected = false;
  for (;;) {
    let messages = [];
    try {
      messages = await poll();
      warnedOffline = false;
      // Positive confirmation the loop is actually live and authenticated — a
      // first successful poll means the token resolved and Canvas is reachable.
      // Without this the user stares at a silent terminal unsure it's working.
      if (!confirmedConnected) {
        console.log("✓ connected to Canvas — watching for prompts.");
        confirmedConnected = true;
      }
    } catch (err) {
      if (!warnedOffline) {
        console.error(
          `Cannot reach Canvas (${err instanceof Error ? err.message : err}). Retrying…`,
        );
        warnedOffline = true;
      }
      await sleep(POLL_MS * 2);
      continue;
    }

    if (messages.length === 0) {
      await sleep(POLL_MS);
      continue;
    }

    // Run independent THREADS in parallel while a single thread's turns stay
    // strictly ordered. Before this, one slow agent turn on deck A blocked a
    // queued prompt on deck B for the whole turn (the TURN_TIMEOUT comment above
    // called this out); now only same-thread turns wait on each other. Each turn
    // keeps its own try/catch backstop so one bad message never aborts another
    // thread or kills the daemon.
    const byThread = new Map();
    for (const msg of messages) {
      const key = msg?.thread_id ?? msg?.id ?? "no-thread";
      if (!byThread.has(key)) byThread.set(key, []);
      byThread.get(key).push(msg);
    }
    await runThreadGroups([...byThread.values()]);
  }
}

// Crash + signal handling for a long-running daemon. Choice: a stray rejection
// or uncaught exception is LOGGED loudly and the process is kept ALIVE — killing
// the daemon on a single bad turn would strand whatever row is in flight at
// "working…" (the poll reaper only recovers it after STALE_MS). The per-turn
// try/catch already contains expected turn failures; these are the last-resort
// nets for the truly unexpected, and staying up is less surprising than vanishing.
process.on("unhandledRejection", (reason) => {
  console.error(
    "⚠ unhandledRejection (kept alive):",
    reason instanceof Error ? reason.stack || reason.message : reason,
  );
});
process.on("uncaughtException", (err) => {
  console.error("⚠ uncaughtException (kept alive):", err?.stack || err?.message || err);
});

// Clean shutdown on Ctrl-C / kill: log a line and exit. Best-effort — we don't
// try to report the in-flight turn (the poll reaper recovers a stranded row).
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(`\ncanvas-agent: received ${sig}, shutting down.`);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
