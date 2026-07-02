# Contributing to Canvas

Thanks for your interest. Canvas is a Next.js app (`app/`) backed by Supabase,
plus a small local bridge (`bridge/`) for the in-app assistant.

## Getting set up

See [README.md](README.md) → **Local dev**. In short: create your own Supabase
project, run the migrations in `app/supabase/migrations/` in order, copy
`app/.env.example` to `app/.env.local` and fill it, then `npm install && npm run dev`.

## Before you open a PR

Run all three from `app/` — CI runs the same and a red check blocks merge:

```bash
npm run lint        # eslint, must be clean
npm test            # vitest (parser + MCP server)
npx tsc --noEmit    # typecheck, must be clean
```

If you touch `app/supabase/migrations/`, add a new numbered migration rather than
editing an existing one, and sanity-check the SQL (RLS is easy to break).

## Conventions

- Read [`app/AGENTS.md`](app/AGENTS.md) first — this is **Next 16.2 / React 19.2**,
  middleware lives in `src/proxy.ts`, and several APIs differ from older Next.
- Domain vocabulary is defined in [`CONTEXT.md`](CONTEXT.md); architectural
  decisions live in [`docs/adr/`](docs/adr/). New decision → new ADR.
- Don't commit secrets, real client decks, or `*.real.html` fixtures (the
  `.gitignore` already guards these).

## License

By contributing you agree your contributions are licensed under the project's
[MIT License](LICENSE).
