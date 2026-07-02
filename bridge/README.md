# canvas-agent — the local assistant bridge

`canvas-agent` connects Canvas's in-app **Ask agent** panel to an agent running
on your machine. Canvas hosts the collaboration state and MCP tools; inference
stays local under your own provider account. The bridge currently has adapters
for **Codex** and **Claude Code**, and the web/MCP protocol is provider-neutral.

## Why a local process?

- Canvas runs no inference and stores no provider credential.
- The agent edits Canvas only through MCP tools, but local-tool isolation is NOT
  the same across adapters: the Claude adapter has no local file or shell access
  at all, while the Codex adapter runs in a read-only sandbox that blocks writes
  and network but can still READ local files (see [Safety](#safety)).
- Browser prompts, streaming replies, Stop, threads, and proposal cards all use
  the same bridge protocol regardless of provider.

## Setup

You do not need to clone the repo. The private GitHub Package runs through
`npx @21xventures/canvas-agent`.

1. Authenticate the agent you want to use locally:
   - **Codex:** install/sign in to the Codex CLI.
   - **Claude Code:** run `claude` and `/login`, or configure its supported API
     key/OAuth environment variable.
2. In Canvas, open **Settings → Connections**, create an access token, and copy
   the `mcp_…` value.
3. If needed, authorize the private package in `~/.npmrc`:

   ```ini
   @21xventures:registry=https://npm.pkg.github.com
   //npm.pkg.github.com/:_authToken=ghp_your_read_packages_token
   ```

4. Run one adapter:

   ```bash
   # Codex
   CANVAS_AGENT_PROVIDER=codex \
   CANVAS_URL=https://canvas.21xventures.com \
   CANVAS_MCP_TOKEN=mcp_xxxxxxxx \
   npx @21xventures/canvas-agent

   # Claude Code
   CANVAS_AGENT_PROVIDER=claude \
   CANVAS_URL=https://canvas.21xventures.com \
   CANVAS_MCP_TOKEN=mcp_xxxxxxxx \
   npx @21xventures/canvas-agent
   ```

`CANVAS_URL` defaults to `http://localhost:3001` for local development. Leave
the process running, open a deck, and use **Ask agent**. A green presence dot
confirms that Canvas is receiving bridge heartbeats.

### Run from source

```bash
cd bridge
npm install
CANVAS_AGENT_PROVIDER=codex CANVAS_MCP_TOKEN=mcp_xxxxxxxx npm start
```

## Keep it running (optional)

```bash
CANVAS_AGENT_PROVIDER=codex CANVAS_MCP_TOKEN=mcp_xxx \
  nohup npx @21xventures/canvas-agent &

CANVAS_AGENT_PROVIDER=codex CANVAS_MCP_TOKEN=mcp_xxx \
  pm2 start npx --name canvas-agent -- @21xventures/canvas-agent
```

The in-deck offline message and **Connections** page always show the current
one-line command, so a stopped or outdated bridge is recoverable without a
repo clone.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `CANVAS_MCP_TOKEN` | required | Per-user Canvas access token. |
| `CANVAS_AGENT_PROVIDER` | `claude` | Adapter: `codex` or `claude`. |
| `CANVAS_URL` | `http://localhost:3001` | Canvas base URL. |
| `CANVAS_MODEL` | provider default | Optional model override. |
| `CANVAS_POLL_MS` | `2500` | Prompt polling interval. |
| `CANVAS_MAX_TURNS` | `40` | Maximum agent turns per prompt. |
| `CANVAS_TURN_TIMEOUT_MS` | `120000` | Wall-clock limit for one turn. |
| `CANVAS_MAX_CONCURRENT_THREADS` | `3` | Concurrent threads; turns in one thread still serialize. |
| `CANVAS_CANCEL_POLL_MS` | `1200` | Stop-request polling interval. |

Node 20+ is required. Provider usage is billed or limited by the account you
authenticated locally; Canvas adds no inference bill.

## Safety

The two adapters do not give the same local-isolation guarantee:

- **Claude adapter:** runs in `dontAsk` mode with an allowlist of only Canvas
  MCP tools, and is given no local tools at all (`tools: []` plus hard-denied
  shell/file/task tools). It genuinely cannot touch your filesystem.
- **Codex adapter:** runs in an empty temporary directory with the Canvas MCP
  server as its only configured server and `sandbox_mode="read-only"`. Read-only
  blocks file **writes** and **network** access, but it does **not** block local
  file **reads** — the Codex model keeps its shell tool and can read files on
  your machine (e.g. `~/.ssh/id_rsa`, `.env`) and surface their contents through
  a Canvas proposal or comment. Run the Codex adapter only on a machine whose
  local files you are comfortable exposing to it.

Both adapters use the token's workspace and deck authorization boundaries, and
all content changes still enter Canvas as proposals. The optional trusted fast
lane is deck-scoped, patch-only, and requires a successful proposal render
before applying.
