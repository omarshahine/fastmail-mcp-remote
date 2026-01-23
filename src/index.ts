import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpAgent } from "agents/mcp";
import { Hono } from "hono";
import { z } from "zod";
import { FastmailAuth } from "./fastmail-auth";
import { JmapClient } from "./jmap-client";
import { ContactsCalendarClient } from "./contacts-calendar";
import {
	handleOAuthDiscovery,
	handleAuthorize,
	handleCallback,
	handleToken,
	handleRegister,
} from "./oauth-handler";
import { validateAccessToken } from "./oauth-utils";

export class FastmailMCP extends McpAgent<Env, Record<string, never>, Record<string, never>> {
	server = new McpServer({
		name: "Fastmail MCP Remote",
		version: "1.0.0",
	});

	private getJmapClient(): JmapClient {
		const auth = new FastmailAuth({
			apiToken: this.env.FASTMAIL_API_TOKEN,
		});
		return new JmapClient(auth);
	}

	private getContactsCalendarClient(): ContactsCalendarClient {
		const auth = new FastmailAuth({
			apiToken: this.env.FASTMAIL_API_TOKEN,
		});
		return new ContactsCalendarClient(auth);
	}

	async init() {
		// Authorization is handled in OAuth callback (oauth-handler.ts)
		// Only users in ALLOWED_USERS can obtain a valid access token

		// =====================
		// EMAIL TOOLS
		// =====================

		this.server.tool(
			"list_mailboxes",
			"List all mailboxes in the Fastmail account",
			{},
			async () => {
				const client = this.getJmapClient();
				const mailboxes = await client.getMailboxes();
				return {
					content: [{ text: JSON.stringify(mailboxes, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"list_emails",
			"List emails from a mailbox",
			{
				mailboxId: z.string().optional().describe("ID of the mailbox to list emails from (optional, defaults to all)"),
				limit: z.number().default(20).describe("Maximum number of emails to return (default: 20)"),
			},
			async ({ mailboxId, limit }) => {
				const client = this.getJmapClient();
				const emails = await client.getEmails(mailboxId, limit);
				return {
					content: [{ text: JSON.stringify(emails, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_email",
			"Get a specific email by ID",
			{
				emailId: z.string().describe("ID of the email to retrieve"),
			},
			async ({ emailId }) => {
				const client = this.getJmapClient();
				const email = await client.getEmailById(emailId);
				return {
					content: [{ text: JSON.stringify(email, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"send_email",
			"Send an email",
			{
				to: z.array(z.string()).describe("Recipient email addresses"),
				cc: z.array(z.string()).optional().describe("CC email addresses (optional)"),
				bcc: z.array(z.string()).optional().describe("BCC email addresses (optional)"),
				from: z.string().optional().describe("Sender email address (optional, defaults to account primary email)"),
				subject: z.string().describe("Email subject"),
				textBody: z.string().optional().describe("Plain text body (optional)"),
				htmlBody: z.string().optional().describe("HTML body (optional)"),
			},
			async ({ to, cc, bcc, from, subject, textBody, htmlBody }) => {
				if (!textBody && !htmlBody) {
					return {
						content: [{ text: "Error: Either textBody or htmlBody is required", type: "text" }],
					};
				}
				const client = this.getJmapClient();
				const submissionId = await client.sendEmail({ to, cc, bcc, from, subject, textBody, htmlBody });
				return {
					content: [{ text: `Email sent successfully. Submission ID: ${submissionId}`, type: "text" }],
				};
			},
		);

		this.server.tool(
			"create_draft",
			"Create an email draft in the Drafts folder without sending it",
			{
				to: z.array(z.string()).describe("Recipient email addresses"),
				cc: z.array(z.string()).optional().describe("CC email addresses (optional)"),
				bcc: z.array(z.string()).optional().describe("BCC email addresses (optional)"),
				from: z.string().optional().describe("Sender email address (optional, defaults to account primary email)"),
				subject: z.string().describe("Email subject"),
				textBody: z.string().optional().describe("Plain text body (optional)"),
				htmlBody: z.string().optional().describe("HTML body (optional)"),
			},
			async ({ to, cc, bcc, from, subject, textBody, htmlBody }) => {
				if (!textBody && !htmlBody) {
					return {
						content: [{ text: "Error: Either textBody or htmlBody is required", type: "text" }],
					};
				}
				const client = this.getJmapClient();
				const draftId = await client.createDraft({ to, cc, bcc, from, subject, textBody, htmlBody });
				return {
					content: [{ text: `Draft created successfully in Drafts folder. Draft ID: ${draftId}`, type: "text" }],
				};
			},
		);

		this.server.tool(
			"search_emails",
			"Search emails by subject or content",
			{
				query: z.string().describe("Search query string"),
				limit: z.number().default(20).describe("Maximum number of results (default: 20)"),
			},
			async ({ query, limit }) => {
				const client = this.getJmapClient();
				const emails = await client.searchEmails(query, limit);
				return {
					content: [{ text: JSON.stringify(emails, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_recent_emails",
			"Get the most recent emails from inbox (like top-ten)",
			{
				limit: z.number().default(10).describe("Number of recent emails to retrieve (default: 10, max: 50)"),
				mailboxName: z.string().default("inbox").describe("Mailbox to search (default: inbox)"),
			},
			async ({ limit, mailboxName }) => {
				const client = this.getJmapClient();
				const emails = await client.getRecentEmails(limit, mailboxName);
				return {
					content: [{ text: JSON.stringify(emails, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"mark_email_read",
			"Mark an email as read or unread",
			{
				emailId: z.string().describe("ID of the email to mark"),
				read: z.boolean().default(true).describe("true to mark as read, false to mark as unread"),
			},
			async ({ emailId, read }) => {
				const client = this.getJmapClient();
				await client.markEmailRead(emailId, read);
				return {
					content: [{ text: `Email ${read ? 'marked as read' : 'marked as unread'} successfully`, type: "text" }],
				};
			},
		);

		this.server.tool(
			"delete_email",
			"Delete an email (move to trash)",
			{
				emailId: z.string().describe("ID of the email to delete"),
			},
			async ({ emailId }) => {
				const client = this.getJmapClient();
				await client.deleteEmail(emailId);
				return {
					content: [{ text: "Email deleted successfully (moved to trash)", type: "text" }],
				};
			},
		);

		this.server.tool(
			"move_email",
			"Move an email to a different mailbox",
			{
				emailId: z.string().describe("ID of the email to move"),
				targetMailboxId: z.string().describe("ID of the target mailbox"),
			},
			async ({ emailId, targetMailboxId }) => {
				const client = this.getJmapClient();
				await client.moveEmail(emailId, targetMailboxId);
				return {
					content: [{ text: "Email moved successfully", type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_email_attachments",
			"Get list of attachments for an email",
			{
				emailId: z.string().describe("ID of the email"),
			},
			async ({ emailId }) => {
				const client = this.getJmapClient();
				const attachments = await client.getEmailAttachments(emailId);
				return {
					content: [{ text: JSON.stringify(attachments, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"download_attachment",
			"Download an email attachment. Returns a temporary download URL that can be used with curl (no auth required). The URL is single-use and expires after 5 minutes.",
			{
				emailId: z.string().describe("ID of the email"),
				attachmentId: z.string().describe("ID of the attachment"),
				inline: z.boolean().default(false).describe("If true, returns base64-encoded content inline instead of a download URL. Only for small files (<1MB)."),
			},
			async ({ emailId, attachmentId, inline }) => {
				const client = this.getJmapClient();
				try {
					// Get attachment metadata
					const metadata = await client.getAttachmentMetadata(emailId, attachmentId);

					if (inline) {
						// Return base64 content for small files
						if (metadata.size > 1024 * 1024) {
							return {
								content: [{ text: `Attachment is too large for inline (${Math.round(metadata.size / 1024)}KB). Use the default download URL instead.`, type: "text" }],
							};
						}
						const attachmentContent = await client.fetchAttachmentContent(emailId, attachmentId);
						return {
							content: [{ text: JSON.stringify(attachmentContent, null, 2), type: "text" }],
						};
					}

					// Generate a single-use download token
					const token = crypto.randomUUID();

					// Store metadata in KV with 5-minute TTL
					await this.env.OAUTH_KV.put(
						`download:${token}`,
						JSON.stringify({
							downloadUrl: metadata.downloadUrl,
							filename: metadata.filename,
							mimeType: metadata.mimeType,
							size: metadata.size,
						}),
						{ expirationTtl: 300 } // 5 minutes
					);

					// Build the proxy URL using configured worker URL
					const baseUrl = this.env.WORKER_URL || 'http://localhost:8788';
					const proxyUrl = `${baseUrl}/download/${token}`;

					return {
						content: [{
							text: JSON.stringify({
								filename: metadata.filename,
								mimeType: metadata.mimeType,
								size: metadata.size,
								downloadUrl: proxyUrl,
								curl: `curl -o "${metadata.filename}" "${proxyUrl}"`,
								note: "URL is single-use and expires in 5 minutes"
							}, null, 2),
							type: "text"
						}],
					};
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					return {
						content: [{ text: `Attachment download failed: ${errorMessage}`, type: "text" }],
					};
				}
			},
		);

		this.server.tool(
			"advanced_search",
			"Advanced email search with multiple criteria",
			{
				query: z.string().optional().describe("Text to search for in subject/body"),
				from: z.string().optional().describe("Filter by sender email"),
				to: z.string().optional().describe("Filter by recipient email"),
				subject: z.string().optional().describe("Filter by subject"),
				hasAttachment: z.boolean().optional().describe("Filter emails with attachments"),
				isUnread: z.boolean().optional().describe("Filter unread emails"),
				mailboxId: z.string().optional().describe("Search within specific mailbox"),
				after: z.string().optional().describe("Emails after this date (ISO 8601)"),
				before: z.string().optional().describe("Emails before this date (ISO 8601)"),
				limit: z.number().default(50).describe("Maximum results (default: 50)"),
			},
			async (filters) => {
				const client = this.getJmapClient();
				const emails = await client.advancedSearch(filters);
				return {
					content: [{ text: JSON.stringify(emails, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_thread",
			"Get all emails in a conversation thread",
			{
				threadId: z.string().describe("ID of the thread/conversation"),
			},
			async ({ threadId }) => {
				const client = this.getJmapClient();
				try {
					const thread = await client.getThread(threadId);
					return {
						content: [{ text: JSON.stringify(thread, null, 2), type: "text" }],
					};
				} catch (error) {
					return {
						content: [{ text: `Thread access failed: ${error instanceof Error ? error.message : String(error)}`, type: "text" }],
					};
				}
			},
		);

		this.server.tool(
			"get_mailbox_stats",
			"Get statistics for a mailbox (unread count, total emails, etc.)",
			{
				mailboxId: z.string().optional().describe("ID of the mailbox (optional, defaults to all mailboxes)"),
			},
			async ({ mailboxId }) => {
				const client = this.getJmapClient();
				const stats = await client.getMailboxStats(mailboxId);
				return {
					content: [{ text: JSON.stringify(stats, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_account_summary",
			"Get overall account summary with statistics",
			{},
			async () => {
				const client = this.getJmapClient();
				const summary = await client.getAccountSummary();
				return {
					content: [{ text: JSON.stringify(summary, null, 2), type: "text" }],
				};
			},
		);

		// =====================
		// BULK EMAIL OPERATIONS
		// =====================

		this.server.tool(
			"bulk_mark_read",
			"Mark multiple emails as read/unread",
			{
				emailIds: z.array(z.string()).describe("Array of email IDs to mark"),
				read: z.boolean().default(true).describe("true to mark as read, false as unread"),
			},
			async ({ emailIds, read }) => {
				const client = this.getJmapClient();
				await client.bulkMarkRead(emailIds, read);
				return {
					content: [{ text: `${emailIds.length} emails ${read ? 'marked as read' : 'marked as unread'} successfully`, type: "text" }],
				};
			},
		);

		this.server.tool(
			"bulk_move",
			"Move multiple emails to a mailbox",
			{
				emailIds: z.array(z.string()).describe("Array of email IDs to move"),
				targetMailboxId: z.string().describe("ID of target mailbox"),
			},
			async ({ emailIds, targetMailboxId }) => {
				const client = this.getJmapClient();
				await client.bulkMove(emailIds, targetMailboxId);
				return {
					content: [{ text: `${emailIds.length} emails moved successfully`, type: "text" }],
				};
			},
		);

		this.server.tool(
			"bulk_delete",
			"Delete multiple emails (move to trash)",
			{
				emailIds: z.array(z.string()).describe("Array of email IDs to delete"),
			},
			async ({ emailIds }) => {
				const client = this.getJmapClient();
				await client.bulkDelete(emailIds);
				return {
					content: [{ text: `${emailIds.length} emails deleted successfully (moved to trash)`, type: "text" }],
				};
			},
		);

		// =====================
		// IDENTITY TOOLS
		// =====================

		this.server.tool(
			"list_identities",
			"List sending identities (email addresses that can be used for sending)",
			{},
			async () => {
				const client = this.getJmapClient();
				const identities = await client.getIdentities();
				return {
					content: [{ text: JSON.stringify(identities, null, 2), type: "text" }],
				};
			},
		);

		// =====================
		// CONTACTS TOOLS
		// =====================

		this.server.tool(
			"list_contacts",
			"List contacts from the address book",
			{
				limit: z.number().default(50).describe("Maximum number of contacts to return (default: 50)"),
			},
			async ({ limit }) => {
				const client = this.getContactsCalendarClient();
				const contacts = await client.getContacts(limit);
				return {
					content: [{ text: JSON.stringify(contacts, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_contact",
			"Get a specific contact by ID",
			{
				contactId: z.string().describe("ID of the contact to retrieve"),
			},
			async ({ contactId }) => {
				const client = this.getContactsCalendarClient();
				const contact = await client.getContactById(contactId);
				return {
					content: [{ text: JSON.stringify(contact, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"search_contacts",
			"Search contacts by name or email",
			{
				query: z.string().describe("Search query string"),
				limit: z.number().default(20).describe("Maximum number of results (default: 20)"),
			},
			async ({ query, limit }) => {
				const client = this.getContactsCalendarClient();
				const contacts = await client.searchContacts(query, limit);
				return {
					content: [{ text: JSON.stringify(contacts, null, 2), type: "text" }],
				};
			},
		);

		// =====================
		// CALENDAR TOOLS
		// =====================

		this.server.tool(
			"list_calendars",
			"List all calendars",
			{},
			async () => {
				const client = this.getContactsCalendarClient();
				const calendars = await client.getCalendars();
				return {
					content: [{ text: JSON.stringify(calendars, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"list_calendar_events",
			"List events from a calendar",
			{
				calendarId: z.string().optional().describe("ID of the calendar (optional, defaults to all calendars)"),
				limit: z.number().default(50).describe("Maximum number of events to return (default: 50)"),
			},
			async ({ calendarId, limit }) => {
				const client = this.getContactsCalendarClient();
				const events = await client.getCalendarEvents(calendarId, limit);
				return {
					content: [{ text: JSON.stringify(events, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"get_calendar_event",
			"Get a specific calendar event by ID",
			{
				eventId: z.string().describe("ID of the event to retrieve"),
			},
			async ({ eventId }) => {
				const client = this.getContactsCalendarClient();
				const event = await client.getCalendarEventById(eventId);
				return {
					content: [{ text: JSON.stringify(event, null, 2), type: "text" }],
				};
			},
		);

		this.server.tool(
			"create_calendar_event",
			"Create a new calendar event",
			{
				calendarId: z.string().describe("ID of the calendar to create the event in"),
				title: z.string().describe("Event title"),
				description: z.string().optional().describe("Event description (optional)"),
				start: z.string().describe("Start time in ISO 8601 format"),
				end: z.string().describe("End time in ISO 8601 format"),
				location: z.string().optional().describe("Event location (optional)"),
				participants: z.array(z.object({
					email: z.string(),
					name: z.string().optional(),
				})).optional().describe("Event participants (optional)"),
			},
			async ({ calendarId, title, description, start, end, location, participants }) => {
				const client = this.getContactsCalendarClient();
				const eventId = await client.createCalendarEvent({
					calendarId,
					title,
					description,
					start,
					end,
					location,
					participants,
				});
				return {
					content: [{ text: `Calendar event created successfully. Event ID: ${eventId}`, type: "text" }],
				};
			},
		);

		// =====================
		// UTILITY TOOLS
		// =====================

		this.server.tool(
			"check_function_availability",
			"Check which MCP functions are available based on account permissions",
			{},
			async () => {
				const client = this.getJmapClient();
				const session = await client.getSession();

				const availability = {
					email: {
						available: true,
						functions: [
							'list_mailboxes', 'list_emails', 'get_email', 'send_email', 'create_draft',
							'search_emails', 'get_recent_emails', 'mark_email_read', 'delete_email', 'move_email',
							'get_email_attachments', 'download_attachment', 'advanced_search', 'get_thread',
							'get_mailbox_stats', 'get_account_summary', 'bulk_mark_read', 'bulk_move', 'bulk_delete'
						]
					},
					identity: {
						available: true,
						functions: ['list_identities']
					},
					contacts: {
						available: !!session.capabilities['urn:ietf:params:jmap:contacts'],
						functions: ['list_contacts', 'get_contact', 'search_contacts'],
						note: session.capabilities['urn:ietf:params:jmap:contacts'] ?
							'Contacts are available' :
							'Contacts access not available - may require enabling in Fastmail account settings',
					},
					calendar: {
						available: !!session.capabilities['urn:ietf:params:jmap:calendars'],
						functions: ['list_calendars', 'list_calendar_events', 'get_calendar_event', 'create_calendar_event'],
						note: session.capabilities['urn:ietf:params:jmap:calendars'] ?
							'Calendar is available' :
							'Calendar access not available - may require enabling in Fastmail account settings',
					},
					capabilities: Object.keys(session.capabilities),
					authenticatedUser: 'authenticated via OAuth',
				};

				return {
					content: [{ text: JSON.stringify(availability, null, 2), type: "text" }],
				};
			},
		);
	}
}

// Create Hono app for routing
const app = new Hono<{ Bindings: Env }>();

// Protected Resource Metadata (RFC 9728) - tells clients where to find auth server
app.get('/.well-known/oauth-protected-resource', (c) => {
	const url = new URL(c.req.url);
	return new Response(JSON.stringify({
		resource: `${url.origin}/mcp`,
		authorization_servers: [url.origin],
		scopes_supported: ['mcp:read', 'mcp:write'],
	}), {
		headers: {
			'Content-Type': 'application/json',
			'Cache-Control': 'public, max-age=3600',
		},
	});
});

// OAuth Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (c) => {
	return handleOAuthDiscovery(new URL(c.req.url));
});

// OAuth endpoints
app.get('/mcp/authorize', async (c) => {
	return handleAuthorize(c.req.raw, c.env, new URL(c.req.url));
});

app.get('/mcp/callback', async (c) => {
	return handleCallback(c.req.raw, c.env, new URL(c.req.url));
});

app.post('/mcp/token', async (c) => {
	return handleToken(c.req.raw, c.env);
});

app.post('/mcp/register', async (c) => {
	return handleRegister(c.req.raw, c.env);
});

// Also handle /register for MCP spec compliance
app.post('/register', async (c) => {
	return handleRegister(c.req.raw, c.env);
});

// Helper to create 401 response with proper WWW-Authenticate header for MCP OAuth
function unauthorizedResponse(c: { req: { url: string } }, error: string, description: string): Response {
	const url = new URL(c.req.url);
	const resourceMetadata = `${url.origin}/.well-known/oauth-protected-resource`;
	return new Response(
		JSON.stringify({ error, error_description: description }),
		{
			status: 401,
			headers: {
				'Content-Type': 'application/json',
				'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"`,
			},
		}
	);
}

// MCP endpoints (require Bearer token)
app.all('/mcp', async (c) => {
	// Validate Bearer token
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return unauthorizedResponse(c, 'unauthorized', 'Missing or invalid Authorization header');
	}

	const token = authHeader.substring(7);
	const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token);
	if (!tokenInfo) {
		return unauthorizedResponse(c, 'invalid_token', 'Invalid or expired access token');
	}

	// Handle MCP request - user is already authorized via OAuth
	return FastmailMCP.serve('/mcp').fetch(c.req.raw, c.env, c.executionCtx);
});

app.all('/sse', async (c) => {
	// Validate Bearer token
	const authHeader = c.req.header('Authorization');
	if (!authHeader?.startsWith('Bearer ')) {
		return unauthorizedResponse(c, 'unauthorized', 'Missing or invalid Authorization header');
	}

	const token = authHeader.substring(7);
	const tokenInfo = await validateAccessToken(c.env.OAUTH_KV, token);
	if (!tokenInfo) {
		return unauthorizedResponse(c, 'invalid_token', 'Invalid or expired access token');
	}

	// Handle SSE MCP request - user is already authorized via OAuth
	return FastmailMCP.serveSSE('/sse').fetch(c.req.raw, c.env, c.executionCtx);
});

// Attachment download proxy endpoint (no auth required - uses single-use token)
app.get('/download/:token', async (c) => {
	const token = c.req.param('token');

	// Look up token in KV
	const tokenData = await c.env.OAUTH_KV.get(`download:${token}`, 'json') as {
		downloadUrl: string;
		filename: string;
		mimeType: string;
		size: number;
	} | null;

	if (!tokenData) {
		return c.json({ error: 'Invalid or expired download token' }, 404);
	}

	// Delete token immediately (single-use)
	await c.env.OAUTH_KV.delete(`download:${token}`);

	// Fetch from Fastmail using the API token
	const response = await fetch(tokenData.downloadUrl, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${c.env.FASTMAIL_API_TOKEN}`,
		},
	});

	if (!response.ok) {
		return c.json({ error: `Failed to fetch attachment: ${response.status}` }, 502);
	}

	// Stream the response back with proper headers
	return new Response(response.body, {
		status: 200,
		headers: {
			'Content-Type': tokenData.mimeType,
			'Content-Disposition': `attachment; filename="${tokenData.filename}"`,
			'Content-Length': tokenData.size.toString(),
		},
	});
});

// Root endpoint
app.get('/', (c) => {
	return c.json({
		name: 'Fastmail MCP Remote',
		version: '1.0.0',
		description: 'Remote MCP server for Fastmail email, contacts, and calendar access',
		oauth_discovery: '/.well-known/oauth-authorization-server',
		endpoints: {
			mcp: '/mcp',
			sse: '/sse',
			download: '/download/:token (temporary, single-use)',
		},
	});
});

export default app;
