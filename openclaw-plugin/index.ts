/**
 * OpenClaw plugin entry point for Fastmail.
 *
 * Registers 33 agent tools that shell out to the `fastmail` CLI.
 * The CLI handles auth, MCP connection, formatting, and cleanup internally,
 * returning compact token-efficient text.
 *
 * Prerequisites: authenticate via `fastmail auth --url <url>` first.
 */

import { configure } from "./src/cli-runner.js";
import { ensureAuthenticated } from "./src/auth.js";
import { registerEmailTools } from "./src/tools/email.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerMemoTools } from "./src/tools/memo.js";

export default function register(api: any) {
  const pluginConfig = api.config || {};

  // Configure CLI runner with optional overrides
  if (pluginConfig.cliCommand) {
    configure({ command: pluginConfig.cliCommand });
  }
  if (pluginConfig.timeout) {
    configure({ timeout: pluginConfig.timeout });
  }

  registerEmailTools(api);
  registerContactTools(api);
  registerCalendarTools(api);
  registerMemoTools(api);
}
