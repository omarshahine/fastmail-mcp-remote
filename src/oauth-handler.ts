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
	verifyCodeChallenge,
	STATE_TTL_SECONDS,
	CODE_TTL_SECONDS,
	TOKEN_TTL_SECONDS,
	DEFAULT_SCOPE,
	getAccessBaseUrl,
	type OAuthStateData,
	type OAuthCodeData,
	type OAuthTokenData,
	type OAuthClientData,
} from './oauth-utils';

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
		grant_types_supported: ['authorization_code'],
		token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
		code_challenge_methods_supported: ['S256', 'plain'],
		service_documentation: 'https://github.com/your-username/fastmail-mcp-remote',
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

	// Validate PKCE if provided
	if (codeChallenge && codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
		return new Response('Invalid code_challenge_method', { status: 400 });
	}

	// Validate redirect URI (allow HTTPS or localhost)
	try {
		const redirectUrl = new URL(redirectUri);
		if (redirectUrl.protocol !== 'https:' && redirectUrl.hostname !== 'localhost' && redirectUrl.hostname !== '127.0.0.1') {
			return new Response('Invalid redirect_uri', { status: 400 });
		}
	} catch {
		return new Response('Invalid redirect_uri', { status: 400 });
	}

	// Generate state and store OAuth parameters in KV
	const state = generateState();
	const combinedState = clientState ? `${state}:${clientState}` : state;
	const expiresAt = getExpiresAt(STATE_TTL_SECONDS);

	const stateData: OAuthStateData = {
		client_id: clientId,
		redirect_uri: redirectUri,
		scope,
		code_challenge: codeChallenge,
		code_challenge_method: codeChallengeMethod,
		expires_at: expiresAt,
	};

	await env.OAUTH_KV.put(`state:${state}`, JSON.stringify(stateData), {
		expirationTtl: STATE_TTL_SECONDS,
	});

	// Build Cloudflare Access OAuth URL
	if (!env.ACCESS_TEAM_NAME) {
		return new Response('ACCESS_TEAM_NAME not configured', { status: 500 });
	}
	const accessBaseUrl = getAccessBaseUrl(env.ACCESS_TEAM_NAME);
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
		const accessBaseUrl = getAccessBaseUrl(env.ACCESS_TEAM_NAME!);
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

		// Decode ID token to get user info
		const idToken = tokenData.id_token!;
		const parts = idToken.split('.');
		const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
		const userInfo = { sub: payload.sub, email: payload.email, name: payload.name };

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

		// Redirect back to client with authorization code
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
export async function handleToken(request: Request, env: Env): Promise<Response> {
	if (!env.OAUTH_KV) {
		return jsonError('server_error', 'KV namespace not available', 500);
	}

	let body: { grant_type?: string; code?: string; redirect_uri?: string; client_id?: string; code_verifier?: string };

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
		};
	} else {
		return jsonError('invalid_request', 'Unsupported Content-Type', 400);
	}

	if (body.grant_type !== 'authorization_code') {
		return jsonError('unsupported_grant_type', 'Only authorization_code grant is supported', 400);
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

	// Validate PKCE if code challenge was provided
	if (authCode.code_challenge) {
		if (!body.code_verifier) {
			return jsonError('invalid_request', 'Missing code_verifier for PKCE', 400);
		}

		const isValid = await verifyCodeChallenge(body.code_verifier, authCode.code_challenge, authCode.code_challenge_method || 'plain');
		if (!isValid) {
			return jsonError('invalid_grant', 'Invalid code_verifier', 400);
		}
	}

	// Generate access token
	const accessToken = generateToken();
	const tokenHash = await hashToken(accessToken);
	const tokenExpiresAt = getExpiresAt(TOKEN_TTL_SECONDS);

	const tokenData: OAuthTokenData = {
		client_id: authCode.client_id,
		user_id: authCode.user_id,
		user_login: authCode.user_login,
		scope: authCode.scope,
		expires_at: tokenExpiresAt,
	};

	await env.OAUTH_KV.put(`token:${tokenHash}`, JSON.stringify(tokenData), {
		expirationTtl: TOKEN_TTL_SECONDS,
	});

	return new Response(
		JSON.stringify({
			access_token: accessToken,
			token_type: 'Bearer',
			expires_in: TOKEN_TTL_SECONDS,
			scope: authCode.scope,
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

	// Generate client credentials
	const clientId = generateState();

	const clientData: OAuthClientData = {
		client_id: clientId,
		client_name: body.client_name,
		redirect_uris: body.redirect_uris,
	};

	// Store in KV (no expiration for clients)
	await env.OAUTH_KV.put(`client:${clientId}`, JSON.stringify(clientData));

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

function jsonError(error: string, description: string, status: number): Response {
	return new Response(JSON.stringify({ error, error_description: description }), {
		status,
		headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Pragma: 'no-cache' },
	});
}
