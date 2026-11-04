import { isJsonContentType } from "@modelcontextprotocol/sdk/shared/mediaType.js";

/**
 * Aggregate JSON request budget: a supported 25 MiB upload expands to about
 * 33.34 MiB in base64, leaving over 2 MiB for the JSON envelope and message.
 * Multiple attachments share this budget. Strings do not consume the SDK's
 * element budget; 10,000 elements still permit large bulk operations.
 */
export const MAX_MCP_BODY_BYTES = 36 * 1024 * 1024;
export const MAX_TOOL_INPUT_ELEMENTS = 10_000;

function inputError(status: 400 | 413 | 415, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", error: { code, message }, id: null }, { status });
}

/** Consume once, counting actual bytes before decoding or JSON/SDK validation. */
export async function readMcpBody(request: Request): Promise<{ parsedBody: unknown } | { response: Response }> {
  if (!isJsonContentType(request.headers.get("Content-Type"))) {
    return { response: inputError(415, -32000, "Unsupported Media Type: Content-Type must be application/json") };
  }
  const declaredLength = Number(request.headers.get("Content-Length"));
  const tooLarge = () => inputError(413, -32600, "MCP request body exceeds the 36 MiB limit");
  if (declaredLength > MAX_MCP_BODY_BYTES) {
    void request.body?.cancel().catch(() => {});
    return { response: tooLarge() };
  }

  const reader = request.body?.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_MCP_BODY_BYTES) {
          // Do not await cancellation of an untrusted producer.
          void reader.cancel().catch(() => {});
          return { response: tooLarge() };
        }
        text += decoder.decode(value, { stream: true });
      }
    }
    text += decoder.decode();
    return { parsedBody: JSON.parse(text) as unknown };
  } catch {
    return { response: inputError(400, -32700, "Parse error: invalid JSON request body") };
  } finally {
    reader?.releaseLock();
  }
}
