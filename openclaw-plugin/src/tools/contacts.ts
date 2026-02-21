/**
 * Contact tools for the Fastmail OpenClaw plugin.
 * 3 read-only tools.
 */

import type { OpenClawApi } from "../../index.js";
import { buildArgs, runTool } from "../cli-runner.js";

export function registerContactTools(api: OpenClawApi, cli: string) {
  api.registerTool({
    name: "fastmail_list_contacts",
    description: "List contacts with names, emails, and phone numbers.",
    parameters: {
      type: "object",
      properties: { limit: { type: "integer", default: 50, description: "Max contacts" } },
    },
    execute: (_id, params: { limit?: number }) =>
      runTool(buildArgs(["contacts"], { limit: params.limit }), cli),
  });

  api.registerTool({
    name: "fastmail_get_contact",
    description: "Get full contact details by ID.",
    parameters: {
      type: "object",
      properties: { contactId: { type: "string", description: "Contact ID" } },
      required: ["contactId"],
    },
    execute: (_id, params: { contactId: string }) =>
      runTool(["contact", params.contactId], cli),
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
    execute: (_id, params: { query: string; limit?: number }) =>
      runTool(buildArgs(["contacts", "search", params.query], { limit: params.limit }), cli),
  });
}
