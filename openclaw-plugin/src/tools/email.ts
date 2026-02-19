/**
 * Email tools for the Fastmail OpenClaw plugin.
 *
 * Each tool shells out to the `fastmail` CLI and returns its compact text output.
 * Write/organize/bulk tools use { optional: true } since they're destructive.
 */

import { runCli } from "../cli-runner.js";

export function registerEmailTools(api: any) {
  // -- Email Read (12 tools, required) --------------------------------

  api.registerTool({
    name: "fastmail_inbox",
    description:
      "Get recent inbox emails with IDs, dates, senders, subjects, and previews.",
    parameters: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          default: 10,
          description: "Number of emails to return",
        },
        mailboxName: {
          type: "string",
          default: "inbox",
          description: "Mailbox name (e.g. inbox, sent, drafts, trash)",
        },
      },
    },
    async execute(_id: string, params: { limit?: number; mailboxName?: string }) {
      const args = ["inbox"];
      if (params.limit) args.push("--limit", String(params.limit));
      if (params.mailboxName && params.mailboxName !== "inbox") {
        args.push("--mailbox", params.mailboxName);
      }
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_email",
    description:
      "Read a single email by ID. Returns formatted headers + body content.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        raw: {
          type: "boolean",
          default: false,
          description: "Return raw JMAP JSON instead of markdown",
        },
      },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string; raw?: boolean }) {
      const args = ["email", params.emailId];
      if (params.raw) args.push("--raw");
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_search_emails",
    description:
      "Search emails by text content. Supports filters: sender, recipient, date range, unread, attachments, mailbox.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        limit: { type: "integer", default: 20, description: "Max results" },
        from: { type: "string", description: "Filter by sender address" },
        to: { type: "string", description: "Filter by recipient address" },
        subject: { type: "string", description: "Filter by subject text" },
        after: {
          type: "string",
          description: "Only emails after this date (ISO 8601)",
        },
        before: {
          type: "string",
          description: "Only emails before this date (ISO 8601)",
        },
        unread: { type: "boolean", description: "Only unread emails" },
        attachments: {
          type: "boolean",
          description: "Only emails with attachments",
        },
        mailbox: {
          type: "string",
          description: "Restrict search to a mailbox ID",
        },
      },
      required: ["query"],
    },
    async execute(_id: string, params: Record<string, any>) {
      const args = ["email", "search", params.query];
      if (params.limit) args.push("--limit", String(params.limit));
      if (params.from) args.push("--from", params.from);
      if (params.to) args.push("--to", params.to);
      if (params.subject) args.push("--subject", params.subject);
      if (params.after) args.push("--after", params.after);
      if (params.before) args.push("--before", params.before);
      if (params.unread) args.push("--unread");
      if (params.attachments) args.push("--attachments");
      if (params.mailbox) args.push("--mailbox", params.mailbox);
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_thread",
    description: "Get all emails in a conversation thread by thread ID.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Thread ID" },
      },
      required: ["threadId"],
    },
    async execute(_id: string, params: { threadId: string }) {
      const text = await runCli(["email", "thread", params.threadId]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_list_mailboxes",
    description:
      "List all mailboxes with IDs, names, roles, and email counts.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const text = await runCli(["mailboxes"]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_mailbox_stats",
    description:
      "Get statistics for a specific mailbox or all mailboxes (total, unread, threads).",
    parameters: {
      type: "object",
      properties: {
        mailboxId: {
          type: "string",
          description: "Mailbox ID (omit for all mailboxes)",
        },
      },
    },
    async execute(_id: string, params: { mailboxId?: string }) {
      const args = ["mailbox-stats"];
      if (params.mailboxId) args.push(params.mailboxId);
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_account_summary",
    description:
      "Get account overview: mailbox count, identity count, total/unread emails.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const text = await runCli(["account"]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_list_identities",
    description: "List sending identities (email addresses and names).",
    parameters: { type: "object", properties: {} },
    async execute() {
      const text = await runCli(["identities"]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_attachments",
    description: "List attachments for an email with names, types, and sizes.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
      },
      required: ["emailId"],
    },
    async execute(_id: string, params: { emailId: string }) {
      const text = await runCli(["email", "attachments", params.emailId]);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_download_attachment",
    description:
      "Get download URL or inline content for an email attachment.",
    parameters: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "Email ID" },
        attachmentId: {
          type: "string",
          description: "Attachment blob ID",
        },
        inline: {
          type: "boolean",
          default: false,
          description: "Return base64 content inline (small files only)",
        },
      },
      required: ["emailId", "attachmentId"],
    },
    async execute(
      _id: string,
      params: { emailId: string; attachmentId: string; inline?: boolean },
    ) {
      const args = ["email", "download", params.emailId, params.attachmentId];
      if (params.inline) args.push("--inline");
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  api.registerTool({
    name: "fastmail_get_inbox_updates",
    description:
      "Get inbox changes since a state token (for incremental sync). Returns added/removed emails.",
    parameters: {
      type: "object",
      properties: {
        sinceQueryState: {
          type: "string",
          description:
            "State token from a previous call (omit to get current state + all emails)",
        },
        mailboxId: { type: "string", description: "Mailbox ID" },
        limit: { type: "integer", default: 100, description: "Max results" },
      },
    },
    async execute(
      _id: string,
      params: { sinceQueryState?: string; mailboxId?: string; limit?: number },
    ) {
      const args = ["updates"];
      if (params.sinceQueryState) args.push("--since", params.sinceQueryState);
      if (params.mailboxId) args.push("--mailbox", params.mailboxId);
      if (params.limit) args.push("--limit", String(params.limit));
      const text = await runCli(args);
      return { content: [{ type: "text", text }] };
    },
  });

  // -- Email Write (3 tools, optional) --------------------------------

  api.registerTool(
    {
      name: "fastmail_send_email",
      description: "Send an email. Supports plain text, HTML, or markdown body.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: { type: "string" },
            description: "Recipient email addresses",
          },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Plain text body" },
          html: { type: "string", description: "HTML body" },
          markdown: {
            type: "string",
            description: "Markdown body (converted to HTML)",
          },
          cc: {
            type: "array",
            items: { type: "string" },
            description: "CC recipients",
          },
          bcc: {
            type: "array",
            items: { type: "string" },
            description: "BCC recipients",
          },
          from: { type: "string", description: "Sender address" },
        },
        required: ["to", "subject"],
      },
      async execute(_id: string, params: Record<string, any>) {
        const args = ["email", "send", "--to", ...params.to, "--subject", params.subject];
        if (params.body) args.push("--body", params.body);
        if (params.html) args.push("--html", params.html);
        if (params.markdown) args.push("--markdown", params.markdown);
        if (params.cc?.length) args.push("--cc", ...params.cc);
        if (params.bcc?.length) args.push("--bcc", ...params.bcc);
        if (params.from) args.push("--from", params.from);
        const text = await runCli(args);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_create_draft",
      description: "Create an email draft.",
      parameters: {
        type: "object",
        properties: {
          to: {
            type: "array",
            items: { type: "string" },
            description: "Recipient email addresses",
          },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Plain text body" },
          html: { type: "string", description: "HTML body" },
          markdown: { type: "string", description: "Markdown body" },
          cc: {
            type: "array",
            items: { type: "string" },
            description: "CC recipients",
          },
          bcc: {
            type: "array",
            items: { type: "string" },
            description: "BCC recipients",
          },
          from: { type: "string", description: "Sender address" },
        },
        required: ["to", "subject"],
      },
      async execute(_id: string, params: Record<string, any>) {
        const args = ["email", "draft", "--to", ...params.to, "--subject", params.subject];
        if (params.body) args.push("--body", params.body);
        if (params.html) args.push("--html", params.html);
        if (params.markdown) args.push("--markdown", params.markdown);
        if (params.cc?.length) args.push("--cc", ...params.cc);
        if (params.bcc?.length) args.push("--bcc", ...params.bcc);
        if (params.from) args.push("--from", params.from);
        const text = await runCli(args);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_reply_to_email",
      description:
        "Reply to an email. Can reply-all, send immediately or save as draft.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID to reply to" },
          body: { type: "string", description: "Reply text body" },
          html: { type: "string", description: "HTML reply body" },
          markdown: { type: "string", description: "Markdown reply body" },
          from: { type: "string", description: "Sender address" },
          replyAll: {
            type: "boolean",
            default: false,
            description: "Reply to all recipients",
          },
          send: {
            type: "boolean",
            default: false,
            description: "Send immediately (default: save as draft)",
          },
          noQuote: {
            type: "boolean",
            default: false,
            description: "Exclude quoted original message",
          },
        },
        required: ["emailId", "body"],
      },
      async execute(_id: string, params: Record<string, any>) {
        const args = ["email", "reply", params.emailId, "--body", params.body];
        if (params.html) args.push("--html", params.html);
        if (params.markdown) args.push("--markdown", params.markdown);
        if (params.from) args.push("--from", params.from);
        if (params.replyAll) args.push("--all");
        if (params.send) args.push("--send");
        if (params.noQuote) args.push("--no-quote");
        const text = await runCli(args);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  // -- Email Organize (5 tools, optional) -----------------------------

  api.registerTool(
    {
      name: "fastmail_mark_read",
      description: "Mark an email as read.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["email", "read", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_mark_unread",
      description: "Mark an email as unread.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["email", "unread", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_flag",
      description: "Flag (star) an email.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["email", "flag", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_unflag",
      description: "Unflag (unstar) an email.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["email", "unflag", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_delete",
      description: "Delete an email (move to trash).",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
        },
        required: ["emailId"],
      },
      async execute(_id: string, params: { emailId: string }) {
        const text = await runCli(["email", "delete", params.emailId]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_move",
      description: "Move an email to a different mailbox.",
      parameters: {
        type: "object",
        properties: {
          emailId: { type: "string", description: "Email ID" },
          targetMailboxId: {
            type: "string",
            description: "Target mailbox ID",
          },
        },
        required: ["emailId", "targetMailboxId"],
      },
      async execute(
        _id: string,
        params: { emailId: string; targetMailboxId: string },
      ) {
        const text = await runCli([
          "email",
          "move",
          params.emailId,
          params.targetMailboxId,
        ]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  // -- Email Bulk (5 tools, optional) ---------------------------------

  api.registerTool(
    {
      name: "fastmail_bulk_read",
      description: "Mark multiple emails as read.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["emailIds"],
      },
      async execute(_id: string, params: { emailIds: string[] }) {
        const text = await runCli(["bulk", "read", ...params.emailIds]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_bulk_unread",
      description: "Mark multiple emails as unread.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["emailIds"],
      },
      async execute(_id: string, params: { emailIds: string[] }) {
        const text = await runCli(["bulk", "unread", ...params.emailIds]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_bulk_flag",
      description: "Flag multiple emails.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["emailIds"],
      },
      async execute(_id: string, params: { emailIds: string[] }) {
        const text = await runCli(["bulk", "flag", ...params.emailIds]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_bulk_unflag",
      description: "Unflag multiple emails.",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["emailIds"],
      },
      async execute(_id: string, params: { emailIds: string[] }) {
        const text = await runCli(["bulk", "unflag", ...params.emailIds]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_bulk_delete",
      description: "Delete multiple emails (move to trash).",
      parameters: {
        type: "object",
        properties: {
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["emailIds"],
      },
      async execute(_id: string, params: { emailIds: string[] }) {
        const text = await runCli(["bulk", "delete", ...params.emailIds]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );

  api.registerTool(
    {
      name: "fastmail_bulk_move",
      description: "Move multiple emails to a mailbox.",
      parameters: {
        type: "object",
        properties: {
          targetMailboxId: {
            type: "string",
            description: "Target mailbox ID",
          },
          emailIds: {
            type: "array",
            items: { type: "string" },
            description: "Email IDs",
          },
        },
        required: ["targetMailboxId", "emailIds"],
      },
      async execute(
        _id: string,
        params: { targetMailboxId: string; emailIds: string[] },
      ) {
        const text = await runCli([
          "bulk",
          "move",
          params.targetMailboxId,
          ...params.emailIds,
        ]);
        return { content: [{ type: "text", text }] };
      },
    },
    { optional: true },
  );
}
