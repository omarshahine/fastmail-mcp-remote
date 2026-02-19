/**
 * Calendar tools for the Fastmail OpenClaw plugin.
 *
 * Registers 4 tools: 3 read-only + 1 optional (create event).
 */

import { runCli } from "../cli-runner.js";

export function registerCalendarTools(api: any) {
  api.registerTool({
    name: "fastmail_list_calendars",
    description: "List all calendars with IDs and names.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const text = await runCli(["calendars"]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_list_events",
    description: "List calendar events, optionally filtered by calendar.",
    parameters: {
      type: "object",
      properties: {
        calendarId: {
          type: "string",
          description: "Calendar ID (omit for all calendars)",
        },
        limit: {
          type: "integer",
          default: 50,
          description: "Max events to return",
        },
      },
    },
    async execute(
      _id: string,
      params: { calendarId?: string; limit?: number },
    ) {
      const args = ["events"];
      if (params.calendarId) args.push("--calendar", params.calendarId);
      if (params.limit) args.push("--limit", String(params.limit));
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_event",
    description:
      "Get full event details by ID (times, location, description, participants).",
    parameters: {
      type: "object",
      properties: {
        eventId: { type: "string", description: "Event ID" },
      },
      required: ["eventId"],
    },
    async execute(_id: string, params: { eventId: string }) {
      const text = await runCli(["event", params.eventId]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool(
    {
      name: "fastmail_create_event",
      description: "Create a new calendar event.",
      parameters: {
        type: "object",
        properties: {
          calendarId: { type: "string", description: "Calendar ID" },
          title: { type: "string", description: "Event title" },
          start: {
            type: "string",
            description: "Start time (ISO 8601)",
          },
          end: {
            type: "string",
            description: "End time (ISO 8601)",
          },
          description: { type: "string", description: "Event description" },
          location: { type: "string", description: "Event location" },
        },
        required: ["calendarId", "title", "start", "end"],
      },
      async execute(_id: string, params: Record<string, any>) {
        const args = [
          "event",
          "create",
          "--calendar",
          params.calendarId,
          "--title",
          params.title,
          "--start",
          params.start,
          "--end",
          params.end,
        ];
        if (params.description) args.push("--description", params.description);
        if (params.location) args.push("--location", params.location);
        const text = await runCli(args);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );
}
