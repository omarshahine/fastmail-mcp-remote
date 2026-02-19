/**
 * Calendar commands for the Fastmail CLI.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
import { formatCalendars, formatEvents, formatEvent } from "../formatters.js";

export function registerCalendarCommands(
  program: Command,
  client: FastmailMcpClient,
) {
  // ── calendars ────────────────────────────────────────────

  program
    .command("calendars")
    .description("List all calendars")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_calendars");
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatCalendars(data));
      }
    });

  // ── events (list) ────────────────────────────────────────

  program
    .command("events")
    .description("List calendar events")
    .option("--calendar <id>", "Calendar ID")
    .option("-l, --limit <n>", "Max results", "50")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_calendar_events", {
        calendarId: opts.calendar,
        limit: parseInt(opts.limit),
      });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatEvents(data));
      }
    });

  // ── event (get + create) ─────────────────────────────────

  const event = program
    .command("event")
    .description("Event operations. Pass an ID to view an event.")
    .argument("[id]", "Event ID to view")
    .option("--json", "JSON output")
    .action(async (id, opts) => {
      if (!id) return event.help();
      const data = await client.callTool("get_calendar_event", { eventId: id });
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.log(formatEvent(data));
      }
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
    .action(async (opts) => {
      const result = await client.callTool("create_calendar_event", {
        calendarId: opts.calendar,
        title: opts.title,
        start: opts.start,
        end: opts.end,
        description: opts.description,
        location: opts.location,
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });
}
