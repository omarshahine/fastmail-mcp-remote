import { describe, it, expect, beforeEach } from 'vitest';
import {
	type PermissionsConfig,
	type UserConfig,
	getUserConfig,
	isToolAllowed,
	getVisibleTools,
	checkMcpPermissions,
	TOOL_CATEGORIES,
	_resetCache,
} from '../src/permissions';

// ─── Fixtures ───────────────────────────────────────────────────────────────

const TEST_CONFIG: PermissionsConfig = {
	users: {
		'admin@example.com': {
			role: 'admin',
			disabled_categories: ['CONTACTS', 'CALENDAR_READ', 'CALENDAR_WRITE'],
		},
		'delegate@example.com': {
			role: 'delegate',
			disabled_categories: ['CONTACTS', 'CALENDAR_READ', 'CALENDAR_WRITE'],
		},
	},
	default_role: 'admin',
	default_disabled_categories: [],
};

function adminConfig(): UserConfig {
	return getUserConfig(TEST_CONFIG, 'admin@example.com');
}

function delegateConfig(): UserConfig {
	return getUserConfig(TEST_CONFIG, 'delegate@example.com');
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
	_resetCache();
});

describe('getUserConfig', () => {
	it('returns config for known user', () => {
		const config = getUserConfig(TEST_CONFIG, 'admin@example.com');
		expect(config.role).toBe('admin');
		expect(config.disabled_categories).toContain('CONTACTS');
	});

	it('is case-insensitive', () => {
		const config = getUserConfig(TEST_CONFIG, 'ADMIN@EXAMPLE.COM');
		expect(config.role).toBe('admin');
	});

	it('returns defaults for unknown user', () => {
		const config = getUserConfig(TEST_CONFIG, 'unknown@example.com');
		expect(config.role).toBe('admin');
		expect(config.disabled_categories).toEqual([]);
	});

	it('returns custom defaults when configured', () => {
		const custom: PermissionsConfig = {
			...TEST_CONFIG,
			default_role: 'delegate',
			default_disabled_categories: ['CALENDAR_WRITE'],
		};
		const config = getUserConfig(custom, 'unknown@example.com');
		expect(config.role).toBe('delegate');
		expect(config.disabled_categories).toContain('CALENDAR_WRITE');
	});
});

describe('isToolAllowed — admin', () => {
	it('allows all email read tools', () => {
		const config = adminConfig();
		expect(isToolAllowed(config, 'list_mailboxes').allowed).toBe(true);
		expect(isToolAllowed(config, 'get_email').allowed).toBe(true);
		expect(isToolAllowed(config, 'advanced_search').allowed).toBe(true);
	});

	it('allows send_email', () => {
		expect(isToolAllowed(adminConfig(), 'send_email').allowed).toBe(true);
	});

	it('allows reply_to_email with sendImmediately:true', () => {
		expect(
			isToolAllowed(adminConfig(), 'reply_to_email', { sendImmediately: true }).allowed,
		).toBe(true);
	});

	it('denies tools in disabled categories', () => {
		const result = isToolAllowed(adminConfig(), 'list_contacts');
		expect(result.allowed).toBe(false);
		expect(result.error).toContain('disabled');
		expect(result.error).toContain('CONTACTS');
	});

	it('denies calendar read for admin with disabled CALENDAR_READ', () => {
		const result = isToolAllowed(adminConfig(), 'list_calendars');
		expect(result.allowed).toBe(false);
	});

	it('denies calendar write for admin with disabled CALENDAR_WRITE', () => {
		const result = isToolAllowed(adminConfig(), 'create_calendar_event');
		expect(result.allowed).toBe(false);
	});
});

describe('isToolAllowed — delegate', () => {
	it('allows email read tools', () => {
		const config = delegateConfig();
		expect(isToolAllowed(config, 'list_mailboxes').allowed).toBe(true);
		expect(isToolAllowed(config, 'get_email').allowed).toBe(true);
		expect(isToolAllowed(config, 'search_emails').allowed).toBe(true);
		expect(isToolAllowed(config, 'get_thread').allowed).toBe(true);
	});

	it('allows inbox management tools', () => {
		const config = delegateConfig();
		expect(isToolAllowed(config, 'mark_email_read').allowed).toBe(true);
		expect(isToolAllowed(config, 'move_email').allowed).toBe(true);
		expect(isToolAllowed(config, 'delete_email').allowed).toBe(true);
		expect(isToolAllowed(config, 'bulk_move').allowed).toBe(true);
	});

	it('allows create_draft', () => {
		expect(isToolAllowed(delegateConfig(), 'create_draft').allowed).toBe(true);
	});

	it('allows reply_to_email with default args (creates draft)', () => {
		expect(isToolAllowed(delegateConfig(), 'reply_to_email').allowed).toBe(true);
		expect(
			isToolAllowed(delegateConfig(), 'reply_to_email', { sendImmediately: false }).allowed,
		).toBe(true);
	});

	it('denies send_email', () => {
		const result = isToolAllowed(delegateConfig(), 'send_email');
		expect(result.allowed).toBe(false);
		expect(result.error).toContain('delegate');
		expect(result.error).toContain('create_draft');
	});

	it('denies reply_to_email with sendImmediately:true', () => {
		const result = isToolAllowed(delegateConfig(), 'reply_to_email', { sendImmediately: true });
		expect(result.allowed).toBe(false);
		expect(result.error).toContain('sendImmediately');
	});

	it('denies tools in disabled categories', () => {
		const result = isToolAllowed(delegateConfig(), 'list_contacts');
		expect(result.allowed).toBe(false);
		expect(result.error).toContain('disabled');
	});

	it('allows check_function_availability (META)', () => {
		expect(isToolAllowed(delegateConfig(), 'check_function_availability').allowed).toBe(true);
	});

	it('allows unknown tools (not in category map)', () => {
		expect(isToolAllowed(delegateConfig(), 'future_new_tool').allowed).toBe(true);
	});
});

