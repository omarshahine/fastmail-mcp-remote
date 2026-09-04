import { describe, expect, it, vi } from "vitest";
import { TOOL_CATEGORIES } from "../src/permissions";
import { registerAllTools, type ToolContext, type ToolResult } from "../src/tools";

describe("tool permission category completeness", () => {
  it("categorizes every registered tool", () => {
    const registered: string[] = [];
    const server = {
      tool(name: string) {
        registered.push(name);
      },
    };

    registerAllTools(server as never, {} as never);

    expect(registered.sort()).toEqual(Object.keys(TOOL_CATEGORIES).sort());
  });

  it("checks permissions before an unfiltered write handler can run", async () => {
    let handler: ((args: Record<string, unknown>) => Promise<ToolResult>) | undefined;
    const server = {
      tool(name: string, _description: string, _schema: unknown, callback: typeof handler) {
        if (name === "create_calendar_event") handler = callback;
      },
    };
    const createEvent = vi.fn();
    const denied: ToolResult = {
      content: [{ type: "text", text: "Error: permission denied" }],
    };
    const checkToolPermission = vi.fn(async () => denied);
    const context = {
      checkToolPermission,
      getContactsCalendarClient: () => ({ createEvent }),
    } as unknown as ToolContext;

    registerAllTools(server as never, context);
    const args = {
      calendarId: "calendar-1",
      title: "Sensitive meeting",
      start: "2026-09-04T12:00:00Z",
      duration: "PT1H",
    };
    await expect(handler!(args)).resolves.toEqual(denied);
    expect(checkToolPermission).toHaveBeenCalledWith("create_calendar_event", args);
    expect(createEvent).not.toHaveBeenCalled();
  });
});
