/**
 * OAuth Handler for MCP Server (KV-based)
 * Adapted from travel-hub for KV storage instead of D1
 */

import {
	generateState,
	generateCode,
	generateToken,
	hashToken,
	getExpiresAt,
	isExpired,
	isUserAllowed,
	isAllowedRedirectUri,
	isLoopbackHost,
	verifyCodeChallenge,
	validateRefreshToken,
	verifyAccessIdToken,
	slideClientRegistrationTtl,
	type DeferWork,
	STATE_TTL_SECONDS,
	CODE_TTL_SECONDS,
	TOKEN_TTL_SECONDS,
	CLIENT_TTL_SECONDS,
	DEFAULT_SCOPE,
	getAccessBaseUrl,
	type OAuthStateData,
	type OAuthCodeData,
	type OAuthTokenData,
	type OAuthRefreshTokenData,
	type OAuthClientData,
} from './oauth-utils';

// Issue a paired access token + refresh token and persist both in KV.
// Refresh tokens have no KV TTL — they live until explicitly revoked.
async function issueTokenPair(
	kv: KVNamespace,
	args: { client_id: string; user_id: string; user_login: string; scope: string | null }
): Promise<{ access_token: string; refresh_token: string; expires_in: number }> {
	const accessToken = generateToken();
	const refreshToken = generateToken();
	const accessTokenHash = await hashToken(accessToken);
	const refreshTokenHash = await hashToken(refreshToken);
	const tokenExpiresAt = getExpiresAt(TOKEN_TTL_SECONDS);

	const accessData: OAuthTokenData = {
		client_id: args.client_id,
		user_id: args.user_id,
		user_login: args.user_login,
		scope: args.scope,
		expires_at: tokenExpiresAt,
	};
	await kv.put(`token:${accessTokenHash}`, JSON.stringify(accessData), {
		expirationTtl: TOKEN_TTL_SECONDS,
	});

	const refreshData: OAuthRefreshTokenData = {
		client_id: args.client_id,
		user_id: args.user_id,
		user_login: args.user_login,
		scope: args.scope,
		access_token_hash: accessTokenHash,
		created_at: new Date().toISOString(),
	};
	await kv.put(`refresh_token:${refreshTokenHash}`, JSON.stringify(refreshData));

	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		expires_in: TOKEN_TTL_SECONDS,
	};
}

// Keep a client's registration alive after it proves it is in use. Handed to
// `ctx.waitUntil` when the caller has an ExecutionContext, so the KV read (and
// at most one write a day) never sits in the response path; otherwise awaited.
// Failures are swallowed inside slideClientRegistrationTtl.
async function slideClientRegistration(
	env: Env,
	clientId: string | undefined,
	defer?: DeferWork
): Promise<void> {
	const work = slideClientRegistrationTtl(env.OAUTH_KV, clientId);
	// With a deferral hook this returns immediately and the runtime keeps the
	// write alive past the response. Without one (tests, or a caller with no
	// ExecutionContext) it is awaited so the work still completes.
	if (defer) {
		defer(work);
		return;
	}
	await work;
}

// OAuth Discovery Endpoint
export function handleOAuthDiscovery(url: URL): Response {
	const metadata = {
		issuer: url.origin,
		authorization_endpoint: `${url.origin}/mcp/authorize`,
		token_endpoint: `${url.origin}/mcp/token`,
		registration_endpoint: `${url.origin}/register`,
		scopes_supported: ['mcp:read', 'mcp:write'],
		response_types_supported: ['code'],
		response_modes_supported: ['query'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
		code_challenge_methods_supported: ['S256'],
		service_documentation: url.origin,
		logo_uri: `${url.origin}/favicon.png`,
	};

	return new Response(JSON.stringify(metadata), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=3600',
		},
	});
}

