/**
 * Route-level wire tests: real `app.request('/mcp')` through the agents
 * stateless handler and the real SDK, pinning what each protocol era sees.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('agents/mcp', () => ({
	McpAgent: class {
		static serve() {
			return { fetch: vi.fn() };
		}
	},
}));

// Code Mode imports the Workers-only `cloudflare:workers` module, which
// Node's Vitest environment cannot load.
vi.mock('@cloudflare/codemode', () => ({
	DynamicWorkerExecutor: class {},
}));
vi.mock('../src/openapi-adapter', () => ({
	buildCodeModeServer: vi.fn(),
}));

vi.mock('../src/oauth-utils', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/oauth-utils')>();
	return {
		...original,
		validateAccessToken: vi.fn(async () => ({
			user_id: 'test-user',
			user_login: 'user@example.com',
			scope: 'mcp:read',
			expiresAt: '2099-01-01T00:00:00.000Z',
		})),
	};
});

vi.mock('../src/permissions', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/permissions')>();
	return {
		...original,
		getPermissionsConfig: vi.fn(async () => ({
			users: {},
			default_role: 'admin',
			default_disabled_categories: [],
		})),
		getUserConfig: vi.fn(() => ({ role: 'admin', disabled_categories: [] })),
		getVisibleTools: vi.fn(() => new Set<string>()),
	};
});

import app from '../src/index';
import { getVisibleTools } from '../src/permissions';
import { JmapClient } from '../src/jmap-client';
import { EMAIL_READER_URI, SEND_REVIEW_URI, UI_MIME_TYPE } from '../src/apps/constants';

const env = {
	ACTION_SIGNING_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
	ALLOWED_USERS: 'user@example.com',
	WORKER_URL: 'https://mail.example.test',
} as unknown as Env;
const executionCtx = {
	waitUntil: vi.fn(),
	passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

const LEGACY = { 'Mcp-Protocol-Version': '2025-06-18' };
const ids = Array.from({ length: 30 }, (_, i) => `e${i}`);

/** POST one JSON-RPC body; returns the status and every JSON-RPC message (JSON or SSE). */
async function post(body: unknown, headers: Record<string, string> = {}) {
	const response = await app.request(
		new Request('https://worker.example/mcp', {
			method: 'POST',
			headers: {
				Authorization: 'Bearer test-token',
				'Content-Type': 'application/json',
				Accept: 'application/json, text/event-stream',
				...headers,
			},
			body: JSON.stringify(body),
		}),
		undefined,
		env,
		executionCtx,
	);
	const text = await response.text();
	const messages = (response.headers.get('content-type') ?? '').includes('event-stream')
		? text.split('\n').filter((line) => line.startsWith('data:')).map((line) => JSON.parse(line.slice(5)))
		: text ? [JSON.parse(text)] : [];
	return { status: response.status, messages };
}

beforeEach(() => {
	vi.mocked(getVisibleTools).mockImplementation(
		() => new Set(['get_email', 'send_email', 'ui_get_email_view', 'ui_get_send_review', 'bulk_delete', 'list_mailboxes']),
	);
});
afterEach(() => {
	vi.restoreAllMocks();
});

describe('legacy (2025-era) wire', () => {
	it('bulk_delete of 25+ ids proceeds with no elicitation', async () => {
		const bulkDelete = vi.spyOn(JmapClient.prototype, 'bulkDelete').mockResolvedValue(undefined as never);
		const r = await post(
			{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bulk_delete', arguments: { emailIds: ids } } },
			LEGACY,
		);

		expect(r.status).toBe(200);
		// No server-to-client request (elicitation/create or otherwise).
		expect(r.messages.filter((message) => 'method' in message)).toEqual([]);
		const result = r.messages.find((message) => message.id === 3)?.result;
		expect(result, JSON.stringify(r.messages)).toBeDefined();
		expect(result.resultType).not.toBe('input_required');
		expect(result.isError).toBeFalsy();
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(bulkDelete).toHaveBeenCalledWith(ids);
	});

	it('tools/list carries the reader resourceUri and app-only visibility', async () => {
		const r = await post({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, LEGACY);

		expect(r.status).toBe(200);
		const tools = r.messages[0].result.tools as any[];
		expect(tools.find((t) => t.name === 'get_email')._meta.ui.resourceUri).toBe(EMAIL_READER_URI);
		expect(tools.find((t) => t.name === 'send_email')._meta.ui.resourceUri).toBe(SEND_REVIEW_URI);
		const appTools = tools.filter((t) => t.name.startsWith('ui_'));
		expect(appTools.map((t) => t.name).sort()).toEqual(['ui_get_email_view', 'ui_get_send_review']);
		for (const tool of appTools) expect(tool._meta.ui.visibility, tool.name).toEqual(['app']);
	});

	it('resources/read of the send review URI returns the MCP App', async () => {
		const r = await post(
			{ jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: SEND_REVIEW_URI } },
			LEGACY,
		);

		expect(r.status, JSON.stringify(r.messages)).toBe(200);
		const content = r.messages[0].result.contents[0];
		expect(content.uri).toBe(SEND_REVIEW_URI);
		expect(content.mimeType).toBe(UI_MIME_TYPE);
		expect(content.mimeType).toBe('text/html;profile=mcp-app');
		expect(content.text).toContain('fastmailApp');
	});
});

describe('modern (2026-07-28) bulk confirmation round trip', () => {
	const meta = {
		'io.modelcontextprotocol/protocolVersion': '2026-07-28',
		'io.modelcontextprotocol/clientInfo': { name: 'wire-test', version: '1.0.0' },
		'io.modelcontextprotocol/clientCapabilities': { elicitation: { form: {} } },
	};
	const headers = { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'bulk_delete', 'Mcp-Protocol-Version': '2026-07-28' };

	async function call(id: number, extra: Record<string, unknown> = {}) {
		const r = await post(
			{ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'bulk_delete', arguments: { emailIds: ids }, _meta: meta, ...extra } },
			headers,
		);
		expect(r.status, JSON.stringify(r.messages)).toBe(200);
		return r.messages[0].result;
	}

	async function askForConfirmation() {
		const first = await call(1);
		expect(first.resultType).toBe('input_required');
		expect(first.inputRequests.confirm.method).toBe('elicitation/create');
		expect(first.inputRequests.confirm.params.message).toBe('Move 30 emails to Trash?');
		expect(typeof first.requestState).toBe('string');
		return first.requestState as string;
	}

	it('asks first, then deletes exactly once on accept', async () => {
		const bulkDelete = vi.spyOn(JmapClient.prototype, 'bulkDelete').mockResolvedValue(undefined as never);
		const requestState = await askForConfirmation();
		expect(bulkDelete).not.toHaveBeenCalled();

		const accepted = await call(2, {
			requestState,
			inputResponses: { confirm: { action: 'accept', content: { confirm: true } } },
		});
		expect(accepted.resultType).not.toBe('input_required');
		expect(accepted.isError).toBeFalsy();
		expect(bulkDelete).toHaveBeenCalledOnce();
		expect(bulkDelete).toHaveBeenCalledWith(ids);
	});

	it('cancels on decline without deleting', async () => {
		const bulkDelete = vi.spyOn(JmapClient.prototype, 'bulkDelete').mockResolvedValue(undefined as never);
		const requestState = await askForConfirmation();

		const declined = await call(3, { requestState, inputResponses: { confirm: { action: 'decline' } } });
		expect(declined.content[0].text).toBe('Cancelled: no emails were deleted.');
		expect(bulkDelete).not.toHaveBeenCalled();
	});
});
