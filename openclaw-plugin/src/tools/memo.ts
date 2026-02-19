/**
 * Memo (private notes) tools for the Fastmail OpenClaw plugin.
 *
 * Registers 3 tools: 1 read-only + 2 optional (create, delete).
 * Memos are private annotations on emails, rendered as yellow highlights
 * in the Fastmail UI.
 */

import { runCli } from "../cli-runner.js";

export function registerMemoTools(api: any) {
  api.registerTool({
    name: "fastmail_get_memo",
    description:
      "Get the private memo (annotation) on an email, if one exists.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
      },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string }) {
      const text = await runCli(["memo", params.emailId]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool(
    {
      name: "fastmail_create_memo",
      description:
        "Add a private memo (annotation) to an email. Shown as a yellow highlight in Fastmail.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID to annotate" },
          text: { type: "string", description: "Memo text content" },
        },
        required: ["emailId", "text"],
      },
      async execute(_id: string, params: { emailId: string; text: string }) {
        const text = await runCli([
          "memo",
          "create",
          params.emailId,
          "--text",
          params.text,
        ]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_delete_memo",
      description: "Delete the private memo on an email.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["memo", "delete", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );
}