// Authorization Endpoint
export async function handleAuthorize(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.OAUTH_KV) {
		return new Response('KV namespace not available', { status: 500 });
	}

	if (!env.ACCESS_CLIENT_ID) {
		return new Response('OAuth not configured', { status: 500 });
	}

	// Parse OAuth request parameters
	const clientId = url.searchParams.get('client_id');
	const redirectUri = url.searchParams.get('redirect_uri');
	const responseType = url.searchParams.get('response_type');
	const clientState = url.searchParams.get('state');
	const scope = url.searchParams.get('scope') || DEFAULT_SCOPE;
	const codeChallenge = url.searchParams.get('code_challenge');
	const codeChallengeMethod = url.searchParams.get('code_challenge_method');

	// Validate required parameters
	if (!clientId) {
		return new Response('Missing client_id parameter', { status: 400 });
	}
	if (!redirectUri) {
		return new Response('Missing redirect_uri parameter', { status: 400 });
	}
	if (responseType && responseType !== 'code') {
		return new Response('Invalid response_type, only "code" is supported', { status: 400 });
	}

	// PKCE: only S256 is accepted. `plain` is rejected because it offers no
	// protection against an intercepted authorization code.
	if (codeChallenge && codeChallengeMethod !== 'S256') {
		return new Response('Only code_challenge_method=S256 is supported', { status: 400 });
	}

	// Validate redirect URI against the host allowlist. This is enforced for
	// ALL clients — registered or not — so open dynamic registration can never
	// whitelist an attacker-controlled origin and phish an auth code to it
	// (the unregistered→any-https fallback that made this exploitable is gone).
	const isOOBUri = redirectUri === 'urn:ietf:wg:oauth:2.0:oob' || redirectUri.startsWith('oob:');
	if (!isAllowedRedirectUri(redirectUri, url.origin, env.ALLOWED_REDIRECT_HOSTS)) {
		return new Response('Invalid redirect_uri', { status: 400 });
	}
	if (!isOOBUri) {
		// Every redirecting client must be registered. The host allowlist is a
		// deployment boundary, not a substitute for binding a client_id to its
		// declared callbacks. OOB remains available for explicit manual flows.
		const clientJson = await env.OAUTH_KV.get(`client:${clientId}`);
		if (!clientJson) {
			return new Response('Invalid client_id', { status: 400 });
		}
		const clientData = JSON.parse(clientJson) as OAuthClientData;
		// Loopback URIs match on scheme+host+path but ignore the port because
		// native/CLI clients bind an ephemeral port at runtime (RFC 8252 §7.3).
		if (!redirectUriMatchesRegistered(redirectUri, clientData.redirect_uris)) {
			return new Response('Invalid redirect_uri', { status: 400 });
		}
	}

	// Require PKCE (S256) for every non-OOB flow. Without this, an intercepted
	// authorization code alone is enough to mint a full-scope token. OOB is
	// exempt because its code is shown on-screen and never auto-redirected.
	if (!isOOBUri && (!codeChallenge || codeChallengeMethod !== 'S256')) {
		return new Response('PKCE (code_challenge with S256) is required for non-OOB flows', { status: 400 });
	}

	// Generate state and store OAuth parameters in KV
	const state = generateState();
	const combinedState = clientState ? `${state}:${clientState}` : state;
	const expiresAt = getExpiresAt(STATE_TTL_SECONDS);

	// Resolve team name: env var takes priority, then query param from CLI
	const teamName = env.ACCESS_TEAM_NAME || url.searchParams.get('team_name');
	if (!teamName) {
		return new Response('ACCESS_TEAM_NAME not configured and no team_name parameter provided', { status: 500 });
	}

	const stateData: OAuthStateData = {
		client_id: clientId,
		redirect_uri: redirectUri,
		scope,
		code_challenge: codeChallenge,
		code_challenge_method: codeChallengeMethod,
		expires_at: expiresAt,
		team_name: teamName,
	};

	await env.OAUTH_KV.put(`state:${state}`, JSON.stringify(stateData), {
		expirationTtl: STATE_TTL_SECONDS,
	});

	// Build Cloudflare Access OAuth URL
	const accessBaseUrl = getAccessBaseUrl(teamName);
	const accessAuthUrl = `${accessBaseUrl}/${env.ACCESS_CLIENT_ID}/authorization`;
	const accessParams = new URLSearchParams({
		client_id: env.ACCESS_CLIENT_ID,
		redirect_uri: `${url.origin}/mcp/callback`,
		response_type: 'code',
		scope: 'openid email profile',
		state: combinedState,
	});

	return new Response(null, {
		status: 302,
		headers: { Location: `${accessAuthUrl}?${accessParams.toString()}` },
	});
}

