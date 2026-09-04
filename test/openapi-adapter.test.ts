import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Executor } from "@cloudflare/codemode";
import { buildCodeModeServer } from "../src/openapi-adapter";

describe("Code Mode public contract", () => {
  it("exposes search and execute tools", async () => {
    const upstream = new McpServer({ name: "upstream", version: "1.0.0" });
    upstream.tool("list_mailboxes", "List mailboxes", {}, async () => ({
      content: [{ type: "text", text: "[]" }],
    }));
    const executor = {
      execute: async () => ({ result: null }),
    } as Executor;
    const codeMode = await buildCodeModeServer(upstream, executor);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "contract-test", version: "1.0.0" });

    await codeMode.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(["execute", "search"]);
    const execute = tools.find((tool) => tool.name === "execute");
    expect(execute?.description).toContain("JavaScript");
    expect(execute?.description).toContain("codemode.request");
    expect(execute?.description).not.toContain("fastmail.search_emails");
    await client.close();
    await codeMode.close();
    await upstream.close();
  });
});
