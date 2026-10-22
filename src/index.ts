import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isLegacyRequest } from "@modelcontextprotocol/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { McpAgent } from "agents/mcp";
import { createMcpHandler } from "agents/mcp/server";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { buildCodeModeServer } from "./openapi-adapter";
import { Hono, type Context } from "hono";
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
import { getPermissionsConfig, getUserConfig, getVisibleTools } from "./permissions";
import { verifyAction, nonceKey } from "./action-urls";
import { FastmailAuth } from "./fastmail-auth";
import { JmapClient } from "./jmap-client";
import { registerAllTools, buildToolContext } from "./tools";
import { clientSupportsApps, clientSupportsInlineApproval, createFastmailMcpServer, createMcpRequestStateCodec } from "./mcp-server";
import {
  handleSendApprovalCallback,
  handleSendApprovalDecision,
  handleSendApprovalStart,
} from "./send-approval-auth";
import { SendApprovalStore } from "./send-approval";
import { OAuthCodeStore } from "./oauth-code-store";

export { OAuthCodeStore, SendApprovalStore };

/**
 * Props passed into the Durable Object per session, set from the validated
 * Bearer token at the Hono layer (see handleMcp()). The agents
 * runtime persists these to DO storage on session init and hands them to
 * onStart(props) -> this.props before init() runs, so init() can register a
 * permission-filtered, user-scoped tool set. The session is bound to whoever
 * initialized it; every subsequent request on that session id is still Bearer-
 * validated at the edge before the runtime routes it here.
 */
interface McpSessionProps extends Record<string, unknown> {
  /** Authenticated user login (email) that owns this session. */
  userLogin: string;
  /** Tool names this user may see, precomputed from the permissions config. */
  visibleTools: string[];
}

export class FastmailMCP extends McpAgent<Env, Record<string, never>, McpSessionProps> {
  server = new McpServer({
    name: "Fastmail MCP Remote",
    version: "1.0.0",
  });

  /**
   * Register the user-scoped, permission-filtered tool set for this session.
   *
   * Runs once per session, after the runtime has populated this.props from the
   * session's persisted props (onStart -> updateProps -> init). Uses the SAME
   * buildToolContext + registerAllTools path as the stateless /mcp/code handler,
   * so the DO and stateless surfaces expose identical tools and identical inner
   * permission checks — the only difference is the transport.
   */
  async init() {
    const props = this.props;
    if (!props?.userLogin) {
      // No identity means the session was created without going through the
      // Bearer-validating edge handler. Register nothing rather than exposing
      // an unscoped tool set.
      console.error("[mcp] init() with no props.userLogin — registering no tools");
      return;
    }

    const ctx = buildToolContext(this.env, props.userLogin);
    const visibleTools = props.visibleTools ? new Set(props.visibleTools) : undefined;
    registerAllTools(this.server, ctx, visibleTools);
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
      scopes_supported: ["mcp:write"],
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
  const url = new URL(c.req.url);
  const state = url.searchParams.get("state");
  if (state && await c.env.OAUTH_KV.get(`send-approval-auth:${state}`)) {
    return handleSendApprovalCallback(c.env, url);
  }
  return handleCallback(c.req.raw, c.env, new URL(c.req.url));
});

