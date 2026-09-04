import { beforeEach, describe, expect, it, vi } from 'vitest';

const { durableFetch } = vi.hoisted(() => ({
	durableFetch: vi.fn(async (request: Request) =>
		Response.json({ jsonrpc: '2.0', id: 2, result: { tools: [] } }, { status: 200 }),
	),
}));

vi.mock('agents/mcp', () => ({
	McpAgent: class {
		static serve() {
			return { fetch: durableFetch };
		}
	},
}));

// Code Mode is unrelated to this route test and imports the Workers-only
// `cloudflare:workers` module, which Node's Vitest environment cannot load.
vi.mock('@cloudflare/codemode', () => ({
	DynamicWorkerExecutor: class {},
}));
vi.mock('../src/openapi-adapter', () => ({
	buildCodeModeServer: vi.fn(),
}));

vi.mock('../src/oauth-utils', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/oauth-utils')>();
	return {
		...original,
		validateAccessToken: vi.fn(async () => ({
			user_id: 'test-user',
			user_login: 'user@example.com',
			scope: 'mcp:read',
			expiresAt: '2099-01-01T00:00:00.000Z',
		})),
	};
});

vi.mock('../src/permissions', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/permissions')>();
	return {
		...original,
		getPermissionsConfig: vi.fn(async () => ({
			users: {},
			default_role: 'admin',
			default_disabled_categories: [],
		})),
		getUserConfig: vi.fn(() => ({ role: 'admin', disabled_categories: [] })),
		getVisibleTools: vi.fn(() => new Set(['list_mailboxes'])),
	};
});

import app from '../src/index';
import { validateAccessToken } from '../src/oauth-utils';

const env = {
	ACTION_SIGNING_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
	ALLOWED_USERS: 'user@example.com',
} as Env;
const executionCtx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('/mcp transport routing', () => {
	beforeEach(() => {
		durableFetch.mockClear();
		vi.mocked(validateAccessToken).mockClear();
	});

	it('rejects standalone GET without dispatching it to the session Durable Object', async () => {
		const sessionId = 'held-stream-session';
		const headers = {
			Authorization: 'Bearer test-token',
			'Mcp-Session-Id': sessionId,
		};

		// Start the same standalone GET the SDK opens after initialization. The
		// response must settle at the Worker rather than occupying the session DO.
		const getPromise = app.request(
			new Request('https://worker.example/mcp', { method: 'GET', headers }),
			undefined,
			env,
			executionCtx,
		);
		const getResponse = await getPromise;

		expect(getResponse.status).toBe(405);
		expect(getResponse.headers.get('Allow')).toBe('POST');
		expect(durableFetch).not.toHaveBeenCalled();

		const startedAt = performance.now();
		const postResponse = await Promise.race([
			app.request(
				new Request('https://worker.example/mcp', {
					method: 'POST',
					headers: { ...headers, 'Content-Type': 'application/json' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
				}),
				undefined,
				env,
				executionCtx,
			),
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error('tools/list POST exceeded 5 seconds')), 5_000),
			),
		]);

		expect(postResponse.status).toBe(200);
		expect(performance.now() - startedAt).toBeLessThan(5_000);
		expect(durableFetch).toHaveBeenCalledTimes(1);
		expect(validateAccessToken).toHaveBeenCalledWith(
			undefined,
			'test-token',
			'user@example.com',
			expect.any(Function),
		);
		expect(durableFetch.mock.calls[0]?.[0].method).toBe('POST');
		expect(durableFetch.mock.calls[0]?.[0].headers.get('Mcp-Session-Id')).toBe(sessionId);
	});

	it('routes MCP 2026-07-28 envelope requests to the stateless v2 handler', async () => {
		const response = await app.request(
			new Request('https://worker.example/mcp', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer test-token',
					'Content-Type': 'application/json',
					'Mcp-Method': 'tools/list',
					'Mcp-Protocol-Version': '2026-07-28',
				},
				body: JSON.stringify({
					jsonrpc: '2.0',
					id: 3,
					method: 'tools/list',
					params: {
						_meta: {
							'io.modelcontextprotocol/protocolVersion': '2026-07-28',
							'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
							'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } },
						},
					},
				}),
			}),
			undefined,
			env,
			executionCtx,
		);

		const responseText = await response.text();
		expect(response.status, responseText).toBe(200);
		expect(response.headers.get('content-type')).toContain('application/json');
		const body = JSON.parse(responseText) as any;
		expect(body.result.tools.map((tool: any) => tool.name)).toEqual(['list_mailboxes']);
		expect(durableFetch).not.toHaveBeenCalled();
	});
});
