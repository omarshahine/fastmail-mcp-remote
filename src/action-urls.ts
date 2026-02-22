/**
 * HMAC-SHA256 signed action URLs for reading digest email actions.
 *
 * Generates time-limited, tamper-proof URLs that let the digest HTML page
 * archive/delete emails directly without needing MCP OAuth tokens.
 *
 * Signature payload: "{action}:{emailId}:{mid}:{exp}"
 * Uses Web Crypto API (native in Cloudflare Workers).
 */

const ACTION_URL_TTL = 86400; // 24 hours

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hexToBuffer(hex: string): ArrayBuffer {
	const bytes = new Uint8Array(hex.length / 2);
	for (let i = 0; i < hex.length; i += 2) {
		bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
	}
	return bytes.buffer;
}

function bufferToHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

// ─── Signing ─────────────────────────────────────────────────────────────────

async function importKey(signingKey: string): Promise<CryptoKey> {
	return crypto.subtle.importKey(
		'raw',
		hexToBuffer(signingKey),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
}

function buildPayload(action: string, emailId: string, mid: string, exp: number): string {
	return `${action}:${emailId}:${mid}:${exp}`;
}

export async function signAction(
	action: string,
	emailId: string,
	mid: string,
	exp: number,
	signingKey: string,
): Promise<string> {
	const key = await importKey(signingKey);
	const payload = buildPayload(action, emailId, mid, exp);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
	return bufferToHex(sig);
}

export async function verifyAction(
	action: string,
	emailId: string,
	mid: string,
	exp: number,
	sig: string,
	signingKey: string,
): Promise<boolean> {
	// Check expiry first
	if (Date.now() / 1000 > exp) return false;

	const key = await importKey(signingKey);
	const payload = buildPayload(action, emailId, mid, exp);
	const expected = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));

	// Constant-time comparison via verify
	return crypto.subtle.verify('HMAC', key, expected, new TextEncoder().encode(bufferToHex(expected)).buffer)
		.then(() => sig === bufferToHex(expected));
}

// ─── URL Generation ──────────────────────────────────────────────────────────

export interface ActionUrls {
	archiveUrl: string;
	deleteUrl: string;
}

/** KV key for a single-use action nonce. Deleted on first use. */
export function nonceKey(sig: string): string {
	return `action-nonce:${sig}`;
}

export async function generateActionUrls(
	emailIds: string[],
	archiveMailboxId: string,
	workerUrl: string,
	signingKey: string,
	kv: KVNamespace,
): Promise<Record<string, ActionUrls>> {
	const exp = Math.floor(Date.now() / 1000) + ACTION_URL_TTL;
	const result: Record<string, ActionUrls> = {};

	for (const emailId of emailIds) {
		const archiveSig = await signAction('archive', emailId, archiveMailboxId, exp, signingKey);
		const deleteSig = await signAction('delete', emailId, '', exp, signingKey);

		// Store nonces in KV — consumed on first use, auto-expire with TTL
		await kv.put(nonceKey(archiveSig), '1', { expirationTtl: ACTION_URL_TTL });
		await kv.put(nonceKey(deleteSig), '1', { expirationTtl: ACTION_URL_TTL });

		result[emailId] = {
			archiveUrl: `${workerUrl}/api/action/archive/${encodeURIComponent(emailId)}?mid=${encodeURIComponent(archiveMailboxId)}&exp=${exp}&sig=${archiveSig}`,
			deleteUrl: `${workerUrl}/api/action/delete/${encodeURIComponent(emailId)}?exp=${exp}&sig=${deleteSig}`,
		};
	}

	return result;
}
