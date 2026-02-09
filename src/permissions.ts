/**
 * Role-based delegate permissions for MCP tools.
 *
 * Enforces two layers of access control:
 *   1. Role-based: admin (full access) vs delegate (read + inbox management + drafts)
 *   2. Category-based: per-user disabled categories (e.g., hide calendar/contacts)
 *
 * Config is stored in KV under "config:permissions" and cached for 5 minutes.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'delegate';

export type ToolCategory =
	| 'EMAIL_READ'
	| 'CONTACTS'
	| 'CALENDAR_READ'
	| 'CALENDAR_WRITE'
	| 'INBOX_MANAGE'
	| 'DRAFT'
	| 'REPLY'
	| 'SEND'
	| 'META';

export interface UserConfig {
	role: Role;
	disabled_categories: ToolCategory[];
}

export interface PermissionsConfig {
	users: Record<string, UserConfig>;
	default_role: Role;
	default_disabled_categories: ToolCategory[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Map every MCP tool name to its category. */
export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
	// EMAIL_READ
	list_mailboxes: 'EMAIL_READ',
	list_emails: 'EMAIL_READ',
	get_email: 'EMAIL_READ',
	search_emails: 'EMAIL_READ',
	get_recent_emails: 'EMAIL_READ',
	get_email_attachments: 'EMAIL_READ',
	download_attachment: 'EMAIL_READ',
	advanced_search: 'EMAIL_READ',
	get_thread: 'EMAIL_READ',
	get_mailbox_stats: 'EMAIL_READ',
	get_account_summary: 'EMAIL_READ',
	list_identities: 'EMAIL_READ',

	// CONTACTS
	list_contacts: 'CONTACTS',
	get_contact: 'CONTACTS',
	search_contacts: 'CONTACTS',

	// CALENDAR_READ
	list_calendars: 'CALENDAR_READ',
	list_calendar_events: 'CALENDAR_READ',
	get_calendar_event: 'CALENDAR_READ',

	// CALENDAR_WRITE
	create_calendar_event: 'CALENDAR_WRITE',

	// INBOX_MANAGE
	mark_email_read: 'INBOX_MANAGE',
	flag_email: 'INBOX_MANAGE',
	delete_email: 'INBOX_MANAGE',
	move_email: 'INBOX_MANAGE',
	bulk_mark_read: 'INBOX_MANAGE',
	bulk_move: 'INBOX_MANAGE',
	bulk_delete: 'INBOX_MANAGE',
	bulk_flag: 'INBOX_MANAGE',

	// DRAFT
	create_draft: 'DRAFT',

	// REPLY (dual behavior — checked specially for sendImmediately)
	reply_to_email: 'REPLY',

	// SEND
	send_email: 'SEND',

	// META
	check_function_availability: 'META',
};

/** Categories that a delegate role is allowed to use. */
const DELEGATE_ALLOWED_CATEGORIES: Set<ToolCategory> = new Set([
	'EMAIL_READ',
	'CONTACTS',
	'CALENDAR_READ',
	'INBOX_MANAGE',
	'DRAFT',
	'REPLY',
	'META',
]);

/** Actionable error hints for denied tools. */
const DENIAL_HINTS: Record<string, string> = {
	send_email: "Use 'create_draft' to compose emails as drafts instead.",
	create_calendar_event: 'Calendar write access is not available for delegate accounts.',
	reply_to_email: "Use 'reply_to_email' without sendImmediately:true to create a draft reply instead.",
};

// ─── KV Cache ───────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let cachedConfig: PermissionsConfig | null = null;
let cachedAt = 0;

const DEFAULT_CONFIG: PermissionsConfig = {
	users: {},
	default_role: 'admin',
	default_disabled_categories: [],
};

/** Load permissions config from KV with 5-minute module-level cache. */
export async function getPermissionsConfig(kv: KVNamespace): Promise<PermissionsConfig> {
	const now = Date.now();
	if (cachedConfig && now - cachedAt < CACHE_TTL_MS) {
		return cachedConfig;
	}

	const data = await kv.get<PermissionsConfig>('config:permissions', 'json');
	cachedConfig = data ?? DEFAULT_CONFIG;
	cachedAt = now;
	return cachedConfig;
}

/** Exposed for testing — resets the module-level cache. */
export function _resetCache(): void {
	cachedConfig = null;
	cachedAt = 0;
}

// ─── User Config ────────────────────────────────────────────────────────────

/** Resolve a user's config. Case-insensitive email lookup; falls back to defaults. */
export function getUserConfig(config: PermissionsConfig, email: string): UserConfig {
	const normalized = email.toLowerCase();
	// Config keys may be any case — normalize for lookup
	for (const [key, value] of Object.entries(config.users)) {
		if (key.toLowerCase() === normalized) {
			return value;
		}
	}
	return {
		role: config.default_role,
		disabled_categories: config.default_disabled_categories,
	};
}

// ─── Permission Checks ─────────────────────────────────────────────────────

export interface PermissionResult {
	allowed: boolean;
	error?: string;
}

/**
 * Check if a specific tool call is allowed for a user.
 *
 * Checks both:
 *   1. disabled_categories — tool's category is explicitly disabled for this user
 *   2. role-based denial — delegate can't use SEND or CALENDAR_WRITE
 *
 * Special case: reply_to_email with sendImmediately:true is denied for delegates.
 */
