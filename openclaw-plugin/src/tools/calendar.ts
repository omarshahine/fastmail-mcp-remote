/**
 * Calendar tools for the Fastmail OpenClaw plugin.
 * 3 read-only + 1 optional (create).
 */

import type { OpenClawApi } from "../../index.js";
import { buildArgs, runTool } from "../cli-runner.js";

export function registerCalendarTools(api: OpenClawApi, cli: string) {
  api.registerTool({
    name: "fastmail_list_calendars",
    description: "List all calendars with IDs and names.",
    parameters: { type: "object", properties: {} },
    execute: () => runTool(["calendars"], cli),
  });

  api.registerTool({
    name: "fastmail_list_events",
    description: "List calendar events, optionally filtered by calendar.",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string", description: "Calendar ID (omit for all)" },
        limit: { type: "integer", default: 50, description: "Max events" },
      },
    },
    execute: (_id, params: { calendarId?: string; limit?: number }) =>
      runTool(buildArgs(["events"], { calendar: params.calendarId, limit: params.limit }), cli),
  });

  api.registerTool({
    name: "fastmail_get_event",
    description: "Get full event details by ID.",
    parameters: {
      type: "object",
      properties: { eventId: { type: "string", description: "Event ID" } },
      required: ["eventId"],
    },
    execute: (_id, params: { eventId: string }) =>
      runTool(["event", params.eventId], cli),
  });

  api.registerTool({
    name: "fastmail_create_event",
    description: "Create a new calendar event.",
    parameters: {
      type: "object",
      properties: {
        calendarId: { type: "string" },
        title: { type: "string" },
        start: { type: "string", description: "ISO 8601" },
        end: { type: "string", description: "ISO 8601" },
        description: { type: "string" },
        location: { type: "string" },
      },
      required: ["calendarId", "title", "start", "end"],
    },
    execute: (_id, params: { calendarId: string; title: string; start: string; end: string; description?: string; location?: string }) =>
      runTool(buildArgs(["event", "create"], {
        calendar: params.calendarId, title: params.title,
        start: params.start, end: params.end,
        description: params.description, location: params.location,
      }), cli),
  }, { optional: true });
}
