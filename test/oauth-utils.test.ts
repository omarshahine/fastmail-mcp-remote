import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	verifyAccessIdToken,
	isAllowedRedirectUri,
	slideClientRegistrationTtl,
	validateAccessToken,
	hashToken,
	CLIENT_TTL_SECONDS,
	CLIENT_TTL_REFRESH_INTERVAL_SECONDS,
} from '../src/oauth-utils';

const TEAM_NAME = 'example-team';
const CLIENT_ID = 'access-client-id';
const ISSUER = `https://${TEAM_NAME}.cloudflareaccess.com/cdn-cgi/access/sso/oidc/${CLIENT_ID}`;
const NOW = new Date('2026-05-17T12:00:00Z');

interface TestJwk extends JsonWebKey {
	kid?: string;
	alg?: string;
	use?: string;
}

function base64Url(input: string | Uint8Array): string {
	const base64 = Buffer.from(input).toString('base64');
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeJson(value: unknown): string {
	return base64Url(JSON.stringify(value));
}

async function createSignedJwt(
	claims: Record<string, unknown>,
	args: { kid?: string; keyPair?: CryptoKeyPair } = {}
): Promise<{ token: string; publicJwk: TestJwk }> {
	const keyPair =
		args.keyPair ??
		((await crypto.subtle.generateKey(
			{
				name: 'RSASSA-PKCS1-v1_5',
				modulusLength: 2048,
				publicExponent: new Uint8Array([1, 0, 1]),
				hash: 'SHA-256',
			},
			true,
			['sign', 'verify']
		)) as CryptoKeyPair);
	const kid = args.kid ?? 'test-key';
	const header = encodeJson({ alg: 'RS256', typ: 'JWT', kid });
	const payload = encodeJson(claims);
	const signedData = new TextEncoder().encode(`${header}.${payload}`);
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, signedData);
	const publicJwk = (await crypto.subtle.exportKey('jwk', keyPair.publicKey)) as JsonWebKey;
	return {
		token: `${header}.${payload}.${base64Url(new Uint8Array(signature))}`,
		publicJwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' },
	};
}

function mockJwks(publicJwk: TestJwk): void {
	vi.stubGlobal(
		'fetch',
		vi.fn(async () => Response.json({ keys: [publicJwk] }))
	);
}

