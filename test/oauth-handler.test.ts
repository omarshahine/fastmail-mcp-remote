import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleGetTokenCallback, handleAuthorize, handleToken } from '../src/oauth-handler';
import { CLIENT_TTL_SECONDS, hashToken } from '../src/oauth-utils';

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
	function makeEnv(registration?: { clientId: string; redirectUris: string[] }) {
		const kv = {
			get: vi.fn(async (key: string) =>
				registration && key === `client:${registration.clientId}`
					? JSON.stringify({
						client_id: registration.clientId,
						client_name: 'test client',
						redirect_uris: registration.redirectUris,
					})
					: null
			),
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
		const { env, kv } = makeEnv({
			clientId: 'some-client',
			redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
		});
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
		const { env } = makeEnv({
			clientId: 'some-client',
			redirectUris: ['https://claude.ai/cb'],
		});
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
		const { env, kv } = makeEnv({
			clientId: 'some-client',
			redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
		});
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
		const { env } = makeEnv({
			clientId: 'cli-client',
			redirectUris: ['http://127.0.0.1/callback'],
		});
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

	it.each([
		['allowlisted HTTPS', 'https://claude.ai/api/mcp/auth_callback'],
		['loopback', 'http://127.0.0.1:53187/callback'],
	])('rejects an unregistered client using an otherwise valid %s redirect', async (_kind, redirectUri) => {
		const { env, kv } = makeEnv();
		const { request, url } = authorizeRequest({
			client_id: 'unknown-client',
			redirect_uri: redirectUri,
			response_type: 'code',
			code_challenge: 'a'.repeat(43),
			code_challenge_method: 'S256',
		});

		const response = await handleAuthorize(request, env, url);

		expect(response.status).toBe(400);
		expect(await response.text()).toContain('Invalid client_id');
		expect(kv.put).not.toHaveBeenCalled();
	});

	// RFC 8252 §7.3: a REGISTERED client's loopback callback must still match
	// when the runtime port differs, since native clients bind ephemeral ports.
	// This is exactly how the fastmail CLI behaves: it registers a portless
	// loopback URI, then authorizes on whatever port it got.
	describe('registered-client loopback matching ignores the port', () => {
		function makeRegisteredEnv(registeredUris: string[]) {
			const kv = {
				get: vi.fn(async (key: string) =>
					key.startsWith('client:')
						? JSON.stringify({ client_id: 'cli', client_name: 'cli', redirect_uris: registeredUris })
						: null
				),
				put: vi.fn(async () => undefined),
				delete: vi.fn(async () => undefined),
			};
			return {
				OAUTH_KV: kv,
				ACCESS_TEAM_NAME: TEAM_NAME,
				ACCESS_CLIENT_ID: CLIENT_ID,
			} as unknown as Env;
		}

		it.each([
			['IPv4', 'http://127.0.0.1/callback', 'http://127.0.0.1:53187/callback'],
			['localhost', 'http://localhost/callback', 'http://localhost:53187/callback'],
			['IPv6', 'http://[::1]/callback', 'http://[::1]:53187/callback'],
		])('allows a %s loopback callback on a different port', async (_label, registered, requested) => {
			const env = makeRegisteredEnv([registered]);
			const { request, url } = authorizeRequest({
				client_id: 'cli',
				redirect_uri: requested,
				response_type: 'code',
				code_challenge: 'a'.repeat(43),
				code_challenge_method: 'S256',
			});

			const response = await handleAuthorize(request, env, url);

			expect(response.status).toBe(302);
		});

		it('still rejects a loopback callback whose path differs from the registered one', async () => {
			const env = makeRegisteredEnv(['http://127.0.0.1/callback']);
			const { request, url } = authorizeRequest({
				client_id: 'cli',
				redirect_uri: 'http://127.0.0.1:53187/evil',
				response_type: 'code',
				code_challenge: 'a'.repeat(43),
				code_challenge_method: 'S256',
			});

			const response = await handleAuthorize(request, env, url);

			expect(response.status).toBe(400);
		});
	});
});

