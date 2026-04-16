import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpAgent } from "agents/mcp";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { buildCodeModeServer } from "./openapi-adapter";
import { Hono } from "hono";
import {
  handleOAuthDiscovery,
  handleAuthorize,
  handleCallback,
  handleToken,
  handleRegister,
  handleGetToken,
  handleGetTokenCallback,
} from "./oauth-handler";
import { validateAccessToken } from "./oauth-utils";
import { checkMcpPermissions, filterToolsListResponse, getPermissionsConfig, getUserConfig, getVisibleTools, isToolAllowed } from "./permissions";
import { verifyAction, nonceKey } from "./action-urls";
import { FastmailAuth } from "./fastmail-auth";
import { JmapClient } from "./jmap-client";
import { ContactsCalendarClient } from "./contacts-calendar";
import { registerAllTools, guardResponse, buildToolContext } from "./tools";
import type { GuardOptions, ToolResult } from "./tools";

export class FastmailMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
  server = new McpServer({
    name: "Fastmail MCP Remote",
    version: "1.0.0",
  });

  /** Current user email, set per-request via X-MCP-User header. */
  private currentUser: string | null = null;

  /**
   * Override onConnect to extract the user identity from the X-MCP-User header
   * injected by the Hono middleware. This enables defense-in-depth permission
   * checks inside individual tool handlers.
   */
  async onConnect(conn: unknown, ctx: { request: Request }) {
    this.currentUser = ctx.request.headers.get('X-MCP-User');
    // @ts-expect-error — McpAgent.onConnect has complex generics; super call is safe
    return super.onConnect(conn, ctx);
  }

  /**
   * Defense-in-depth: Check if a tool call is allowed for the current user.
   * Used inside sensitive tool handlers (send_email, reply_to_email).
   * Returns an error result if denied, or null if allowed.
   */
  private async checkToolPermission(
    toolName: string,
    args?: Record<string, unknown>,
  ): Promise<{ content: { text: string; type: "text" }[] } | null> {
    if (!this.currentUser) {
      console.error(`[permissions] INNER CHECK: No user identity for ${toolName} — denying`);
      return {
        content: [{ text: `Error: Permission denied — no user identity available.`, type: "text" }],
      };
    }

    const config = await getPermissionsConfig(this.env.OAUTH_KV);
    const userConfig = getUserConfig(config, this.currentUser);
    const result = isToolAllowed(userConfig, toolName, args);

    if (!result.allowed) {
      console.warn(`[permissions] INNER DENIED: user=${this.currentUser} tool=${toolName}`);
      return {
        content: [{ text: `Error: ${result.error}`, type: "text" }],
      };
    }
    return null;
  }

  private getJmapClient(): JmapClient {
    const auth = new FastmailAuth({
      apiToken: this.env.FASTMAIL_API_TOKEN,
    });
    return new JmapClient(auth);
  }

  private getContactsCalendarClient(): ContactsCalendarClient {
    const auth = new FastmailAuth({
      apiToken: this.env.FASTMAIL_API_TOKEN,
    });
    return new ContactsCalendarClient(auth);
  }

  /**
   * Wrap a tool response with prompt injection datamarking and optional compact formatting.
   * Delegates to the standalone guardResponse from tools.ts.
   */
  private guardResponse(
    toolName: string,
    data: unknown,
    options?: GuardOptions,
  ): ToolResult {
    return guardResponse(toolName, data, options);
  }

  async init() {
    registerAllTools(this.server, {
      env: this.env,
      getCurrentUser: () => this.currentUser,
      getJmapClient: () => this.getJmapClient(),
      getContactsCalendarClient: () => this.getContactsCalendarClient(),
      checkToolPermission: (name, args) => this.checkToolPermission(name, args),
      guardResponse: (name, data, opts) => this.guardResponse(name, data, opts),
    });
  }
}

// Create Hono app for routing
const app = new Hono<{ Bindings: Env }>();

