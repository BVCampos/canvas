import { describe, expect, it } from "vitest";
import { extractMcpBearerToken } from "../src/app/api/mcp/route";
import { readMcpClientInfo } from "../src/app/api/mcp/[token]/route";

describe("provider-neutral MCP connection metadata", () => {
  it("accepts a case-insensitive bearer token and trims it", () => {
    expect(
      extractMcpBearerToken({
        headers: new Headers({ authorization: "bearer   mcp_example  " }),
      }),
    ).toBe("mcp_example");
  });

  it("rejects absent or non-bearer authorization", () => {
    expect(extractMcpBearerToken({ headers: new Headers() })).toBeNull();
    expect(
      extractMcpBearerToken({
        headers: new Headers({ authorization: "Basic abc" }),
      }),
    ).toBeNull();
  });

  it("reads standard initialize clientInfo without assuming a provider", () => {
    expect(
      readMcpClientInfo({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { clientInfo: { name: "Acme Agent", version: "7.2" } },
      }),
    ).toEqual({ name: "Acme Agent", version: "7.2" });
  });

  it("finds initialize inside a batch and ignores ordinary tool calls", () => {
    expect(
      readMcpClientInfo([
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "initialize",
          params: { clientInfo: { name: "Codex" } },
        },
      ]),
    ).toEqual({ name: "Codex", version: null });
    expect(
      readMcpClientInfo({ jsonrpc: "2.0", id: 3, method: "tools/list" }),
    ).toBeNull();
  });
});