// Callback Endpoint
export async function handleCallback(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.OAUTH_KV) {
		return new Response('KV namespace not available', { status: 500 });
	}

	if (!env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) {
		return new Response('OAuth not configured', { status: 500 });
	}

	// Get parameters from Access callback
	const code = url.searchParams.get('code');
	const combinedState = url.searchParams.get('state');
	const error = url.searchParams.get('error');
	const errorDescription = url.searchParams.get('error_description');

	if (error) {
		return new Response(`OAuth error: ${error} - ${errorDescription}`, { status: 400 });
	}

	if (!code || !combinedState) {
		return new Response('Missing code or state parameter', { status: 400 });
	}

	// Extract our state from combined state
	const [ourState, ...clientStateParts] = combinedState.split(':');
	const clientState = clientStateParts.join(':');

	// Validate state and retrieve OAuth parameters from KV
	const stateJson = await env.OAUTH_KV.get(`state:${ourState}`);
	if (!stateJson) {
		return new Response('Invalid or expired state', { status: 400 });
	}

	const stateResult = JSON.parse(stateJson) as OAuthStateData;
	if (isExpired(stateResult.expires_at)) {
		await env.OAUTH_KV.delete(`state:${ourState}`);
		return new Response('Invalid or expired state', { status: 400 });
	}

	// Delete used state
	await env.OAUTH_KV.delete(`state:${ourState}`);

	try {
		// Exchange code for tokens with Cloudflare Access
		// Use team_name from stored state (set during authorize), falling back to env var
		const teamName = stateResult.team_name || env.ACCESS_TEAM_NAME;
		if (!teamName) {
			throw new Error('ACCESS_TEAM_NAME not available');
		}
		const accessBaseUrl = getAccessBaseUrl(teamName);
		const tokenUrl = `${accessBaseUrl}/${env.ACCESS_CLIENT_ID}/token`;
		const tokenResponse = await fetch(tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: env.ACCESS_CLIENT_ID,
				client_secret: env.ACCESS_CLIENT_SECRET,
				code,
				redirect_uri: `${url.origin}/mcp/callback`,
			}),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			throw new Error(`Failed to exchange Access code: ${errorText}`);
		}

		const tokenData = (await tokenResponse.json()) as { id_token?: string; error?: string; error_description?: string };

		if (tokenData.error) {
			throw new Error(tokenData.error_description || tokenData.error);
		}

		const idToken = tokenData.id_token!;
		const userInfo = await verifyAccessIdToken(idToken, {
			teamName,
			clientId: env.ACCESS_CLIENT_ID,
		});

		// Check if user is allowed
		if (!isUserAllowed(userInfo.email, env.ALLOWED_USERS || '')) {
			const redirectUrl = new URL(stateResult.redirect_uri);
			redirectUrl.searchParams.set('error', 'access_denied');
			redirectUrl.searchParams.set('error_description', `User ${userInfo.email} is not authorized`);
			if (clientState) redirectUrl.searchParams.set('state', clientState);
			return new Response(null, { status: 302, headers: { Location: redirectUrl.toString() } });
		}

		// Generate authorization code for the client
		const authCode = generateCode();
		const codeExpiresAt = getExpiresAt(CODE_TTL_SECONDS);

		const codeData: OAuthCodeData = {
			client_id: stateResult.client_id,
			user_id: userInfo.sub,
			user_login: userInfo.email,
			user_email: userInfo.email,
			scope: stateResult.scope,
			redirect_uri: stateResult.redirect_uri,
			code_challenge: stateResult.code_challenge,
			code_challenge_method: stateResult.code_challenge_method,
			expires_at: codeExpiresAt,
			used: false,
		};

		await env.OAUTH_KV.put(`code:${authCode}`, JSON.stringify(codeData), {
			expirationTtl: CODE_TTL_SECONDS,
		});

		// Check for explicit OOB (Out-of-Band) mode
		const isExplicitOOB = stateResult.redirect_uri === 'urn:ietf:wg:oauth:2.0:oob' ||
			stateResult.redirect_uri.startsWith('oob:');

		if (isExplicitOOB) {
			// Display the code on a page for manual copy-paste (SSH/headless flow)
			return renderOOBPage(authCode, clientState, null);
		}

		// Build redirect URL and do a normal redirect
		// For SSH/headless scenarios, users should use /get-token instead of the OAuth flow
		const redirectUrl = new URL(stateResult.redirect_uri);
		redirectUrl.searchParams.set('code', authCode);
		if (clientState) redirectUrl.searchParams.set('state', clientState);

		return new Response(null, { status: 302, headers: { Location: redirectUrl.toString() } });
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		const redirectUrl = new URL(stateResult.redirect_uri);
		redirectUrl.searchParams.set('error', 'server_error');
		redirectUrl.searchParams.set('error_description', message);
		if (clientState) redirectUrl.searchParams.set('state', clientState);
		return new Response(null, { status: 302, headers: { Location: redirectUrl.toString() } });
	}
}

