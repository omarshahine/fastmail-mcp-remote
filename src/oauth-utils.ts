/**
 * OAuth Utilities for MCP Server (KV-based)
 * Adapted from travel-hub for KV storage instead of D1
 */

// Configuration
// Add allowed user emails here (lowercase)
// ALLOWED_USERS is now configured via environment variable
// Set ALLOWED_USERS in wrangler.jsonc as comma-separated emails
export const STATE_TTL_SECONDS = 600; // 10 minutes
export const CODE_TTL_SECONDS = 60; // 1 minute
export const TOKEN_TTL_SECONDS = 86400 * 30; // 30 days
export const DEFAULT_SCOPE = 'mcp:read mcp:write';

// Build Access base URL from team name (set via ACCESS_TEAM_NAME env var)
export function getAccessBaseUrl(teamName: string): string {
	return `https://${teamName}.cloudflareaccess.com/cdn-cgi/access/sso/oidc`;
}

// Generate cryptographically secure random string
export function generateRandomString(length: number): string {
	const array = new Uint8Array(length);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Generate OAuth state
export function generateState(): string {
	return generateRandomString(32);
}

// Generate authorization code
export function generateCode(): string {
	return generateRandomString(32);
}

// Generate access token
export function generateToken(): string {
	return generateRandomString(48);
}

// Hash token using SHA-256
export async function hashToken(token: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(token);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Calculate expiration timestamp
export function getExpiresAt(ttlSeconds: number): string {
	const now = new Date();
	now.setSeconds(now.getSeconds() + ttlSeconds);
	return now.toISOString();
}

// Check if timestamp has expired
export function isExpired(expiresAt: string): boolean {
	return new Date(expiresAt) < new Date();
}

// Check if user is allowed (by email)
// allowedUsers is a comma-separated string from env var
export function isUserAllowed(email: string, allowedUsers: string): boolean {
	if (!allowedUsers) return false;
	const allowed = new Set(allowedUsers.split(',').map(e => e.trim().toLowerCase()));
	return allowed.has(email.toLowerCase());
}

// PKCE: Generate code challenge from verifier
export async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = new Uint8Array(hashBuffer);
	const base64 = btoa(String.fromCharCode(...hashArray));
	return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// PKCE: Verify code verifier against challenge
export async function verifyCodeChallenge(verifier: string, challenge: string, method: string): Promise<boolean> {
	if (method === 'plain') {
		return verifier === challenge;
	}
	if (method === 'S256') {
		const computed = await generateCodeChallenge(verifier);
		return computed === challenge;
	}
	return false;
}

// KV data types
export interface OAuthStateData {
	client_id: string;
	redirect_uri: string;
	scope: string;
	code_challenge: string | null;
	code_challenge_method: string | null;
	expires_at: string;
	team_name?: string | null;
}

export interface OAuthCodeData {
	client_id: string;
	user_id: string;
	user_login: string;
	user_email: string;
	scope: string | null;
	redirect_uri: string;
	code_challenge: string | null;
	code_challenge_method: string | null;
	expires_at: string;
	used: boolean;
}

export interface OAuthTokenData {
	client_id: string;
	user_id: string;
	user_login: string;
	scope: string | null;
	expires_at: string;
}

export interface OAuthClientData {
	client_id: string;
	client_name: string;
	redirect_uris: string[];
}

// Validate access token (KV-based)
export async function validateAccessToken(
	kv: KVNamespace,
	token: string
): Promise<{ user_id: string; user_login: string; scope: string | null } | null> {
	const tokenHash = await hashToken(token);
	const data = await kv.get<OAuthTokenData>(`token:${tokenHash}`, 'json');

	if (!data || isExpired(data.expires_at)) {
		return null;
	}

	return {
		user_id: data.user_id,
		user_login: data.user_login,
		scope: data.scope,
	};
}