// RFC 9728 Protected Resource Metadata - tells clients where to find auth server
// SDK's discoverMetadataWithFallback() tries path-aware first, then falls back to root
function handleProtectedResourceMetadata(c: { req: { url: string } }): Response {
  const url = new URL(c.req.url);
  return new Response(
    JSON.stringify({
      resource: `${url.origin}/mcp`,
      authorization_servers: [url.origin],
      scopes_supported: ["mcp:read", "mcp:write"],
      bearer_methods_supported: ["header"],
      resource_name: "Fastmail MCP",
      resource_documentation: url.origin,
      logo_uri: `${url.origin}/favicon.png`,
    }),
    {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
      },
    },
  );
}

app.get("/.well-known/oauth-protected-resource", (c) => handleProtectedResourceMetadata(c));
app.get("/.well-known/oauth-protected-resource/mcp", (c) => handleProtectedResourceMetadata(c));
app.get("/.well-known/oauth-protected-resource/mcp/code", (c) => handleProtectedResourceMetadata(c));

// OAuth Authorization Server Metadata
app.get("/.well-known/oauth-authorization-server", (c) => {
  return handleOAuthDiscovery(new URL(c.req.url));
});

// OAuth endpoints
app.get("/mcp/authorize", async (c) => {
  return handleAuthorize(c.req.raw, c.env, new URL(c.req.url));
});

app.get("/mcp/callback", async (c) => {
  return handleCallback(c.req.raw, c.env, new URL(c.req.url));
});

app.post("/mcp/token", async (c) => {
  return handleToken(c.req.raw, c.env);
});

app.post("/mcp/register", async (c) => {
  return handleRegister(c.req.raw, c.env);
});

// Also handle /register for MCP spec compliance
app.post("/register", async (c) => {
  return handleRegister(c.req.raw, c.env);
});

// Direct token flow for SSH/headless scenarios
// Visit /get-token in browser, authenticate, get a token to configure manually
app.get("/get-token", async (c) => {
  return handleGetToken(c.req.raw, c.env, new URL(c.req.url));
});

app.get("/get-token/callback", async (c) => {
  return handleGetTokenCallback(c.req.raw, c.env, new URL(c.req.url));
});

// Re-wrap a Response to add X-Token-Expires-At so CLI clients can track
// the server's sliding-window renewal and refresh their local cache.
function withTokenExpiresAt(response: Response, expiresAt: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Token-Expires-At", expiresAt);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Helper to create 401 response with proper WWW-Authenticate header for MCP OAuth
function unauthorizedResponse(c: { req: { url: string } }, error: string, description: string): Response {
  const url = new URL(c.req.url);
  const resourceMetadata = `${url.origin}/.well-known/oauth-protected-resource`;
  // Include error type in WWW-Authenticate for invalid tokens per RFC 6750 Section 3
  const wwwAuth =
    error === "invalid_token"
      ? `Bearer error="invalid_token", resource_metadata="${resourceMetadata}"`
      : `Bearer resource_metadata="${resourceMetadata}"`;
  return new Response(JSON.stringify({ error, error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": wwwAuth,
    },
  });
}

// ─── Code Mode endpoint ────────────────────────────────────────────────────
// Wraps all Fastmail tools into a single `code` tool. The LLM writes TypeScript
// that chains calls like `await codemode.list_emails({limit: 5})` and runs in
// an isolated Dynamic Worker sandbox. Only the final result enters the context.
app.get("/mcp/code", (c) => {
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: This server does not support GET SSE streams" },
    id: null,
  }, 405, { Allow: "POST" });
});
app.delete("/mcp/code", (c) => {
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: Stateless server has no sessions to delete" },
    id: null,
  }, 405, { Allow: "POST" });
});
app.post("/mcp/code", async (c) => {
  // Same Bearer token validation as /mcp
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorizedResponse(c, "unauthorized", "Missing or invalid Authorization header");
  }
  const token = authHeader.substring(7);
  const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token);
  if (!tokenInfo) {
    return unauthorizedResponse(c, "invalid_token", "Invalid or expired access token");
  }

  // Build a fresh McpServer with permission-filtered tools
  const config = await getPermissionsConfig(c.env.OAUTH_KV);
  const userConfig = getUserConfig(config, tokenInfo.user_login);
  const visibleTools = getVisibleTools(userConfig);

  const upstreamServer = new McpServer({ name: "Fastmail MCP", version: "1.0.0" });
  const ctx = buildToolContext(c.env, tokenInfo.user_login);
  registerAllTools(upstreamServer, ctx, visibleTools);

  // Wrap with search+execute Code Mode: ~1,000 tokens instead of full TypeScript blob
  const executor = new DynamicWorkerExecutor({ loader: c.env.LOADER, globalOutbound: null });
  const codeServer = await buildCodeModeServer(upstreamServer, executor);

  // Serve via stateless WebStandard streamable HTTP transport
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await codeServer.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return withTokenExpiresAt(response, tokenInfo.expiresAt);
});