function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		iss: ISSUER,
		aud: CLIENT_ID,
		exp: Math.floor(NOW.getTime() / 1000) + 300,
		iat: Math.floor(NOW.getTime() / 1000) - 30,
		sub: 'user-subject',
		email: 'user@example.com',
		name: 'User Example',
		...overrides,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('verifyAccessIdToken', () => {
	it('rejects unsigned JWTs before trusting claims', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch');
		const token = `${encodeJson({ alg: 'none', typ: 'JWT' })}.${encodeJson(
			validClaims()
		)}.unsigned`;

		await expect(
			verifyAccessIdToken(token, { teamName: TEAM_NAME, clientId: CLIENT_ID, now: NOW })
		).rejects.toThrow('unsupported alg');
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it('rejects JWTs with an invalid signature', async () => {
		const { token, publicJwk } = await createSignedJwt(validClaims());
		mockJwks(publicJwk);
		const forgedToken = `${token.slice(0, -2)}xx`;

		await expect(
			verifyAccessIdToken(forgedToken, { teamName: TEAM_NAME, clientId: CLIENT_ID, now: NOW })
		).rejects.toThrow('signature invalid');
	});

	it('accepts a signed Access ID token with valid issuer, audience, expiry, and identity claims', async () => {
		const { token, publicJwk } = await createSignedJwt(validClaims());
		mockJwks(publicJwk);

		const claims = await verifyAccessIdToken(token, {
			teamName: TEAM_NAME,
			clientId: CLIENT_ID,
			now: NOW,
		});

		expect(claims).toMatchObject({
			sub: 'user-subject',
			email: 'user@example.com',
			name: 'User Example',
			iss: ISSUER,
			aud: CLIENT_ID,
		});
		expect(fetch).toHaveBeenCalledWith(`${ISSUER}/jwks`, {
			headers: { Accept: 'application/json' },
		});
	});

	it('rejects a validly signed token for the wrong audience', async () => {
		const { token, publicJwk } = await createSignedJwt(validClaims({ aud: 'other-client' }));
		mockJwks(publicJwk);

		await expect(
			verifyAccessIdToken(token, { teamName: TEAM_NAME, clientId: CLIENT_ID, now: NOW })
		).rejects.toThrow('audience mismatch');
	});
});

describe('isAllowedRedirectUri', () => {
	const ORIGIN = 'https://worker.example';

	it('rejects an arbitrary external https origin (the phishing vector)', () => {
		expect(isAllowedRedirectUri('https://evil.example/cb', ORIGIN)).toBe(false);
	});

	it('allows the default Claude/Anthropic hosts and their subdomains', () => {
		expect(isAllowedRedirectUri('https://claude.ai/api/mcp/auth_callback', ORIGIN)).toBe(true);
		expect(isAllowedRedirectUri('https://claude.com/cb', ORIGIN)).toBe(true);
		expect(isAllowedRedirectUri('https://console.anthropic.com/cb', ORIGIN)).toBe(true);
	});

	it("does not treat an attacker suffix domain as a subdomain match", () => {
		expect(isAllowedRedirectUri('https://claude.ai.evil.example/cb', ORIGIN)).toBe(false);
		expect(isAllowedRedirectUri('https://notclaude.ai/cb', ORIGIN)).toBe(false);
	});

	it('allows loopback on any port for native/CLI clients', () => {
		expect(isAllowedRedirectUri('http://127.0.0.1:53187/callback', ORIGIN)).toBe(true);
		expect(isAllowedRedirectUri('http://localhost:8080/callback', ORIGIN)).toBe(true);
	});

	it("allows the worker's own origin", () => {
		expect(isAllowedRedirectUri('https://worker.example/mcp/callback', ORIGIN)).toBe(true);
	});

	it('allows OOB redirect targets', () => {
		expect(isAllowedRedirectUri('urn:ietf:wg:oauth:2.0:oob', ORIGIN)).toBe(true);
		expect(isAllowedRedirectUri('oob:custom', ORIGIN)).toBe(true);
	});

	it('rejects non-loopback plain http and custom app schemes', () => {
		expect(isAllowedRedirectUri('http://claude.ai/cb', ORIGIN)).toBe(false);
		expect(isAllowedRedirectUri('com.evil.app://cb', ORIGIN)).toBe(false);
	});

	it('honors an explicit ALLOWED_REDIRECT_HOSTS override, replacing the defaults', () => {
		const allow = 'partner.example';
		expect(isAllowedRedirectUri('https://partner.example/cb', ORIGIN, allow)).toBe(true);
		expect(isAllowedRedirectUri('https://app.partner.example/cb', ORIGIN, allow)).toBe(true);
		// Once an override is set, the built-in Claude defaults no longer apply.
		expect(isAllowedRedirectUri('https://claude.ai/cb', ORIGIN, allow)).toBe(false);
	});

	it('rejects malformed redirect URIs', () => {
		expect(isAllowedRedirectUri('not a url', ORIGIN)).toBe(false);
		expect(isAllowedRedirectUri('', ORIGIN)).toBe(false);
	});
});

describe('slideClientRegistrationTtl', () => {
	function makeKv(record: unknown) {
		return {
			get: vi.fn(async () => record),
			put: vi.fn(async () => undefined),
			delete: vi.fn(async () => undefined),
		} as unknown as KVNamespace & { get: ReturnType<typeof vi.fn>; put: ReturnType<typeof vi.fn> };
	}

	const CLIENT = {
		client_id: 'client-abc',
		client_name: 'Test Client',
		redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
	};

	it('rewrites the record with a fresh 90-day TTL on first use', async () => {
		const kv = makeKv({ ...CLIENT });
		await slideClientRegistrationTtl(kv, 'client-abc');

		expect(kv.get).toHaveBeenCalledWith('client:client-abc', 'json');
		expect(kv.put).toHaveBeenCalledTimes(1);
		const [key, value, options] = kv.put.mock.calls[0];
		expect(key).toBe('client:client-abc');
		expect(options).toEqual({ expirationTtl: CLIENT_TTL_SECONDS });
		const written = JSON.parse(value as string);
		// Registered redirect_uris must survive the rewrite — they are what the
		// exact-match check at /authorize depends on.
		expect(written.redirect_uris).toEqual(CLIENT.redirect_uris);
		expect(Date.parse(written.ttl_refreshed_at)).toBeGreaterThan(Date.now() - 60_000);
	});

	it('throttles to one write per client per day', async () => {
		const kv = makeKv({ ...CLIENT, ttl_refreshed_at: new Date(Date.now() - 60_000).toISOString() });
		await slideClientRegistrationTtl(kv, 'client-abc');
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('slides again once the throttle interval has passed', async () => {
		const stale = new Date(Date.now() - (CLIENT_TTL_REFRESH_INTERVAL_SECONDS + 60) * 1000).toISOString();
		const kv = makeKv({ ...CLIENT, ttl_refreshed_at: stale });
		await slideClientRegistrationTtl(kv, 'client-abc');
		expect(kv.put).toHaveBeenCalledTimes(1);
	});

	it('slides despite a future-dated stamp instead of skipping the write forever', async () => {
		const future = new Date(Date.now() + 10 * 86_400_000).toISOString();
		const kv = makeKv({ ...CLIENT, ttl_refreshed_at: future });
		await slideClientRegistrationTtl(kv, 'client-abc');
		expect(kv.put).toHaveBeenCalledTimes(1);
	});

	it('slides when the stamp is unparseable', async () => {
		const kv = makeKv({ ...CLIENT, ttl_refreshed_at: 'not-a-date' });
		await slideClientRegistrationTtl(kv, 'client-abc');
		expect(kv.put).toHaveBeenCalledTimes(1);
	});

	it('never resurrects a lapsed or unregistered client record', async () => {
		const kv = makeKv(null);
		await slideClientRegistrationTtl(kv, 'client-abc');
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('is a no-op without a client_id', async () => {
		const kv = makeKv({ ...CLIENT });
		await slideClientRegistrationTtl(kv, undefined);
		expect(kv.get).not.toHaveBeenCalled();
		expect(kv.put).not.toHaveBeenCalled();
	});

	it('swallows KV failures so token issuance is never blocked', async () => {
		const kv = {
			get: vi.fn(async () => {
				throw new Error('KV unavailable');
			}),
			put: vi.fn(async () => undefined),
		} as unknown as KVNamespace;
		await expect(slideClientRegistrationTtl(kv, 'client-abc')).resolves.toBeUndefined();
	});
});

describe('validateAccessToken — keeps the client registration alive', () => {
	const CLIENT = {
		client_id: 'cli-client',
		client_name: 'fastmail-cli',
		redirect_uris: ['http://127.0.0.1/callback'],
	};

	function makeKv(overrides: Record<string, unknown> = {}) {
		const store: Record<string, unknown> = { 'client:cli-client': { ...CLIENT }, ...overrides };
		const put = vi.fn(async (key: string, value: string) => {
			store[key] = JSON.parse(value);
		});
		const kv = {
			get: vi.fn(async (key: string) => (store[key] === undefined ? null : store[key])),
			put,
			delete: vi.fn(async () => undefined),
		} as unknown as KVNamespace;
		return { kv, put, store };
	}

	function clientWrites(put: ReturnType<typeof vi.fn>) {
		return put.mock.calls.filter((call: any[]) => String(call[0]).startsWith('client:'));
	}

	async function tokenStore(overrides: Record<string, unknown> = {}) {
		const token = 'access-token-value';
		const key = `token:${await hashToken(token)}`;
		return {
			token,
			key,
			record: {
				client_id: 'cli-client',
				user_id: 'user-1',
				user_login: 'allowed@example.com',
				scope: 'mcp:read mcp:write',
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
				...overrides,
			},
		};
	}

	// The first-party CLI stores only the access token (cli/auth.ts never keeps
	// refresh_token), so after `fastmail auth` it never calls /mcp/token again.
	// Token validation is the only place its registration can be kept alive.
	it('slides the registration on a validated request from an access-token-only client', async () => {
		const { token, key, record } = await tokenStore();
		const { kv, put } = makeKv({ [key]: record });

		const result = await validateAccessToken(kv, token);

		expect(result).toMatchObject({ user_login: 'allowed@example.com' });
		const writes = clientWrites(put);
		expect(writes).toHaveLength(1);
		expect(writes[0][2]).toEqual({ expirationTtl: CLIENT_TTL_SECONDS });
	});

	it('stamps the token record so the next request pays no extra KV read', async () => {
		const { token, key, record } = await tokenStore();
		const { kv, put, store } = makeKv({ [key]: record });

		await validateAccessToken(kv, token);
		expect((store[key] as any).client_ttl_slid_at).toBeTruthy();

		put.mockClear();
		(kv.get as ReturnType<typeof vi.fn>).mockClear();
		await validateAccessToken(kv, token);

		expect(clientWrites(put)).toHaveLength(0);
		// Only the token record is read on the throttled path.
		const readKeys = (kv.get as ReturnType<typeof vi.fn>).mock.calls.map((call: any[]) => call[0]);
		expect(readKeys).toEqual([key]);
	});

	it('slides again once the daily throttle has elapsed', async () => {
		const stale = new Date(Date.now() - (CLIENT_TTL_REFRESH_INTERVAL_SECONDS + 60) * 1000).toISOString();
		const { token, key, record } = await tokenStore({ client_ttl_slid_at: stale });
		const { kv, put } = makeKv({ [key]: record });

		await validateAccessToken(kv, token);
		expect(clientWrites(put)).toHaveLength(1);
	});

	it('defers the slide when the caller supplies waitUntil', async () => {
		const { token, key, record } = await tokenStore();
		const { kv, put } = makeKv({ [key]: record });
		const deferred: Promise<unknown>[] = [];

		await validateAccessToken(kv, token, (work) => {
			deferred.push(work);
		});

		expect(deferred).toHaveLength(1);
		await Promise.all(deferred);
		expect(clientWrites(put)).toHaveLength(1);
	});

	it('still authenticates when the client record has lapsed', async () => {
		const { token, key, record } = await tokenStore();
		const { kv, put, store } = makeKv({ [key]: record });
		delete store['client:cli-client'];

		const result = await validateAccessToken(kv, token);

		expect(result).toMatchObject({ user_login: 'allowed@example.com' });
		expect(clientWrites(put)).toHaveLength(0);
	});

	it('returns null for an expired token without touching the registration', async () => {
		const { token, key, record } = await tokenStore({
			expires_at: new Date(Date.now() - 1000).toISOString(),
		});
		const { kv, put } = makeKv({ [key]: record });

		expect(await validateAccessToken(kv, token)).toBeNull();
		expect(put).not.toHaveBeenCalled();
	});
});
