/**
 * Contact tools for the Fastmail OpenClaw plugin.
 *
 * Registers 3 read-only tools for listing, getting, and searching contacts.
 */

import { runCli } from "../cli-runner.js";

export function registerContactTools(api: any) {
  api.registerTool({
    name: "fastmail_list_contacts",
    description: "List contacts with names, emails, and phone numbers.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: 50,
          description: "Max contacts to return",
        },
      },
    },
    async execute(_id: string, params: { limit?: number }) {
      const args = ["contacts"];
      if (params.limit) args.push("--limit", String(params.limit));
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_contact",
    description:
      "Get full contact details by ID (emails, phones, addresses, company, notes).",
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string", description: "Contact ID" },
      },
      required: ["contactId"],
    },
    async execute(_id: string, params: { contactId: string }) {
      const text = await runCli(["contact", params.contactId]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_search_contacts",
    description: "Search contacts by name or email address.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", default: 20, description: "Max results" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; limit?: number }) {
      const args = ["contacts", "search", params.query];
      if (params.limit) args.push("--limit", String(params.limit));
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });
}
