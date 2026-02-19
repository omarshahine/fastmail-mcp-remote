/**
 * Calendar tools for the Fastmail OpenClaw plugin.
 * 3 read-only + 1 optional (create).
 */

import type { GetClientFn } from "../../index.js";
import { formatCalendars, formatEvents, formatEvent } from "../formatters.js";

export function registerCalendarTools(api: any, getClient: GetClientFn) {
  api.registerTool({
    name: "fastmail_list_calendars",
    description: "List all calendars with IDs and names.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const client = await getClient();
      return { content: [{ type: "text", text: formatCalendars(await client.callTool("list_calendars")) }] };
    },
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
    async execute(_id: string, params: { calendarId?: string; limit?: number }) {
      const client = await getClient();
      const data = await client.callTool("list_calendar_events", { calendarId: params.calendarId, limit: params.limit ?? 50 });
      return { content: [{ type: "text", text: Array.isArray(data) ? formatEvents(data) : String(data) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_event",
    description: "Get full event details by ID.",
    parameters: {
      type: "object",
      properties: { eventId: { type: "string", description: "Event ID" } },
      required: ["eventId"],
    },
    async execute(_id: string, params: { eventId: string }) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatEvent(await client.callTool("get_calendar_event", { eventId: params.eventId })) }] };
    },
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
    async execute(_id: string, params: Record<string, any>) {
      const client = await getClient();
      const data = await client.callTool("create_calendar_event", params);
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });
}
