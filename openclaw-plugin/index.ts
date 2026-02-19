/**
 * OpenClaw plugin entry point for Fastmail.
 *
 * Registers agent tools that proxy to the remote Fastmail MCP Worker
 * via a persistent in-process MCP SDK connection. Responses are formatted
 * using compact text formatters for token efficiency.
 *
 * Credentials (workerUrl + bearerToken) come from plugin config,
 * supporting multi-user setups where each workspace has its own token.
 */

import { FastmailMcpClient } from "./src/mcp-client.js";
import { resolveCredentials } from "./src/auth.js";
import { registerEmailTools } from "./src/tools/email.js";
import { registerContactTools } from "./src/tools/contacts.js";
import { registerCalendarTools } from "./src/tools/calendar.js";
import { registerMemoTools } from "./src/tools/memo.js";

export type GetClientFn = () => Promise<FastmailMcpClient>;

/**
 * Create a lazy client factory that connects on first tool call.
 * One persistent connection per plugin instance (per workspace).
 */
function lazyClientFactory(pluginConfig: {
  workerUrl?: string;
  bearerToken?: string;
}): GetClientFn {
  let client: FastmailMcpClient | null = null;

  return async () => {
    if (client) return client;
    const { url, token } = resolveCredentials(pluginConfig);
    client = new FastmailMcpClient(url, token);
    return client;
  };
}

export default function register(api: any) {
  const pluginConfig = api.config || {};
  const getClient = lazyClientFactory(pluginConfig);

  registerEmailTools(api, getClient);
  registerContactTools(api, getClient);
  registerCalendarTools(api, getClient);
  registerMemoTools(api, getClient);
}