app.post("/mcp/token", async (c) => {
  // waitUntil keeps the best-effort client-registration TTL slide off the
  // response path — the tokens themselves are already durably stored.
  return handleToken(c.req.raw, c.env, (work) => c.executionCtx.waitUntil(work));
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

// Authenticated, short-lived review flow for server-enforced outbound approval.
app.get("/approve/send/:approvalId", (c) => {
  return handleSendApprovalStart(c.env, new URL(c.req.url));
});

app.post("/approve/send/:approvalId", (c) => {
  return handleSendApprovalDecision(c.env, c.req.raw, c.req.param("approvalId"));
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
// Exposes `search` for progressive OpenAPI discovery and `execute` for running
// JavaScript that chains Fastmail operations in an isolated Dynamic Worker.
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
  const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token, c.env.ALLOWED_USERS || "", (work) =>
    c.executionCtx.waitUntil(work),
  );
  if (!tokenInfo) {
    return unauthorizedResponse(c, "invalid_token", "Invalid or expired access token");
  }

  // Build a fresh McpServer with permission-filtered tools
  const config = await getPermissionsConfig(c.env.OAUTH_KV);
  const userConfig = getUserConfig(config, tokenInfo.user_login);
  const visibleTools = getVisibleTools(userConfig);

  const upstreamServer = new McpServer({ name: "Fastmail MCP", version: "1.0.0" });
  const ctx = buildToolContext(c.env, tokenInfo.user_login, undefined, true);
  registerAllTools(upstreamServer, ctx, visibleTools);

  // Wrap with search+execute Code Mode: ~1,000 tokens instead of every operation schema
  const executor = new DynamicWorkerExecutor({ loader: c.env.LOADER, globalOutbound: null });
  const codeServer = await buildCodeModeServer(upstreamServer, executor);

  // Serve via stateless WebStandard streamable HTTP transport
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await codeServer.connect(transport);
  const response = await transport.handleRequest(c.req.raw);
  return withTokenExpiresAt(response, tokenInfo.expiresAt);
});

// ─── /mcp — Main MCP endpoint, served by one stateless SDK v2 server ────────
//
// Every POST/DELETE is Bearer-validated here, then handed to the agents
// stateless handler, which builds a fresh v2 McpServer per request via
// createFastmailMcpServer(). 2026-07-28 requests are served natively;
// 2025-era requests (any protocolVersion, with or without a leftover
// Mcp-Session-Id) go through the agents stateless legacy lane, which blocks
// server-to-client requests. Those clients advertise no URL elicitation, so
// send approval falls back to the approval URL in the tool result text. The
// FastmailMCP Durable Object above stays exported for its binding but is no
// longer routed.

/**
 * Validate the Bearer token, compute the user's visible tools, and serve the
 * request from the stateless v2 server. Shared by POST/DELETE /mcp.
 */
async function handleMcp(c: Context<{ Bindings: Env }>): Promise<Response> {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return unauthorizedResponse(c, "unauthorized", "Missing or invalid Authorization header");
  }

  const token = authHeader.substring(7);
  const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token, c.env.ALLOWED_USERS || "", (work) =>
    c.executionCtx.waitUntil(work),
  );
  if (!tokenInfo) {
    return unauthorizedResponse(c, "invalid_token", "Invalid or expired access token");
  }

  // The permission-filtered tool set decides what is registered; the user
  // identity also drives the inner defense-in-depth checks in buildToolContext.
  const config = await getPermissionsConfig(c.env.OAUTH_KV);
  const userConfig = getUserConfig(config, tokenInfo.user_login);
  const visibleTools = getVisibleTools(userConfig);

  // Era telemetry for the Durable Object retirement soak (Task 8), and the
  // per-request MCP Apps decision. Reads a clone; the parse is reused below.
  // `method` is the JSON-RPC method when the body has one, else the HTTP
  // method (DELETE).
  const parsedBody: unknown = c.req.method === "POST"
    ? await c.req.raw.clone().json().catch(() => undefined)
    : undefined;
  const isLegacy = await isLegacyRequest(c.req.raw.clone(), parsedBody);
  const rpcMethod = parsedBody && typeof parsedBody === "object" && !Array.isArray(parsedBody)
    ? (parsedBody as { method?: unknown }).method
    : undefined;
  console.log(JSON.stringify({
    mcpEra: isLegacy ? "legacy" : "modern",
    method: typeof rpcMethod === "string" ? rpcMethod : c.req.method,
  }));

  const requestStateCodec = createMcpRequestStateCodec(c.env, tokenInfo.user_login);
  const apps = clientSupportsApps(parsedBody, isLegacy);
  const inlineApproval = clientSupportsInlineApproval(parsedBody, isLegacy);
  const handler = createMcpHandler(() => createFastmailMcpServer({
    env: c.env,
    userLogin: tokenInfo.user_login,
    visibleTools,
    requestStateCodec,
    apps,
    inlineApproval,
  }), {
    route: "/mcp",
    legacy: "stateless",
    // Browser-hosted clients (claude.ai) send an Origin the agents default
    // allowlist rejects with 403. Every request was Bearer-validated above,
    // so an Origin check adds no protection here.
    allowedOriginHostnames: "*",
  });
  // Hand the body parsed above to the SDK so it does not parse it again.
  const response = await handler.fetch(c.req.raw, {
    parsedBody,
    authInfo: {
      token,
      clientId: tokenInfo.user_id,
      scopes: ["mcp:read", "mcp:write"],
      expiresAt: Math.floor(Date.parse(tokenInfo.expiresAt) / 1000),
    },
  });
  return withTokenExpiresAt(response, tokenInfo.expiresAt);
}

