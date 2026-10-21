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
} as unknown as Env;
const executionCtx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

describe('/mcp transport routing', () => {
	beforeEach(() => {
		durableFetch.mockClear();
		vi.mocked(validateAccessToken).mockClear();
	});

	it('rejects standalone GET with 405 and never touches the Durable Object', async () => {
		const getResponse = await app.request(
			new Request('https://worker.example/mcp', {
				method: 'GET',
				headers: { Authorization: 'Bearer test-token', 'Mcp-Session-Id': 'held-stream-session' },
			}),
			undefined,
			env,
			executionCtx,
		);

		expect(getResponse.status).toBe(405);
		expect(getResponse.headers.get('Allow')).toBe('POST');
		expect(durableFetch).not.toHaveBeenCalled();
	});

	it('Bearer-validates POST /mcp before serving it statelessly', async () => {
		const postResponse = await app.request(
			new Request('https://worker.example/mcp', {
				method: 'POST',
				headers: {
					Authorization: 'Bearer test-token',
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
			}),
			undefined,
			env,
			executionCtx,
		);

		expect(postResponse.status).toBe(200);
		expect(validateAccessToken).toHaveBeenCalledWith(
			undefined,
			'test-token',
			'user@example.com',
			expect.any(Function),
		);
		expect(durableFetch).not.toHaveBeenCalled();
	});

	it('does not advertise or serve the removed legacy /sse transport', async () => {
		const root = await app.request('https://worker.example/', undefined, env, executionCtx);
		const metadata = await root.json() as any;
		expect(metadata.endpoints.mcp).toBe('/mcp');
		expect(JSON.stringify(metadata.endpoints)).not.toContain('/sse');

		const response = await app.request('https://worker.example/sse', undefined, env, executionCtx);
		expect(response.status).toBe(404);
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


const modernMeta = {
	'io.modelcontextprotocol/protocolVersion': '2026-07-28',
	'io.modelcontextprotocol/clientInfo': { name: 'test-client', version: '1.0.0' },
	'io.modelcontextprotocol/clientCapabilities': { elicitation: { url: {} } },
};

function mcpPost(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return app.request(
		new Request('https://worker.example/mcp', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-token',
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...headers,
			},
			body: JSON.stringify(body),
		}),
		undefined,
		env,
		executionCtx,
	) as Promise<Response>;
}

/** Read a JSON-RPC message from either a JSON or a single-event SSE response. */
async function readJsonRpc(response: Response): Promise<any> {
	const text = await response.text();
	if (!(response.headers.get('content-type') ?? '').includes('text/event-stream')) {
		return JSON.parse(text);
	}
	const data = text.split('\n').find((line) => line.startsWith('data:'));
	if (!data) throw new Error(`No SSE data line in: ${text}`);
	return JSON.parse(data.slice('data:'.length).trim());
}

describe('/mcp single stateless v2 server', () => {
	beforeEach(() => {
		durableFetch.mockClear();
	});

	it.each(['2025-03-26', '2025-06-18', '2025-11-25'])(
		'legacy initialize is served statelessly for %s',
		async (protocolVersion) => {
			const response = await mcpPost({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion,
					capabilities: {},
					clientInfo: { name: 'legacy-client', version: '1.0.0' },
				},
			});

			expect(response.status).toBe(200);
			expect(response.headers.get('Mcp-Session-Id')).toBeNull();
			const body = await readJsonRpc(response);
			expect(body.result.protocolVersion).toBe(protocolVersion);
			expect(durableFetch).not.toHaveBeenCalled();
		},
	);

	it('legacy tools/list with a stale Mcp-Session-Id still succeeds', async () => {
		const response = await mcpPost(
			{ jsonrpc: '2.0', id: 2, method: 'tools/list' },
			{ 'Mcp-Session-Id': '0f0e0d0c0b0a09080706050403020100' },
		);

		expect(response.status).toBe(200);
		const body = await readJsonRpc(response);
		expect(body.result.tools.map((tool: any) => tool.name)).toContain('list_mailboxes');
		expect(durableFetch).not.toHaveBeenCalled();
	});

	it('server/discover advertises 2026-07-28', async () => {
		const response = await mcpPost(
			{ jsonrpc: '2.0', id: 4, method: 'server/discover', params: { _meta: modernMeta } },
			{ 'Mcp-Method': 'server/discover', 'Mcp-Protocol-Version': '2026-07-28' },
		);

		expect(response.status).toBe(200);
		const body = await readJsonRpc(response);
		expect(body.result.supportedVersions).toContain('2026-07-28');
	});

	it('modern tools/call with mismatched Mcp-Name is rejected', async () => {
		const response = await mcpPost(
			{
				jsonrpc: '2.0',
				id: 5,
				method: 'tools/call',
				params: { name: 'list_mailboxes', arguments: {}, _meta: modernMeta },
			},
			{
				'Mcp-Method': 'tools/call',
				'Mcp-Name': 'get_email',
				'Mcp-Protocol-Version': '2026-07-28',
			},
		);

		expect(response.status).toBe(400);
		const body = await readJsonRpc(response);
		expect(body.error.code).toBe(-32020);
	});
});

describe('OAuth discovery routes', () => {
	it.each([
		'/.well-known/oauth-protected-resource',
		'/.well-known/oauth-protected-resource/mcp',
		'/.well-known/oauth-protected-resource/mcp/code',
	])('serves public protected-resource metadata at %s', async (path) => {
		const response = await app.request(`https://worker.example${path}`, undefined, {} as Env, executionCtx);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
		expect(await response.json()).toEqual({
			resource: 'https://worker.example/mcp',
			authorization_servers: ['https://worker.example'],
			scopes_supported: ['mcp:write'],
			bearer_methods_supported: ['header'],
			resource_name: 'Fastmail MCP',
			resource_documentation: 'https://worker.example',
			logo_uri: 'https://worker.example/favicon.png',
		});
	});

	it('serves public authorization-server metadata', async () => {
		const response = await app.request(
			'https://worker.example/.well-known/oauth-authorization-server', undefined, {} as Env, executionCtx,
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('Content-Type')).toContain('application/json');
		expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600');
		expect(await response.json()).toEqual({
			issuer: 'https://worker.example',
			authorization_endpoint: 'https://worker.example/mcp/authorize',
			token_endpoint: 'https://worker.example/mcp/token',
			registration_endpoint: 'https://worker.example/register',
			scopes_supported: ['mcp:write'],
			response_types_supported: ['code'],
			response_modes_supported: ['query'],
			grant_types_supported: ['authorization_code', 'refresh_token'],
			token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
			code_challenge_methods_supported: ['S256'],
			service_documentation: 'https://worker.example',
			logo_uri: 'https://worker.example/favicon.png',
		});
	});
});
