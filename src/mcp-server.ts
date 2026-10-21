/**
 * The single SDK v2 MCP server factory behind `/mcp`.
 *
 * One stateless server instance is built per request and serves both protocol
 * eras: 2026-07-28 requests natively, and 2025-era requests through the agents
 * stateless legacy lane. Tools register through the same `registerAllTools`
 * path as the `/mcp/code` endpoint, so every surface exposes identical tools
 * and identical inner permission checks.
 */

import {
  McpServer,
  createRequestStateCodec,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { registerAllTools, buildToolContext, legacyShapedModernServer } from "./tools";
import type { SendApprovalRequestState } from "./send-approval";
import type { BulkConfirmRequestState } from "./bulk-confirm";
import { UI_EXTENSION_ID } from "./apps/constants";

/** Opaque state carried across input-required rounds. */
export type ModernRequestState = SendApprovalRequestState | BulkConfirmRequestState;

export interface McpRequestStateCodec {
  mint(state: ModernRequestState, context: ServerContext): Promise<string>;
  verify(state: string, context: ServerContext): Promise<ModernRequestState>;
}

/**
 * HMAC codec for `requestState`, bound to the authenticated user and the
 * request method so a state minted for one user or method cannot be replayed
 * against another.
 */
export function createMcpRequestStateCodec(env: Env, userLogin: string): McpRequestStateCodec {
  return createRequestStateCodec<ModernRequestState>({
    key: env.ACTION_SIGNING_KEY,
    ttlSeconds: 10 * 60,
    bind: (context) => `${userLogin}\0${context.mcpReq.method}`,
  });
}

export function createFastmailMcpServer(input: {
  env: Env;
  userLogin: string;
  visibleTools?: Set<string>;
  requestStateCodec: McpRequestStateCodec;
}): McpServer {
  const { env, userLogin, visibleTools, requestStateCodec } = input;
  const server = new McpServer(
    { name: "Fastmail MCP Remote", version: "1.0.0" },
    {
      // MCP Apps: hosts that support the extension render `ui://` resources
      // linked from tool `_meta.ui.resourceUri`.
      capabilities: { extensions: { [UI_EXTENSION_ID]: {} } },
      inputRequired: { legacyShim: false, maxRounds: 3 },
      requestState: { verify: requestStateCodec.verify },
      // Tool and resource lists differ per user (permissions), so they are
      // private; resource bodies change rarely.
      cacheHints: {
        "tools/list": { ttlMs: 60_000, cacheScope: "private" },
        "resources/list": { ttlMs: 60_000, cacheScope: "private" },
        "resources/read": { ttlMs: 300_000, cacheScope: "private" },
      },
    },
  );
  const toolContext = buildToolContext(env, userLogin, {
    getClientCapabilities: () => server.server.getClientCapabilities(),
    mintRequestState: (state, context) => requestStateCodec.mint(state, context),
  });
  registerAllTools(legacyShapedModernServer(server), toolContext, visibleTools, { apps: true });
  return server;
}