export function isToolAllowed(
	userConfig: UserConfig,
	toolName: string,
	args?: Record<string, unknown>,
): PermissionResult {
	const category = TOOL_CATEGORIES[toolName];
	if (!category) {
		// Unknown tool — allow (could be a new tool not yet categorized)
		return { allowed: true };
	}

	// Check disabled categories first (applies to ALL roles)
	if (userConfig.disabled_categories.includes(category)) {
		return {
			allowed: false,
			error: `Permission denied: '${toolName}' is disabled for your account (category: ${category}).`,
		};
	}

	// Admin bypasses role checks
	if (userConfig.role === 'admin') {
		return { allowed: true };
	}

	// Delegate role checks
	if (!DELEGATE_ALLOWED_CATEGORIES.has(category)) {
		const hint = DENIAL_HINTS[toolName] || '';
		return {
			allowed: false,
			error: `Permission denied: '${toolName}' is not available for delegate accounts.${hint ? ` ${hint}` : ''}`,
		};
	}

	// Special case: reply_to_email with sendImmediately:true
	if (toolName === 'reply_to_email' && args?.sendImmediately === true) {
		return {
			allowed: false,
			error: `Permission denied: '${toolName}' with sendImmediately:true is not available for delegate accounts. ${DENIAL_HINTS.reply_to_email}`,
		};
	}

	return { allowed: true };
}

/**
 * Return the set of tool names visible to a user (for tools/list filtering).
 * Excludes tools whose category is disabled OR denied by role.
 */
export function getVisibleTools(userConfig: UserConfig): Set<string> {
	const visible = new Set<string>();
	for (const [toolName, category] of Object.entries(TOOL_CATEGORIES)) {
		// Skip disabled categories
		if (userConfig.disabled_categories.includes(category)) continue;

		// Skip role-denied categories for delegate
		if (userConfig.role === 'delegate' && !DELEGATE_ALLOWED_CATEGORIES.has(category)) continue;

		visible.add(toolName);
	}
	return visible;
}

// ─── Hono-Level Interception ────────────────────────────────────────────────

/**
 * Check a tools/call request and return a JSON-RPC error Response if denied.
 * Returns null if the request is allowed (or is not a tools/call).
 *
 * Clones the request internally so the original body remains unconsumed.
 */
export async function checkMcpPermissions(
	request: Request,
	userLogin: string,
	kv: KVNamespace,
): Promise<Response | null> {
	// Only intercept POST requests (JSON-RPC)
	if (request.method !== 'POST') return null;

	let body: unknown;
	try {
		body = await request.clone().json();
	} catch {
		// Not JSON — let it through
		return null;
	}

	// JSON-RPC can be an object or an array (batch)
	const messages = Array.isArray(body) ? body : [body];

	const config = await getPermissionsConfig(kv);
	const userConfig = getUserConfig(config, userLogin);

	for (const msg of messages) {
		if (
			typeof msg !== 'object' ||
			msg === null ||
			(msg as Record<string, unknown>).method !== 'tools/call'
		) {
			continue;
		}

		const params = (msg as Record<string, unknown>).params as Record<string, unknown> | undefined;
		const toolName = params?.name as string | undefined;
		if (!toolName) continue;

		const args = params?.arguments as Record<string, unknown> | undefined;
		const result = isToolAllowed(userConfig, toolName, args);

		if (!result.allowed) {
			const id = (msg as Record<string, unknown>).id ?? null;
			return new Response(
				JSON.stringify({
					jsonrpc: '2.0',
					id,
					error: {
						code: -32600,
						message: result.error,
					},
				}),
				{
					status: 200,
					headers: { 'Content-Type': 'application/json' },
				},
			);
		}
	}

	return null;
}

/**
 * Filter a tools/list response to hide tools from disabled/denied categories.
 * If the response is not a tools/list result, passes through unchanged.
 */
export async function filterToolsListResponse(
	response: Response,
	userLogin: string,
	kv: KVNamespace,
): Promise<Response> {
	// Only filter JSON responses
	const contentType = response.headers.get('content-type') || '';
	if (!contentType.includes('application/json')) return response;

	let body: unknown;
	try {
		body = await response.clone().json();
	} catch {
		return response;
	}

	// Check if this is a tools/list result (has result.tools array)
	if (
		typeof body !== 'object' ||
		body === null ||
		!('result' in (body as Record<string, unknown>))
	) {
		return response;
	}

	const result = (body as Record<string, unknown>).result as Record<string, unknown> | undefined;
	if (!result || !Array.isArray(result.tools)) return response;

	const config = await getPermissionsConfig(kv);
	const userConfig = getUserConfig(config, userLogin);
	const visible = getVisibleTools(userConfig);

	// Filter tools
	const filteredTools = (result.tools as Array<Record<string, unknown>>).filter(
		(tool) => {
			const name = tool.name as string;
			// Allow tools not in our category map (future tools)
			return !TOOL_CATEGORIES[name] || visible.has(name);
		},
	);

	// Reconstruct response with filtered tools
	const filteredBody = {
		...(body as Record<string, unknown>),
		result: {
			...result,
			tools: filteredTools,
		},
	};

	// Copy headers but remove Content-Length so the runtime recomputes it
	// for the new (shorter) body. Passing stale Content-Length would cause
	// clients to hang waiting for bytes that never arrive.
	const headers = new Headers(response.headers);
	headers.delete('Content-Length');

	return new Response(JSON.stringify(filteredBody), {
		status: response.status,
		headers,
	});
}