// Token Endpoint
export async function handleToken(request: Request, env: Env, defer?: DeferWork): Promise<Response> {
	if (!env.OAUTH_KV) {
		return jsonError('server_error', 'KV namespace not available', 500);
	}

	let body: {
		grant_type?: string;
		code?: string;
		redirect_uri?: string;
		client_id?: string;
		code_verifier?: string;
		refresh_token?: string;
	};

	// Parse request body (support both JSON and form-urlencoded)
	const contentType = request.headers.get('Content-Type') || '';
	if (contentType.includes('application/json')) {
		body = await request.json();
	} else if (contentType.includes('application/x-www-form-urlencoded')) {
		const formData = await request.formData();
		body = {
			grant_type: formData.get('grant_type') as string,
			code: formData.get('code') as string,
			redirect_uri: formData.get('redirect_uri') as string | undefined,
			client_id: formData.get('client_id') as string | undefined,
			code_verifier: formData.get('code_verifier') as string | undefined,
			refresh_token: formData.get('refresh_token') as string | undefined,
		};
	} else {
		return jsonError('invalid_request', 'Unsupported Content-Type', 400);
	}

	if (body.grant_type === 'refresh_token') {
		return handleRefreshTokenGrant(body, env, defer);
	}

	if (body.grant_type !== 'authorization_code') {
		return jsonError('unsupported_grant_type', 'Only authorization_code and refresh_token grants are supported', 400);
	}

	if (!body.code) {
		return jsonError('invalid_request', 'Missing code parameter', 400);
	}

	// Retrieve and validate authorization code from KV
	const codeJson = await env.OAUTH_KV.get(`code:${body.code}`);
	if (!codeJson) {
		return jsonError('invalid_grant', 'Invalid or expired authorization code', 400);
	}

	const authCode = JSON.parse(codeJson) as OAuthCodeData;
	if (isExpired(authCode.expires_at) || authCode.used) {
		await env.OAUTH_KV.delete(`code:${body.code}`);
		return jsonError('invalid_grant', 'Invalid or expired authorization code', 400);
	}

	// Mark code as used by deleting it (KV doesn't support updates)
	await env.OAUTH_KV.delete(`code:${body.code}`);

	// Validate client_id matches
	if (body.client_id && body.client_id !== authCode.client_id) {
		return jsonError('invalid_grant', 'client_id mismatch', 400);
	}

	// Validate redirect_uri matches
	if (body.redirect_uri && body.redirect_uri !== authCode.redirect_uri) {
		return jsonError('invalid_grant', 'redirect_uri mismatch', 400);
	}

	// Defense in depth: re-check the bound redirect_uri against the host
	// allowlist at token time, so a code minted before an allowlist change
	// (or via any future authorize-side gap) still cannot be redeemed for a
	// token destined to a disallowed origin.
	if (!isAllowedRedirectUri(authCode.redirect_uri, new URL(request.url).origin, env.ALLOWED_REDIRECT_HOSTS)) {
		return jsonError('invalid_grant', 'redirect_uri not permitted', 400);
	}

	// Validate PKCE if code challenge was provided. Only S256 is accepted —
	// `plain` offers no protection against an intercepted code.
	if (authCode.code_challenge) {
		if (authCode.code_challenge_method !== 'S256') {
			return jsonError('invalid_grant', 'Only S256 PKCE is supported', 400);
		}
		if (!body.code_verifier) {
			return jsonError('invalid_request', 'Missing code_verifier for PKCE', 400);
		}

		const isValid = await verifyCodeChallenge(body.code_verifier, authCode.code_challenge, 'S256');
		if (!isValid) {
			return jsonError('invalid_grant', 'Invalid code_verifier', 400);
		}
	}

	// Issue paired access + refresh tokens
	const pair = await issueTokenPair(env.OAUTH_KV, {
		client_id: authCode.client_id,
		user_id: authCode.user_id,
		user_login: authCode.user_login,
		scope: authCode.scope,
	});

	// The client is demonstrably in use — keep its registration from lapsing.
	// Deferred where the runtime allows it: the token is already durably stored,
	// so this must not add KV latency to the response.
	await slideClientRegistration(env, authCode.client_id, defer);

	return new Response(
		JSON.stringify({
			access_token: pair.access_token,
			refresh_token: pair.refresh_token,
			token_type: 'Bearer',
			expires_in: pair.expires_in,
			scope: authCode.scope,
			user_login: authCode.user_login,
		}),
		{
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				Pragma: 'no-cache',
			},
		}
	);
}

// Handle grant_type=refresh_token: validate the presented refresh token,
// re-check the user against ALLOWED_USERS (so the env var remains a real
// kill switch — removing an email must cut off refresh too, not just new
// auth-code flows), and mint a new access token. The refresh token itself
// is non-rotating: the same token value is returned, paired with a new
// access token. Revocation happens either via ALLOWED_USERS changes or by
// setting `revoked: true` on the KV entry.
async function handleRefreshTokenGrant(
	body: { refresh_token?: string; client_id?: string },
	env: Env,
	defer?: DeferWork
): Promise<Response> {
	if (!env.OAUTH_KV) {
		return jsonError('server_error', 'KV namespace not available', 500);
	}
	if (!body.refresh_token) {
		return jsonError('invalid_request', 'Missing refresh_token parameter', 400);
	}

	const validated = await validateRefreshToken(env.OAUTH_KV, body.refresh_token);
	if (!validated) {
		return jsonError('invalid_grant', 'Invalid or revoked refresh token', 400);
	}
	const { data: refreshData, token_hash: refreshTokenHash } = validated;

	// Re-check allowlist on every refresh. Without this, removing a user
	// from ALLOWED_USERS would only block new auth-code flows — an existing
	// refresh token could mint access tokens indefinitely.
	if (!isUserAllowed(refreshData.user_login, env.ALLOWED_USERS || '')) {
		// RFC 6749 §5.2: all token-endpoint error responses use HTTP 400.
		return jsonError('invalid_grant', 'User no longer authorized', 400);
	}

	if (body.client_id && body.client_id !== refreshData.client_id) {
		return jsonError('invalid_grant', 'client_id mismatch', 400);
	}

	// Mint a fresh access token. Reuse the caller's refresh token (non-rotating).
	const accessToken = generateToken();
	const accessTokenHash = await hashToken(accessToken);
	const tokenExpiresAt = getExpiresAt(TOKEN_TTL_SECONDS);

	const accessData: OAuthTokenData = {
		client_id: refreshData.client_id,
		user_id: refreshData.user_id,
		user_login: refreshData.user_login,
		scope: refreshData.scope,
		expires_at: tokenExpiresAt,
	};
	await env.OAUTH_KV.put(`token:${accessTokenHash}`, JSON.stringify(accessData), {
		expirationTtl: TOKEN_TTL_SECONDS,
	});

	// Update the refresh token record with the new access_token_hash link
	// and last_used_at stamp — single write using the record we already have
	// in hand, avoiding a second (eventually-consistent) KV read. Best-effort:
	// the access token above is the source of truth returned to the client.
	try {
		refreshData.access_token_hash = accessTokenHash;
		refreshData.last_used_at = new Date().toISOString();
		await env.OAUTH_KV.put(`refresh_token:${refreshTokenHash}`, JSON.stringify(refreshData));
	} catch (e) {
		console.warn(`[oauth] Failed to update refresh token metadata (non-fatal): ${e}`);
	}

	// A refresh-token-only client never reaches /authorize, so this and token
	// validation are the only places its registration can be kept alive.
	await slideClientRegistration(env, refreshData.client_id, defer);

	return new Response(
		JSON.stringify({
			access_token: accessToken,
			refresh_token: body.refresh_token,
			token_type: 'Bearer',
			expires_in: TOKEN_TTL_SECONDS,
			scope: refreshData.scope,
			user_login: refreshData.user_login,
		}),
		{
			status: 200,
			headers: {
				'Content-Type': 'application/json',
				'Cache-Control': 'no-store',
				Pragma: 'no-cache',
			},
		}
	);
}

