/**
 * Calendar commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatCalendars, formatEvents, formatEvent } from "../formatters.js";
import { validateIds, validateDateArg, validateTextArg, validatePositiveInt } from "../validate.js";
import { output, dryRunOutput } from "../helpers.js";

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
