/**
 * Email tools for the Fastmail OpenClaw plugin.
 *
 * 11 read + 3 write + 6 organize + 6 bulk = 26 tools total.
 * Write/organize/bulk tools use { optional: true }.
 */

import type { OpenClawApi, GetClientFn } from "../../index.js";
import {
  formatEmailList,
  formatEmail,
  formatMailboxes,
  formatMailboxStats,
  formatAccountSummary,
  formatIdentities,
  formatAttachments,
  formatInboxUpdates,
} from "../formatters.js";

export function registerEmailTools(api: OpenClawApi, getClient: GetClientFn) {
  // -- Read (11 tools) ------------------------------------------------

  api.registerTool({
    name: "fastmail_inbox",
    description: "Get recent inbox emails with IDs, dates, senders, subjects, and previews.",
    parameters: {
      type: "object",
      properties: {
        limit: { type: "integer", default: 10, description: "Number of emails" },
        mailboxName: { type: "string", default: "inbox", description: "Mailbox name" },
      },
    },
    async execute(_id: string, params: { limit?: number; mailboxName?: string }) {
      const client = await getClient();
      const data = await client.callTool("get_recent_emails", {
        limit: params.limit ?? 10,
        mailboxName: params.mailboxName ?? "inbox",
      });
      const text = Array.isArray(data) ? formatEmailList(data, params.mailboxName ?? "inbox") : String(data);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_email",
    description: "Read a single email by ID. Returns formatted headers + body.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        format: { type: "string", enum: ["markdown", "html"], default: "markdown", description: "Body format" },
      },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string; format?: string }) {
      const client = await getClient();
      const data = await client.callTool("get_email", {
        emailId: params.emailId,
        format: params.format ?? "markdown",
      });
      return { content: [{ type: "text", text: formatEmail(data) }] };
    },
  });

  api.registerTool({
    name: "fastmail_search_emails",
    description: "Search emails with text and optional filters: sender, recipient, date range, unread, attachments, mailbox.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        limit: { type: "integer", default: 20, description: "Max results" },
        from: { type: "string", description: "Filter by sender" },
        to: { type: "string", description: "Filter by recipient" },
        subject: { type: "string", description: "Filter by subject" },
        after: { type: "string", description: "After date (ISO 8601)" },
        before: { type: "string", description: "Before date (ISO 8601)" },
        isUnread: { type: "boolean", description: "Only unread" },
        hasAttachment: { type: "boolean", description: "Only with attachments" },
        mailboxId: { type: "string", description: "Restrict to mailbox" },
      },
      required: ["query"],
    },
    async execute(_id: string, params: Record<string, any>) {
      const client = await getClient();
      const hasFilters = params.from || params.to || params.subject || params.after || params.before || params.isUnread || params.hasAttachment || params.mailboxId;
      const tool = hasFilters ? "advanced_search" : "search_emails";
      const data = await client.callTool(tool, {
        query: params.query,
        limit: params.limit ?? 20,
        ...(hasFilters && {
          from: params.from, to: params.to, subject: params.subject,
          after: params.after, before: params.before,
          isUnread: params.isUnread, hasAttachment: params.hasAttachment,
          mailboxId: params.mailboxId,
        }),
      });
      const text = Array.isArray(data) ? formatEmailList(data, `Search: ${params.query}`) : String(data);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_thread",
    description: "Get all emails in a conversation thread.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread ID" },
        format: { type: "string", enum: ["markdown", "html"], default: "markdown" },
      },
      required: ["threadId"],
    },
    async execute(_id: string, params: { threadId: string; format?: string }) {
      const client = await getClient();
      const data = await client.callTool("get_thread", { threadId: params.threadId, format: params.format ?? "markdown" });
      let text: string;
      if (typeof data === "string") text = data;
      else if (Array.isArray(data)) text = data.map(formatEmail).join("\n\n---\n\n");
      else text = JSON.stringify(data, null, 2);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_list_mailboxes",
    description: "List all mailboxes with IDs, names, roles, and email counts.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: Record<string, never>) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatMailboxes(await client.callTool("list_mailboxes")) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_mailbox_stats",
    description: "Get statistics for a specific mailbox or all mailboxes.",
    parameters: {
      type: "object",
      properties: { mailboxId: { type: "string", description: "Mailbox ID (omit for all)" } },
    },
    async execute(_id: string, params: { mailboxId?: string }) {
      const client = await getClient();
      const args: Record<string, unknown> = {};
      if (params.mailboxId) args.mailboxId = params.mailboxId;
      return { content: [{ type: "text", text: formatMailboxStats(await client.callTool("get_mailbox_stats", args)) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_account_summary",
    description: "Get account overview: mailbox count, identity count, total/unread emails.",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: Record<string, never>) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatAccountSummary(await client.callTool("get_account_summary")) }] };
    },
  });

  api.registerTool({
    name: "fastmail_list_identities",
    description: "List sending identities (email addresses and names).",
    parameters: { type: "object", properties: {} },
    async execute(_id: string, _params: Record<string, never>) {
      const client = await getClient();
      return { content: [{ type: "text", text: formatIdentities(await client.callTool("list_identities")) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_attachments",
    description: "List attachments for an email.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("get_email_attachments", { emailId: params.emailId });
      return { content: [{ type: "text", text: Array.isArray(data) ? formatAttachments(data) : String(data) }] };
    },
  });

  api.registerTool({
    name: "fastmail_download_attachment",
    description: "Get download URL or inline content for an attachment.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        attachmentId: { type: "string", description: "Attachment blob ID" },
        inline: { type: "boolean", default: false, description: "Return base64 inline" },
      },
      required: ["emailId", "attachmentId"],
    },
    async execute(_id: string, params: { emailId: string; attachmentId: string; inline?: boolean }) {
      const client = await getClient();
      const data = await client.callTool("download_attachment", {
        emailId: params.emailId, attachmentId: params.attachmentId, inline: params.inline ?? false,
      });
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_inbox_updates",
    description: "Get inbox changes since a state token (incremental sync).",
    parameters: {
      type: "object",
      properties: {
        sinceQueryState: { type: "string", description: "State token from previous call" },
        mailboxId: { type: "string", description: "Mailbox ID" },
        limit: { type: "integer", default: 100, description: "Max results" },
      },
    },
    async execute(_id: string, params: { sinceQueryState?: string; mailboxId?: string; limit?: number }) {
      const client = await getClient();
      const data = await client.callTool("get_inbox_updates", {
        sinceQueryState: params.sinceQueryState, mailboxId: params.mailboxId, limit: params.limit ?? 100,
      });
      return { content: [{ type: "text", text: typeof data === "object" && data !== null ? formatInboxUpdates(data) : String(data) }] };
    },
  });

  // -- Write (3 tools, optional) --------------------------------------

  api.registerTool({
    name: "fastmail_send_email",
    description: "Send an email. Supports plain text, HTML, or markdown body.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipients" },
        subject: { type: "string", description: "Subject" },
        textBody: { type: "string", description: "Plain text body" },
        htmlBody: { type: "string", description: "HTML body" },
        markdownBody: { type: "string", description: "Markdown body" },
        cc: { type: "array", items: { type: "string" }, description: "CC" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC" },
        from: { type: "string", description: "Sender address" },
      },
      required: ["to", "subject"],
    },
    async execute(_id: string, params: { to: string[]; subject: string; textBody?: string; htmlBody?: string; markdownBody?: string; cc?: string[]; bcc?: string[]; from?: string }) {
      const client = await getClient();
      const data = await client.callTool("send_email", {
        to: params.to, subject: params.subject,
        ...(params.textBody && { textBody: params.textBody }),
        ...(params.htmlBody && { htmlBody: params.htmlBody }),
        ...(params.markdownBody && { markdownBody: params.markdownBody }),
        ...(params.cc && { cc: params.cc }),
        ...(params.bcc && { bcc: params.bcc }),
        ...(params.from && { from: params.from }),
      });
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_create_draft",
    description: "Create an email draft.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipients" },
        subject: { type: "string", description: "Subject" },
        textBody: { type: "string", description: "Plain text body" },
        htmlBody: { type: "string", description: "HTML body" },
        markdownBody: { type: "string", description: "Markdown body" },
        cc: { type: "array", items: { type: "string" }, description: "CC" },
        bcc: { type: "array", items: { type: "string" }, description: "BCC" },
        from: { type: "string", description: "Sender address" },
      },
      required: ["to", "subject"],
    },
    async execute(_id: string, params: { to: string[]; subject: string; textBody?: string; htmlBody?: string; markdownBody?: string; cc?: string[]; bcc?: string[]; from?: string }) {
      const client = await getClient();
      const data = await client.callTool("create_draft", {
        to: params.to, subject: params.subject,
        ...(params.textBody && { textBody: params.textBody }),
        ...(params.htmlBody && { htmlBody: params.htmlBody }),
        ...(params.markdownBody && { markdownBody: params.markdownBody }),
        ...(params.cc && { cc: params.cc }),
        ...(params.bcc && { bcc: params.bcc }),
        ...(params.from && { from: params.from }),
      });
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_reply_to_email",
    description: "Reply to an email. Can reply-all, send immediately or save as draft.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID to reply to" },
        body: { type: "string", description: "Reply text" },
        htmlBody: { type: "string", description: "HTML reply body" },
        markdownBody: { type: "string", description: "Markdown reply body" },
        from: { type: "string", description: "Sender address" },
        replyAll: { type: "boolean", default: false, description: "Reply to all" },
        sendImmediately: { type: "boolean", default: false, description: "Send now vs draft" },
        excludeQuote: { type: "boolean", default: false, description: "Exclude quoted original" },
      },
      required: ["emailId", "body"],
    },
    async execute(_id: string, params: { emailId: string; body: string; htmlBody?: string; markdownBody?: string; from?: string; replyAll?: boolean; sendImmediately?: boolean; excludeQuote?: boolean }) {
      const client = await getClient();
      const data = await client.callTool("reply_to_email", {
        emailId: params.emailId, body: params.body,
        ...(params.htmlBody && { htmlBody: params.htmlBody }),
        ...(params.markdownBody && { markdownBody: params.markdownBody }),
        ...(params.from && { from: params.from }),
        ...(params.replyAll !== undefined && { replyAll: params.replyAll }),
        ...(params.sendImmediately !== undefined && { sendImmediately: params.sendImmediately }),
        ...(params.excludeQuote !== undefined && { excludeQuote: params.excludeQuote }),
      });
      return { content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }] };
    },
  }, { optional: true });

  // -- Organize (6 tools, optional) -----------------------------------

  api.registerTool({
    name: "fastmail_mark_read",
    description: "Mark an email as read.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("mark_email_read", { emailId: params.emailId, read: true });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Marked as read" }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_mark_unread",
    description: "Mark an email as unread.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("mark_email_read", { emailId: params.emailId, read: false });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Marked as unread" }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_flag",
    description: "Flag (star) an email.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("flag_email", { emailId: params.emailId, flagged: true });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Flagged" }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_unflag",
    description: "Unflag (unstar) an email.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("flag_email", { emailId: params.emailId, flagged: false });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Unflagged" }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_delete",
    description: "Delete an email (move to trash).",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    async execute(_id: string, params: { emailId: string }) {
      const client = await getClient();
      const data = await client.callTool("delete_email", { emailId: params.emailId });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Deleted" }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_move",
    description: "Move an email to a different mailbox.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        targetMailboxId: { type: "string", description: "Target mailbox ID" },
      },
      required: ["emailId", "targetMailboxId"],
    },
    async execute(_id: string, params: { emailId: string; targetMailboxId: string }) {
      const client = await getClient();
      const data = await client.callTool("move_email", { emailId: params.emailId, targetMailboxId: params.targetMailboxId });
      return { content: [{ type: "text", text: typeof data === "string" ? data : "Moved" }] };
    },
  }, { optional: true });

  // -- Bulk (6 tools, optional) ---------------------------------------

  api.registerTool({
    name: "fastmail_bulk_read",
    description: "Mark multiple emails as read.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    async execute(_id: string, params: { emailIds: string[] }) {
      const client = await getClient();
      const data = await client.callTool("bulk_mark_read", { emailIds: params.emailIds, read: true });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} marked read` }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_unread",
    description: "Mark multiple emails as unread.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    async execute(_id: string, params: { emailIds: string[] }) {
      const client = await getClient();
      const data = await client.callTool("bulk_mark_read", { emailIds: params.emailIds, read: false });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} marked unread` }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_flag",
    description: "Flag multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    async execute(_id: string, params: { emailIds: string[] }) {
      const client = await getClient();
      const data = await client.callTool("bulk_flag", { emailIds: params.emailIds, flagged: true });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} flagged` }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_unflag",
    description: "Unflag multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    async execute(_id: string, params: { emailIds: string[] }) {
      const client = await getClient();
      const data = await client.callTool("bulk_flag", { emailIds: params.emailIds, flagged: false });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} unflagged` }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_delete",
    description: "Delete multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    async execute(_id: string, params: { emailIds: string[] }) {
      const client = await getClient();
      const data = await client.callTool("bulk_delete", { emailIds: params.emailIds });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} deleted` }] };
    },
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_move",
    description: "Move multiple emails to a mailbox.",
    parameters: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" } },
        targetMailboxId: { type: "string", description: "Target mailbox ID" },
      },
      required: ["emailIds", "targetMailboxId"],
    },
    async execute(_id: string, params: { emailIds: string[]; targetMailboxId: string }) {
      const client = await getClient();
      const data = await client.callTool("bulk_move", { emailIds: params.emailIds, targetMailboxId: params.targetMailboxId });
      return { content: [{ type: "text", text: typeof data === "string" ? data : `${params.emailIds.length} moved` }] };
    },
  }, { optional: true });
}
