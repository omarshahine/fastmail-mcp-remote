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

	// Validate redirect URI (allow HTTPS, localhost, or OOB URIs for headless flows)
	const isOOBUri = redirectUri === 'urn:ietf:wg:oauth:2.0:oob' || redirectUri.startsWith('oob:');
	if (!isOOBUri) {
		try {
			const redirectUrl = new URL(redirectUri);
			if (redirectUrl.protocol !== 'https:' && redirectUrl.hostname !== 'localhost' && redirectUrl.hostname !== '127.0.0.1') {
				return new Response('Invalid redirect_uri', { status: 400 });
			}
		} catch {
			return new Response('Invalid redirect_uri', { status: 400 });
		}
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

		// Check for explicit OOB (Out-of-Band) mode
		const isExplicitOOB = stateResult.redirect_uri === 'urn:ietf:wg:oauth:2.0:oob' ||
			stateResult.redirect_uri.startsWith('oob:');

		if (isExplicitOOB) {
			// Display the code on a page for manual copy-paste (SSH/headless flow)
			return renderOOBPage(authCode, clientState, null);
		}

		// Build redirect URL
		const redirectUrl = new URL(stateResult.redirect_uri);
		redirectUrl.searchParams.set('code', authCode);
		if (clientState) redirectUrl.searchParams.set('state', clientState);

		// For localhost redirects, show a hybrid page that:
		// 1. Attempts the redirect automatically
		// 2. Shows the code for manual copy if redirect fails (SSH scenarios)
		try {
			const parsedRedirect = new URL(stateResult.redirect_uri);
			if (parsedRedirect.hostname === 'localhost' || parsedRedirect.hostname === '127.0.0.1') {
				return renderHybridPage(authCode, clientState, redirectUrl.toString());
			}
		} catch {
			// Invalid URL, fall through to normal redirect
		}

		// Normal redirect for HTTPS endpoints
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

// Render hybrid page for localhost redirects - tries redirect but shows code as fallback
function renderHybridPage(authCode: string, clientState: string | null, redirectUrl: string): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
			max-width: 540px;
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
		.spinner {
			display: none;
			width: 64px;
			height: 64px;
			border: 4px solid #e5e7eb;
			border-top-color: #4f46e5;
			border-radius: 50%;
			animation: spin 1s linear infinite;
			margin: 0 auto 24px;
		}
		@keyframes spin { to { transform: rotate(360deg); } }
		h1 {
			text-align: center;
			color: #1f2937;
			font-size: 24px;
			margin-bottom: 8px;
		}
		.subtitle {
			text-align: center;
			color: #6b7280;
			margin-bottom: 24px;
		}
		.redirect-status {
			text-align: center;
			padding: 16px;
			background: #f0fdf4;
			border-radius: 8px;
			color: #166534;
			margin-bottom: 24px;
		}
		.redirect-failed {
			background: #fef3c7;
			color: #92400e;
		}
		.divider {
			display: flex;
			align-items: center;
			margin: 24px 0;
			color: #9ca3af;
			font-size: 14px;
		}
		.divider::before, .divider::after {
			content: '';
			flex: 1;
			height: 1px;
			background: #e5e7eb;
		}
		.divider span { padding: 0 16px; }
		.code-section { display: none; }
		.code-section.visible { display: block; }
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
			padding-right: 80px;
			font-family: 'SF Mono', SFMono-Regular, ui-monospace, Menlo, monospace;
			font-size: 13px;
			word-break: break-all;
			color: #1f2937;
			position: relative;
		}
		.copy-btn {
			position: absolute;
			top: 50%;
			right: 8px;
			transform: translateY(-50%);
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
		.toggle-manual {
			display: block;
			text-align: center;
			color: #4f46e5;
			cursor: pointer;
			font-size: 14px;
			margin-top: 16px;
		}
		.toggle-manual:hover { text-decoration: underline; }
	</style>
</head>
<body>
	<div class="container">
		<div class="icon" id="successIcon">
			<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
		</div>
		<div class="spinner" id="spinner"></div>

		<h1>Authorization Successful</h1>
		<p class="subtitle" id="subtitle">Redirecting to Claude Code...</p>

		<div class="redirect-status" id="redirectStatus">
			<span id="statusText">⏳ Completing authorization...</span>
		</div>

		<div class="code-section" id="codeSection">
			<div class="divider"><span>or copy manually</span></div>
			<div class="code-label">Authorization Code</div>
			<div class="code-box">
				<code id="authCode">${authCode}</code>
				<button class="copy-btn" onclick="copyCode()">Copy</button>
			</div>
		</div>

		<a class="toggle-manual" id="toggleManual" onclick="showManual()">
			Using SSH? Click here to copy the code manually
		</a>
	</div>

	<script>
		const redirectUrl = ${JSON.stringify(redirectUrl)};
		let redirectAttempted = false;

		function attemptRedirect() {
			if (redirectAttempted) return;
			redirectAttempted = true;

			document.getElementById('spinner').style.display = 'block';
			document.getElementById('successIcon').style.display = 'none';

			// Try to redirect
			const startTime = Date.now();
			window.location.href = redirectUrl;

			// If still on this page after 2 seconds, show manual option
			setTimeout(() => {
				if (document.visibilityState !== 'hidden') {
					showManualWithError();
				}
			}, 2000);
		}

		function showManual() {
			document.getElementById('codeSection').classList.add('visible');
			document.getElementById('toggleManual').style.display = 'none';
		}

		function showManualWithError() {
			document.getElementById('spinner').style.display = 'none';
			document.getElementById('successIcon').style.display = 'flex';
			document.getElementById('subtitle').textContent = 'Copy this code and paste it into Claude Code';
			document.getElementById('redirectStatus').classList.add('redirect-failed');
			document.getElementById('statusText').textContent = '⚠️ Redirect failed - copy the code below instead';
			document.getElementById('codeSection').classList.add('visible');
			document.getElementById('toggleManual').style.display = 'none';
		}

		function copyCode() {
			const code = document.getElementById('authCode').textContent;
			navigator.clipboard.writeText(code).then(() => {
				const btn = document.querySelector('.copy-btn');
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 2000);
			});
		}

		// Start redirect attempt after brief delay
		setTimeout(attemptRedirect, 500);
	</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}

// Render OOB page for explicit headless/SSH OAuth flow (no redirect attempt)
function renderOOBPage(authCode: string, clientState: string | null, _unused: null): Response {
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
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
			<button class="copy-btn" onclick="copyCode()">Copy</button>
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
		${clientState ? `<div class="state-info">State: ${clientState}</div>` : ''}
	</div>

	<script>
		function copyCode() {
			const code = document.getElementById('authCode').textContent;
			navigator.clipboard.writeText(code).then(() => {
				const btn = document.querySelector('.copy-btn');
				btn.textContent = 'Copied!';
				btn.classList.add('copied');
				setTimeout(() => {
					btn.textContent = 'Copy';
					btn.classList.remove('copied');
				}, 2000);
			});
		}
	</script>
</body>
</html>`;

	return new Response(html, {
		status: 200,
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			'Cache-Control': 'no-store',
		},
	});
}
