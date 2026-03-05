/**
 * Contact commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatContacts, formatContact } from "../formatters.js";
import { validateIds, validateQuery, validatePositiveInt } from "../validate.js";
import { output } from "../helpers.js";

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
