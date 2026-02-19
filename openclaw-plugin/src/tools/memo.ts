/**
 * Memo (private notes) tools for the Fastmail OpenClaw plugin.
 * 1 read-only + 2 optional (create, delete).
 */

import type { GetClientFn } from "../../index.js";
import { formatMemo } from "../formatters.js";

export function registerMemoTools(api: any, getClient: GetClientFn) {
  api.registerTool({
    name: "fastmail_get_memo",
    description: "Get the private memo on an email, if one exists.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatMemo(await client.callTool("get_memo", { emailId: params.emailId })) }] };
    },
  });

  api.registerTool({
    name: "fastmail_create_memo",
    description: "Add a private memo to an email. Shown as a yellow highlight in Fastmail.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        text: { type: "string", description: "Memo text" },
      },
      required: ["emailId", "text"],
    },
    async execute(_id: string, params: { emailId: string; text: string }) {
      const client = await getClient();
      const data = await client.callTool("create_memo", params);
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_delete_memo",
    description: "Delete the private memo on an email.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("delete_memo", { emailId: params.emailId });
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });
}
