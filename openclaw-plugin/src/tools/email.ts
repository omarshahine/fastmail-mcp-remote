/**
 * Email tools for the Fastmail OpenClaw plugin.
 *
 * 11 read + 3 write + 6 organize + 6 bulk = 26 tools total.
 * Write/organize/bulk tools use { optional: true }.
 */

import type { OpenClawApi } from "../../index.js";
import { buildArgs, runTool } from "../cli-runner.js";

export function registerEmailTools(api: OpenClawApi, cli: string) {
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
    execute: (_id, params: { limit?: number; mailboxName?: string }) =>
      runTool(buildArgs(["inbox"], { limit: params.limit, mailbox: params.mailboxName }), cli),
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
    execute: (_id, params: { emailId: string; format?: string }) =>
      runTool(buildArgs(["email", params.emailId], { raw: params.format === "html" }), cli),
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
    execute: (_id, params: Record<string, any>) =>
      runTool(buildArgs(["email", "search", params.query], {
        limit: params.limit,
        from: params.from,
        to: params.to,
        subject: params.subject,
        after: params.after,
        before: params.before,
        unread: params.isUnread,
        attachments: params.hasAttachment,
        mailbox: params.mailboxId,
      }), cli),
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
    execute: (_id, params: { threadId: string; format?: string }) =>
      runTool(buildArgs(["email", "thread", params.threadId], { raw: params.format === "html" }), cli),
  });

  api.registerTool({
    name: "fastmail_list_mailboxes",
    description: "List all mailboxes with IDs, names, roles, and email counts.",
    parameters: { type: "object", properties: {} },
    execute: () => runTool(["mailboxes"], cli),
  });

  api.registerTool({
    name: "fastmail_get_mailbox_stats",
    description: "Get statistics for a specific mailbox or all mailboxes.",
    parameters: {
      type: "object",
      properties: { mailboxId: { type: "string", description: "Mailbox ID (omit for all)" } },
    },
    execute: (_id, params: { mailboxId?: string }) =>
      runTool(buildArgs(params.mailboxId ? ["mailbox-stats", params.mailboxId] : ["mailbox-stats"]), cli),
  });

  api.registerTool({
    name: "fastmail_get_account_summary",
    description: "Get account overview: mailbox count, identity count, total/unread emails.",
    parameters: { type: "object", properties: {} },
    execute: () => runTool(["account"], cli),
  });

  api.registerTool({
    name: "fastmail_list_identities",
    description: "List sending identities (email addresses and names).",
    parameters: { type: "object", properties: {} },
    execute: () => runTool(["identities"], cli),
  });

  api.registerTool({
    name: "fastmail_get_attachments",
    description: "List attachments for an email.",
    parameters: {
      type: "object",
      properties: { emailId: { type: "string", description: "Email ID" } },
      required: ["emailId"],
    },
    execute: (_id, params: { emailId: string }) =>
      runTool(["email", "attachments", params.emailId], cli),
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
    execute: (_id, params: { emailId: string; attachmentId: string; inline?: boolean }) =>
      runTool(buildArgs(["email", "download", params.emailId, params.attachmentId], { inline: params.inline }), cli),
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
    execute: (_id, params: { sinceQueryState?: string; mailboxId?: string; limit?: number }) =>
      runTool(buildArgs(["updates"], { since: params.sinceQueryState, mailbox: params.mailboxId, limit: params.limit }), cli),
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
    execute: (_id, params: { to: string[]; subject: string; textBody?: string; htmlBody?: string; markdownBody?: string; cc?: string[]; bcc?: string[]; from?: string }) =>
      runTool(buildArgs(["email", "send"], {
        to: params.to, subject: params.subject,
        body: params.textBody, html: params.htmlBody, markdown: params.markdownBody,
        cc: params.cc, bcc: params.bcc, from: params.from,
      }), cli),
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
    execute: (_id, params: { to: string[]; subject: string; textBody?: string; htmlBody?: string; markdownBody?: string; cc?: string[]; bcc?: string[]; from?: string }) =>
      runTool(buildArgs(["email", "draft"], {
        to: params.to, subject: params.subject,
        body: params.textBody, html: params.htmlBody, markdown: params.markdownBody,
        cc: params.cc, bcc: params.bcc, from: params.from,
      }), cli),
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
    execute: (_id, params: { emailId: string; body: string; htmlBody?: string; markdownBody?: string; from?: string; replyAll?: boolean; sendImmediately?: boolean; excludeQuote?: boolean }) =>
      runTool(buildArgs(["email", "reply", params.emailId], {
        body: params.body, html: params.htmlBody, markdown: params.markdownBody,
        from: params.from, all: params.replyAll, send: params.sendImmediately,
        "no-quote": params.excludeQuote,
      }), cli),
  }, { optional: true });

  // -- Organize (6 tools, optional) -----------------------------------

  api.registerTool({
    name: "fastmail_mark_read",
    description: "Mark an email as read.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    execute: (_id, params: { emailId: string }) => runTool(["email", "read", params.emailId], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_mark_unread",
    description: "Mark an email as unread.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    execute: (_id, params: { emailId: string }) => runTool(["email", "unread", params.emailId], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_flag",
    description: "Flag (star) an email.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    execute: (_id, params: { emailId: string }) => runTool(["email", "flag", params.emailId], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_unflag",
    description: "Unflag (unstar) an email.",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    execute: (_id, params: { emailId: string }) => runTool(["email", "unflag", params.emailId], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_delete",
    description: "Delete an email (move to trash).",
    parameters: { type: "object", properties: { emailId: { type: "string" } }, required: ["emailId"] },
    execute: (_id, params: { emailId: string }) => runTool(["email", "delete", params.emailId], cli),
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
    execute: (_id, params: { emailId: string; targetMailboxId: string }) =>
      runTool(["email", "move", params.emailId, params.targetMailboxId], cli),
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
    execute: (_id, params: { emailIds: string[] }) =>
      runTool(["bulk", "read", ...params.emailIds], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_unread",
    description: "Mark multiple emails as unread.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    execute: (_id, params: { emailIds: string[] }) =>
      runTool(["bulk", "unread", ...params.emailIds], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_flag",
    description: "Flag multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    execute: (_id, params: { emailIds: string[] }) =>
      runTool(["bulk", "flag", ...params.emailIds], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_unflag",
    description: "Unflag multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    execute: (_id, params: { emailIds: string[] }) =>
      runTool(["bulk", "unflag", ...params.emailIds], cli),
  }, { optional: true });

  api.registerTool({
    name: "fastmail_bulk_delete",
    description: "Delete multiple emails.",
    parameters: {
      type: "object",
      properties: { emailIds: { type: "array", items: { type: "string" } } },
      required: ["emailIds"],
    },
    execute: (_id, params: { emailIds: string[] }) =>
      runTool(["bulk", "delete", ...params.emailIds], cli),
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
    execute: (_id, params: { emailIds: string[]; targetMailboxId: string }) =>
      runTool(["bulk", "move", params.targetMailboxId, ...params.emailIds], cli),
  }, { optional: true });
}
