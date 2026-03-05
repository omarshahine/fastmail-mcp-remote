/**
 * Contact commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatContacts, formatContact } from "../formatters.js";
import { validateIds, validateQuery, validatePositiveInt } from "../validate.js";

/** Helper: output JSON (optionally filtered by --fields) or formatted text. */
function output(data: any, formatter: (d: any) => string, json: boolean, fields?: string) {
  if (json) {
    const filtered = fields ? filterFields(data, fields) : data;
    console.log(JSON.stringify(filtered, null, 2));
  } else {
    console.log(formatter(data));
  }
}

function filterFields(data: any, fields: string): any {
  const keys = new Set(fields.split(",").map((f) => f.trim()));
  if (Array.isArray(data)) return data.map((item) => pick(item, keys));
  if (data && typeof data === "object") return pick(data, keys);
  return data;
}

function pick(obj: Record<string, any>, keys: Set<string>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const key of keys) {
    if (key in obj) result[key] = obj[key];
  }
  return result;
}

export function registerContactCommands(
  program: Command,
  client: FastmailMcpClient,
) {
  // ── contacts (list) ──────────────────────────────────────

  const contacts = program
    .command("contacts")
    .description("List contacts")
    .option("-l, --limit <n>", "Max results", "50")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const limit = validatePositiveInt(opts.limit, "limit");
      const data = await client.callTool("list_contacts", { limit });
      output(data, formatContacts, opts.json, opts.fields);
    });

  // ── contacts search ──────────────────────────────────────

  contacts
    .command("search <query>")
    .description("Search contacts by name or email")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (query, opts) => {
      validateQuery(query, "search query");
      const limit = validatePositiveInt(opts.limit, "limit");
      const data = await client.callTool("search_contacts", { query, limit });
      output(data, formatContacts, opts.json, opts.fields);
    });

  // ── contact (single) ────────────────────────────────────

  program
    .command("contact <id>")
    .description("Get a specific contact by ID")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (id, opts) => {
      validateIds(id, "contact ID");
      const data = await client.callTool("get_contact", { contactId: id });
      output(data, formatContact, opts.json, opts.fields);
    });
}
