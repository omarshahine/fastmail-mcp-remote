import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAllTools, type ToolContext } from '../src/tools';
import { TOOL_ANNOTATIONS } from '../src/tool-annotations';
import { TOOL_CATEGORIES } from '../src/permissions';

const READ = [
	'list_mailboxes', 'list_emails', 'get_email', 'search_emails', 'get_recent_emails',
	'get_inbox_updates', 'get_email_attachments', 'download_attachment', 'advanced_search',
	'get_thread', 'get_memo', 'get_mailbox_stats', 'get_account_summary', 'list_identities',
	'list_contacts', 'get_contact', 'search_contacts', 'list_calendars', 'list_calendar_events',
	'get_calendar_event', 'check_function_availability',
];
const WRITE_NON_IDEMPOTENT = ['create_draft', 'create_memo', 'create_calendar_event', 'generate_email_action_urls'];
const DESTRUCTIVE = ['delete_email', 'delete_memo', 'bulk_delete', 'bulk_move'];
const SEND = ['send_email', 'send_copy', 'reply_to_email', 'forward_email'];

function registeredTools() {
	const configs = new Map<string, any>();
	const server = {
		registerTool(name: string, config: unknown) {
			configs.set(name, config);
		},
		registerResource() {},
	} as unknown as McpServer;
	const context: ToolContext = {
		env: {} as Env,
		getCurrentUser: () => 'user@example.com',
		getJmapClient: vi.fn() as any,
		getContactsCalendarClient: vi.fn() as any,
		checkToolPermission: async () => null,
		guardResponse: vi.fn() as any,
	};
	registerAllTools(server, context, undefined, { apps: true });
	return configs;
}

describe('tool annotations', () => {
	it('every registered tool has annotations and a category', () => {
		const configs = registeredTools();
		const names = [...configs.keys()].sort();
		expect(names).toEqual(Object.keys(TOOL_ANNOTATIONS).sort());
		expect(names).toEqual(Object.keys(TOOL_CATEGORIES).sort());
		for (const [name, config] of configs) {
			expect(config.annotations, name).toEqual(TOOL_ANNOTATIONS[name]);
		}
	});

	it('read tools are read-only', () => {
		const configs = registeredTools();
		for (const name of READ) expect(configs.get(name)?.annotations.readOnlyHint, name).toBe(true);
	});

	it('non-idempotent writes, including action URL minting, are plain writes', () => {
		const configs = registeredTools();
		for (const name of WRITE_NON_IDEMPOTENT) {
			expect(configs.get(name)?.annotations, name).toEqual({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			});
		}
	});

	it('destructive and send tools are marked destructive', () => {
		const configs = registeredTools();
		for (const name of [...DESTRUCTIVE, ...SEND]) {
			expect(configs.get(name)?.annotations.destructiveHint, name).toBe(true);
		}
	});
});