describe('getVisibleTools', () => {
	it('excludes disabled categories for admin', () => {
		const visible = getVisibleTools(adminConfig());
		// Admin with disabled CONTACTS/CALENDAR — no contact or calendar tools
		expect(visible.has('list_contacts')).toBe(false);
		expect(visible.has('list_calendars')).toBe(false);
		expect(visible.has('create_calendar_event')).toBe(false);
		// But email tools are visible
		expect(visible.has('list_mailboxes')).toBe(true);
		expect(visible.has('send_email')).toBe(true);
	});

	it('excludes disabled categories AND role-denied tools for delegate', () => {
		const visible = getVisibleTools(delegateConfig());
		// Disabled categories
		expect(visible.has('list_contacts')).toBe(false);
		expect(visible.has('list_calendars')).toBe(false);
		// Role-denied
		expect(visible.has('send_email')).toBe(false);
		expect(visible.has('create_calendar_event')).toBe(false);
		// Allowed
		expect(visible.has('list_mailboxes')).toBe(true);
		expect(visible.has('create_draft')).toBe(true);
		expect(visible.has('reply_to_email')).toBe(true);
	});

	it('returns all tools for admin with no disabled categories', () => {
		const config: UserConfig = { role: 'admin', disabled_categories: [] };
		const visible = getVisibleTools(config);
		const allTools = Object.keys(TOOL_CATEGORIES);
		for (const tool of allTools) {
			expect(visible.has(tool)).toBe(true);
		}
	});

	it('returns correct count for delegate with no disabled categories', () => {
		const config: UserConfig = { role: 'delegate', disabled_categories: [] };
		const visible = getVisibleTools(config);
		// Delegate should not see SEND or CALENDAR_WRITE tools
		expect(visible.has('send_email')).toBe(false);
		expect(visible.has('create_calendar_event')).toBe(false);
		// But sees everything else
		expect(visible.has('list_mailboxes')).toBe(true);
		expect(visible.has('create_draft')).toBe(true);
		expect(visible.has('reply_to_email')).toBe(true);
		expect(visible.has('list_contacts')).toBe(true);
		expect(visible.has('list_calendars')).toBe(true);
	});
});

describe('checkMcpPermissions — fail-closed', () => {
	// Mock KV that returns delegate config
	const mockKv = {
		get: async () => TEST_CONFIG,
	} as unknown as KVNamespace;

	it('returns null (allows) for null body (GET requests)', async () => {
		const result = await checkMcpPermissions(null, 'admin@example.com', mockKv);
		expect(result).toBeNull();
	});

	it('DENIES unparseable JSON body (fail-closed)', async () => {
		const result = await checkMcpPermissions('not json{{{', 'delegate@example.com', mockKv);
		expect(result).not.toBeNull();
		const body = await result!.json() as { error: { message: string } };
		expect(body.error.message).toContain('could not parse');
	});

	it('denies send_email for delegate', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'send_email', arguments: { to: ['x@example.com'], subject: 'hi', textBody: 'hi' } },
		});
		const result = await checkMcpPermissions(body, 'delegate@example.com', mockKv);
		expect(result).not.toBeNull();
		const json = await result!.json() as { error: { message: string } };
		expect(json.error.message).toContain('delegate');
	});

	it('allows send_email for admin', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'send_email', arguments: { to: ['x@example.com'], subject: 'hi', textBody: 'hi' } },
		});
		const result = await checkMcpPermissions(body, 'admin@example.com', mockKv);
		expect(result).toBeNull();
	});

	it('allows non-tools/call methods', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/list',
		});
		const result = await checkMcpPermissions(body, 'delegate@example.com', mockKv);
		expect(result).toBeNull();
	});

	it('denies reply_to_email with sendImmediately:true for delegate', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'reply_to_email', arguments: { emailId: 'abc', body: 'hi', sendImmediately: true } },
		});
		const result = await checkMcpPermissions(body, 'delegate@example.com', mockKv);
		expect(result).not.toBeNull();
	});

	it('allows reply_to_email without sendImmediately for delegate', async () => {
		const body = JSON.stringify({
			jsonrpc: '2.0',
			id: 1,
			method: 'tools/call',
			params: { name: 'reply_to_email', arguments: { emailId: 'abc', body: 'hi' } },
		});
		const result = await checkMcpPermissions(body, 'delegate@example.com', mockKv);
		expect(result).toBeNull();
	});
});

describe('TOOL_CATEGORIES completeness', () => {
	it('maps all 32 tools', () => {
		expect(Object.keys(TOOL_CATEGORIES).length).toBe(32);
	});

	it('has no empty categories', () => {
		const categories = new Set(Object.values(TOOL_CATEGORIES));
		expect(categories.size).toBeGreaterThanOrEqual(9);
	});
});
