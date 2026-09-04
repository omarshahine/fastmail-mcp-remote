import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerEmailCommands } from "../cli/commands/email";

function setup() {
  const program = new Command().exitOverride();
  const callTool = vi.fn(async () => ({ ok: true }));
  registerEmailCommands(program, { callTool } as never);
  return { program, callTool };
}

afterEach(() => vi.restoreAllMocks());

describe("email send/draft body validation", () => {
  it.each(["send", "draft"])("rejects %s without a body before dry-run or MCP", async (command) => {
    const { program, callTool } = setup();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(program.parseAsync([
      "node", "fastmail", "email", command,
      "--to", "person@example.com",
      "--subject", "Hello",
      "--dry-run",
    ])).rejects.toMatchObject({ exitCode: 3 });
    expect(callTool).not.toHaveBeenCalled();
  });

  it.each([
    ["--body", "textBody"],
    ["--html", "htmlBody"],
    ["--markdown", "markdownBody"],
  ])("accepts %s for both send and draft", async (flag, argumentName) => {
    for (const [command, tool] of [["send", "send_email"], ["draft", "create_draft"]] as const) {
      const { program, callTool } = setup();
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await program.parseAsync([
        "node", "fastmail", "email", command,
        "--to", "person@example.com",
        "--subject", "Hello",
        flag, "content",
      ]);
      expect(callTool).toHaveBeenCalledWith(tool, expect.objectContaining({ [argumentName]: "content" }));
    }
  });
});
