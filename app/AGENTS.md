# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Notably:

- Middleware lives in `src/proxy.ts` (not `middleware.ts`). The exported function is `proxy`, not `middleware`.
- We are on Next 16.2 + React 19.2. Server Components are the default; client components must be explicitly marked.
- Route groups (`(auth)`, etc.) and the `app/` directory follow current Next.js conventions.
