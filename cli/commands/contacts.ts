/**
 * Contact commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatContacts, formatContact } from "../formatters.js";

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
    .action(async (opts) => {
      const data = await client.callTool("list_contacts", {
        limit: parseInt(opts.limit),
      });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatContacts(data));
      }
    });

  // ── contacts search ──────────────────────────────────────

  contacts
    .command("search <query>")
    .description("Search contacts by name or email")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--json", "JSON output")
    .action(async (query, opts) => {
      const data = await client.callTool("search_contacts", {
        query,
        limit: parseInt(opts.limit),
      });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatContacts(data));
      }
    });

  // ── contact (single) ────────────────────────────────────

  program
    .command("contact <id>")
    .description("Get a specific contact by ID")
    .option("--json", "JSON output")
    .action(async (id, opts) => {
      const data = await client.callTool("get_contact", { contactId: id });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatContact(data));
      }
    });
}