// GET /mcp — Reject SSE stream requests (stateless transport, no session to stream to).
// Cloudflare Workers kill hung responses when no data is pushed on a fresh transport.
// Clients fall back to POST-only mode per MCP Streamable HTTP spec.
app.get("/mcp", (c) => {
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: This server does not support GET SSE streams" },
    id: null,
  }, 405, { Allow: "POST" });
});

// DELETE /mcp — No sessions to clean up in stateless mode.
app.delete("/mcp", (c) => {
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: Stateless server has no sessions to delete" },
    id: null,
  }, 405, { Allow: "POST" });
});

// POST /mcp — Main MCP endpoint (require Bearer token)
// Uses WebStandard transport directly (no Durable Object) to enable MCP elicitation
// for send confirmation dialogs.
app.post("/mcp", async (c) => {
  // Validate Bearer token
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorizedResponse(c, "unauthorized", "Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7);
  const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token);
  if (!tokenInfo) {
    return unauthorizedResponse(c, "invalid_token", "Invalid or expired access token");
  }

  // Build a fresh McpServer with permission-filtered tools
  const config = await getPermissionsConfig(c.env.OAUTH_KV);
  const userConfig = getUserConfig(config, tokenInfo.user_login);
  const visibleTools = getVisibleTools(userConfig);

  const server = new McpServer({ name: "Fastmail MCP Remote", version: "1.0.0" });
  const ctx = buildToolContext(c.env, tokenInfo.user_login);
  registerAllTools(server, ctx, visibleTools);

  // Serve via stateless WebStandard streamable HTTP transport (supports elicitation)
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return withTokenExpiresAt(response, tokenInfo.expiresAt);
});

