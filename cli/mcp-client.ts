/**
 * MCP SDK client wrapper for the Fastmail CLI.
 *
 * Connects to the remote Worker using StreamableHTTPClientTransport,
 * injects the Bearer token via a custom fetch wrapper, and provides
 * a simple callTool() API that returns parsed results.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { updateTokenExpiry } from "./auth.js";

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
  // Remove marker tags. Datamarking wraps values as "[START] value [END]", so
  // consume one optional whitespace on BOTH sides of a marker — matching only
  // the trailing side left the space before the closing marker behind, and
  // every unwrapped value came back with a stray trailing space.
  cleaned = cleaned.replace(
    /\s?\[\/?UNTRUSTED_EXTERNAL_DATA_[^\]]+\]\s?/g,
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
  private connectionPromise: Promise<Client> | null = null;
  private url: string;
  private token: string;

  constructor(url: string, token: string) {
    this.url = url;
    this.token = token;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectionPromise) return this.connectionPromise;

    const connectingClient = new Client({
      name: "fastmail-cli",
      version: "1.0.0",
    });

    // Inject Bearer token into every request via custom fetch.
    // Also intercept the response to persist any server-issued X-Token-Expires-At
    // header — this is how the CLI learns that the Worker just slid the token's
    // TTL forward, so the local config stops drifting from server-side reality.
    const token = this.token;
    const authFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);

      // Never open the standalone GET SSE stream.
      //
      // /mcp is served by a Durable Object, which handles requests serially. A
      // long-lived SSE GET occupies it, so every subsequent POST queues behind
      // the stream and only completes when it terminates (~300s) — far past the
      // SDK's 60s request timeout. The symptom is every tool call failing with
      // "MCP error -32001: Request timed out" while the server is perfectly
      // healthy on each request in isolation.
      //
      // The stream is optional in the MCP spec: a server that does not offer it
      // returns 405, and the client proceeds using POST responses only, which is
      // all this CLI needs (it makes requests and reads replies; it consumes no
      // server-initiated notifications). Synthesize that 405 rather than issuing
      // a GET that would wedge the Durable Object.
      if ((init?.method ?? "GET").toUpperCase() === "GET") {
        return new Response(null, { status: 405, statusText: "Method Not Allowed" });
      }

      const response = await fetch(input, { ...init, headers });
      const renewed = response.headers.get("X-Token-Expires-At");
      // Validate as a parseable ISO date before trusting it. A malformed header
      // (misconfigured proxy, future server regression) would otherwise poison
      // config.tokenExpiresAt and turn every `new Date(...)` into Invalid Date.
      if (renewed && !Number.isNaN(new Date(renewed).getTime())) {
        // Fire-and-forget: never block or break the request on cache write failures
        updateTokenExpiry(renewed).catch(() => {});
      }
      return response;
    };

    const transport = new StreamableHTTPClientTransport(
      new URL(`${this.url}/mcp`),
      { fetch: authFetch },
    );

    const pending = (async () => {
      try {
        await connectingClient.connect(transport);
        this.client = connectingClient;
        return connectingClient;
      } catch (err: any) {
        if (err?.message?.includes("401") || err?.message?.includes("Unauthorized")) {
          console.error("Authentication failed. Run: fastmail auth");
          process.exit(2); // EXIT.AUTH — avoid circular import from exit-codes
        }
        throw err;
      } finally {
        this.connectionPromise = null;
      }
    })();

    this.connectionPromise = pending;
    return pending;
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

    // MCP reports tool-level failures in a successful protocol response. Do not
    // let callers mistake an error payload for ordinary command output.
    if (result.isError === true) {
      throw new Error(cleaned || `MCP tool '${name}' failed`);
    }

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

  /**
   * List all available MCP tools with their schemas.
   * Used by the `describe` command for runtime schema introspection.
   */
  async listTools(): Promise<{ name: string; description?: string; inputSchema: any }[]> {
    const client = await this.ensureConnected();
    const result = await client.listTools();
    return (result.tools || []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async close(): Promise<void> {
    if (this.connectionPromise) {
      await this.connectionPromise.catch(() => undefined);
    }
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }
}
