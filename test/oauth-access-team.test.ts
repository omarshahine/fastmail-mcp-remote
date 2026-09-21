import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	handleAuthorize,
	handleCallback,
	handleGetToken,
	handleGetTokenCallback,
} from '../src/oauth-handler';
import { getAccessBaseUrl, resolveAccessTeamName } from '../src/oauth-utils';

const TEAM_NAME = 'example-team';
const CLIENT_ID = 'access-client-id';
const CONFIGURED_HOST = `${TEAM_NAME}.cloudflareaccess.com`;
const HOSTILE_TEAMS = ['other-team', 'attacker.example/', 'attacker.example/oidc?', 'a#b', 'user@evil.example', 'a b'];

afterEach(() => {
	vi.unstubAllGlobals();
});

function makeKv(initial: Record<string, string> = {}) {
	const store = new Map(Object.entries(initial));
	return {
		store,
		get: vi.fn(async (key: string) => store.get(key) ?? null),
		put: vi.fn(async (key: string, value: string) => {
			store.set(key, value);
		}),
		delete: vi.fn(async (key: string) => {
			store.delete(key);
		}),
	};
}

// Pass null for an unset ACCESS_TEAM_NAME.
function makeEnv(kv: ReturnType<typeof makeKv>, teamName: string | null = TEAM_NAME): Env {
	return {
		OAUTH_KV: kv,
		ACCESS_TEAM_NAME: teamName ?? undefined,
		ACCESS_CLIENT_ID: CLIENT_ID,
		ACCESS_CLIENT_SECRET: 'client-secret',
		ALLOWED_USERS: 'allowed@example.com',
	} as unknown as Env;
}

// An OOB authorize request needs no client registration or PKCE, so it reaches
// the Access redirect with the fewest moving parts.
function oobAuthorizeUrl(teamName: string): URL {
	const url = new URL('https://worker.example/mcp/authorize');
	url.searchParams.set('client_id', 'cli');
	url.searchParams.set('redirect_uri', 'urn:ietf:wg:oauth:2.0:oob');
	url.searchParams.set('response_type', 'code');
	url.searchParams.set('team_name', teamName);
	return url;
}

function getTokenUrl(teamName: string): URL {
	const url = new URL('https://worker.example/get-token');
	url.searchParams.set('team_name', teamName);
	return url;
}

// Captures the Access token-exchange request and fails it, which stops the
// callback before any ID token handling.
function stubAccessFetch() {
	const fetchMock = vi.fn(async () => new Response('stop', { status: 400 }));
	vi.stubGlobal('fetch', fetchMock);
	return fetchMock;
}

function fetchedHosts(fetchMock: ReturnType<typeof stubAccessFetch>): string[] {
	return fetchMock.mock.calls.map((call: unknown[]) => new URL(String(call[0])).hostname);
}

describe('resolveAccessTeamName', () => {
	it('accepts a single DNS label and trims whitespace', () => {
		expect(resolveAccessTeamName(TEAM_NAME)).toBe(TEAM_NAME);
		expect(resolveAccessTeamName(`  ${TEAM_NAME}\n`)).toBe(TEAM_NAME);
	});

	it.each([undefined, null, '', '   ', '-team', 'team-', 'a'.repeat(64), ...HOSTILE_TEAMS.slice(1)])(
		'rejects %j',
		(value) => {
			expect(resolveAccessTeamName(value as string | undefined)).toBeNull();
		}
	);

	it('getAccessBaseUrl refuses anything that is not a single label', () => {
		expect(getAccessBaseUrl(TEAM_NAME)).toBe(`https://${CONFIGURED_HOST}/cdn-cgi/access/sso/oidc`);
		expect(() => getAccessBaseUrl('attacker.example/')).toThrow('Invalid Access team name');
	});
});

describe.each([
	['handleAuthorize', handleAuthorize, oobAuthorizeUrl],
	['handleGetToken', handleGetToken, getTokenUrl],
] as const)('%s — Access team selection', (_name, handler, buildUrl) => {
	it.each(HOSTILE_TEAMS)('ignores team_name=%j and redirects to the configured team', async (team) => {
		const kv = makeKv();
		const url = buildUrl(team);

		const response = await handler(new Request(url), makeEnv(kv), url);

		expect(response.status).toBe(302);
		expect(new URL(response.headers.get('Location')!).hostname).toBe(CONFIGURED_HOST);
		for (const [, value] of kv.store) {
			expect(value).not.toContain(team);
		}
	});

	it.each([null, 'attacker.example/'])(
		'refuses to start when ACCESS_TEAM_NAME is %j, even with a team_name parameter',
		async (configured) => {
			const kv = makeKv();
			const url = buildUrl('attacker');

			const response = await handler(new Request(url), makeEnv(kv, configured), url);

			expect(response.status).toBe(500);
			expect(response.headers.get('Location')).toBeNull();
			expect(await response.text()).toContain('ACCESS_TEAM_NAME');
			expect(kv.put).not.toHaveBeenCalled();
		}
	);
});

describe('callbacks use only the configured Access team', () => {
	// State written by an older version could still carry a team_name.
	const legacyState = {
		client_id: 'cli',
		redirect_uri: 'urn:ietf:wg:oauth:2.0:oob',
		scope: 'mcp:read mcp:write',
		code_challenge: null,
		code_challenge_method: null,
		expires_at: new Date(Date.now() + 60_000).toISOString(),
		team_name: 'attacker',
	};

	it('handleCallback exchanges the code with the configured team, not the stored one', async () => {
		const fetchMock = stubAccessFetch();
		const kv = makeKv({ 'state:s1': JSON.stringify(legacyState) });
		const url = new URL('https://worker.example/mcp/callback?code=abc&state=s1');

		await handleCallback(new Request(url), makeEnv(kv), url);

		expect(fetchedHosts(fetchMock)).toEqual([CONFIGURED_HOST]);
	});

	it('handleCallback sends nothing when ACCESS_TEAM_NAME is unset', async () => {
		const fetchMock = stubAccessFetch();
		const kv = makeKv({ 'state:s1': JSON.stringify(legacyState) });
		const url = new URL('https://worker.example/mcp/callback?code=abc&state=s1');

		const response = await handleCallback(new Request(url), makeEnv(kv, null), url);

		// Errors after state validation redirect back to the client with error=.
		expect(new URL(response.headers.get('Location')!).searchParams.get('error')).toBe('server_error');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('handleGetTokenCallback exchanges the code with the configured team, not the stored one', async () => {
		const fetchMock = stubAccessFetch();
		const kv = makeKv({ 'direct-token-state:s2': JSON.stringify({ team_name: 'attacker' }) });
		const url = new URL('https://worker.example/get-token/callback?code=abc&state=s2');

		await handleGetTokenCallback(new Request(url), makeEnv(kv), url);

		expect(fetchedHosts(fetchMock)).toEqual([CONFIGURED_HOST]);
	});

	it('handleGetTokenCallback sends nothing when ACCESS_TEAM_NAME is unset', async () => {
		const fetchMock = stubAccessFetch();
		const kv = makeKv({ 'direct-token-state:s2': JSON.stringify({ team_name: 'attacker' }) });
		const url = new URL('https://worker.example/get-token/callback?code=abc&state=s2');

		const response = await handleGetTokenCallback(new Request(url), makeEnv(kv, null), url);

		expect(response.status).toBeGreaterThanOrEqual(400);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
