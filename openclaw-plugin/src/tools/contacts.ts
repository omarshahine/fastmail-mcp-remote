/**
 * Contact tools for the Fastmail OpenClaw plugin.
 * 3 read-only tools.
 */

import type { OpenClawApi, GetClientFn } from "../../index.js";
import { formatContacts, formatContact } from "../formatters.js";

export function registerContactTools(api: OpenClawApi, getClient: GetClientFn) {
  api.registerTool({
    name: "fastmail_list_contacts",
    description: "List contacts with names, emails, and phone numbers.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", default: 50, description: "Max contacts" } },
    },
    async execute(_id: string, params: { limit?: number }) {
      const client = await getClient();
      const data = await client.callTool("list_contacts", { limit: params.limit ?? 50 });
      return { content: [{ type: "text", text: Array.isArray(data) ? formatContacts(data) : String(data) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_contact",
    description: "Get full contact details by ID.",
    parameters: {
      type: "object",
      properties: { contactId: { type: "string", description: "Contact ID" } },
      required: ["contactId"],
    },
    async execute(_id: string, params: { contactId: string }) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatContact(await client.callTool("get_contact", { contactId: params.contactId })) }] };
    },
  });

  api.registerTool({
    name: "fastmail_search_contacts",
    description: "Search contacts by name or email.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        limit: { type: "integer", default: 20, description: "Max results" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: { query: string; limit?: number }) {
      const client = await getClient();
      const data = await client.callTool("search_contacts", { query: params.query, limit: params.limit ?? 20 });
      return { content: [{ type: "text", text: Array.isArray(data) ? formatContacts(data) : String(data) }] };
    },
  });
}