// Attachment download proxy endpoint (no auth required - uses single-use token)
app.get("/download/:token", async (c) => {
  const token = c.req.param("token");

  // Look up token in KV
  const tokenData = (await c.env.OAUTH_KV.get(`download:${token}`, "json")) as {
    downloadUrl: string;
    filename: string;
    mimeType: string;
    size: number;
  } | null;

  if (!tokenData) {
    return c.json({ error: "Invalid or expired download token" }, 404);
  }

  // Delete token immediately (single-use)
  await c.env.OAUTH_KV.delete(`download:${token}`);

  // Fetch from Fastmail using the API token
  const response = await fetch(tokenData.downloadUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${c.env.FASTMAIL_API_TOKEN}`,
    },
  });

  if (!response.ok) {
    return c.json({ error: `Failed to fetch attachment: ${response.status}` }, 502);
  }

  // Stream the response back with proper headers
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": tokenData.mimeType,
      "Content-Disposition": `attachment; filename="${tokenData.filename}"`,
      "Content-Length": tokenData.size.toString(),
    },
  });
});

// ─── Email Action Endpoints (HMAC-signed, no OAuth) ───────────────────────
// These endpoints are called directly from the reading-digest HTML page.
// Auth is via HMAC signature in the URL — no Bearer token or CF Access needed.

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
}

// CORS preflight (defensive — simple POST won't trigger preflight, but browsers vary)
app.options("/api/action/:action/:emailId", (c) => {
  return new Response(null, { status: 204, headers: corsHeaders() });
});

// Execute email action (archive or delete)
app.post("/api/action/:action/:emailId", async (c) => {
  const action = c.req.param("action");
  const emailId = c.req.param("emailId");
  const mid = c.req.query("mid") || "";
  const expStr = c.req.query("exp") || "0";
  const sig = c.req.query("sig") || "";
  const exp = parseInt(expStr, 10);

  // Validate action type
  if (action !== "archive" && action !== "delete") {
    return c.json({ ok: false, error: "Invalid action. Must be 'archive' or 'delete'." }, { status: 400, headers: corsHeaders() });
  }

  // Archive requires a mailbox ID
  if (action === "archive" && !mid) {
    return c.json({ ok: false, error: "Archive action requires 'mid' (mailbox ID) parameter." }, { status: 400, headers: corsHeaders() });
  }

  // Verify HMAC signature + expiry
  const signingKey = c.env.ACTION_SIGNING_KEY;
  if (!signingKey) {
    console.error("[action] ACTION_SIGNING_KEY not configured");
    return c.json({ ok: false, error: "Server misconfigured." }, { status: 500, headers: corsHeaders() });
  }

  const valid = await verifyAction(action, emailId, mid, exp, sig, signingKey);
  if (!valid) {
    return c.json({ ok: false, error: "Invalid or expired signature." }, { status: 403, headers: corsHeaders() });
  }

  // Single-use enforcement: consume the nonce (reject if already used)
  const nonce = await c.env.OAUTH_KV.get(nonceKey(sig));
  if (!nonce) {
    return c.json({ ok: false, error: "Action URL already used." }, { status: 409, headers: corsHeaders() });
  }
  await c.env.OAUTH_KV.delete(nonceKey(sig));

  // Execute the action using a direct JmapClient (no Durable Object needed)
  try {
    const auth = new FastmailAuth({ apiToken: c.env.FASTMAIL_API_TOKEN });
    const client = new JmapClient(auth);

    if (action === "archive") {
      await client.moveEmail(emailId, mid);
      await client.flagEmail(emailId, false);
    } else {
      await client.deleteEmail(emailId);
    }

    return c.json({ ok: true, action, emailId }, { status: 200, headers: corsHeaders() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[action] Failed to ${action} email ${emailId}: ${message}`);
    return c.json({ ok: false, error: `Failed to ${action} email: ${message}` }, { status: 502, headers: corsHeaders() });
  }
});

// Favicon - Fastmail app icon (64x64 PNG)
import { FASTMAIL_ICON_BASE64 } from "./favicon";
app.get("/favicon.png", (c) => {
  const iconBytes = Uint8Array.from(atob(FASTMAIL_ICON_BASE64), (ch) => ch.charCodeAt(0));
  return new Response(iconBytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});
app.get("/favicon.ico", (c) => {
  const iconBytes = Uint8Array.from(atob(FASTMAIL_ICON_BASE64), (ch) => ch.charCodeAt(0));
  return new Response(iconBytes, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400",
    },
  });
});

// Root endpoint
app.get("/", (c) => {
  return c.json({
    name: "Fastmail MCP Remote",
    version: "1.0.0",
    description: "Remote MCP server for Fastmail email, contacts, and calendar access",
    oauth_discovery: "/.well-known/oauth-authorization-server",
    protected_resource_metadata: "/.well-known/oauth-protected-resource",
    endpoints: {
      mcp: "/mcp",
      mcp_code: "/mcp/code (Code Mode: single code tool, 81% fewer tokens)",
      download: "/download/:token (temporary, single-use)",
    },
  });
});

export default app;
