/**
 * OpenClaw plugin entry point for Fastmail.
 *
 * Registers 36 agent tools that proxy to the remote Fastmail MCP Worker
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

export default function register(api: OpenClawApi) {
  const pluginConfig = (api.config || {}) as { workerUrl?: string; bearerToken?: string };
  const getClient = lazyClientFactory(pluginConfig);

  registerEmailTools(api, getClient);
  registerContactTools(api, getClient);
  registerCalendarTools(api, getClient);
  registerMemoTools(api, getClient);
}
