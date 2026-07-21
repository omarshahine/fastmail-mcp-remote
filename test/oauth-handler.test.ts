import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGetTokenCallback, handleAuthorize } from '../src/oauth-handler';

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

describe('handleAuthorize — redirect_uri allowlist + PKCE enforcement', () => {
	// KV with no registered client (the unregistered-client_id attack path).
	function makeEnv() {
		const kv = {
			get: vi.fn(async () => null),
			put: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
		};
		const env = {
			OAUTH_KV: kv,
			ACCESS_TEAM_NAME: TEAM_NAME,
			ACCESS_CLIENT_ID: CLIENT_ID,
		} as unknown as Env;
		return { env, kv };
	}

	function authorizeRequest(params: Record<string, string>) {
		const url = new URL('https://worker.example/mcp/authorize');
		for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
		return { request: new Request(url.toString()), url };
	}

	it('rejects an attacker-controlled redirect_uri for an unregistered client (the exploit)', async () => {
		const { env, kv } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'attacker-random-id',
			redirect_uri: 'https://evil.example/cb',
			response_type: 'code',
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid redirect_uri');
		// No state persisted — the flow never reached the CF Access redirect.
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('rejects a non-OOB authorize request with no PKCE challenge', async () => {
		const { env, kv } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'some-client',
			redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
			response_type: 'code',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('PKCE');
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('rejects a plain PKCE method (downgrade attempt)', async () => {
		const { env } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'some-client',
			redirect_uri: 'https://claude.ai/cb',
			response_type: 'code',
			code_challenge: 'verifier-as-challenge',
			code_challenge_method: 'plain',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('S256');
	});

	it('accepts an allowlisted https redirect with S256 PKCE and 302s to CF Access', async () => {
		const { env, kv } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'some-client',
			redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
			response_type: 'code',
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(302);
		expect(response.headers.get('Location')).toContain('cloudflareaccess.com');
		expect(kv.put).toHaveBeenCalledOnce();
	});

	it('accepts a loopback redirect on an ephemeral port with S256 PKCE', async () => {
		const { env } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'cli-client',
			redirect_uri: 'http://127.0.0.1:53187/callback',
			response_type: 'code',
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(302);
	});
});
