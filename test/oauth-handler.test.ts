import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGetTokenCallback } from '../src/oauth-handler';

const TEAM_NAME = 'example-team';
const CLIENT_ID = 'access-client-id';

function base64UrlJson(value: unknown): string {
	const base64 = Buffer.from(JSON.stringify(value)).toString('base64');
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unsignedIdToken(): string {
	const issuer = `https://${TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
	return `${base64UrlJson({ alg: 'none', typ: 'JWT' })}.${base64UrlJson({
		iss: issuer,
		aud: CLIENT_ID,
		exp: Math.floor(Date.now() / 1000) + 300,
		sub: 'forged-subject',
		email: 'allowed@example.com',
	})}.unsigned`;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('handleGetTokenCallback', () => {
	it('rejects forged Access ID tokens before issuing MCP access tokens', async () => {
		const kv = {
			get: vi.fn(async () => JSON.stringify({ team_name: TEAM_NAME })),
			delete: vi.fn(async () => undefined),
			put: vi.fn(async () => undefined),
		};
		const env = {
			OAUTH_KV: kv,
			ACCESS_TEAM_NAME: TEAM_NAME,
			ACCESS_CLIENT_ID: CLIENT_ID,
			ACCESS_CLIENT_SECRET: 'client-secret',
			ALLOWED_USERS: 'allowed@example.com',
		} as unknown as Env;

		vi.stubGlobal(
			'fetch',
			vi.fn(async () => Response.json({ id_token: unsignedIdToken() }))
		);

		const response = await handleGetTokenCallback(
			new Request('https://worker.example/get-token/callback?code=abc&state=state-123'),
			env,
			new URL('https://worker.example/get-token/callback?code=abc&state=state-123')
		);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('unsupported alg');
		expect(kv.put).not.toHaveBeenCalled();
	});
});
