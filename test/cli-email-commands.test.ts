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

describe("email forward", () => {
  it("maps flags to forward_email, forwarding attachments by default", async () => {
    const { program, callTool } = setup();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program.parseAsync([
      "node", "fastmail", "email", "forward", "M123",
      "--to", "person@example.com",
      "--markdown", "Take a look",
    ]);
    expect(callTool).toHaveBeenCalledWith("forward_email", expect.objectContaining({
      emailId: "M123",
      to: ["person@example.com"],
      markdownBody: "Take a look",
      includeAttachments: true,
      sendImmediately: false,
    }));
  });

  it("supports --no-attachments and --send", async () => {
    const { program, callTool } = setup();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await program.parseAsync([
      "node", "fastmail", "email", "forward", "M123",
      "--to", "person@example.com",
      "--no-attachments", "--send",
    ]);
    expect(callTool).toHaveBeenCalledWith("forward_email", expect.objectContaining({
      includeAttachments: false,
      sendImmediately: true,
    }));
  });
});
