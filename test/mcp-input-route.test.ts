import { afterEach, describe, expect, it, vi } from 'vitest';

// Exercise the real Code Mode adapter/host bridge; replace only the Workers
// sandbox with a deterministic executor that generates arguments in memory.
const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@cloudflare/codemode', () => ({
  DynamicWorkerExecutor: class { execute = execute; },
}));
vi.mock('../src/oauth-utils', async (original) => ({
  ...await original<typeof import('../src/oauth-utils')>(),
  validateAccessToken: vi.fn(async () => ({
    user_id: 'test-user', user_login: 'user@example.com', expiresAt: '2099-01-01T00:00:00Z',
  })),
}));
vi.mock('../src/permissions', async (original) => ({
  ...await original<typeof import('../src/permissions')>(),
  getPermissionsConfig: vi.fn(async () => ({ users: {}, default_role: 'admin', default_disabled_categories: [] })),
  getUserConfig: vi.fn(() => ({ role: 'admin', disabled_categories: [] })),
  getVisibleTools: vi.fn(() => new Set(['bulk_mark_read', 'create_draft'])),
}));

import app from '../src/index';
import { validateAccessToken } from '../src/oauth-utils';
import { JmapClient } from '../src/jmap-client';
import { MAX_MCP_BODY_BYTES, MAX_TOOL_INPUT_ELEMENTS } from '../src/mcp-input';

const env = { ACTION_SIGNING_KEY: '0123456789abcdef'.repeat(4), ALLOWED_USERS: 'user@example.com' } as unknown as Env;
const executionCtx = { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
const variants = ['legacy', 'modern', 'code'] as const;
type Variant = typeof variants[number];
function post(variant: Variant, body: string | ReadableStream<Uint8Array>, extraHeaders: Record<string, string> = {}) {
  return app.request(new Request(`https://worker.example/mcp${variant === 'code' ? '/code' : ''}`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token', 'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(variant === 'modern' ? { 'Mcp-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'bulk_mark_read' } : {}),
      ...extraHeaders,
    }, body, duplex: 'half',
  } as RequestInit), undefined, env, executionCtx);
}
function call(variant: Variant, args: unknown, name = 'bulk_mark_read') {
  return JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
    name: variant === 'code' ? 'execute' : name,
    arguments: variant === 'code' ? { code: 'async () => codemode.request({method:"POST",path:"/tools/bulk_mark_read"})' } : args,
    ...(variant === 'modern' ? { _meta: {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'limits-test', version: '1' },
      'io.modelcontextprotocol/clientCapabilities': {},
    } } : {}),
  } });
}
async function rpc(response: Response) {
  const text = await response.text();
  const line = text.split('\n').find((line) => line.startsWith('data:'));
  return JSON.parse(line ? line.slice(5) : text);
}
function generatedRequest(body: unknown, path = '/tools/bulk_mark_read') {
  execute.mockImplementation(async (_code, bindings) => ({ result: await bindings[0].fns.request({ method: 'POST', path, body }) }));
}
afterEach(() => { vi.restoreAllMocks(); execute.mockReset(); });

describe.each(variants)('%s input limits', (variant) => {
  it('authenticates before reading even an oversized request', async () => {
    const response = await post(variant, '{', { Authorization: '', 'Content-Length': String(MAX_MCP_BODY_BYTES + 1) });
    expect(response.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects an expired token before body parsing', async () => {
    vi.mocked(validateAccessToken).mockResolvedValueOnce(null);
    expect((await post(variant, '{')).status).toBe(401);
  });

  it('rejects declared oversized bodies before SDK validation', async () => {
    expect((await post(variant, '{', { 'Content-Length': String(MAX_MCP_BODY_BYTES + 1) })).status).toBe(413);
    expect(execute).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with a parse error', async () => {
    const response = await post(variant, '{');
    expect(response.status).toBe(400);
    expect((await rpc(response)).error.code).toBe(-32700);
  });

  it.each(['text/plain', 'application/json-evil', 'application/problem+json'])('preserves 415 for %s before parsing', async (type) => {
    expect((await post(variant, '{', { 'Content-Type': type })).status).toBe(415);
  });

  it('bounds chunked bodies even when Content-Length understates their size', async () => {
    let emitted = 0;
    const cancelled = vi.fn();
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const body = new ReadableStream({
      pull(controller) { emitted++; controller.enqueue(chunk); },
      cancel: cancelled,
    });
    expect((await post(variant, body, { 'Content-Length': '1' })).status).toBe(413);
    expect(cancelled).toHaveBeenCalledOnce();
    expect(emitted).toBeLessThanOrEqual(38);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['flat', 'nested'])('rejects excessive %s invalid arrays before tool schema validation', async (shape) => {
    const invalid = Array(MAX_TOOL_INPUT_ELEMENTS).fill(null);
    const args = { emailIds: shape === 'nested' ? [invalid] : invalid };
    generatedRequest(args);
    const mark = vi.spyOn(JmapClient.prototype, 'bulkMarkRead');
    const result = await rpc(await post(variant, call(variant, args)));
    expect(JSON.stringify(result)).toContain(`maximum of ${MAX_TOOL_INPUT_ELEMENTS} elements`);
    expect(JSON.stringify(result)).not.toContain('expected string');
    expect(mark).not.toHaveBeenCalled();
    if (variant === 'code') expect(execute).toHaveBeenCalledOnce();
  });

  it('accepts the element boundary for a legitimate bulk operation', async () => {
    const args = { emailIds: Array(MAX_TOOL_INPUT_ELEMENTS - 1).fill('email-id') };
    generatedRequest(args);
    const mark = vi.spyOn(JmapClient.prototype, 'bulkMarkRead').mockResolvedValue(undefined);
    const result = await rpc(await post(variant, call(variant, args)));
    expect(result.error).toBeUndefined();
    expect(mark).toHaveBeenCalledWith(args.emailIds, true);
  });

  it('preserves a supported 25 MiB attachment without the SDK default 4 MiB cap', async () => {
    const content = 'A'.repeat(4 * Math.ceil(25 * 1024 * 1024 / 3) - 2) + '==';
    const args = { to: ['recipient@example.com'], subject: 'Attachment', textBody: 'Body',
      attachments: [{ filename: 'file.bin', mimeType: 'application/octet-stream', content }] };
    generatedRequest(args, '/tools/create_draft');
    const draft = vi.spyOn(JmapClient.prototype, 'createDraft').mockResolvedValue('draft-id');
    // Code Mode carries the attachment in its source string, as real clients do.
    const body = variant === 'code'
      ? JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
        name: 'execute', arguments: { code: `async () => codemode.request(${JSON.stringify({ method: 'POST', path: '/tools/create_draft', body: args })})` },
      } })
      : call(variant, args, 'create_draft');
    const response = await post(variant, body, variant === 'modern' ? { 'Mcp-Name': 'create_draft' } : {});
    const result = await rpc(response);
    expect(response.status, JSON.stringify(result)).toBe(200);
    expect(result.error).toBeUndefined();
    expect(draft).toHaveBeenCalledOnce();
    expect(draft.mock.calls[0][0].attachments?.[0].content).toBe(content);
  });
});