// The Streamable HTTP GET stream is optional. Do not route it through the
// session Durable Object: DO requests are serialized, so an idle, held-open
// stream would deadlock every subsequent POST for that session. Clients treat
// 405 as POST-only mode per the MCP transport specification.
app.get("/mcp", (c) => {
  return c.json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method Not Allowed: This server does not support GET SSE streams" },
    id: null,
  }, 405, { Allow: "POST" });
});
app.post("/mcp", (c) => handleMcp(c));
app.delete("/mcp", (c) => handleMcp(c));

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

// These endpoints carry no ambient credentials — the capability IS the signed,
// single-use URL — so CORS is not what protects them. Still, ACTION_ALLOWED_ORIGINS
// (comma-separated) narrows which browser origins may read the response. When it
// is unset we fall back to "*", which keeps the locally-opened digest page
// (file:// → "Origin: null") working.
function corsHeaders(env: Env, requestOrigin: string | null): Record<string, string> {
  const configured = (env.ACTION_ALLOWED_ORIGINS || "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  let allowOrigin = "*";
  if (configured.length > 0) {
    // Echo back only an origin we recognize; otherwise name the primary one so
    // a disallowed origin is refused by the browser rather than silently allowed.
    allowOrigin = requestOrigin && configured.includes(requestOrigin) ? requestOrigin : configured[0];
  }

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
    Vary: "Origin",
  };
}

// CORS preflight (defensive — simple POST won't trigger preflight, but browsers vary)
app.options("/api/action/:action/:emailId", (c) => {
  return new Response(null, { status: 204, headers: corsHeaders(c.env, c.req.header("Origin") ?? null) });
});

// Execute email action (archive or delete)
app.post("/api/action/:action/:emailId", async (c) => {
  const action = c.req.param("action");
  const emailId = c.req.param("emailId");
  const mid = c.req.query("mid") || "";
  const expStr = c.req.query("exp") || "0";
  const sig = c.req.query("sig") || "";
  const exp = parseInt(expStr, 10);
  const cors = corsHeaders(c.env, c.req.header("Origin") ?? null);

  // Validate action type
  if (action !== "archive" && action !== "delete") {
    return c.json({ ok: false, error: "Invalid action. Must be 'archive' or 'delete'." }, { status: 400, headers: cors });
  }

  // Archive requires a mailbox ID
  if (action === "archive" && !mid) {
    return c.json({ ok: false, error: "Archive action requires 'mid' (mailbox ID) parameter." }, { status: 400, headers: cors });
  }

  // Verify HMAC signature + expiry
  const signingKey = c.env.ACTION_SIGNING_KEY;
  if (!signingKey) {
    console.error("[action] ACTION_SIGNING_KEY not configured");
    return c.json({ ok: false, error: "Server misconfigured." }, { status: 500, headers: cors });
  }

  const valid = await verifyAction(action, emailId, mid, exp, sig, signingKey);
  if (!valid) {
    return c.json({ ok: false, error: "Invalid or expired signature." }, { status: 403, headers: cors });
  }

  // Single-use enforcement: consume the nonce (reject if already used)
  const nonce = await c.env.OAUTH_KV.get(nonceKey(sig));
  if (!nonce) {
    return c.json({ ok: false, error: "Action URL already used." }, { status: 409, headers: cors });
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

    return c.json({ ok: true, action, emailId }, { status: 200, headers: cors });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[action] Failed to ${action} email ${emailId}: ${message}`);
    return c.json({ ok: false, error: `Failed to ${action} email: ${message}` }, { status: 502, headers: cors });
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
      mcp_code: "/mcp/code (Code Mode: search and execute tools, 81% fewer tokens)",
      download: "/download/:token (temporary, single-use)",
    },
  });
});

export default app;
