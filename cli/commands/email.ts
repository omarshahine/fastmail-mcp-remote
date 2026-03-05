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
import {
  validateIds,
  validateEmails,
  validateDateArg,
  validateTextArg,
  validateQuery,
  validatePositiveInt,
} from "../validate.js";
import { output, filterFields, dryRunOutput } from "../helpers.js";

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
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const limit = validatePositiveInt(opts.limit, "limit");
      validateTextArg(opts.mailbox, "mailbox name");
      const data = await client.callTool("get_recent_emails", {
        limit,
        mailboxName: opts.mailbox,
      });
      output(data, (d) => formatEmailList(d, `${opts.mailbox}`), opts.json, opts.fields);
    });

  // ── email (group + default get) ──────────────────────────

  const email = program
    .command("email")
    .description("Email operations. Pass an ID to read an email.")
    .argument("[id]", "Email ID to read")
    .option("--raw", "Return raw JMAP JSON instead of markdown")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (id, opts) => {
      if (!id) return email.help();
      validateIds(id, "email ID");
      const format = opts.raw ? "html" : "markdown";
      const data = await client.callTool("get_email", {
        emailId: id,
        format,
      });
      output(data, formatEmail, opts.json || opts.raw, opts.fields);
    });

  // ── email thread ─────────────────────────────────────────

  email
    .command("thread <threadId>")
    .description("Get all emails in a conversation thread")
    .option("--raw", "Raw JMAP JSON")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (threadId, opts) => {
      validateIds(threadId, "thread ID");
      const format = opts.raw ? "html" : "markdown";
      const data = await client.callTool("get_thread", {
        threadId,
        format,
      });
      if (opts.json || opts.raw) {
        const filtered = opts.fields ? filterFields(data, opts.fields) : data;
        console.log(JSON.stringify(filtered, null, 2));
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
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (query, opts) => {
      validateQuery(query, "search query");
      const limit = validatePositiveInt(opts.limit, "limit");
      if (opts.from) validateTextArg(opts.from, "from filter");
      if (opts.to) validateTextArg(opts.to, "to filter");
      if (opts.subject) validateTextArg(opts.subject, "subject filter");
      if (opts.after) validateDateArg(opts.after, "after date");
      if (opts.before) validateDateArg(opts.before, "before date");
      if (opts.mailbox) validateIds(opts.mailbox, "mailbox ID");

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
          limit,
        });
        output(data, (d) => formatEmailList(d, `Search: ${query}`), opts.json, opts.fields);
      } else {
        const data = await client.callTool("search_emails", {
          query,
          limit,
        });
        output(data, (d) => formatEmailList(d, `Search: ${query}`), opts.json, opts.fields);
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
    .option("--dry-run", "Preview what would be sent without sending")
    .action(async (opts) => {
      validateEmails(opts.to, "recipient");
      validateTextArg(opts.subject, "subject");
      if (opts.body) validateTextArg(opts.body, "body");
      if (opts.html) validateTextArg(opts.html, "HTML body");
      if (opts.markdown) validateTextArg(opts.markdown, "markdown body");
      if (opts.cc) validateEmails(opts.cc, "CC recipient");
      if (opts.bcc) validateEmails(opts.bcc, "BCC recipient");
      if (opts.from) validateEmails(opts.from, "sender address");

      const args = {
        to: opts.to,
        subject: opts.subject,
        textBody: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        cc: opts.cc,
        bcc: opts.bcc,
        from: opts.from,
      };

      if (opts.dryRun) return dryRunOutput("send_email", args);

      const result = await client.callTool("send_email", args);
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
    .option("--dry-run", "Preview what would be created without creating")
    .action(async (opts) => {
      validateEmails(opts.to, "recipient");
      validateTextArg(opts.subject, "subject");
      if (opts.body) validateTextArg(opts.body, "body");
      if (opts.html) validateTextArg(opts.html, "HTML body");
      if (opts.markdown) validateTextArg(opts.markdown, "markdown body");
      if (opts.cc) validateEmails(opts.cc, "CC recipient");
      if (opts.bcc) validateEmails(opts.bcc, "BCC recipient");
      if (opts.from) validateEmails(opts.from, "sender address");

      const args = {
        to: opts.to,
        subject: opts.subject,
        textBody: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        cc: opts.cc,
        bcc: opts.bcc,
        from: opts.from,
      };

      if (opts.dryRun) return dryRunOutput("create_draft", args);

      const result = await client.callTool("create_draft", args);
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
    .option("--dry-run", "Preview what would be sent without sending")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      validateTextArg(opts.body, "reply body");
      if (opts.html) validateTextArg(opts.html, "HTML reply body");
      if (opts.markdown) validateTextArg(opts.markdown, "markdown reply body");
      if (opts.from) validateEmails(opts.from, "sender address");

      const args = {
        emailId,
        body: opts.body,
        htmlBody: opts.html,
        markdownBody: opts.markdown,
        from: opts.from,
        replyAll: opts.all || false,
        sendImmediately: opts.send || false,
        excludeQuote: !opts.quote,
      };

      if (opts.dryRun) return dryRunOutput("reply_to_email", args);

      const result = await client.callTool("reply_to_email", args);
      console.log(typeof result === "string" ? result : JSON.stringify(result));
    });

  // ── email mark actions ───────────────────────────────────

  email
    .command("read <emailId>")
    .description("Mark email as read")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const args = { emailId, read: true };
      if (opts.dryRun) return dryRunOutput("mark_email_read", args);
      const result = await client.callTool("mark_email_read", args);
      console.log(typeof result === "string" ? result : "Marked as read");
    });

  email
    .command("unread <emailId>")
    .description("Mark email as unread")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const args = { emailId, read: false };
      if (opts.dryRun) return dryRunOutput("mark_email_read", args);
      const result = await client.callTool("mark_email_read", args);
      console.log(typeof result === "string" ? result : "Marked as unread");
    });

  email
    .command("flag <emailId>")
    .description("Flag an email")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const args = { emailId, flagged: true };
      if (opts.dryRun) return dryRunOutput("flag_email", args);
      const result = await client.callTool("flag_email", args);
      console.log(typeof result === "string" ? result : "Flagged");
    });

  email
    .command("unflag <emailId>")
    .description("Unflag an email")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const args = { emailId, flagged: false };
      if (opts.dryRun) return dryRunOutput("flag_email", args);
      const result = await client.callTool("flag_email", args);
      console.log(typeof result === "string" ? result : "Unflagged");
    });

  email
    .command("delete <emailId>")
    .description("Delete an email (move to trash)")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const args = { emailId };
      if (opts.dryRun) return dryRunOutput("delete_email", args);
      const result = await client.callTool("delete_email", args);
      console.log(typeof result === "string" ? result : "Deleted");
    });

  email
    .command("move <emailId> <targetMailboxId>")
    .description("Move an email to a different mailbox")
    .option("--dry-run", "Preview without executing")
    .action(async (emailId, targetMailboxId, opts) => {
      validateIds(emailId, "email ID");
      validateIds(targetMailboxId, "target mailbox ID");
      const args = { emailId, targetMailboxId };
      if (opts.dryRun) return dryRunOutput("move_email", args);
      const result = await client.callTool("move_email", args);
      console.log(typeof result === "string" ? result : "Moved");
    });

  // ── email attachments ────────────────────────────────────

  email
    .command("attachments <emailId>")
    .description("List attachments for an email")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (emailId, opts) => {
      validateIds(emailId, "email ID");
      const data = await client.callTool("get_email_attachments", { emailId });
      output(data, formatAttachments, opts.json, opts.fields);
    });

  email
    .command("download <emailId> <attachmentId>")
    .description("Get download URL for an attachment")
    .option("--inline", "Return base64 content inline (small files only)")
    .action(async (emailId, attachmentId, opts) => {
      validateIds(emailId, "email ID");
      validateIds(attachmentId, "attachment ID");
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
    .option("--dry-run", "Preview without executing")
    .action(async (ids, opts) => {
      validateIds(ids, "email ID");
      const args = { emailIds: ids, read: true };
      if (opts.dryRun) return dryRunOutput("bulk_mark_read", args);
      const result = await client.callTool("bulk_mark_read", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails marked as read`);
    });

  bulk
    .command("unread <ids...>")
    .description("Mark multiple emails as unread")
    .option("--dry-run", "Preview without executing")
    .action(async (ids, opts) => {
      validateIds(ids, "email ID");
      const args = { emailIds: ids, read: false };
      if (opts.dryRun) return dryRunOutput("bulk_mark_read", args);
      const result = await client.callTool("bulk_mark_read", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails marked as unread`);
    });

  bulk
    .command("flag <ids...>")
    .description("Flag multiple emails")
    .option("--dry-run", "Preview without executing")
    .action(async (ids, opts) => {
      validateIds(ids, "email ID");
      const args = { emailIds: ids, flagged: true };
      if (opts.dryRun) return dryRunOutput("bulk_flag", args);
      const result = await client.callTool("bulk_flag", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails flagged`);
    });

  bulk
    .command("unflag <ids...>")
    .description("Unflag multiple emails")
    .option("--dry-run", "Preview without executing")
    .action(async (ids, opts) => {
      validateIds(ids, "email ID");
      const args = { emailIds: ids, flagged: false };
      if (opts.dryRun) return dryRunOutput("bulk_flag", args);
      const result = await client.callTool("bulk_flag", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails unflagged`);
    });

  bulk
    .command("delete <ids...>")
    .description("Delete multiple emails")
    .option("--dry-run", "Preview without executing")
    .action(async (ids, opts) => {
      validateIds(ids, "email ID");
      const args = { emailIds: ids };
      if (opts.dryRun) return dryRunOutput("bulk_delete", args);
      const result = await client.callTool("bulk_delete", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails deleted`);
    });

  bulk
    .command("move <targetMailboxId> <ids...>")
    .description("Move multiple emails to a mailbox")
    .option("--dry-run", "Preview without executing")
    .action(async (targetMailboxId, ids, opts) => {
      validateIds(ids, "email ID");
      validateIds(targetMailboxId, "target mailbox ID");
      const args = { emailIds: ids, targetMailboxId };
      if (opts.dryRun) return dryRunOutput("bulk_move", args);
      const result = await client.callTool("bulk_move", args);
      console.log(typeof result === "string" ? result : `${ids.length} emails moved`);
    });

  // ── mailboxes ────────────────────────────────────────────

  program
    .command("mailboxes")
    .description("List all mailboxes")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_mailboxes");
      output(data, formatMailboxes, opts.json, opts.fields);
    });

  // ── mailbox stats ────────────────────────────────────────

  program
    .command("mailbox-stats")
    .description("Get mailbox statistics")
    .argument("[mailboxId]", "Specific mailbox ID (omit for all)")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (mailboxId, opts) => {
      const args: Record<string, unknown> = {};
      if (mailboxId) {
        validateIds(mailboxId, "mailbox ID");
        args.mailboxId = mailboxId;
      }
      const data = await client.callTool("get_mailbox_stats", args);
      output(data, formatMailboxStats, opts.json, opts.fields);
    });

  // ── account summary ──────────────────────────────────────

  program
    .command("account")
    .description("Show account summary")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const data = await client.callTool("get_account_summary");
      output(data, formatAccountSummary, opts.json, opts.fields);
    });

  // ── identities ───────────────────────────────────────────

  program
    .command("identities")
    .description("List sending identities")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const data = await client.callTool("list_identities");
      output(data, formatIdentities, opts.json, opts.fields);
    });

  // ── inbox updates ────────────────────────────────────────

  program
    .command("updates")
    .description("Get inbox changes since last check")
    .option("--since <state>", "State token from previous call")
    .option("--mailbox <id>", "Mailbox ID")
    .option("-l, --limit <n>", "Max results", "100")
    .option("--json", "JSON output")
    .option("--fields <list>", "Comma-separated fields to include in JSON output")
    .action(async (opts) => {
      const limit = validatePositiveInt(opts.limit, "limit");
      if (opts.mailbox) validateIds(opts.mailbox, "mailbox ID");
      const data = await client.callTool("get_inbox_updates", {
        sinceQueryState: opts.since,
        mailboxId: opts.mailbox,
        limit,
      });
      output(data, formatInboxUpdates, opts.json, opts.fields);
    });
}
