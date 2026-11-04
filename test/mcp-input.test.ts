import { describe, expect, it, vi } from 'vitest';
import { MAX_MCP_BODY_BYTES, readMcpBody } from '../src/mcp-input';

function streamed(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  return new Request('https://worker.example/mcp', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: new ReadableStream({
      pull(controller) {
        const chunk = chunks.shift();
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
    }),
    duplex: 'half',
  } as RequestInit);
}

describe('MCP streaming JSON budget', () => {
  it('accepts exactly the aggregate byte limit', async () => {
    const result = await readMcpBody(streamed([
      new TextEncoder().encode('"'), new Uint8Array(MAX_MCP_BODY_BYTES - 2).fill(97),
      new TextEncoder().encode('"'),
    ]));
    expect('parsedBody' in result && (result.parsedBody as string).length).toBe(MAX_MCP_BODY_BYTES - 2);
  });

  it('rejects an oversized Content-Length without reading or parsing', async () => {
    const read = vi.fn();
    const request = new Request('https://worker.example/mcp', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(MAX_MCP_BODY_BYTES + 1) }, body: '{}',
    });
    vi.spyOn(request.body!, 'getReader').mockImplementation(read);
    const result = await readMcpBody(request);
    expect('response' in result && result.response.status).toBe(413);
    expect(read).not.toHaveBeenCalled();
  });

  it.each<Record<string, string>>([{}, { 'Content-Length': '1' }])('counts streamed bytes regardless of headers %j', async (headers) => {
    const parse = vi.spyOn(JSON, 'parse');
    const result = await readMcpBody(streamed([
      new Uint8Array(MAX_MCP_BODY_BYTES).fill(32), new Uint8Array([32]),
    ], headers));
    expect('response' in result && result.response.status).toBe(413);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
  });

  it('counts UTF-8 bytes and decodes characters split across chunks', async () => {
    const bytes = new TextEncoder().encode('{"text":"📬"}');
    expect(await readMcpBody(streamed([bytes.slice(0, 11), bytes.slice(11)]))).toEqual({ parsedBody: { text: '📬' } });
  });

  it.each(['{', '', 'undefined'])('returns a JSON-RPC parse error for malformed JSON %j', async (body) => {
    const result = await readMcpBody(new Request('https://worker.example/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }));
    expect('response' in result && result.response.status).toBe(400);
    if ('response' in result) expect((await result.response.json() as any).error.code).toBe(-32700);
  });
});
