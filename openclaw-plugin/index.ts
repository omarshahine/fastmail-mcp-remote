/**
 * OpenClaw plugin entry point for Fastmail.
 *
 * Registers 36 agent tools that shell out to the `fastmail` CLI.
 * The CLI handles MCP connection, auth, and compact text formatting.
 * Zero runtime dependencies — just execFile to the CLI process.
 */

import { registerEmailTools } from "./src/tools/email.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerMemoTools } from "./src/tools/memo.js";

/** Minimal typed interface for the OpenClaw plugin API. */
export interface OpenClawApi {
  registerTool(tool: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (_id: string, params: any) => Promise<{ content: Array<{ type: string; text: string }> }>;
  }, opts?: { optional: boolean }): void;
  config?: Record<string, unknown>;
}

export default function register(api: OpenClawApi) {
  const cli = (api.config?.cliCommand as string) ?? "fastmail";

  registerEmailTools(api, cli);
  registerContactTools(api, cli);
  registerCalendarTools(api, cli);
  registerMemoTools(api, cli);
}