// Client Registration Endpoint
export async function handleRegister(request: Request, env: Env): Promise<Response> {
	if (request.method !== 'POST') {
		return new Response('Method not allowed', { status: 405 });
	}

	if (!env.OAUTH_KV) {
		return jsonError('server_error', 'KV namespace not available', 500);
	}

	let body: { client_name?: string; redirect_uris?: string[] };
	try {
		body = await request.json();
	} catch {
		return jsonError('invalid_request', 'Invalid JSON body', 400);
	}

	if (!body.client_name) {
		return jsonError('invalid_request', 'Missing client_name', 400);
	}

	if (!body.redirect_uris || !Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
		return jsonError('invalid_request', 'Missing or invalid redirect_uris', 400);
	}

	// Reject registration outright if any redirect_uri is outside the host
	// allowlist, so unauthenticated registration cannot stage a phishing target.
	const workerOrigin = new URL(request.url).origin;
	for (const uri of body.redirect_uris) {
		if (typeof uri !== 'string' || !isAllowedRedirectUri(uri, workerOrigin, env.ALLOWED_REDIRECT_HOSTS)) {
			return jsonError('invalid_redirect_uri', `redirect_uri not permitted: ${uri}`, 400);
		}
	}

	// Generate client credentials
	const clientId = generateState();

	const clientData: OAuthClientData = {
		client_id: clientId,
		client_name: body.client_name,
		redirect_uris: body.redirect_uris,
	};

	// TTL-bounded so open, unauthenticated registration cannot grow OAUTH_KV
	// without limit. Clients re-register transparently once a record lapses.
	await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(clientData), {
		expirationTtl: CLIENT_TTL_SECONDS,
	});

	return new Response(
		JSON.stringify({
			client_id: clientId,
			client_name: body.client_name,
			redirect_uris: body.redirect_uris,
		}),
		{
			status: 201,
			headers: { 'Content-Type': 'application/json' },
		}
	);
}

// Whether a requested redirect_uri is covered by a client's registered set.
// Exact string match, except loopback URIs match on scheme+host+path while
// ignoring the port, per RFC 8252 §7.3 — native/CLI clients bind an ephemeral
// port that won't equal the one they registered.
//
// Loopback detection MUST come from the shared isLoopbackHost (IPv4, IPv6, and
// localhost). An inline copy here previously omitted IPv6, so a client that
// registered http://[::1]/callback passed the global allowlist but was then
// rejected by this matcher.
function isLoopbackUrl(u: URL): boolean {
	return isLoopbackHost(u.hostname) && (u.protocol === 'http:' || u.protocol === 'https:');
}

function redirectUriMatchesRegistered(redirectUri: string, registered: string[]): boolean {
	if (registered.includes(redirectUri)) return true;

	let reqUrl: URL;
	try {
		reqUrl = new URL(redirectUri);
	} catch {
		return false;
	}
	if (!isLoopbackUrl(reqUrl)) return false;

	return registered.some((entry) => {
		try {
			const regUrl = new URL(entry);
			return (
				isLoopbackUrl(regUrl) &&
				regUrl.protocol === reqUrl.protocol &&
				regUrl.hostname === reqUrl.hostname &&
				regUrl.pathname === reqUrl.pathname
			);
		} catch {
			return false;
		}
	});
}

function jsonError(error: string, description: string, status: number): Response {
	return new Response(JSON.stringify({ error, error_description: description }), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
	});
}

