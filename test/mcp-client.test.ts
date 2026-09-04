import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { FastmailMcpClient } from "../cli/mcp-client.js";

describe("FastmailMcpClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("shares one in-flight connection between concurrent first calls", async () => {
    let finishConnect!: () => void;
    const connect = vi.spyOn(Client.prototype, "connect").mockImplementation(
      () => new Promise<void>((resolve) => { finishConnect = resolve; }),
    );
    const callTool = vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
    } as any);
    const wrapper = new FastmailMcpClient("https://worker.example", "token");

    const first = wrapper.callTool("first");
    const second = wrapper.callTool("second");
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    expect(callTool).not.toHaveBeenCalled();

    finishConnect();
    await expect(Promise.all([first, second])).resolves.toEqual([{}, {}]);
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("clears a failed connection so a later call can retry", async () => {
    const connect = vi.spyOn(Client.prototype, "connect")
      .mockRejectedValueOnce(new Error("temporary connection failure"))
      .mockResolvedValueOnce(undefined);
    vi.spyOn(Client.prototype, "callTool").mockResolvedValue({
      content: [{ type: "text", text: "{}" }],
    } as any);
    const wrapper = new FastmailMcpClient("https://worker.example", "token");

    await expect(wrapper.callTool("first")).rejects.toThrow("temporary connection failure");
    await expect(wrapper.callTool("second")).resolves.toEqual({});
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
