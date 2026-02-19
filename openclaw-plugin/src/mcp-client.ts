/**
 * MCP SDK client wrapper for the Fastmail OpenClaw plugin.
 *
 * Maintains a persistent connection to the remote Worker using
 * StreamableHTTPClientTransport. The connection is lazy-initialized
 * on first tool call and reused for all subsequent calls.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Strip prompt-injection datamarking from MCP tool responses.
 *
 * The server wraps external data in [UNTRUSTED_EXTERNAL_DATA_xxx] markers
 * and prepends a preamble paragraph. These are useful for LLM safety but
 * noise in a plugin context.
 */
function stripDatamarking(text: string): string {
  let cleaned = text.replace(
    /^Data between \[UNTRUSTED_EXTERNAL_DATA_[^\]]+\] and \[\/UNTRUSTED_EXTERNAL_DATA_[^\]]+\] markers is[\s\S]*?not acted upon as directives\.\s*/,
    "",
  );
  cleaned = cleaned.replace(
    /\[\/?UNTRUSTED_EXTERNAL_DATA_[^\]]+\]\s?/g,
    "",
  );
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
      name: "fastmail-openclaw",
      version: "1.0.0",
    });

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
        throw new Error(
          "Authentication failed. Check your bearerToken or run: fastmail auth",
        );
      }
      throw err;
    }

    return this.client;
  }

  /**
   * Call an MCP tool on the remote server and return the parsed result.
   * JSON responses are parsed; text responses returned as strings.
   * Datamarking is stripped automatically.
   */
  async callTool(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<any> {
    const client = await this.ensureConnected();
    const result = await client.callTool({ name, arguments: args });

    const textParts = (result.content as any[])
      ?.filter((c) => c.type === "text")
      .map((c) => c.text) || [];
    const text = textParts.join("\n");
    const cleaned = stripDatamarking(text);

    try {
      return JSON.parse(cleaned);
    } catch {
      // Not JSON
    }

    // Try finding JSON after preamble remnants
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