// Security headers for every HTML page this worker serves. These pages can
// carry a bearer token or authorization code, so:
//  - Referrer-Policy stops the URL leaking to any third party via Referer
//  - CSP denies by default; there is no connect/form/frame surface at all, so
//    even a hypothetical injection has no network path to exfiltrate the token
//  - scripts run only under a per-response nonce (no 'unsafe-inline')
function htmlSecurityHeaders(nonce?: string): Record<string, string> {
	const scriptSrc = nonce ? `'nonce-${nonce}'` : "'none'";
	return {
		'Content-Type': 'text/html; charset=utf-8',
		'Cache-Control': 'no-store',
		'Referrer-Policy': 'no-referrer',
		'X-Content-Type-Options': 'nosniff',
		'X-Frame-Options': 'DENY',
		'Content-Security-Policy': [
			"default-src 'none'",
			"style-src 'unsafe-inline'",
			`script-src ${scriptSrc}`,
			"img-src 'self'",
			"base-uri 'none'",
			"form-action 'none'",
			"frame-ancestors 'none'",
		].join('; '),
	};
}

// Per-response CSP nonce.
function generateNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
}

// Escape HTML special characters to prevent XSS
function escapeHtml(str: string | null | undefined): string {
	if (!str) return '';
	return str
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Render OOB page for explicit headless/SSH OAuth flow (no redirect attempt)
function renderOOBPage(authCode: string, clientState: string | null, _unused: null): Response {
	const nonce = generateNonce();
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="icon" href="/favicon.png" type="image/png">
	<title>Fastmail MCP - Authorization Complete</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}
		.container {
			background: white;
			border-radius: 16px;
			padding: 40px;
			max-width: 500px;
			width: 100%;
			box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
		}
		.icon {
			width: 64px;
			height: 64px;
			background: linear-gradient(135deg, #10b981 0%, #059669 100%);
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 auto 24px;
		}
		.icon svg { width: 32px; height: 32px; fill: white; }
		h1 {
			text-align: center;
			color: #1f2937;
			font-size: 24px;
			margin-bottom: 8px;
		}
		.subtitle {
			text-align: center;
			color: #6b7280;
			margin-bottom: 32px;
		}
		.code-label {
			font-size: 14px;
			font-weight: 600;
			color: #374151;
			margin-bottom: 8px;
		}
		.code-box {
			background: #f3f4f6;
			border: 2px solid #e5e7eb;
			border-radius: 8px;
			padding: 16px;
			font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
			font-size: 14px;
			word-break: break-all;
			color: #1f2937;
			position: relative;
		}
		.copy-btn {
			position: absolute;
			top: 8px;
			right: 8px;
			background: #4f46e5;
			color: white;
			border: none;
			border-radius: 6px;
			padding: 8px 16px;
			font-size: 12px;
			font-weight: 600;
			cursor: pointer;
			transition: all 0.2s;
		}
		.copy-btn:hover { background: #4338ca; }
		.copy-btn.copied { background: #10b981; }
		.instructions {
			margin-top: 24px;
			padding: 16px;
			background: #fef3c7;
			border-radius: 8px;
			border-left: 4px solid #f59e0b;
		}
		.instructions-title {
			font-weight: 600;
			color: #92400e;
			margin-bottom: 8px;
		}
		.instructions ol {
			color: #78350f;
			padding-left: 20px;
			font-size: 14px;
			line-height: 1.6;
		}
		${clientState ? '.state-info { margin-top: 16px; font-size: 12px; color: #9ca3af; }' : ''}
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">
			<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
		</div>
		<h1>Authorization Successful</h1>
		<p class="subtitle">Copy this code and paste it into Claude Code</p>

		<div class="code-label">Authorization Code</div>
		<div class="code-box">
			<code id="authCode">${authCode}</code>
			<button class="copy-btn" id="copyBtn">Copy</button>
		</div>

		<div class="instructions">
			<div class="instructions-title">📋 Next Steps</div>
			<ol>
				<li>Copy the code above</li>
				<li>Return to your terminal (SSH session)</li>
				<li>Paste the code when Claude Code prompts for it</li>
				<li>You can close this browser tab</li>
			</ol>
		</div>
		${clientState ? `<div class="state-info">State: ${escapeHtml(clientState)}</div>` : ''}
	</div>

	<script nonce="${nonce}">
		document.getElementById('copyBtn').addEventListener('click', () => {
			const code = document.getElementById('authCode').textContent;
			navigator.clipboard.writeText(code).then(() => {
				const btn = document.getElementById('copyBtn');
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 2000);
			});
		});
	</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: htmlSecurityHeaders(nonce),
	});
}

// =====================================================
// DIRECT TOKEN FLOW (for SSH/headless scenarios)
// =====================================================
// This flow bypasses Claude Code's OAuth entirely.
// User visits /get-token, authenticates, gets a token to configure manually.

