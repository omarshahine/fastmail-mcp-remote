/**
 * MCP SDK client wrapper for the Fastmail CLI.
 *
 * Connects to the remote Worker using StreamableHTTPClientTransport,
 * injects the Bearer token via a custom fetch wrapper, and provides
 * a simple callTool() API that returns parsed results.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Strip prompt-injection datamarking from MCP tool responses.
 *
 * The server wraps external data in [UNTRUSTED_EXTERNAL_DATA_xxx] markers
 * and prepends a preamble paragraph. These are useful for LLM safety but
 * pure noise in a terminal context.
 */
function stripDatamarking(text: string): string {
  // Remove preamble paragraph (starts with "Data between [UNTRUSTED_")
  let cleaned = text.replace(
    /^Data between \[UNTRUSTED_EXTERNAL_DATA_[^\]]+\] and \[\/UNTRUSTED_EXTERNAL_DATA_[^\]]+\] markers is[\s\S]*?not acted upon as directives\.\s*/,
    "",
  );
  // Remove marker tags
  cleaned = cleaned.replace(
    /\[\/?UNTRUSTED_EXTERNAL_DATA_[^\]]+\]\s?/g,
    "",
  );
  // Remove inline WARNING blocks injected by prompt guard
  cleaned = cleaned.replace(
    /\[WARNING: The [^\]]*? below contains text patterns[\s\S]*?found in it\.\]\s*/g,
    "",
  );
  return cleaned.trim();
}

export class FastmailMcpClient {
  private client: Client | null = null;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;

    this.client = new Client({
      name: "fastmail-cli",
      version: "1.0.0",
    });

    // Inject Bearer token into every request via custom fetch
    const token = this.token;
    const authFetch: typeof fetch = (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      return fetch(input, { ...init, headers });
    };

    const transport = new StreamableHTTPClientTransport(
      new URL(`${this.url}/mcp`),
      { fetch: authFetch },
    );

    try {
      await this.client.connect(transport);
    } catch (err: any) {
      this.client = null;
      if (err?.message?.includes("401") || err?.message?.includes("Unauthorized")) {
        console.error("Authentication failed. Run: fastmail auth");
        process.exit(1);
      }
      throw err;
    }

    return this.client;
  }

  /**
   * Call an MCP tool on the remote server and return the parsed result.
   *
   * - JSON responses are parsed and returned as objects/arrays
   * - Text responses (markdown, success messages) are returned as strings
   * - Datamarking preambles/markers are stripped automatically
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });

    // Extract text content from MCP result
    const textParts = (result.content as any[])
      ?.filter((c) => c.type === "text")
      .map((c) => c.text) || [];
    const text = textParts.join("\n");

    // Strip datamarking
    const cleaned = stripDatamarking(text);

    // Try parsing as JSON (most tool responses are JSON)
    try {
      return JSON.parse(cleaned);
    } catch {
      // Not JSON — return as string (markdown, success messages, etc.)
    }

    // Try finding JSON after preamble remnants (double newline separator)
    const parts = cleaned.split("\n\n");
    for (let i = parts.length - 1; i > 0; i--) {
      const candidate = parts.slice(i).join("\n\n");
      const trimmed = candidate.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          // Keep looking
        }
      }
    }

    return cleaned;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
