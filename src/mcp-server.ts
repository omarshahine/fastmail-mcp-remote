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

/**
 * Whether this request's client can render MCP Apps. 2025-era requests carry
 * no per-request capabilities, so they keep Apps (claude.ai is on that lane).
 * 2026-07-28 requests get Apps only when they advertise the ui extension.
 */
export function clientSupportsApps(parsedBody: unknown, isLegacy: boolean): boolean {
  if (isLegacy) return true;
  return declaresUiExtension(parsedBody);
}

/**
 * Whether this request's client may approve eligible replies from the send
 * review card. Only 2026-07-28 requests that declare the ui extension qualify:
 * a 2025-era request says nothing about the client, so it is never assumed to
 * render the card.
 */
export function clientSupportsInlineApproval(parsedBody: unknown, isLegacy: boolean): boolean {
  return !isLegacy && declaresUiExtension(parsedBody);
}

function declaresUiExtension(parsedBody: unknown): boolean {
  if (!parsedBody || typeof parsedBody !== "object" || Array.isArray(parsedBody)) return false;
  const meta = (parsedBody as { params?: { _meta?: Record<string, unknown> } }).params?._meta;
  const capabilities = meta?.["io.modelcontextprotocol/clientCapabilities"] as
    | { extensions?: Record<string, unknown> }
    | undefined;
  return capabilities?.extensions?.[UI_EXTENSION_ID] != null;
}

export function createFastmailMcpServer(input: {
  env: Env;
  userLogin: string;
  visibleTools?: Set<string>;
  requestStateCodec: McpRequestStateCodec;
  /** Register MCP Apps resources, `ui_*` tools and tool `_meta.ui`. */
  apps: boolean;
  /** Register `ui_approve_send` and mark low-risk replies for inline approval. */
  inlineApproval?: boolean;
}): McpServer {
  const { env, userLogin, visibleTools, requestStateCodec, apps, inlineApproval = false } = input;
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
  registerAllTools(legacyShapedModernServer(server), toolContext, visibleTools, { apps, inlineApproval });
  return server;
}