// Initiates direct token flow - redirects to Cloudflare Access
export async function handleGetToken(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.ACCESS_CLIENT_ID) {
		return new Response('OAuth not configured', { status: 500 });
	}

	// Resolve team name: env var takes priority, then query param
	const teamName = env.ACCESS_TEAM_NAME || url.searchParams.get('team_name');
	if (!teamName) {
		return new Response('ACCESS_TEAM_NAME not configured and no team_name parameter provided', { status: 500 });
	}

	// Generate state for CSRF protection (store team_name so callback can use it)
	const state = generateState();
	await env.OAUTH_KV.put(`direct-token-state:${state}`, JSON.stringify({ team_name: teamName }), {
		expirationTtl: STATE_TTL_SECONDS,
	});

	// Redirect to Cloudflare Access
	const accessBaseUrl = getAccessBaseUrl(teamName);
	const accessAuthUrl = `${accessBaseUrl}/${env.ACCESS_CLIENT_ID}/authorization`;
	const accessParams = new URLSearchParams({
		client_id: env.ACCESS_CLIENT_ID,
		redirect_uri: `${url.origin}/get-token/callback`,
		response_type: 'code',
		scope: 'openid email profile',
		state,
	});

	return new Response(null, {
		status: 302,
		headers: { Location: `${accessAuthUrl}?${accessParams.toString()}` },
	});
}

// Callback for direct token flow - generates token and displays it
export async function handleGetTokenCallback(request: Request, env: Env, url: URL): Promise<Response> {
	if (!env.OAUTH_KV || !env.ACCESS_CLIENT_ID || !env.ACCESS_CLIENT_SECRET) {
		return new Response('OAuth not configured', { status: 500 });
	}

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const error = url.searchParams.get('error');

	if (error) {
		return new Response(`OAuth error: ${error}`, { status: 400 });
	}

	if (!code || !state) {
		return new Response('Missing code or state', { status: 400 });
	}

	// Validate state and extract stored data (includes team_name)
	const stateDataJson = await env.OAUTH_KV.get(`direct-token-state:${state}`);
	if (!stateDataJson) {
		return new Response('Invalid or expired state', { status: 400 });
	}
	await env.OAUTH_KV.delete(`direct-token-state:${state}`);

	// Parse stored state — may be 'pending' (legacy) or JSON with team_name
	let storedTeamName: string | null = null;
	try {
		const parsed = JSON.parse(stateDataJson);
		storedTeamName = parsed.team_name || null;
	} catch {
		// Legacy format: plain string 'pending'
	}

	try {
		// Exchange code for tokens with Cloudflare Access
		const teamName = storedTeamName || env.ACCESS_TEAM_NAME;
		if (!teamName) {
			throw new Error('ACCESS_TEAM_NAME not available');
		}
		const accessBaseUrl = getAccessBaseUrl(teamName);
		const tokenUrl = `${accessBaseUrl}/${env.ACCESS_CLIENT_ID}/token`;
		const tokenResponse = await fetch(tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				client_id: env.ACCESS_CLIENT_ID,
				client_secret: env.ACCESS_CLIENT_SECRET,
				code,
				redirect_uri: `${url.origin}/get-token/callback`,
			}),
		});

		if (!tokenResponse.ok) {
			const errorText = await tokenResponse.text();
			throw new Error(`Failed to exchange code: ${errorText}`);
		}

		const tokenData = (await tokenResponse.json()) as { id_token?: string; error?: string };
		if (tokenData.error || !tokenData.id_token) {
			throw new Error(tokenData.error || 'No ID token received');
		}

		const userInfo = await verifyAccessIdToken(tokenData.id_token, {
			teamName,
			clientId: env.ACCESS_CLIENT_ID,
		});
		const userEmail = userInfo.email;

		// Check if user is allowed
		if (!isUserAllowed(userEmail, env.ALLOWED_USERS || '')) {
			return renderDirectTokenError(`User ${userEmail} is not authorized`);
		}

		// Generate access token for MCP
		const accessToken = generateToken();
		const tokenHash = await hashToken(accessToken);
		const tokenExpiresAt = getExpiresAt(TOKEN_TTL_SECONDS);

		const mcpTokenData: OAuthTokenData = {
			client_id: 'direct-token',
			user_id: userInfo.sub,
			user_login: userEmail,
			scope: DEFAULT_SCOPE,
			expires_at: tokenExpiresAt,
		};

		await env.OAUTH_KV.put(`token:${tokenHash}`, JSON.stringify(mcpTokenData), {
			expirationTtl: TOKEN_TTL_SECONDS,
		});

		// Calculate expiry for display
		const expiryDate = new Date(tokenExpiresAt);
		const expiryString = expiryDate.toLocaleDateString('en-US', {
			month: 'long', day: 'numeric', year: 'numeric'
		});

		return renderDirectTokenSuccess(accessToken, userEmail, expiryString, url.origin);
	} catch (err) {
		const message = err instanceof Error ? err.message : 'Unknown error';
		return renderDirectTokenError(message);
	}
}

