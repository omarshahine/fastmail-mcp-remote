import { Client as ClientV2, StreamableHTTPClientTransport as TransportV2 } from '@modelcontextprotocol/client';
import { Client as ClientV1 } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as TransportV1 } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { SEND_REVIEW_URI, UI_MIME_TYPE } from '../src/apps/constants';

const serverUrl = process.env.FASTMAIL_MCP_TEST_URL;
const accessToken = process.env.FASTMAIL_MCP_TEST_TOKEN;
const hasLiveCredentials = Boolean(serverUrl && accessToken);

function endpoint(path: '/mcp' | '/mcp/code'): URL {
	const url = new URL(serverUrl!);
	url.pathname = path;
	return url;
}

const bearerFetch: typeof fetch = (input, init) => {
	const headers = new Headers(init?.headers);
	headers.set('Authorization', `Bearer ${accessToken}`);
	return fetch(input, { ...init, headers });
};

const negotiationModes = [
	{ label: 'legacy', versionNegotiation: { mode: 'legacy' }, version: /^2025-/ },
	{ label: 'auto', versionNegotiation: { mode: 'auto' }, version: /^2026-07-28$/ },
	{ label: 'pin 2026-07-28', versionNegotiation: { mode: { pin: '2026-07-28' } }, version: /^2026-07-28$/ },
] as const;

describe.skipIf(!hasLiveCredentials)('live MCP client compatibility matrix', () => {
	describe.each(negotiationModes)('/mcp with $label negotiation', ({ versionNegotiation, version }) => {
		async function withClient<T>(run: (client: ClientV2) => Promise<T>): Promise<T> {
			const client = new ClientV2(
				{ name: 'mcp-compat-test', version: '1.0.0' },
				{
					versionNegotiation,
					// The server gates MCP Apps on this extension for 2026-07-28 requests.
					capabilities: { extensions: { 'io.modelcontextprotocol/ui': {} } },
				},
			);
			const transport = new TransportV2(endpoint('/mcp'), { fetch: bearerFetch });
			await client.connect(transport);
			try {
				expect(client.getNegotiatedProtocolVersion()).toMatch(version);
				return await run(client);
			} finally {
				await client.close();
			}
		}

		it('lists tools with read-only annotations', async () => {
			await withClient(async (client) => {
				const { tools } = await client.listTools();
				const tool = tools.find((t) => t.name === 'list_mailboxes');
				expect(tool).toBeDefined();
				expect(tool!.annotations?.readOnlyHint).toBe(true);
			});
		}, 30_000);

		it('serves the send review MCP App resource', async () => {
			await withClient(async (client) => {
				const result = await client.readResource({ uri: SEND_REVIEW_URI });
				expect(result.contents[0].mimeType).toBe(UI_MIME_TYPE);
			});
		}, 30_000);
	});

	describe('/mcp/code', () => {
		it('lists search and execute for a v1 SDK client', async () => {
			const client = new ClientV1({ name: 'mcp-compat-test-v1', version: '1.0.0' });
			const transport = new TransportV1(endpoint('/mcp/code'), {
				requestInit: { headers: { Authorization: `Bearer ${accessToken}` } },
			});
			await client.connect(transport);
			try {
				const { tools } = await client.listTools();
				const names = tools.map((t) => t.name);
				expect(names).toContain('search');
				expect(names).toContain('execute');
			} finally {
				await client.close();
			}
		}, 30_000);

		it('answers server/discover with a JSON-RPC error so 2026 clients fall back', async () => {
			const response = await fetch(endpoint('/mcp/code'), {
				method: 'POST',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'Content-Type': 'application/json',
					Accept: 'application/json, text/event-stream',
				},
				body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover' }),
			});
			expect(response.status).toBeLessThan(500);
			const text = await response.text();
			expect(text).toContain('"error"');
		}, 30_000);
	});
});
