/**
 * Email commands for the Fastmail CLI.
 *
 * Covers: inbox, email (get/thread/search/send/draft/reply/mark/delete/move),
 * bulk operations, mailboxes, mailbox stats, account, identities, updates.
 */

import { Command } from "commander";
import type { FastmailMcpClient } from "../mcp-client.js";
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

/** Helper: output JSON or formatted text based on --json flag */
function output(data: any, formatter: (d: any) => string, json: boolean) {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(formatter(data));
  }
}

export function registerEmailCommands(
  program: Command,
  client: FastmailMcpClient,
) {
  // ── inbox ────────────────────────────────────────────────

  program
    .command("inbox")
    .description("Show recent inbox emails")
    .option("-l, --limit <n>", "Number of emails", "10")
    .option("-m, --mailbox <name>", "Mailbox name", "inbox")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("get_recent_emails", {
        limit: parseInt(opts.limit),
        mailboxName: opts.mailbox,
      });
      output(data, (d) => formatEmailList(d, `${opts.mailbox}`), opts.json);
    });

  // ── email (group + default get) ──────────────────────────

  const email = program
    .command("email")
    .description("Email operations. Pass an ID to read an email.")
    .argument("[id]", "Email ID to read")
    .option("--raw", "Return raw JMAP JSON instead of markdown")
    .option("--json", "JSON output")
    .action(async (id, opts) => {
      if (!id) return email.help();
      const format = opts.raw ? "html" : "markdown";
      const data = await client.callTool("get_email", {
        emailId: id,
        format,
      });
      output(data, formatEmail, opts.json || opts.raw);
    });

  // ── email thread ─────────────────────────────────────────

  email
    .command("thread <threadId>")
    .description("Get all emails in a conversation thread")
    .option("--raw", "Raw JMAP JSON")
    .option("--json", "JSON output")
    .action(async (threadId, opts) => {
      const format = opts.raw ? "html" : "markdown";
      const data = await client.callTool("get_thread", {
        threadId,
        format,
      });
      if (opts.json || opts.raw) {
        console.log(JSON.stringify(data, null, 2));
      } else if (typeof data === "string") {
        console.log(data);
      } else if (Array.isArray(data)) {
        console.log(data.map(formatEmail).join("\n\n---\n\n"));
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    });

  // ── email search ─────────────────────────────────────────

  email
    .command("search <query>")
    .description("Search emails by text content")
    .option("-l, --limit <n>", "Max results", "20")
    .option("--from <addr>", "Filter by sender")
    .option("--to <addr>", "Filter by recipient")
    .option("--subject <text>", "Filter by subject")
    .option("--after <date>", "After date (ISO 8601)")
    .option("--before <date>", "Before date (ISO 8601)")
    .option("--unread", "Only unread emails")
    .option("--attachments", "Only emails with attachments")
    .option("--mailbox <id>", "Search within mailbox")
    .option("--json", "JSON output")
    .action(async (query, opts) => {
      // Use advanced_search if any filter options are provided
      const hasFilters = opts.from || opts.to || opts.subject || opts.after || opts.before || opts.unread || opts.attachments || opts.mailbox;

      if (hasFilters) {
        const data = await client.callTool("advanced_search", {
          query,
          from: opts.from,
          to: opts.to,
          subject: opts.subject,
          after: opts.after,
          before: opts.before,
          isUnread: opts.unread || undefined,
          hasAttachment: opts.attachments || undefined,
          mailboxId: opts.mailbox,
          limit: parseInt(opts.limit),
        });
        output(data, (d) => formatEmailList(d, `Search: ${query}`), opts.json);
      } else {
        const data = await client.callTool("search_emails", {
          query,
          limit: parseInt(opts.limit),
        });
        output(data, (d) => formatEmailList(d, `Search: ${query}`), opts.json);
      }
    });

  // ── email send ───────────────────────────────────────────

  email
    .command("send")
    .description("Send an email")
    .requiredOption("--to <addrs...>", "Recipient(s)")
    .requiredOption("--subject <text>", "Subject")
    .option("--body <text>", "Plain text body")
    .option("--html <text>", "HTML body")
    .option("--markdown <text>", "Markdown body")
    .option("--cc <addrs...>", "CC recipients")
    .option("--bcc <addrs...>", "BCC recipients")
    .option("--from <addr>", "Sender address")
    .action(async (opts) => {
      const result = await client.callTool("send_email", {
        to: opts.to,
        subject: opts.subject,
        textBody: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        cc: opts.cc,
        bcc: opts.bcc,
        from: opts.from,
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  // ── email draft ──────────────────────────────────────────

  email
    .command("draft")
    .description("Create an email draft")
    .requiredOption("--to <addrs...>", "Recipient(s)")
    .requiredOption("--subject <text>", "Subject")
    .option("--body <text>", "Plain text body")
    .option("--html <text>", "HTML body")
    .option("--markdown <text>", "Markdown body")
    .option("--cc <addrs...>", "CC recipients")
    .option("--bcc <addrs...>", "BCC recipients")
    .option("--from <addr>", "Sender address")
    .action(async (opts) => {
      const result = await client.callTool("create_draft", {
        to: opts.to,
        subject: opts.subject,
        textBody: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        cc: opts.cc,
        bcc: opts.bcc,
        from: opts.from,
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  // ── email reply ──────────────────────────────────────────

  email
    .command("reply <emailId>")
    .description("Reply to an email")
    .requiredOption("--body <text>", "Reply text")
    .option("--html <text>", "HTML reply body")
    .option("--markdown <text>", "Markdown reply body")
    .option("--from <addr>", "Sender address")
    .option("--all", "Reply to all recipients")
    .option("--send", "Send immediately (default: create draft)")
    .option("--no-quote", "Exclude quoted original message")
    .action(async (emailId, opts) => {
      const result = await client.callTool("reply_to_email", {
        emailId,
        body: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        from: opts.from,
        replyAll: opts.all || false,
        sendImmediately: opts.send || false,
        excludeQuote: !opts.quote,
      });
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  // ── email mark actions ───────────────────────────────────

  email
    .command("read <emailId>")
    .description("Mark email as read")
    .action(async (emailId) => {
      const result = await client.callTool("mark_email_read", {
        emailId,
        read: true,
      });
      console.log(typeof result === "string" ? result : "Marked as read");
    });

  email
    .command("unread <emailId>")
    .description("Mark email as unread")
    .action(async (emailId) => {
      const result = await client.callTool("mark_email_read", {
        emailId,
        read: false,
      });
      console.log(typeof result === "string" ? result : "Marked as unread");
    });

  email
    .command("flag <emailId>")
    .description("Flag an email")
    .action(async (emailId) => {
      const result = await client.callTool("flag_email", {
        emailId,
        flagged: true,
      });
      console.log(typeof result === "string" ? result : "Flagged");
    });

  email
    .command("unflag <emailId>")
    .description("Unflag an email")
    .action(async (emailId) => {
      const result = await client.callTool("flag_email", {
        emailId,
        flagged: false,
      });
      console.log(typeof result === "string" ? result : "Unflagged");
    });

  email
    .command("delete <emailId>")
    .description("Delete an email (move to trash)")
    .action(async (emailId) => {
      const result = await client.callTool("delete_email", { emailId });
      console.log(typeof result === "string" ? result : "Deleted");
    });

  email
    .command("move <emailId> <targetMailboxId>")
    .description("Move an email to a different mailbox")
    .action(async (emailId, targetMailboxId) => {
      const result = await client.callTool("move_email", {
        emailId,
        targetMailboxId,
      });
      console.log(typeof result === "string" ? result : "Moved");
    });

  // ── email attachments ────────────────────────────────────

  email
    .command("attachments <emailId>")
    .description("List attachments for an email")
    .option("--json", "JSON output")
    .action(async (emailId, opts) => {
      const data = await client.callTool("get_email_attachments", { emailId });
      output(data, formatAttachments, opts.json);
    });

  email
    .command("download <emailId> <attachmentId>")
    .description("Get download URL for an attachment")
    .option("--inline", "Return base64 content inline (small files only)")
    .action(async (emailId, attachmentId, opts) => {
      const data = await client.callTool("download_attachment", {
        emailId,
        attachmentId,
        inline: opts.inline || false,
      });
      if (typeof data === "string") {
        console.log(data);
      } else if (data.curl) {
        console.log(`File: ${data.filename} (${data.mimeType})`);
        console.log(`Download: ${data.curl}`);
        console.log(`Note: ${data.note}`);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
    });

  // ── bulk operations ──────────────────────────────────────

  const bulk = program
    .command("bulk")
    .description("Bulk email operations");

  bulk
    .command("read <ids...>")
    .description("Mark multiple emails as read")
    .action(async (ids) => {
      const result = await client.callTool("bulk_mark_read", {
        emailIds: ids,
        read: true,
      });
      console.log(typeof result === "string" ? result : `${ids.length} emails marked as read`);
    });

  bulk
    .command("unread <ids...>")
    .description("Mark multiple emails as unread")
    .action(async (ids) => {
      const result = await client.callTool("bulk_mark_read", {
        emailIds: ids,
        read: false,
      });
      console.log(typeof result === "string" ? result : `${ids.length} emails marked as unread`);
    });

  bulk
    .command("flag <ids...>")
    .description("Flag multiple emails")
    .action(async (ids) => {
      const result = await client.callTool("bulk_flag", {
        emailIds: ids,
        flagged: true,
      });
      console.log(typeof result === "string" ? result : `${ids.length} emails flagged`);
    });

  bulk
    .command("unflag <ids...>")
    .description("Unflag multiple emails")
    .action(async (ids) => {
      const result = await client.callTool("bulk_flag", {
        emailIds: ids,
        flagged: false,
      });
      console.log(typeof result === "string" ? result : `${ids.length} emails unflagged`);
    });

  bulk
    .command("delete <ids...>")
    .description("Delete multiple emails")
    .action(async (ids) => {
      const result = await client.callTool("bulk_delete", { emailIds: ids });
      console.log(typeof result === "string" ? result : `${ids.length} emails deleted`);
    });

  bulk
    .command("move <targetMailboxId> <ids...>")
    .description("Move multiple emails to a mailbox")
    .action(async (targetMailboxId, ids) => {
      const result = await client.callTool("bulk_move", {
        emailIds: ids,
        targetMailboxId,
      });
      console.log(typeof result === "string" ? result : `${ids.length} emails moved`);
    });

  // ── mailboxes ────────────────────────────────────────────

  program
    .command("mailboxes")
    .description("List all mailboxes")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_mailboxes");
      output(data, formatMailboxes, opts.json);
    });

  // ── mailbox stats ────────────────────────────────────────

  program
    .command("mailbox-stats")
    .description("Get mailbox statistics")
    .argument("[mailboxId]", "Specific mailbox ID (omit for all)")
    .option("--json", "JSON output")
    .action(async (mailboxId, opts) => {
      const args: Record<string, unknown> = {};
      if (mailboxId) args.mailboxId = mailboxId;
      const data = await client.callTool("get_mailbox_stats", args);
      output(data, formatMailboxStats, opts.json);
    });

  // ── account summary ──────────────────────────────────────

  program
    .command("account")
    .description("Show account summary")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("get_account_summary");
      output(data, formatAccountSummary, opts.json);
    });

  // ── identities ───────────────────────────────────────────

  program
    .command("identities")
    .description("List sending identities")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_identities");
      output(data, formatIdentities, opts.json);
    });

  // ── inbox updates ────────────────────────────────────────

  program
    .command("updates")
    .description("Get inbox changes since last check")
    .option("--since <state>", "State token from previous call")
    .option("--mailbox <id>", "Mailbox ID")
    .option("-l, --limit <n>", "Max results", "100")
    .option("--json", "JSON output")
    .action(async (opts) => {
      const data = await client.callTool("get_inbox_updates", {
        sinceQueryState: opts.since,
        mailboxId: opts.mailbox,
        limit: parseInt(opts.limit),
      });
      output(data, formatInboxUpdates, opts.json);
    });
}