function renderDirectTokenSuccess(token: string, email: string, expiry: string, origin: string): Response {
	const nonce = generateNonce();
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="icon" href="/favicon.png" type="image/png">
	<title>Fastmail MCP - Token Generated</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}
		.container {
			background: white;
			border-radius: 16px;
			padding: 40px;
			max-width: 700px;
			width: 100%;
			box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.25);
		}
		.icon {
			width: 64px;
			height: 64px;
			background: linear-gradient(135deg, #10b981 0%, #059669 100%);
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 auto 24px;
		}
		.icon svg { width: 32px; height: 32px; fill: white; }
		h1 { text-align: center; color: #1f2937; font-size: 24px; margin-bottom: 8px; }
		.subtitle { text-align: center; color: #6b7280; margin-bottom: 24px; }
		.user-info {
			text-align: center;
			padding: 12px;
			background: #f0fdf4;
			border-radius: 8px;
			color: #166534;
			margin-bottom: 24px;
			font-size: 14px;
		}
		.section { margin-bottom: 24px; }
		.section-title { font-weight: 600; color: #374151; margin-bottom: 8px; font-size: 14px; }
		.token-box {
			background: #1f2937;
			border-radius: 8px;
			padding: 16px;
			font-family: 'SF Mono', monospace;
			font-size: 12px;
			color: #10b981;
			word-break: break-all;
			position: relative;
		}
		.copy-btn {
			position: absolute;
			top: 8px;
			right: 8px;
			background: #4f46e5;
			color: white;
			border: none;
			border-radius: 6px;
			padding: 6px 12px;
			font-size: 11px;
			font-weight: 600;
			cursor: pointer;
		}
		.copy-btn:hover { background: #4338ca; }
		.copy-btn.copied { background: #10b981; }
		.command-box {
			background: #f3f4f6;
			border-radius: 8px;
			padding: 12px 16px;
			font-family: 'SF Mono', monospace;
			font-size: 12px;
			color: #1f2937;
			overflow-x: auto;
			white-space: nowrap;
		}
		.warning {
			padding: 16px;
			background: #fef3c7;
			border-radius: 8px;
			border-left: 4px solid #f59e0b;
			font-size: 14px;
			color: #92400e;
		}
		.warning-title { font-weight: 600; margin-bottom: 4px; }
		.expiry { text-align: center; color: #6b7280; font-size: 13px; margin-top: 16px; }
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">
			<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
		</div>
		<h1>Token Generated Successfully</h1>
		<p class="subtitle">Use this token to configure Fastmail MCP in Claude Code</p>

		<div class="user-info">✓ Authenticated as ${escapeHtml(email)}</div>

		<div class="section">
			<div class="section-title">Your Access Token</div>
			<div class="token-box">
				<code id="token">${token}</code>
				<button class="copy-btn" id="copyBtn">Copy</button>
			</div>
		</div>

		<div class="section">
			<div class="section-title">Add to Claude Code</div>
			<div class="command-box">
				claude mcp add --transport http fastmail-remote ${origin}/mcp --header "Authorization: Bearer ${token}"
			</div>
		</div>

		<div class="warning">
			<div class="warning-title">⚠️ Keep this token secret</div>
			This token grants full access to your Fastmail account via MCP. Don't share it.
		</div>

		<p class="expiry">Token expires: ${expiry}</p>
	</div>

	<script nonce="${nonce}">
		document.getElementById('copyBtn').addEventListener('click', () => {
			navigator.clipboard.writeText(document.getElementById('token').textContent).then(() => {
				const btn = document.getElementById('copyBtn');
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 2000);
			});
		});
	</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: htmlSecurityHeaders(nonce),
	});
}

function renderDirectTokenError(message: string): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<link rel="icon" href="/favicon.png" type="image/png">
	<title>Fastmail MCP - Error</title>
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%);
			min-height: 100vh;
			display: flex;
			align-items: center;
			justify-content: center;
			padding: 20px;
		}
		.container {
			background: white;
			border-radius: 16px;
			padding: 40px;
			max-width: 500px;
			width: 100%;
			text-align: center;
		}
		.icon {
			width: 64px;
			height: 64px;
			background: #fecaca;
			border-radius: 50%;
			display: flex;
			align-items: center;
			justify-content: center;
			margin: 0 auto 24px;
		}
		.icon svg { width: 32px; height: 32px; fill: #dc2626; }
		h1 { color: #1f2937; font-size: 24px; margin-bottom: 16px; }
		.message { color: #6b7280; margin-bottom: 24px; }
		.retry {
			display: inline-block;
			background: #4f46e5;
			color: white;
			padding: 12px 24px;
			border-radius: 8px;
			text-decoration: none;
			font-weight: 600;
		}
		.retry:hover { background: #4338ca; }
	</style>
</head>
<body>
	<div class="container">
		<div class="icon">
			<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
		</div>
		<h1>Token Generation Failed</h1>
		<p class="message">${escapeHtml(message)}</p>
		<a href="/get-token" class="retry">Try Again</a>
	</div>
</body>
</html>`;

	return new Response(html, {
		status: 400,
		headers: htmlSecurityHeaders(),
	});
}
