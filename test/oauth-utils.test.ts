import { afterEach, describe, expect, it, vi } from 'vitest';
import { verifyAccessIdToken, isAllowedRedirectUri } from '../src/oauth-utils';

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
