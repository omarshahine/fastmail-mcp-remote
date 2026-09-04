import { describe, expect, it, vi } from "vitest";
import { FastmailMcpClient } from "../cli/mcp-client.js";

describe("FastmailMcpClient", () => {
  it("throws when an MCP tool result is marked as an error", async () => {
    const wrapper = new FastmailMcpClient("https://worker.example", "token");
    (wrapper as any).client = {
      callTool: vi.fn().mockResolvedValue({
        isError: true,
        content: [{ type: "text", text: "Error: permission denied" }],
      }),
    };

    await expect(wrapper.callTool("restricted_tool")).rejects.toThrow(
      "Error: permission denied",
    );
  });
});
