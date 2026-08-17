import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

const serverUrl = process.env.FASTMAIL_MCP_TEST_URL;
const accessToken = process.env.FASTMAIL_MCP_TEST_TOKEN;
const hasLiveCredentials = Boolean(serverUrl && accessToken);

function mcpEndpoint(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (url.pathname === '/' || url.pathname === '') url.pathname = '/mcp';
	return url;
}

function rejectAfter(milliseconds: number): Promise<never> {
	return new Promise((_, reject) => {
		setTimeout(
			() => reject(new Error(`tools/list did not complete within ${milliseconds}ms`)),
			milliseconds,
		);
	});
}

describe.skipIf(!hasLiveCredentials)('live /mcp standalone stream concurrency', () => {
	it(
		'does not let the standalone GET stream block a POST on the same session',
		async () => {
			const client = new Client({ name: 'mcp-stream-concurrency-test', version: '1.0.0' });
			const transport = new StreamableHTTPClientTransport(mcpEndpoint(serverUrl!), {
				requestInit: {
					headers: { Authorization: `Bearer ${accessToken}` },
				},
			});

			try {
				// connect() reproduces the SDK sequence from issue #64: initialize,
				// notifications/initialized, then a held-open standalone GET stream.
				await client.connect(transport);

				const result = await Promise.race([client.listTools(), rejectAfter(5_000)]);
				expect(result.tools.length).toBeGreaterThan(0);
			} finally {
				await client.close();
			}
		},
		15_000,
	);
});