describe('handleToken — client registration TTL slides on use', () => {
	const CLIENT_RECORD = {
		client_id: 'registered-client',
		client_name: 'Test Client',
		redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
	};

	// KV fake that serves whatever the handler asks for by key prefix and
	// records every write, so a test can assert on the `client:` write alone.
	function makeKv(overrides: Record<string, unknown> = {}) {
		const store: Record<string, unknown> = {
			'client:registered-client': { ...CLIENT_RECORD },
			...overrides,
		};
		const put = vi.fn(async (key: string, value: string) => {
			store[key] = JSON.parse(value);
		});
		const kv = {
			// `type` is 'json' for the typed reads and undefined for raw string reads.
			get: vi.fn(async (key: string, type?: string) => {
				const value = store[key];
				if (value === undefined) return null;
				return type === 'json' ? value : JSON.stringify(value);
			}),
			put,
			delete: vi.fn(async (key: string) => {
				delete store[key];
			}),
		};
		return { kv, put, store };
	}

	function env(kv: unknown): Env {
		return {
			OAUTH_KV: kv,
			ALLOWED_USERS: 'allowed@example.com',
		} as unknown as Env;
	}

	function tokenRequest(params: Record<string, string>): Request {
		return new Request('https://worker.example/mcp/token', {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(params).toString(),
		});
	}

	function clientWrites(put: ReturnType<typeof vi.fn>) {
		return put.mock.calls.filter((call: any[]) => String(call[0]).startsWith('client:'));
	}

	it('slides the registration on the authorization_code grant', async () => {
		const { kv, put } = makeKv({
			'code:auth-code-1': {
				client_id: 'registered-client',
				user_id: 'user-1',
				user_login: 'allowed@example.com',
				user_email: 'allowed@example.com',
				scope: 'mcp:read mcp:write',
				redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
				code_challenge: null,
				code_challenge_method: null,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
				used: false,
			},
		});

		const response = await handleToken(
			tokenRequest({ grant_type: 'authorization_code', code: 'auth-code-1' }),
			env(kv)
		);

		expect(response.status).toBe(200);
		const writes = clientWrites(put);
		expect(writes).toHaveLength(1);
		expect(writes[0][2]).toEqual({ expirationTtl: CLIENT_TTL_SECONDS });
	});

	it('slides the registration on the refresh_token grant — the only hot path a refresh-only client touches', async () => {
		const refreshToken = 'refresh-token-value';
		const refreshKey = `refresh_token:${await hashToken(refreshToken)}`;
		const { kv, put } = makeKv({
			[refreshKey]: {
				client_id: 'registered-client',
				user_id: 'user-1',
				user_login: 'allowed@example.com',
				scope: 'mcp:read mcp:write',
				access_token_hash: 'old-hash',
				created_at: new Date(Date.now() - 86_400_000).toISOString(),
			},
		});

		const response = await handleToken(
			tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
			env(kv)
		);

		expect(response.status).toBe(200);
		const writes = clientWrites(put);
		expect(writes).toHaveLength(1);
		expect(writes[0][2]).toEqual({ expirationTtl: CLIENT_TTL_SECONDS });
	});

	it('still issues a token when the client record has already lapsed', async () => {
		const refreshToken = 'refresh-token-value';
		const refreshKey = `refresh_token:${await hashToken(refreshToken)}`;
		const { kv, put, store } = makeKv({
			[refreshKey]: {
				client_id: 'lapsed-client',
				user_id: 'user-1',
				user_login: 'allowed@example.com',
				scope: null,
				access_token_hash: 'old-hash',
				created_at: new Date(Date.now() - 86_400_000).toISOString(),
			},
		});
		delete store['client:registered-client'];

		const response = await handleToken(
			tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken }),
			env(kv)
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ token_type: 'Bearer' });
		// A lapsed record is never recreated — re-registration is the recovery path.
		expect(clientWrites(put)).toHaveLength(0);
	});
});
