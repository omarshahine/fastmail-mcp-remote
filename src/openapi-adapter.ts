/**
 * OpenAPI Adapter for Fastmail MCP
 *
 * Converts registered MCP tools into an OpenAPI 3.1 spec, then uses
 * @cloudflare/codemode's openApiMcpServer() to serve them as search + execute
 * tools. This gives LLMs progressive discovery (~1,000 tokens) instead of
 * stuffing all tool TypeScript into a single description that gets truncated.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openApiMcpServer } from "@cloudflare/codemode/mcp";
import type { RequestOptions } from "@cloudflare/codemode/mcp";
import type { Executor } from "@cloudflare/codemode";

/** Derive a tag from the tool name prefix */
function deriveTag(toolName: string): string {
  const tagMap: Record<string, string> = {
    list: "email",
    get: "email",
    search: "email",
    advanced: "email",
    send: "email",
    create: "email",
    reply: "email",
    mark: "email",
    flag: "email",
    delete: "email",
    move: "email",
    bulk: "email",
    download: "email",
    generate: "email",
    check: "meta",
  };

  // Specific overrides for non-email tools
  const exactMap: Record<string, string> = {
    list_contacts: "contacts",
    get_contact: "contacts",
    search_contacts: "contacts",
    list_calendars: "calendar",
    list_calendar_events: "calendar",
    get_calendar_event: "calendar",
    create_calendar_event: "calendar",
    list_mailboxes: "email",
    list_emails: "email",
    get_email: "email",
    search_emails: "email",
    get_recent_emails: "email",
    advanced_search: "email",
    get_thread: "email",
    get_email_attachments: "email",
    download_attachment: "email",
    get_mailbox_stats: "email",
    get_account_summary: "email",
    get_inbox_updates: "email",
    list_identities: "email",
    send_email: "email",
    create_draft: "email",
    reply_to_email: "email",
    mark_email_read: "email",
    flag_email: "email",
    delete_email: "email",
    move_email: "email",
    bulk_mark_read: "email",
    bulk_move: "email",
    bulk_delete: "email",
    bulk_flag: "email",
    create_memo: "memo",
    get_memo: "memo",
    delete_memo: "memo",
    generate_email_action_urls: "email",
    check_function_availability: "meta",
  };

  return exactMap[toolName] ?? tagMap[toolName.split("_")[0]] ?? "other";
}

/**
 * Connect to an MCP server via in-memory transport, discover all tools,
 * and generate an OpenAPI 3.1 spec where each tool is a POST endpoint.
 */
async function buildSpecFromMcp(server: McpServer): Promise<{
  spec: Record<string, unknown>;
  client: Client;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: "openapi-adapter", version: "1.0.0" });
  await client.connect(clientTransport);

  const { tools } = await client.listTools();

  const paths: Record<string, unknown> = {};
  const tagSet = new Set<string>();

  for (const tool of tools) {
    const tag = deriveTag(tool.name);
    tagSet.add(tag);

    paths[`/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        tags: [tag],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: tool.inputSchema,
            },
          },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
        },
      },
    };
  }

  const spec = {
    openapi: "3.1.0",
    info: {
      title: "Fastmail API",
      version: "1.0.0",
      description:
        "Fastmail email, contacts, and calendar management via JMAP. Tags: email, contacts, calendar, memo, meta.",
    },
    tags: Array.from(tagSet)
      .sort()
      .map((name) => ({ name })),
    paths,
  };

  return { spec, client };
}

/**
 * Create a request handler that dispatches OpenAPI-style requests to MCP tool calls.
 */
function createMcpRequestHandler(client: Client): (options: RequestOptions) => Promise<unknown> {
  return async (options: RequestOptions) => {
    const { path, body } = options;

    const match = path.match(/^\/tools\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid path: ${path}. Use /tools/{tool_name}`);
    }
    const toolName = match[1];

    const result = await client.callTool({
      name: toolName,
      arguments: (body as Record<string, unknown>) ?? {},
    });

    if (result.content && Array.isArray(result.content)) {
      const textParts = result.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text);

      if (textParts.length === 1) {
        try {
          return JSON.parse(textParts[0]);
        } catch {
          return textParts[0];
        }
      }
      return textParts;
    }
    return result;
  };
}

/**
 * Build an openApiMcpServer from a registered McpServer.
 */
export async function buildCodeModeServer(
  upstreamServer: McpServer,
  executor: Executor,
): Promise<McpServer> {
  const { spec, client } = await buildSpecFromMcp(upstreamServer);
  const requestHandler = createMcpRequestHandler(client);

  return openApiMcpServer({
    spec,
    executor,
    request: requestHandler,
    name: "fastmail",
    version: "1.0.0",
    description:
      "Fastmail email, contacts, and calendar API. Use search to discover endpoints by tag (email, contacts, calendar, memo, meta), then execute to call them.",
  });
}
