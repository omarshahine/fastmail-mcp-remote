/**
 * Calendar commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatCalendars, formatEvents, formatEvent } from "../formatters.js";
import { validateIds, validateDateArg, validateTextArg, validatePositiveInt } from "../validate.js";

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

/** Format a dry-run preview for a mutation command. */
function dryRunOutput(toolName: string, args: Record<string, unknown>): void {
  console.log(`[dry-run] Would call: ${toolName}`);
  console.log(JSON.stringify(args, null, 2));
}

export function registerCalendarCommands(
  program: Command,
  client: FastmailMcpClient,
) {
  // ── calendars ────────────────────────────────────────────

  program
    .command("calendars")
    .description("List all calendars")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_calendars");
      output(data, formatCalendars, opts.json, opts.fields);
    });

  // ── events (list) ────────────────────────────────────────

  program
    .command("events")
    .description("List calendar events")
    .option("--calendar <id>", "Calendar ID")
    .option("-l, --limit <n>", "Max results", "50")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const limit = validatePositiveInt(opts.limit, "limit");
      if (opts.calendar) validateIds(opts.calendar, "calendar ID");
      const data = await client.callTool("list_calendar_events", {
        calendarId: opts.calendar,
        limit,
      });
      output(data, formatEvents, opts.json, opts.fields);
    });

  // ── event (get + create) ─────────────────────────────────

  const event = program
    .command("event")
    .description("Event operations. Pass an ID to view an event.")
    .argument("[id]", "Event ID to view")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (id, opts) => {
      if (!id) return event.help();
      validateIds(id, "event ID");
      const data = await client.callTool("get_calendar_event", { eventId: id });
      output(data, formatEvent, opts.json, opts.fields);
    });

  event
    .command("create")
    .description("Create a calendar event")
    .requiredOption("--calendar <id>", "Calendar ID")
    .requiredOption("--title <text>", "Event title")
    .requiredOption("--start <datetime>", "Start time (ISO 8601)")
    .requiredOption("--end <datetime>", "End time (ISO 8601)")
    .option("--description <text>", "Event description")
    .option("--location <text>", "Event location")
    .option("--dry-run", "Preview what would be created without creating")
    .action(async (opts) => {
      validateIds(opts.calendar, "calendar ID");
      validateTextArg(opts.title, "event title");
      validateDateArg(opts.start, "start time");
      validateDateArg(opts.end, "end time");
      if (opts.description) validateTextArg(opts.description, "description");
      if (opts.location) validateTextArg(opts.location, "location");

      const args = {
        calendarId: opts.calendar,
        title: opts.title,
        start: opts.start,
        end: opts.end,
        description: opts.description,
        location: opts.location,
      };

      if (opts.dryRun) return dryRunOutput("create_calendar_event", args);

      const result = await client.callTool("create_calendar_event", args);
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });
}
