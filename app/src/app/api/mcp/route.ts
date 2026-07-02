// Provider-neutral MCP endpoint using Authorization: Bearer <token>.
//
// The legacy /api/mcp/{token} URL remains supported for clients that cannot
// send headers. Modern MCP clients and the local agent bridge should prefer
// this endpoint so the bearer secret does not appear in URLs or process args.

import { NextResponse, type NextRequest } from "next/server";
import {
  GET as legacyGet,
  POST as legacyPost,
} from "./[token]/route";

export const runtime = "nodejs";
export const maxDuration = 60;

export function extractMcpBearerToken(
  request: Pick<NextRequest, "headers">,
): string | null {
  const authorization = request.headers.get("authorization") ?? "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export async function POST(request: NextRequest) {
  const token = extractMcpBearerToken(request);
  if (!token) {
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32001, message: "Missing bearer token" },
      },
      { status: 401 },
    );
  }
  return legacyPost(request, { params: Promise.resolve({ token }) });
}

export async function GET(request: NextRequest) {
  const token = extractMcpBearerToken(request);
  if (!token) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return legacyGet(request, { params: Promise.resolve({ token }) });
}
